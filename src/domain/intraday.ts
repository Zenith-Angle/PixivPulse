import type { ObservationBatch, WorkMetrics, WorkObservation, WorkRecord, WorkSample } from "./types";
import { beijingDayRange, parseInstant } from "./time";

export type IntradayBaselineLabel = "estimated" | "partial";

export interface IntradayPoint {
  observedAt: string;
  runId: string;
  metricsChanged: boolean;
  metrics: WorkMetrics;
}

export interface IntradayWorkAnalysis {
  workKey: string;
  date: string;
  baselineAt: string | null;
  baselineLabel: IntradayBaselineLabel;
  sampleCount: number;
  changeSampleCount: number;
  points: IntradayPoint[];
  delta: WorkMetrics;
}

export interface IntradayPortfolioAnalysis {
  date: string;
  baselineLabel: IntradayBaselineLabel;
  sampleCount: number;
  points: IntradayPortfolioPoint[];
  works: IntradayWorkAnalysis[];
  delta: WorkMetrics;
}

export interface IntradayPortfolioPoint {
  observedAt: string;
  runId: string;
  metrics: WorkMetrics;
}

export interface IntradayAnalyticsInput {
  works?: readonly Pick<WorkRecord, "key">[];
  samples: readonly WorkSample[];
  observations: readonly WorkObservation[];
  observationBatches?: readonly ObservationBatch[];
  now?: Date | string | number;
  configuredIntervalHours?: number;
  syncIntervalHours?: number;
}

export interface IntradayAnalyticsOptions {
  now?: Date | string | number;
  configuredIntervalHours?: number;
  syncIntervalHours?: number;
}

const METRIC_KEYS = Object.keys({
  likes: true,
  bookmarks: true,
  views: true,
  comments: true,
  rank: true,
  responses: true,
  illustrations: true,
}) as Array<keyof WorkMetrics>;

const ADDITIVE_METRIC_KEYS = [
  "likes",
  "bookmarks",
  "views",
  "comments",
  "responses",
  "illustrations",
] as const satisfies readonly (keyof WorkMetrics)[];

function emptyMetrics(): WorkMetrics {
  return {
    likes: null,
    bookmarks: null,
    views: null,
    comments: null,
    rank: null,
    responses: null,
    illustrations: null,
  };
}

function parseTime(value: string): number | null {
  return parseInstant(value);
}

function cloneMetrics(metrics: WorkMetrics): WorkMetrics {
  return { ...metrics };
}

function subtractMetrics(current: WorkMetrics, baseline: WorkMetrics): WorkMetrics {
  const result = emptyMetrics();
  for (const key of METRIC_KEYS) {
    const currentValue = current[key];
    const baselineValue = baseline[key];
    result[key] = currentValue == null || baselineValue == null ? null : currentValue - baselineValue;
  }
  return result;
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return left + right;
}

function aggregateDelta(works: readonly IntradayWorkAnalysis[]): WorkMetrics {
  const result = emptyMetrics();
  for (const work of works) {
    for (const key of ADDITIVE_METRIC_KEYS) result[key] = addNullable(result[key], work.delta[key]);
  }
  return result;
}

interface TimedRecord {
  timestamp: number;
  id?: number;
  sourceIndex: number;
}

interface IndexedSample extends TimedRecord {
  sample: WorkSample;
}

interface IndexedObservation extends TimedRecord {
  observation: WorkObservation;
}

interface IndexedPoint {
  timestamp: number;
  point: IntradayPoint;
}

function compareTimedRecords(left: TimedRecord, right: TimedRecord): number {
  const timestampDifference = left.timestamp - right.timestamp;
  if (timestampDifference !== 0) return timestampDifference;

  const idDifference = (left.id ?? 0) - (right.id ?? 0);
  if (!Number.isNaN(idDifference) && idDifference !== 0) return idDifference;
  return left.sourceIndex - right.sourceIndex;
}

function indexSamples(samples: readonly WorkSample[]): Map<string, IndexedSample[]> {
  const byWork = new Map<string, IndexedSample[]>();
  samples.forEach((sample, sourceIndex) => {
    const timestamp = parseTime(sample.collectedAt);
    if (timestamp == null) return;
    const list = byWork.get(sample.workKey) ?? [];
    list.push({ sample, timestamp, sourceIndex, ...(sample.id === undefined ? {} : { id: sample.id }) });
    byWork.set(sample.workKey, list);
  });
  for (const list of byWork.values()) list.sort(compareTimedRecords);
  return byWork;
}

function indexObservations(
  observations: readonly WorkObservation[],
  midnight: number,
  dayEnd: number,
  observationCeiling: number,
): Map<string, IndexedObservation[]> {
  const byWork = new Map<string, IndexedObservation[]>();
  observations.forEach((observation, sourceIndex) => {
    const timestamp = parseTime(observation.observedAt);
    if (timestamp == null || timestamp < midnight || timestamp >= dayEnd || timestamp > observationCeiling) return;
    const list = byWork.get(observation.workKey) ?? [];
    list.push({ observation, timestamp, sourceIndex, ...(observation.id === undefined ? {} : { id: observation.id }) });
    byWork.set(observation.workKey, list);
  });
  for (const list of byWork.values()) list.sort(compareTimedRecords);
  return byWork;
}

function latestAtOrBefore<T extends { timestamp: number }>(entries: readonly T[], at: number): T | null {
  let low = 0;
  let high = entries.length - 1;
  let latestIndex = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle];
    if (!entry) break;
    if (entry.timestamp <= at) {
      latestIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return latestIndex < 0 ? null : entries[latestIndex] ?? null;
}

function aggregatePortfolioPoints(
  works: readonly IntradayWorkAnalysis[],
  samplesByWork: ReadonlyMap<string, readonly IndexedSample[]>,
  pointsByWork: ReadonlyMap<string, readonly IndexedPoint[]>,
  workKeys: readonly string[],
): IntradayPortfolioPoint[] {
  const byRun = new Map<string, { observedAt: string; timestamp: number; sourceIndex: number }>();
  let nextRunIndex = 0;
  for (const work of works) {
    for (const timedPoint of pointsByWork.get(work.workKey) ?? []) {
      const { point, timestamp } = timedPoint;
      const current = byRun.get(point.runId);
      if (!current) {
        byRun.set(point.runId, { observedAt: point.observedAt, timestamp, sourceIndex: nextRunIndex });
        nextRunIndex += 1;
      } else if (timestamp > current.timestamp) {
        byRun.set(point.runId, { observedAt: point.observedAt, timestamp, sourceIndex: current.sourceIndex });
      }
    }
  }

  const orderedRuns = [...byRun.entries()].sort((left, right) => left[1].timestamp - right[1].timestamp
    || left[1].sourceIndex - right[1].sourceIndex);
  const pointCursors = new Map<string, number>();
  const sampleCursors = new Map<string, number>();
  return orderedRuns.map(([runId, run]) => {
    const metrics = emptyMetrics();
    for (const workKey of workKeys) {
      const points = pointsByWork.get(workKey) ?? [];
      let pointCursor = pointCursors.get(workKey) ?? -1;
      while (pointCursor + 1 < points.length && points[pointCursor + 1]!.timestamp <= run.timestamp) pointCursor += 1;
      pointCursors.set(workKey, pointCursor);

      const samples = samplesByWork.get(workKey) ?? [];
      let sampleCursor = sampleCursors.get(workKey) ?? -1;
      while (sampleCursor + 1 < samples.length && samples[sampleCursor + 1]!.timestamp <= run.timestamp) sampleCursor += 1;
      sampleCursors.set(workKey, sampleCursor);

      const point = pointCursor < 0 ? null : points[pointCursor]?.point ?? null;
      const fallback = point ? null : sampleCursor < 0 ? null : samples[sampleCursor]?.sample ?? null;
      const currentMetrics = point?.metrics ?? fallback?.metrics;
      if (!currentMetrics) continue;
      for (const key of ADDITIVE_METRIC_KEYS) metrics[key] = addNullable(metrics[key], currentMetrics[key]);
    }
    return { observedAt: run.observedAt, runId, metrics };
  });
}

function inputWorkKeys(input: IntradayAnalyticsInput): string[] {
  const keys = new Set<string>();
  for (const work of input.works ?? []) if (work.key) keys.add(work.key);
  for (const observation of input.observations) if (observation.workKey) keys.add(observation.workKey);
  for (const batch of input.observationBatches ?? []) for (const workKey of batch.workKeys) if (workKey) keys.add(workKey);
  return [...keys];
}

function normalizedObservations(input: IntradayAnalyticsInput): WorkObservation[] {
  const observations = input.observations.slice();
  const seen = new Set(observations.map((observation) => `${observation.runId}\u0000${observation.workKey}`));
  for (const batch of input.observationBatches ?? []) {
    const changed = new Set(batch.changedWorkKeys);
    for (const workKey of batch.workKeys) {
      const key = `${batch.runId}\u0000${workKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push({ workKey, runId: batch.runId, observedAt: batch.observedAt, metricsChanged: changed.has(workKey) });
    }
  }
  return observations;
}

/**
 * Reconstruct today's observations by forward-filling change-point samples.
 * Displayed daily changes always use the first Beijing-day observation as the
 * baseline. How close that first observation is to Beijing midnight only
 * affects the completeness label, never the displayed first-to-latest delta.
 */
export function buildIntradayAnalytics(input: IntradayAnalyticsInput): IntradayPortfolioAnalysis {
  const now = input.now == null ? Date.now() : parseInstant(input.now);
  const day = now == null ? null : beijingDayRange(now);
  if (now == null || day == null) {
    return { date: "", baselineLabel: "partial", sampleCount: 0, points: [], works: [], delta: emptyMetrics() };
  }
  const date = day.date;
  const midnight = day.startMs;
  const observationCeiling = Math.min(now, day.endMs - 1);
  const intervalHours = input.configuredIntervalHours ?? input.syncIntervalHours ?? 1;
  const baselineWindowMs = Math.max(2 * 60 * 60_000, Math.max(0, intervalHours) * 2 * 60 * 60_000);
  const workKeys = inputWorkKeys(input);
  const normalized = normalizedObservations(input);
  const samplesByWork = indexSamples(input.samples);
  const observationsByWork = indexObservations(normalized, midnight, day.endMs, observationCeiling);

  const works: IntradayWorkAnalysis[] = [];
  const pointsByWork = new Map<string, IndexedPoint[]>();
  for (const workKey of workKeys) {
    const observations = observationsByWork.get(workKey) ?? [];
    if (observations.length === 0) continue;
    const samples = samplesByWork.get(workKey) ?? [];
    const points: IntradayPoint[] = [];
    const indexedPoints: IndexedPoint[] = [];
    for (const { observation, timestamp } of observations) {
      const sample = latestAtOrBefore(samples, timestamp);
      const point: IntradayPoint = {
        observedAt: observation.observedAt,
        runId: observation.runId,
        metricsChanged: observation.metricsChanged,
        metrics: sample ? cloneMetrics(sample.sample.metrics) : emptyMetrics(),
      };
      points.push(point);
      indexedPoints.push({ point, timestamp });
    }
    pointsByWork.set(workKey, indexedPoints);

    const firstObservationAt = observations[0]?.timestamp ?? null;
    const baselineLabel: IntradayBaselineLabel = firstObservationAt != null && firstObservationAt - midnight <= baselineWindowMs ? "estimated" : "partial";
    const baselineMetrics = cloneMetrics(points[0]?.metrics ?? emptyMetrics());
    const latestMetrics = points.at(-1)?.metrics ?? emptyMetrics();
    const changeSampleCount = samples.filter(({ sample, timestamp }) => {
      return sample.kind === "change" && timestamp >= midnight && timestamp < day.endMs && timestamp <= observationCeiling;
    }).length;
    works.push({
      workKey,
      date,
      baselineAt: points[0]?.observedAt ?? null,
      baselineLabel,
      sampleCount: observations.length,
      changeSampleCount,
      points,
      delta: subtractMetrics(latestMetrics, baselineMetrics),
    });
  }

  const points = aggregatePortfolioPoints(works, samplesByWork, pointsByWork, workKeys);
  return {
    date,
    baselineLabel: works.length === 0 || works.some((work) => work.baselineLabel === "partial") ? "partial" : "estimated",
    sampleCount: points.length,
    points,
    works,
    delta: aggregateDelta(works),
  };
}

export function analyzeIntraday(
  works: readonly Pick<WorkRecord, "key">[],
  samples: readonly WorkSample[],
  observations: readonly WorkObservation[],
  options: IntradayAnalyticsOptions = {},
): IntradayPortfolioAnalysis {
  return buildIntradayAnalytics({ ...options, works, samples, observations });
}

export const calculateIntradayAnalytics = buildIntradayAnalytics;
export const reconstructIntraday = buildIntradayAnalytics;
