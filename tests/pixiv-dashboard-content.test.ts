import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  DashboardData,
  WorkMetrics,
  WorkObservation,
  WorkRecord,
  WorkSample,
} from "../src/domain/types";

const runtimeMock = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: runtimeMock.sendMessage,
      onMessage: { addListener: vi.fn() },
    },
    storage: { onChanged: { addListener: vi.fn() } },
  },
}));

import {
  buildGrowthRenderContext,
  createLatestRequestGuard,
  formatGrowthDelta,
  injectGrowthContext,
  injectGrowthContextProgressively,
  injectGrowthChips,
  isNaturalWorksDashboardUrl,
  observeGrowthCardChanges,
  selectGrowthAnalyticsInput,
  sendPassivePageSnapshot,
  todayGrowthFor,
} from "../entrypoints/pixiv-dashboard.content";

const source = readFileSync(resolve(process.cwd(), "entrypoints/pixiv-dashboard.content.ts"), "utf8");

const metrics = (overrides: Partial<WorkMetrics> = {}): WorkMetrics => ({
  likes: 10,
  bookmarks: 5,
  views: 100,
  comments: 4,
  rank: null,
  responses: null,
  illustrations: null,
  ...overrides,
});

const work = (id: string, current: WorkMetrics): WorkRecord => ({
  id,
  type: "illust",
  key: `illust-${id}`,
  title: `Work ${id}`,
  seriesTitle: null,
  publishedAt: null,
  wordCount: null,
  pageCount: null,
  isAi: null,
  isR18: null,
  thumbnailUrl: null,
  workUrl: `https://www.pixiv.net/artworks/${id}`,
  metrics: current,
  rawLabels: {},
  missingFields: [],
  parserVersion: 1,
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-01T02:00:00.000Z",
  lastObservedRunId: "run-current",
  absentSince: null,
});

const sample = (workKey: string, runId: string, at: string, current: WorkMetrics): WorkSample => ({
  workKey,
  runId,
  collectedAt: at,
  metrics: current,
  parserVersion: 1,
  dataQuality: 1,
  kind: "change",
});

const settings: AppSettings = {
  onboardingComplete: true,
  scheduledSyncEnabled: false,
  syncIntervalHours: 1,
  showPixivChips: true,
  theme: "system",
  lastCompactedAt: null,
  storageWarningBytes: 0,
};

const dashboard = (current: WorkMetrics): DashboardData => {
  const currentWork = work("1", current);
  return {
    works: [currentWork],
    samples: [
      sample(currentWork.key, "run-old", "2026-08-01T00:00:00.000Z", metrics({ likes: 10, bookmarks: null, views: 100, comments: 6 })),
      sample(currentWork.key, "run-current", "2026-08-01T02:00:00.000Z", current),
    ],
    observations: [
      { workKey: currentWork.key, runId: "run-old", observedAt: "2026-08-01T00:00:00.000Z", metricsChanged: true },
      { workKey: currentWork.key, runId: "run-current", observedAt: "2026-08-01T02:00:00.000Z", metricsChanged: true },
    ] as WorkObservation[],
    runs: [],
    settings,
    syncState: null,
  };
};

function pageWithCard(): Document {
  const doc = document.implementation.createHTMLDocument("Pixiv works");
  doc.body.innerHTML = `<article data-ga4-entity-id="illust/1"><h2>Work 1</h2></article>`;
  return doc;
}

function dashboardWithWorks(ids: readonly string[]): DashboardData {
  const works = ids.map((id, index) => work(id, metrics({ views: 120 + index, likes: 12 + index })));
  return {
    works,
    samples: works.flatMap((item, index) => [
      sample(item.key, "run-old", "2026-08-01T00:00:00.000Z", metrics({ views: 100, likes: 10 })),
      sample(item.key, "run-current", "2026-08-01T02:00:00.000Z", metrics({ views: 120 + index, likes: 12 + index })),
    ]),
    observations: works.flatMap((item) => [
      { workKey: item.key, runId: "run-old", observedAt: "2026-08-01T00:00:00.000Z", metricsChanged: true },
      { workKey: item.key, runId: "run-current", observedAt: "2026-08-01T02:00:00.000Z", metricsChanged: true },
    ]),
    runs: [],
    settings,
    syncState: null,
  };
}

function pageWithCards(ids: readonly string[]): Document {
  const doc = document.implementation.createHTMLDocument("Pixiv works");
  doc.body.innerHTML = ids.map((id) => `<article data-ga4-entity-id="illust/${id}"><h2>Work ${id}</h2></article>`).join("");
  return doc;
}

function payload(fingerprint: string): Parameters<typeof sendPassivePageSnapshot>[1] {
  return {
    runId: "",
    page: 1,
    pageCount: 1,
    hasNext: false,
    positivelyEmpty: false,
    fingerprint,
    works: [],
    account: null,
    parserVersion: 1,
    collectedAt: "2026-08-01T00:00:00.000Z",
    quality: { totalCards: 0, validCards: 0, missingRequired: 0, missingMetricFields: 0 },
  };
}

describe("Pixiv works content script", () => {
  it("keeps page parsing and chips without mounting the legacy floating toolbar", () => {
    expect(source).not.toContain("mountPixivToolbar");
    expect(source).not.toContain("pixiv-toolbar");
    expect(source).not.toContain("refreshToolbar");
    expect(source).toContain("injectGrowthChips");
    expect(source).toContain("PAGE_READY");
    expect(source.match(/buildIntradayAnalytics\(/g)).toHaveLength(1);
  });

  it("renders all four growth metrics, including unknown, zero, and negative values", () => {
    const doc = pageWithCard();
    const current = metrics({ views: 105, likes: 10, bookmarks: null, comments: 2 });

    expect(injectGrowthChips(doc, dashboard(current), Date.parse("2026-08-01T03:00:00.000Z"))).toBe(1);
    const host = doc.querySelector("pixiv-pulse-growth");
    expect(host).toBeTruthy();
    const cells = Array.from(host?.shadowRoot?.querySelectorAll<HTMLElement>(".metric") ?? []);
    expect(cells.map((cell) => cell.textContent)).toEqual(["浏览+5", "赞+0", "收藏—", "评论-4"]);
    expect(cells[3]?.dataset.negative).toBe("true");
    expect(host?.hasAttribute("data-negative")).toBe(false);
    expect(host?.shadowRoot?.textContent).not.toContain("排名");
    expect(formatGrowthDelta(null)).toBe("—");
    expect(formatGrowthDelta(0)).toBe("+0");
    expect(formatGrowthDelta(-3)).toBe("-3");
  });

  it("uses the first Beijing-day observation instead of the latest sync delta", () => {
    const currentWork = work("1", metrics({ views: 130, likes: 14, bookmarks: 8, comments: 6 }));
    const data: DashboardData = {
      works: [currentWork],
      samples: [
        sample(currentWork.key, "before-day", "2026-08-30T15:30:00.000Z", metrics({ views: 100, likes: 10, bookmarks: 5, comments: 4 })),
        sample(currentWork.key, "morning", "2026-08-30T17:00:00.000Z", metrics({ views: 120, likes: 12, bookmarks: 7, comments: 5 })),
        sample(currentWork.key, "latest", "2026-08-30T18:00:00.000Z", currentWork.metrics),
      ],
      observations: [
        { workKey: currentWork.key, runId: "before-day", observedAt: "2026-08-30T15:30:00.000Z", metricsChanged: true },
        { workKey: currentWork.key, runId: "morning", observedAt: "2026-08-30T17:00:00.000Z", metricsChanged: true },
        { workKey: currentWork.key, runId: "latest", observedAt: "2026-08-30T18:00:00.000Z", metricsChanged: true },
      ],
      runs: [], settings, syncState: null,
    };

    const growth = todayGrowthFor(currentWork, data, Date.parse("2026-08-30T19:00:00.000Z"));
    expect(growth?.delta.views).toBe(10);
    expect(growth?.delta.likes).toBe(2);
  });

  it("updates one existing host in place and removes duplicates or stale hosts", () => {
    const doc = pageWithCard();
    const firstDashboard = dashboard(metrics({ views: 105, comments: 2 }));
    injectGrowthChips(doc, firstDashboard, Date.parse("2026-08-01T03:00:00.000Z"));
    const host = doc.querySelector("pixiv-pulse-growth");
    expect(host).toBeTruthy();

    const duplicate = doc.createElement("pixiv-pulse-growth");
    duplicate.dataset.pixivKey = "illust-1";
    doc.querySelector("article")?.append(duplicate);
    const updatedDashboard = dashboard(metrics({ views: 120, comments: 8 }));
    expect(injectGrowthChips(doc, updatedDashboard, Date.parse("2026-08-01T03:00:00.000Z"))).toBe(0);
    expect(doc.querySelectorAll("pixiv-pulse-growth")).toHaveLength(1);
    expect(doc.querySelector("pixiv-pulse-growth")).toBe(host);
    expect(host?.shadowRoot?.textContent).toContain("浏览+20");

    injectGrowthChips(doc, { ...updatedDashboard, settings: { ...settings, showPixivChips: false } });
    expect(doc.querySelector("pixiv-pulse-growth")).toBeNull();
  });

  it("builds one reusable growth context and renders cards in Pixiv DOM order", () => {
    const data = dashboardWithWorks(["1", "2", "3"]);
    const context = buildGrowthRenderContext(data, Date.parse("2026-08-01T03:00:00.000Z"));
    const doc = pageWithCards(["3", "1", "2"]);

    expect(context.analysisByWork.size).toBe(3);
    expect(injectGrowthContext(doc, context)).toBe(3);
    expect(Array.from(doc.querySelectorAll<HTMLElement>("pixiv-pulse-growth")).map((host) => host.dataset.pixivKey)).toEqual([
      "illust-3",
      "illust-1",
      "illust-2",
    ]);
  });

  it("keeps only the recent growth window plus one older baseline per work", () => {
    const data = dashboardWithWorks(["1"]);
    data.samples.unshift(
      sample("illust-1", "ancient", "2026-07-01T00:00:00.000Z", metrics({ views: 20 })),
      sample("illust-1", "older-baseline", "2026-07-31T13:00:00.000Z", metrics({ views: 80 })),
    );
    data.observations.unshift({ workKey: "illust-1", runId: "ancient", observedAt: "2026-07-01T00:00:00.000Z", metricsChanged: true });

    const selected = selectGrowthAnalyticsInput(data, Date.parse("2026-08-01T03:00:00.000Z"));
    expect(selected.samples.map((item) => item.runId).sort()).toEqual(["older-baseline", "run-current", "run-old"].sort());
    expect(selected.observations.map((item) => item.runId)).not.toContain("ancient");
  });

  it("renders the top batch before yielding and cancels stale continuation work", async () => {
    const ids = ["1", "2", "3", "4", "5"];
    const doc = pageWithCards(ids);
    const context = buildGrowthRenderContext(dashboardWithWorks(ids), Date.parse("2026-08-01T03:00:00.000Z"));
    let releaseFirstYield: () => void = () => undefined;
    const firstYield = new Promise<void>((resolve) => { releaseFirstYield = resolve; });
    const yieldToBrowser = vi.fn()
      .mockReturnValueOnce(firstYield)
      .mockResolvedValue(undefined);
    let current = true;
    const task = injectGrowthContextProgressively(doc, context, {
      firstBatchSize: 2,
      batchSize: 1,
      isCurrent: () => current,
      yieldToBrowser,
    });

    await Promise.resolve();
    expect(doc.querySelectorAll("pixiv-pulse-growth")).toHaveLength(2);
    current = false;
    releaseFirstYield();
    await task;
    expect(doc.querySelectorAll("pixiv-pulse-growth")).toHaveLength(2);
  });

  it("reuses an unchanged strip but replaces a host when Pixiv reuses a card node", () => {
    const data = dashboardWithWorks(["1", "2"]);
    const context = buildGrowthRenderContext(data, Date.parse("2026-08-01T03:00:00.000Z"));
    const doc = pageWithCards(["1"]);
    injectGrowthContext(doc, context);
    const firstHost = doc.querySelector<HTMLElement>("pixiv-pulse-growth");
    const firstStrip = firstHost?.shadowRoot?.querySelector(".strip");

    injectGrowthContext(doc, context);
    expect(firstHost?.shadowRoot?.querySelector(".strip")).toBe(firstStrip);

    doc.querySelector("[data-ga4-entity-id]")?.setAttribute("data-ga4-entity-id", "illust/2");
    injectGrowthContext(doc, context);
    const reusedHost = doc.querySelector<HTMLElement>("pixiv-pulse-growth");
    expect(doc.querySelectorAll("pixiv-pulse-growth")).toHaveLength(1);
    expect(reusedHost?.dataset.pixivKey).toBe("illust-2");
  });

  it("observes new or reused Pixiv cards and stops cleanly", async () => {
    const doc = pageWithCards(["1"]);
    const changed = vi.fn();
    const stop = observeGrowthCardChanges(doc, changed);
    doc.body.insertAdjacentHTML("beforeend", `<article data-ga4-entity-id="illust/2"></article>`);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(changed).toHaveBeenCalledTimes(1);

    stop();
    doc.querySelector("[data-ga4-entity-id='illust/2']")?.setAttribute("data-ga4-entity-id", "illust/3");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("accepts only the latest asynchronous dashboard response", () => {
    const guard = createLatestRequestGuard();
    const older = guard.begin();
    const latest = guard.begin();
    expect(guard.isLatest(older)).toBe(false);
    expect(guard.isLatest(latest)).toBe(true);
    guard.cancel();
    expect(guard.isLatest(latest)).toBe(false);
  });

  it("sends one natural-route passive snapshot per route and fingerprint, excluding fallback routes", async () => {
    runtimeMock.sendMessage.mockReset();
    runtimeMock.sendMessage.mockResolvedValue({ ok: true });
    const naturalRoute = "https://www.pixiv.net/dashboard/works?passive-test=natural";
    const first = payload("passive-fingerprint-1");

    expect(isNaturalWorksDashboardUrl("https://www.pixiv.net/dashboard/works")).toBe(true);
    expect(isNaturalWorksDashboardUrl("https://www.pixiv.net/dashboard/works?p=1&pixivPulseRun=fallback")).toBe(false);
    expect(await sendPassivePageSnapshot(naturalRoute, first)).toBe(true);
    expect(await sendPassivePageSnapshot(naturalRoute, first)).toBe(false);
    expect(runtimeMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtimeMock.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "PASSIVE_PAGE_SNAPSHOT",
      payload: { fingerprint: first.fingerprint },
    });
    expect(runtimeMock.sendMessage.mock.calls[0]?.[0].payload.runId).toMatch(/^pixiv-pulse-passive-/);

    expect(await sendPassivePageSnapshot(
      "https://www.pixiv.net/dashboard/works?p=1&pixivPulseRun=fallback",
      payload("fallback-fingerprint"),
    )).toBe(false);
    expect(runtimeMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retries a failed passive snapshot and accepts changed metrics on the same route", async () => {
    runtimeMock.sendMessage.mockReset();
    const route = "https://www.pixiv.net/dashboard/works?passive-test=retry";
    const first = { ...payload("same-shape"), works: [work("1", metrics({ views: 100 }))] };
    const changed = { ...first, works: [work("1", metrics({ views: 101 }))] };

    runtimeMock.sendMessage.mockRejectedValueOnce(new Error("worker restarted"));
    expect(await sendPassivePageSnapshot(route, first)).toBe(false);
    runtimeMock.sendMessage.mockResolvedValue({ ok: true });
    expect(await sendPassivePageSnapshot(route, first)).toBe(true);
    expect(await sendPassivePageSnapshot(route, changed)).toBe(true);
    expect(runtimeMock.sendMessage).toHaveBeenCalledTimes(3);
  });
});
