import { beijingDayRange, parseInstant, type TimeInput } from "../domain/time";
import type { AccountFollowerSample } from "../domain/types";
import {
  resolveChartTimeRange,
  type ChartTimeRange,
  type ChartTimeRangeInput,
} from "./chartTimeRange";

export type { AccountFollowerSample } from "../domain/types";

export interface FollowerSamplePoint extends AccountFollowerSample {
  timestamp: number;
}

export type FollowerConfidence = "exact" | "approximate" | "insufficient";
export type FollowerRecordIntegrity = "complete" | "approximate" | "baseline" | "insufficient";

export interface FollowerDelta {
  value: number | null;
  fromAt: string | null;
  toAt: string | null;
  baseline: AccountFollowerSample | null;
  current: AccountFollowerSample | null;
  confidence: FollowerConfidence;
}

export interface FollowerAnalyticsOptions {
  /** Omit to analyze all account IDs in the supplied collection. */
  accountId?: string | null;
  /** Omit to use the complete normalized history for the range calculation. */
  range?: ChartTimeRangeInput | null;
  /** Injected clock value for deterministic Beijing-day calculations. */
  now?: TimeInput | null;
}

export interface FollowerAnalytics {
  accountId: string | null;
  samples: AccountFollowerSample[];
  normalizedSamples: FollowerSamplePoint[];
  current: number | null;
  currentSample: AccountFollowerSample | null;
  lastCollectedAt: string | null;
  range: ChartTimeRange | null;
  rangeSamples: AccountFollowerSample[];
  /** Points shown in the chart. A short history falls back to all valid data. */
  chartSamples: AccountFollowerSample[];
  rangeBaseline: AccountFollowerSample | null;
  rangeDelta: number | null;
  rangeConfidence: FollowerConfidence;
  recordIntegrity: FollowerRecordIntegrity;
  today: FollowerDelta;
  todayDelta: number | null;
  todayConfidence: FollowerConfidence;
}

interface IndexedSample {
  sample: AccountFollowerSample;
  timestamp: number;
  inputIndex: number;
}

const allHistoryRange: ChartTimeRange = { preset: "all", startMs: null, endMs: null };

const isResolvedRange = (value: ChartTimeRangeInput): value is ChartTimeRange =>
  typeof value === "object"
  && value !== null
  && "startMs" in value
  && "endMs" in value;

const resolveRange = (value: ChartTimeRangeInput | null | undefined): ChartTimeRange | null => {
  if (value === undefined) return allHistoryRange;
  if (value === null) return null;
  return isResolvedRange(value) ? value : resolveChartTimeRange(value);
};

const validFollowerCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const sameSample = (left: AccountFollowerSample | null, right: AccountFollowerSample | null): boolean =>
  left !== null
  && right !== null
  && left.runId === right.runId
  && left.collectedAt === right.collectedAt
  && left.accountId === right.accountId;

/**
 * Normalize account observations for analytical use. Invalid timestamps and
 * follower values are dropped, then one observation is retained per run ID.
 * The latest real timestamp wins when a run was imported more than once.
 */
export function normalizeFollowerSamples(
  samples: readonly AccountFollowerSample[] | null | undefined,
  accountId?: string | null,
): FollowerSamplePoint[] {
  const indexed: IndexedSample[] = [];
  for (const [inputIndex, sample] of (samples ?? []).entries()) {
    if (accountId != null && sample.accountId !== accountId) continue;
    if (typeof sample.runId !== "string" || !sample.runId.trim()) continue;
    if (typeof sample.accountId !== "string" || !sample.accountId.trim()) continue;
    if (typeof sample.collectedAt !== "string" || !sample.collectedAt.trim()) continue;
    if (!validFollowerCount(sample.followers)) continue;
    const timestamp = parseInstant(sample.collectedAt);
    if (timestamp == null) continue;
    indexed.push({ sample, timestamp, inputIndex });
  }

  indexed.sort((left, right) => left.timestamp - right.timestamp || left.inputIndex - right.inputIndex);
  const latestByRun = new Map<string, IndexedSample>();
  for (const item of indexed) {
    const previous = latestByRun.get(item.sample.runId);
    if (!previous || item.timestamp >= previous.timestamp) latestByRun.set(item.sample.runId, item);
  }

  return [...latestByRun.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.inputIndex - right.inputIndex)
    .map(({ sample, timestamp }) => ({ ...sample, timestamp }));
}

const sampleValue = (sample: FollowerSamplePoint | AccountFollowerSample | null): number | null =>
  sample && validFollowerCount(sample.followers) ? sample.followers : null;

const emptyDelta = (): FollowerDelta => ({
  value: null,
  fromAt: null,
  toAt: null,
  baseline: null,
  current: null,
  confidence: "insufficient",
});

const makeDelta = (
  baseline: AccountFollowerSample | null,
  current: AccountFollowerSample | null,
  confidence: FollowerConfidence,
): FollowerDelta => {
  const baselineValue = sampleValue(baseline);
  const currentValue = sampleValue(current);
  return {
    value: baselineValue === null || currentValue === null ? null : currentValue - baselineValue,
    fromAt: baseline?.collectedAt ?? null,
    toAt: current?.collectedAt ?? null,
    baseline,
    current,
    confidence,
  };
};

const recordIntegrityFor = (delta: FollowerDelta, rangeSamples: readonly AccountFollowerSample[]): FollowerRecordIntegrity => {
  if (delta.confidence === "exact") return "complete";
  if (delta.confidence === "approximate") return "approximate";
  return rangeSamples.length === 1 ? "baseline" : "insufficient";
};

/**
 * Build account-level follower analytics. Range baselines are taken from the
 * last point strictly before the selected start; an in-range first-to-last
 * delta is explicitly approximate when no prior point exists.
 */
export function buildFollowerAnalytics(
  samples: readonly AccountFollowerSample[] | null | undefined,
  options: FollowerAnalyticsOptions = {},
): FollowerAnalytics {
  const normalizedSamples = normalizeFollowerSamples(samples, options.accountId);
  const normalizedRaw = normalizedSamples.map((sample) => ({ ...sample }));
  const normalizedAccounts = normalizedRaw.map(({ timestamp: _timestamp, ...sample }) => sample);
  const currentPoint = normalizedSamples.at(-1) ?? null;
  const current = sampleValue(currentPoint);
  const range = resolveRange(options.range);
  const rangePoints = range == null
    ? []
    : normalizedSamples.filter((point) =>
      (range.startMs == null || point.timestamp >= range.startMs)
      && (range.endMs == null || point.timestamp <= range.endMs),
    );
  const rangeSamples = rangePoints.map(({ timestamp: _timestamp, ...sample }) => sample);

  const rangeStartMs = range?.startMs ?? null;
  const rangeBaselinePoint = rangeStartMs == null
    ? null
    : normalizedSamples.filter((point) => point.timestamp < rangeStartMs).at(-1) ?? null;
  const rangeBaseline = rangeBaselinePoint
    ? (({ timestamp: _timestamp, ...sample }) => sample)(rangeBaselinePoint)
    : null;
  const rangeCurrent = rangeSamples.at(-1) ?? null;

  let rangeDelta = emptyDelta();
  if (rangeCurrent) {
    if (rangeBaseline) {
      rangeDelta = makeDelta(rangeBaseline, rangeCurrent, "exact");
    } else if (rangeSamples.length >= 2) {
      rangeDelta = makeDelta(rangeSamples[0] ?? null, rangeCurrent, "approximate");
    } else {
      // One point establishes a baseline but is not evidence of +0 growth.
      rangeDelta = { ...makeDelta(rangeSamples[0] ?? null, rangeCurrent, "insufficient"), value: null };
    }
  }

  const displaySamples = range === null
    ? []
    : rangeSamples.length > 0 || range.preset === "custom"
      ? rangeSamples
      : normalizedAccounts;
  const chartSamples = rangeBaseline && rangeSamples.length > 0 && !sameSample(rangeBaseline, rangeSamples[0] ?? null)
    ? [rangeBaseline, ...displaySamples]
    : displaySamples;

  const nowMs = parseInstant(options.now === undefined ? Date.now() : options.now);
  const day = nowMs == null ? null : beijingDayRange(nowMs);
  const todayPoints = day && nowMs != null
    ? normalizedSamples.filter((point) => point.timestamp >= day.startMs && point.timestamp <= nowMs)
    : [];
  const todayCurrentPoint = todayPoints.at(-1) ?? null;
  const todayCurrent = todayCurrentPoint
    ? (({ timestamp: _timestamp, ...sample }) => sample)(todayCurrentPoint)
    : null;
  const todayFirstPoint = todayPoints[0] ?? null;
  const todayFirst = todayFirstPoint
    ? (({ timestamp: _timestamp, ...sample }) => sample)(todayFirstPoint)
    : null;
  const todayBaselinePoint = day
    ? normalizedSamples.filter((point) => point.timestamp < day.startMs).at(-1) ?? null
    : null;
  const todayBaseline = todayBaselinePoint
    ? (({ timestamp: _timestamp, ...sample }) => sample)(todayBaselinePoint)
    : null;
  const today = todayBaseline && todayCurrent
    ? makeDelta(todayBaseline, todayCurrent, "exact")
    : todayPoints.length >= 2 && todayFirst && todayCurrent
      ? makeDelta(todayFirst, todayCurrent, "approximate")
      : makeDelta(todayBaseline, todayCurrent, "insufficient");

  return {
    accountId: options.accountId ?? null,
    samples: normalizedAccounts,
    normalizedSamples,
    current,
    currentSample: currentPoint ? (({ timestamp: _timestamp, ...sample }) => sample)(currentPoint) : null,
    lastCollectedAt: currentPoint?.collectedAt ?? null,
    range,
    rangeSamples,
    chartSamples,
    rangeBaseline,
    rangeDelta: rangeDelta.value,
    rangeConfidence: rangeDelta.confidence,
    recordIntegrity: recordIntegrityFor(rangeDelta, rangeSamples),
    today,
    todayDelta: today.value,
    todayConfidence: today.confidence,
  };
}

export const buildAccountFollowerAnalytics = buildFollowerAnalytics;
export const analyzeFollowerSamples = buildFollowerAnalytics;
export const normalizeAccountFollowerSamples = normalizeFollowerSamples;
