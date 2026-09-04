import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { PAGE_READY_TIMEOUT_MS, PAGE_STABLE_MS, PARSER_VERSION } from "../src/domain/constants";
import { parsePage } from "../src/domain/parser";
import { buildIntradayAnalytics, type IntradayAnalyticsInput, type IntradayWorkAnalysis } from "../src/domain/intraday";
import { classifyTransientPageFailure } from "../src/domain/page-failure";
import { beijingDayRange, parseInstant } from "../src/domain/time";
import { DATA_REVISION_STORAGE_KEY } from "../src/data/local-state";
import type { RuntimeMessage, RuntimeResponse } from "../src/domain/messages";
import type { DashboardData, PagePayload, WorkRecord, WorkMetrics } from "../src/domain/types";

export interface PageReadiness {
  ready: boolean;
  payload: PagePayload | null;
  failure: { code: "CHALLENGE" | "RATE_LIMITED" | "PAGE_TIMEOUT" | "SCHEMA_DRIFT"; message: string } | null;
}

const CHECK_INTERVAL_MS = 200;
const WORKS_PATH = /^\/dashboard\/works\/?$/;
const PASSIVE_RUN_MARKER = "pixivPulseRun";

const GROWTH_METRICS = [
  { key: "views", label: "浏览" },
  { key: "likes", label: "赞" },
  { key: "bookmarks", label: "收藏" },
  { key: "comments", label: "评论" },
] as const satisfies ReadonlyArray<{ key: keyof WorkMetrics; label: string }>;

let passiveRunSequence = 0;
const sentPassiveSnapshots = new Set<string>();

export function isWorksDashboardUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.pixiv.net" && WORKS_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function getRunId(value: string): string | null {
  try {
    const runId = new URL(value).searchParams.get("pixivPulseRun");
    return runId && /^[A-Za-z0-9._:-]{1,160}$/.test(runId) ? runId : null;
  } catch {
    return null;
  }
}

function hasRunMarker(value: string): boolean {
  try {
    return new URL(value).searchParams.has(PASSIVE_RUN_MARKER);
  } catch {
    return false;
  }
}

export function isNaturalWorksDashboardUrl(value: string): boolean {
  return isWorksDashboardUrl(value) && !hasRunMarker(value);
}

export function getPassiveRouteKey(value: string): string | null {
  if (!isNaturalWorksDashboardUrl(value)) return null;
  try {
    const url = new URL(value);
    const search = new URLSearchParams(url.search);
    search.sort();
    const query = search.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

export function makePassiveRunId(): string {
  passiveRunSequence += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return `pixiv-pulse-passive-${random ?? `${Date.now()}-${passiveRunSequence}-${Math.random().toString(36).slice(2)}`}`;
}

/** Send at most one natural-page snapshot for a route and stable page shape. */
export async function sendPassivePageSnapshot(route: string, payload: PagePayload): Promise<boolean> {
  const routeKey = getPassiveRouteKey(route);
  if (!routeKey) return false;
  const metricSignature = payload.works.map((work) => [
    work.type,
    work.id,
    work.metrics.views,
    work.metrics.likes,
    work.metrics.bookmarks,
    work.metrics.comments,
  ].join(":")).join(",");
  const dedupeKey = `${routeKey}|${payload.fingerprint}|${metricSignature}`;
  if (sentPassiveSnapshots.has(dedupeKey)) return false;
  sentPassiveSnapshots.add(dedupeKey);

  const message = {
    type: "PASSIVE_PAGE_SNAPSHOT",
    payload: { ...payload, runId: makePassiveRunId() },
  } satisfies RuntimeMessage;
  try {
    await browser.runtime.sendMessage(message);
    return true;
  } catch {
    sentPassiveSnapshots.delete(dedupeKey);
    return false;
  }
}

function hasLoadingPlaceholders(root: Document): boolean {
  return Boolean(root.querySelector([
    "[aria-busy='true']",
    "[data-testid*='skeleton' i]",
    "[data-test-id*='skeleton' i]",
    "[class*='skeleton' i]",
    "[class*='placeholder' i]",
    "[class*='loading' i]",
  ].join(",")));
}

function workSignature(payload: PagePayload): string {
  return `${payload.page}|${payload.pageCount}|${payload.hasNext}|${payload.works.map((work) => `${work.type}:${work.id}`).join(",")}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/** Wait for a quiet, stable page before allowing a snapshot into the background. */
export async function waitForPageReady(
  root: Document,
  runId: string,
  options: { stableMs?: number; timeoutMs?: number; checkIntervalMs?: number } = {},
): Promise<PageReadiness> {
  const stableMs = options.stableMs ?? PAGE_STABLE_MS;
  const timeoutMs = options.timeoutMs ?? PAGE_READY_TIMEOUT_MS;
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const startedAt = Date.now();
  let lastMutationAt = Date.now();
  let previousSignature = "";
  let stableChecks = 0;
  const observer = typeof MutationObserver === "undefined" || !root.documentElement
    ? null
    : new MutationObserver(() => { lastMutationAt = Date.now(); });
  observer?.observe(root.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const failure = classifyTransientPageFailure(root);
      if (failure) return { ready: false, payload: null, failure };
      const payload = parsePage(root, runId);
      const quiet = Date.now() - lastMutationAt >= stableMs;
      const noLoading = !hasLoadingPlaceholders(root);
      const signature = workSignature(payload);
      if (quiet && noLoading && signature === previousSignature) stableChecks += 1;
      else stableChecks = 0;
      previousSignature = signature;

      if (quiet && noLoading && stableChecks >= 2 && (payload.works.length > 0 || payload.positivelyEmpty)) {
        return { ready: true, payload, failure: null };
      }
      await sleep(checkIntervalMs);
    }
    const finalPayload = parsePage(root, runId);
    const failure = finalPayload.works.length === 0 && !finalPayload.positivelyEmpty
      ? { code: "SCHEMA_DRIFT" as const, message: "Dashboard content was stable but no supported work cards were found" }
      : { code: "PAGE_TIMEOUT" as const, message: "Dashboard did not become stable before the readiness deadline" };
    return { ready: false, payload: null, failure };
  } finally {
    observer?.disconnect();
  }
}

function workKey(work: WorkRecord): string {
  return `${work.type}-${work.id}`;
}

const CHIP_CSS = `
:host {
  box-sizing: border-box;
  display: inline-flex;
  align-items: stretch;
  max-width: calc(100% - 6px);
  min-width: 176px;
  margin: 3px 0 3px 6px;
  vertical-align: middle;
  overflow: hidden;
  color: #236b43;
  background: #f3fbf5;
  border: 1px solid #b7ddc5;
  border-radius: 4px;
  font: 600 11px/1.25 system-ui, sans-serif;
  white-space: nowrap;
}

.strip {
  display: flex;
  align-items: stretch;
  width: 100%;
  min-width: 0;
}

.metric {
  box-sizing: border-box;
  display: grid;
  flex: 1 1 0;
  min-width: 44px;
  gap: 1px;
  padding: 3px 6px;
  overflow: hidden;
  text-align: center;
}

.metric + .metric {
  border-inline-start: 1px solid #c9e5d1;
}

.metric-label,
.metric-value {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metric-label {
  color: #5d8a6c;
  font-size: 10px;
  font-weight: 600;
}

.metric-value {
  color: #236b43;
  font-variant-numeric: tabular-nums;
}

.metric[data-negative="true"] {
  background: #fff8f7;
}

.metric[data-negative="true"] .metric-value {
  color: #b42318;
}
`;

export function formatGrowthDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function growthAriaLabel(analysis: IntradayWorkAnalysis | null): string {
  return GROWTH_METRICS
    .map(({ key, label }) => `${label} ${formatGrowthDelta(analysis?.delta[key])}`)
    .join("，");
}

export function todayGrowthFor(work: WorkRecord, dashboard: DashboardData, now: number = Date.now()): IntradayWorkAnalysis | null {
  return buildGrowthRenderContext(dashboard, now).analysisByWork.get(work.key) ?? null;
}

export interface GrowthRenderContext {
  dashboard: DashboardData;
  worksByKey: ReadonlyMap<string, WorkRecord>;
  analysisByWork: ReadonlyMap<string, IntradayWorkAnalysis>;
}

export function selectGrowthAnalyticsInput(
  dashboard: DashboardData,
  now: number = Date.now(),
): IntradayAnalyticsInput {
  const day = beijingDayRange(now);
  const intervalHours = dashboard.settings.syncIntervalHours;
  if (!day) {
    return {
      works: dashboard.works,
      samples: [],
      observations: [],
      observationBatches: [],
      configuredIntervalHours: intervalHours,
      now,
    };
  }
  const baselineWindowMs = Math.max(2 * 60 * 60_000, Math.max(0, intervalHours) * 2 * 60 * 60_000);
  const scanStart = day.startMs - baselineWindowMs;
  const latestOlderSample = new Map<string, { timestamp: number; sample: DashboardData["samples"][number] }>();
  const samples: DashboardData["samples"] = [];
  for (const sample of dashboard.samples) {
    const timestamp = parseInstant(sample.collectedAt);
    if (timestamp == null || timestamp > now) continue;
    if (timestamp >= scanStart) {
      samples.push(sample);
      continue;
    }
    const current = latestOlderSample.get(sample.workKey);
    if (!current || timestamp > current.timestamp) latestOlderSample.set(sample.workKey, { timestamp, sample });
  }
  for (const { sample } of latestOlderSample.values()) samples.push(sample);
  const inScanWindow = (value: string): boolean => {
    const timestamp = parseInstant(value);
    return timestamp != null && timestamp >= scanStart && timestamp <= now;
  };
  return {
    works: dashboard.works,
    samples,
    observations: dashboard.observations.filter((observation) => inScanWindow(observation.observedAt)),
    observationBatches: (dashboard.observationBatches ?? []).filter((batch) => inScanWindow(batch.observedAt)),
    configuredIntervalHours: intervalHours,
    now,
  };
}

export function buildGrowthRenderContext(dashboard: DashboardData, now: number = Date.now()): GrowthRenderContext {
  const intraday = buildIntradayAnalytics(selectGrowthAnalyticsInput(dashboard, now));
  return {
    dashboard,
    worksByKey: new Map(dashboard.works.map((work) => [workKey(work), work])),
    analysisByWork: new Map(intraday.works.map((analysis) => [analysis.workKey, analysis])),
  };
}

function renderSignature(analysis: IntradayWorkAnalysis | null): string {
  return GROWTH_METRICS.map(({ key }) => {
    const value = analysis?.delta[key];
    return value == null || !Number.isFinite(value) ? "?" : String(Math.round(value));
  }).join("|");
}

function renderGrowthStrip(root: Document, host: HTMLElement, work: WorkRecord, analysis: IntradayWorkAnalysis | null): void {
  const signature = renderSignature(analysis);
  if (host.dataset.pixivKey === workKey(work) && host.dataset.renderSignature === signature && host.shadowRoot) return;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const style = root.createElement("style");
  style.textContent = CHIP_CSS;
  const strip = root.createElement("span");
  strip.className = "strip";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", `PixivPulse ${growthAriaLabel(analysis)}`);

  for (const { key, label } of GROWTH_METRICS) {
    const delta = analysis?.delta[key] ?? null;
    const value = formatGrowthDelta(delta);
    const cell = root.createElement("span");
    cell.className = "metric";
    cell.dataset.metric = key;
    if (delta != null && delta < 0) cell.dataset.negative = "true";

    const labelNode = root.createElement("span");
    labelNode.className = "metric-label";
    labelNode.textContent = label;
    const valueNode = root.createElement("strong");
    valueNode.className = "metric-value";
    valueNode.textContent = value;
    cell.append(labelNode, valueNode);
    strip.append(cell);
  }

  host.removeAttribute("data-negative");
  host.dataset.renderSignature = signature;
  host.setAttribute("aria-label", `PixivPulse ${strip.getAttribute("aria-label")?.replace(/^PixivPulse /, "") ?? ""}`);
  shadow.replaceChildren(style, strip);
}

function managedHosts(root: Document): HTMLElement[] {
  return Array.from(root.querySelectorAll("pixiv-pulse-growth[data-pixiv-key]")) as HTMLElement[];
}

function removeGrowthChips(root: Document): void {
  for (const host of managedHosts(root)) host.remove();
}

export function injectGrowthChips(root: Document, dashboard: DashboardData, now: number = Date.now()): number {
  return injectGrowthContext(root, buildGrowthRenderContext(dashboard, now));
}

interface GrowthTarget {
  card: Element;
  key: string;
  work: WorkRecord;
}

function entityWorkKey(value: string | null): string | null {
  const match = value?.match(/^(illust|novel)\/(\d+)$/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function cardWorkKey(card: Element): string | null {
  const own = entityWorkKey(card.getAttribute("data-ga4-entity-id"));
  if (own) return own;
  return entityWorkKey(card.querySelector("[data-ga4-entity-id]")?.getAttribute("data-ga4-entity-id") ?? null);
}

function collectGrowthTargets(root: Document, context: GrowthRenderContext): {
  targets: GrowthTarget[];
  hostsByKey: Map<string, HTMLElement>;
} {
  const targets: GrowthTarget[] = [];
  const seenCards = new Set<Element>();
  for (const entity of root.querySelectorAll("[data-ga4-entity-id]")) {
    const key = entityWorkKey(entity.getAttribute("data-ga4-entity-id"));
    const work = key ? context.worksByKey.get(key) : undefined;
    const card = entity.closest("article, li, [role='article']") ?? entity;
    if (!key || !work || seenCards.has(card)) continue;
    seenCards.add(card);
    targets.push({ card, key, work });
  }

  const hostsByKey = new Map<string, HTMLElement>();
  for (const host of managedHosts(root)) {
    const key = host.dataset.pixivKey ?? "";
    const parentCard = host.parentElement?.closest("article, li, [role='article']") ?? host.parentElement;
    const currentCardKey = parentCard ? cardWorkKey(parentCard) : null;
    if (!context.worksByKey.has(key) || currentCardKey !== key || hostsByKey.has(key)) {
      host.remove();
      continue;
    }
    hostsByKey.set(key, host);
  }
  return { targets, hostsByKey };
}

function renderGrowthTarget(
  root: Document,
  context: GrowthRenderContext,
  target: GrowthTarget,
  hostsByKey: Map<string, HTMLElement>,
): boolean {
  let host = hostsByKey.get(target.key);
  const created = !host;
  if (!host) {
    host = root.createElement("pixiv-pulse-growth");
    hostsByKey.set(target.key, host);
  }
  host.className = "pixiv-pulse-growth-chip";
  host.dataset.pixivKey = target.key;
  renderGrowthStrip(root, host, target.work, context.analysisByWork.get(target.key) ?? null);
  if (host.parentElement !== target.card) target.card.append(host);
  return created;
}

export function injectGrowthContext(root: Document, context: GrowthRenderContext): number {
  const dashboard = context.dashboard;
  if (!dashboard.settings.showPixivChips || dashboard.works.length === 0) {
    removeGrowthChips(root);
    return 0;
  }
  const { targets, hostsByKey } = collectGrowthTargets(root, context);
  let injected = 0;
  for (const target of targets) if (renderGrowthTarget(root, context, target, hostsByKey)) injected += 1;
  return injected;
}

export interface ProgressiveGrowthOptions {
  firstBatchSize?: number;
  batchSize?: number;
  isCurrent?: () => boolean;
  yieldToBrowser?: () => Promise<void>;
}

function defaultYieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else window.setTimeout(resolve, 0);
  });
}

export async function injectGrowthContextProgressively(
  root: Document,
  context: GrowthRenderContext,
  options: ProgressiveGrowthOptions = {},
): Promise<number> {
  if (!context.dashboard.settings.showPixivChips || context.dashboard.works.length === 0) {
    removeGrowthChips(root);
    return 0;
  }
  const firstBatchSize = Math.max(1, Math.round(options.firstBatchSize ?? 6));
  const batchSize = Math.max(1, Math.round(options.batchSize ?? 8));
  const isCurrent = options.isCurrent ?? (() => true);
  const yieldToBrowser = options.yieldToBrowser ?? defaultYieldToBrowser;
  const { targets, hostsByKey } = collectGrowthTargets(root, context);
  let injected = 0;
  let index = 0;
  const renderBatch = (limit: number): void => {
    const end = Math.min(targets.length, index + limit);
    while (index < end && isCurrent()) {
      const target = targets[index];
      index += 1;
      if (target && renderGrowthTarget(root, context, target, hostsByKey)) injected += 1;
    }
  };

  if (!isCurrent()) return 0;
  renderBatch(firstBatchSize);
  while (index < targets.length && isCurrent()) {
    await yieldToBrowser();
    if (!isCurrent()) break;
    renderBatch(batchSize);
  }
  return injected;
}

function mutationTouchesWorkCards(mutation: MutationRecord): boolean {
  if (mutation.type === "attributes") return mutation.attributeName === "data-ga4-entity-id";
  const changed = [...mutation.addedNodes, ...mutation.removedNodes];
  return changed.some((node) => {
    if (!(node instanceof Element) || node.matches("pixiv-pulse-growth")) return false;
    return node.matches("[data-ga4-entity-id]") || Boolean(node.querySelector("[data-ga4-entity-id]"));
  });
}

export function observeGrowthCardChanges(root: Document, onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || !root.documentElement) return () => undefined;
  const observer = new MutationObserver((mutations) => {
    if (mutations.some(mutationTouchesWorkCards)) onChange();
  });
  observer.observe(root.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-ga4-entity-id"],
  });
  return () => observer.disconnect();
}

export function createLatestRequestGuard(): {
  begin: () => number;
  isLatest: (request: number) => boolean;
  cancel: () => void;
} {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isLatest: (request) => request === latest,
    cancel: () => { latest += 1; },
  };
}

async function readDashboardData(): Promise<DashboardData | null> {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_DASHBOARD_DATA" } satisfies RuntimeMessage) as RuntimeResponse;
    return response.ok ? response.data ?? null : null;
  } catch {
    return null;
  }
}

async function sendFailure(runId: string, failure: NonNullable<PageReadiness["failure"]>): Promise<void> {
  const message: RuntimeMessage = { type: "PAGE_FAILED", runId, code: failure.code, message: failure.message };
  try {
    await browser.runtime.sendMessage(message);
  } catch {
    // The background may have gone away during extension reload; the watchdog
    // will handle the persisted run in that case.
  }
}

async function run(generation = 0, currentGeneration = (): number => generation): Promise<void> {
  const route = location.href;
  if (!isWorksDashboardUrl(route)) {
    removeGrowthChips(document);
    return;
  }
  const runId = getRunId(route);
  const readiness = await waitForPageReady(document, runId ?? "");
  if (currentGeneration() !== generation || location.href !== route) return;
  if (runId) {
    if (!readiness.ready || !readiness.payload || readiness.payload.parserVersion !== PARSER_VERSION) {
      await sendFailure(runId, readiness.failure ?? { code: "SCHEMA_DRIFT", message: "Page parser contract mismatch" });
      return;
    }
    try {
      await browser.runtime.sendMessage({ type: "PAGE_READY", payload: readiness.payload } satisfies RuntimeMessage);
    } catch {
      return;
    }
  } else if (isNaturalWorksDashboardUrl(route) && readiness.ready && readiness.payload) {
    await sendPassivePageSnapshot(route, readiness.payload);
  }
}

export default defineContentScript({
  matches: ["https://www.pixiv.net/dashboard/works*"],
  runAt: "document_idle",
  main(ctx) {
    let generation = 0;
    let renderGeneration = 0;
    let cachedContext: GrowthRenderContext | null = null;
    let stopObserving = (): void => undefined;
    const requestGuard = createLatestRequestGuard();

    const renderCachedContext = (): void => {
      if (!cachedContext || !isWorksDashboardUrl(location.href)) return;
      renderGeneration += 1;
      const currentRender = renderGeneration;
      void injectGrowthContextProgressively(document, cachedContext, {
        isCurrent: () => currentRender === renderGeneration && isWorksDashboardUrl(location.href),
      });
    };

    const refreshGrowthChips = async (): Promise<void> => {
      const route = location.href;
      if (!isWorksDashboardUrl(route)) {
        requestGuard.cancel();
        renderGeneration += 1;
        removeGrowthChips(document);
        return;
      }
      const request = requestGuard.begin();
      const dashboard = await readDashboardData();
      if (!requestGuard.isLatest(request) || location.href !== route) return;
      if (dashboard) {
        cachedContext = buildGrowthRenderContext(dashboard);
        renderCachedContext();
      } else if (!cachedContext) {
        removeGrowthChips(document);
      }
    };

    const start = (): void => {
      generation += 1;
      const current = generation;
      requestGuard.cancel();
      renderGeneration += 1;
      stopObserving();
      stopObserving = () => undefined;
      if (!isWorksDashboardUrl(location.href)) {
        removeGrowthChips(document);
        return;
      }
      stopObserving = observeGrowthCardChanges(document, renderCachedContext);
      // SPA route changes can reuse the last immutable snapshot immediately;
      // the guarded refresh below replaces it only when its newer read wins.
      renderCachedContext();
      void refreshGrowthChips();
      void run(current, () => generation);
    };
    start();
    ctx.addEventListener(window, "wxt:locationchange", start);
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || (!changes["pixivPulse.settings"] && !changes["pixivPulse.syncState"] && !changes[DATA_REVISION_STORAGE_KEY])) return;
      void refreshGrowthChips();
    });
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "SET_SHOW_CHIPS") return;
      void refreshGrowthChips();
    });
  },
});
