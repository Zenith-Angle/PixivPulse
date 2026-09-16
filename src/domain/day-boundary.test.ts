import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildDailySummary } from "./daily-summary";
import { buildWorkTimeline, buildPortfolioTimeline } from "./timeline";
import { buildIntradayAnalytics } from "./intraday";
import { resolveChartTimeRange } from "../ui/chartTimeRange";
import { buildCompareBuckets } from "../ui/compareBuckets";
import { buildFollowerAnalytics } from "../ui/followerAnalytics";
import type { WorkSample } from "./types";

const at = (day: number, time: string) => `2026-09-${day}T${time}:00+08:00`;
const sample = (day: number, time: string, views: number): WorkSample => ({
  workKey: "a", runId: `${day}-${time}`, collectedAt: at(day, time), kind: "change",
  metrics: { views, likes: 0, bookmarks: 0, comments: 0, rank: null, responses: null, illustrations: null },
  parserVersion: 1, dataQuality: 1,
});

describe("midnight accounting across the real display pipeline", () => {
  beforeEach(() => vi.setSystemTime(new Date(at(18, "12:00"))));
  afterEach(() => vi.useRealTimers());
  it.each(["00:00", "00:02"])("shares %s closing sample without losing or double-counting the last half-hour", (time) => {
    const samples = [sample(16, "00:00", 100), sample(16, "23:30", 150), sample(17, time, 160), sample(17, "00:30", 170)];
    const yesterday = resolveChartTimeRange({ preset: "custom", start: "2026-09-16", end: "2026-09-16" })!;
    const today = resolveChartTimeRange({ preset: "today", now: at(17, "00:30") })!;
    const delta = (range: typeof today) => {
      const points = buildWorkTimeline("a", samples, [], range).map(p => ({ at: p.at, value: p.metrics.views }));
      return buildCompareBuckets(points, range.startMs!, range.endMs!, 1).reduce((sum, b) => sum + (b.value ?? 0), 0);
    };
    expect(delta(yesterday)).toBe(60);
    expect(delta(today)).toBe(10);
    const summary = buildDailySummary("2026-09-16", ["a"], samples, []);
    expect(summary.delta.views).toBe(60);
    expect(summary.status).toBe(time === "00:00" ? "complete" : "estimated");
    expect(Date.parse(summary.toAt!)).toBe(Date.parse(at(17, time)));
  });

  it("does not turn yesterday's stale total into a new day's observation", () => {
    const samples = [sample(16, "23:30", 100), sample(17, "00:30", 130)];
    const range = resolveChartTimeRange({ preset: "today", now: at(17, "00:30") })!;
    expect(buildWorkTimeline("a", samples, [], range)).toHaveLength(1);
    const observations = samples.map(s => ({ workKey: "a", runId: s.runId, observedAt: s.collectedAt, metricsChanged: true }));
    expect(buildIntradayAnalytics({ samples, observations, now: at(17, "00:30") }).delta.views).toBeNull();
  });

  it("resets follower growth at the shared midnight sample", () => {
    const samples = [sample(16, "23:30", 100), sample(17, "00:00", 110), sample(17, "00:30", 120)];
    const result = buildFollowerAnalytics(samples.map(s => ({ accountId: "a", runId: s.runId, collectedAt: s.collectedAt, followers: s.metrics.views! })), {
      now: at(17, "00:30"), range: { preset: "today", now: at(17, "00:30") },
    });
    expect(result.todayDelta).toBe(10);
    expect(result.rangeDelta).toBe(10);
  });
  it("keeps an unchanged midnight observation as a real closing point", () => {
    const samples = [sample(16, "00:00", 100), sample(16, "23:30", 150)];
    const batches = [{ runId: "unchanged", observedAt: at(17, "00:02"), workKeys: ["a"], changedWorkKeys: [], scope: "complete" as const }];
    const summary = buildDailySummary("2026-09-16", ["a"], samples, [], batches);
    expect(summary).toMatchObject({ status: "estimated", closedWorks: 1, delta: { views: 50 } });
  });

  it("does not claim a full day if the midnight observation is missing or very late", () => {
    const samples = [sample(16, "00:00", 100), sample(16, "23:30", 150), sample(17, "00:30", 170)];
    expect(buildDailySummary("2026-09-16", ["a"], samples, [])).toMatchObject({ status: "partial", closedWorks: 0, delta: { views: 50 } });
  });

  it("keeps negative and observed-zero changes after the new baseline", () => {
    for (const views of [100, 95]) {
      const samples = [sample(17, "00:00", 100), sample(17, "00:30", views)];
      const observations = samples.map(s => ({ workKey: "a", runId: s.runId, observedAt: s.collectedAt, metricsChanged: true }));
      expect(buildIntradayAnalytics({ samples, observations, now: at(17, "00:30") }).delta.views).toBe(views - 100);
    }
  });

  it("does not count a newly discovered work's old counters as portfolio growth", () => {
    const samples = [sample(17, "00:00", 100), sample(17, "00:30", 110), { ...sample(17, "00:30", 900), workKey: "b" }];
    const range = resolveChartTimeRange({ preset: "today", now: at(17, "00:30") })!;
    const points = buildPortfolioTimeline(["a", "b"], samples, [], range);
    expect(points.at(-1)?.metrics.views).toBe(1010);
    expect(points.at(-1)?.growth?.views).toBe(10);
  });

  it("does not read future observations when the requested current time is midnight", () => {
    vi.setSystemTime(new Date(at(17, "00:00")));
    const samples = [sample(16, "23:30", 100), sample(17, "00:02", 110)];
    const range = resolveChartTimeRange({ preset: "today", now: at(17, "00:00") })!;
    expect(buildWorkTimeline("a", samples, [], range)).toEqual([]);
  });

  it("includes the closing midnight when the datetime picker ends at 23:59", () => {
    const range = resolveChartTimeRange({ preset: "custom", start: "2026-09-16T00:00", end: "2026-09-16T23:59" })!;
    expect(range.endMs).toBe(Date.parse(at(17, "00:00")));
    const samples = [sample(16, "00:00", 100), sample(16, "23:30", 150), sample(17, "00:02", 160)];
    expect(buildWorkTimeline("a", samples, [], range).at(-1)?.metrics.views).toBe(160);
  });

  it("does not treat staggered first observations of different works as zero growth", () => {
    const samples = [sample(17, "00:00", 100), { ...sample(17, "00:30", 900), workKey: "b" }];
    const range = resolveChartTimeRange({ preset: "today", now: at(17, "00:30") })!;
    const points = buildPortfolioTimeline(["a", "b"], samples, [], range);
    expect(points).toHaveLength(2);
    expect(points.every(point => point.incrementObserved === false)).toBe(true);
  });

});
