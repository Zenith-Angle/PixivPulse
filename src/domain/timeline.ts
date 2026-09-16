import { dayBoundaryCoordinates, isMidnight, MIDNIGHT_GRACE_MS } from "./day-boundary";
import { beijingDayRange, parseInstant } from "./time";
import type { ObservationBatch, WorkMetrics, WorkObservation, WorkSample } from "./types";

const ADDITIVE_KEYS = ["views", "bookmarks", "likes", "comments"] as const;

export interface TimelineRange {
  startMs: number | null;
  endMs: number | null;
}

export interface WorkTimelinePoint {
  workKey: string;
  at: string;
  runId: string;
  metrics: WorkMetrics;
  /** Actual source time when the midnight accounting coordinate is estimated. */
  sourceAt?: string;
}

export interface PortfolioTimelinePoint {
  at: string;
  runId: string;
  metrics: Pick<WorkMetrics, (typeof ADDITIVE_KEYS)[number]>;
  /** Sum of per-work growth, excluding counters on newly discovered works. */
  growth?: Pick<WorkMetrics, (typeof ADDITIVE_KEYS)[number]>;
  incrementObserved?: boolean;
}

interface ParsedSample {
  at: number;
  sample: WorkSample;
}

interface TimelineInstant {
  at: number;
  iso: string;
  runId: string;
  sourceAt?: string;
}

const timestamp = (value: string): number | null => parseInstant(value);

const inRange = (value: number, range: TimelineRange): boolean =>
  (range.startMs == null || value >= range.startMs) && (range.endMs == null || value <= range.endMs);

const samplesByWork = (samples: readonly WorkSample[]): Map<string, ParsedSample[]> => {
  const grouped = new Map<string, ParsedSample[]>();
  for (const sample of samples) {
    const at = timestamp(sample.collectedAt);
    if (at == null) continue;
    const list = grouped.get(sample.workKey) ?? [];
    list.push({ at, sample });
    grouped.set(sample.workKey, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => left.at - right.at || (left.sample.id ?? 0) - (right.sample.id ?? 0));
  }
  return grouped;
};

const latestSampleAtOrBefore = (samples: readonly ParsedSample[], at: number): WorkSample | null => {
  let low = 0;
  let high = samples.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const entry = samples[middle];
    if (!entry) break;
    if (entry.at <= at) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match >= 0 ? samples[match]?.sample ?? null : null;
};

const addInstant = (target: Map<string, TimelineInstant>, iso: string, runId: string, range: TimelineRange): void => {
  const at = timestamp(iso);
  if (at == null || !inRange(at, range)) return;
  const key = `${at}\u0000${runId}`;
  if (!target.has(key)) target.set(key, { at, iso, runId });
};

const addBoundaryInstant = (target: Map<string, TimelineInstant>, range: TimelineRange): void => {
  if (range.startMs == null || isMidnight(range.startMs)) return;
  const iso = new Date(range.startMs).toISOString();
  target.set(`${range.startMs}\u0000range-start`, { at: range.startMs, iso, runId: "range-start" });
};

const orderedInstants = (instants: Map<string, TimelineInstant>): TimelineInstant[] =>
  [...instants.values()].sort((left, right) => left.at - right.at || left.runId.localeCompare(right.runId));

/**
 * Rebuild a work timeline at real observation times while retaining compacted
 * daily history. Samples are indexed once and looked up with binary search, so
 * switching a long time range no longer repeatedly filters and sorts the full
 * local dataset.
 */
export function buildWorkTimeline(
  workKey: string,
  samples: readonly WorkSample[],
  observations: readonly WorkObservation[],
  range: TimelineRange,
  observationBatches: readonly ObservationBatch[] = [],
): WorkTimelinePoint[] {
  return buildIndexedWorkTimeline(workKey, samplesByWork(samples).get(workKey) ?? [], observations, range, observationBatches);
}

function buildIndexedWorkTimeline(
  workKey: string, workSamples: readonly ParsedSample[], observations: readonly WorkObservation[],
  range: TimelineRange, observationBatches: readonly ObservationBatch[],
): WorkTimelinePoint[] {
  const instants = new Map<string, TimelineInstant>();
  // Only boundary candidates in the selected days can affect this range.
  // Keep earlier samples indexed for carry-forward, but do not reconstruct
  // every historical observation just to discard it after midnight mapping.
  const sourceRange = { startMs: range.startMs == null ? null : beijingDayRange(range.startMs)?.startMs ?? range.startMs, endMs: range.endMs != null && isMidnight(range.endMs) ? Math.min(Date.now(), range.endMs + MIDNIGHT_GRACE_MS) : range.endMs };
  addBoundaryInstant(instants, range);

  for (const observation of observations) {
    if (observation.workKey === workKey) addInstant(instants, observation.observedAt, observation.runId, sourceRange);
  }
  for (const batch of observationBatches) {
    if (batch.workKeys.includes(workKey)) addInstant(instants, batch.observedAt, batch.runId, sourceRange);
  }
  for (const { at, sample } of workSamples) {
    if (!inRange(at, sourceRange)) continue;
    const runId = sample.kind === "daily-rollup" ? `daily:${sample.collectedAt}` : sample.runId;
    addInstant(instants, sample.collectedAt, runId, sourceRange);
  }

  const coordinates = dayBoundaryCoordinates([...instants.values()].filter(p => !p.runId.startsWith("daily:")).map(p => p.at));
  const seen = new Set<string>();
  return orderedInstants(instants).flatMap((instant) => {
    const at = coordinates.get(instant.at) ?? instant.at;
    if (!inRange(at, range)) return [];
    const identity = `${at}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const sample = latestSampleAtOrBefore(workSamples, instant.at);
    return sample ? [{ workKey, at: new Date(at).toISOString(), runId: instant.runId, metrics: sample.metrics,
      ...(at === instant.at ? {} : { sourceAt: instant.iso }) }] : [];
  });
}

/** Shared indexing for portfolio and daily-summary queries. */
export function buildWorkTimelines(workKeys: readonly string[], samples: readonly WorkSample[], observations: readonly WorkObservation[], range: TimelineRange, batches: readonly ObservationBatch[] = []): WorkTimelinePoint[][] {
  const indexed = samplesByWork(samples);
  const byWork = new Map<string, WorkObservation[]>();
  const byBatch = new Map<string, ObservationBatch[]>();
  for (const observation of observations) {
    const list = byWork.get(observation.workKey) ?? [];
    list.push(observation); byWork.set(observation.workKey, list);
  }
  for (const batch of batches) for (const key of batch.workKeys) {
    const list = byBatch.get(key) ?? [];
    list.push(batch); byBatch.set(key, list);
  }
  return [...new Set(workKeys)].map(key => buildIndexedWorkTimeline(key, indexed.get(key) ?? [], byWork.get(key) ?? [], range, byBatch.get(key) ?? []));
}

/** Aggregate works at every real observation instant without dropping unchanged works. */
export function buildPortfolioTimeline(
  workKeys: readonly string[],
  samples: readonly WorkSample[],
  observations: readonly WorkObservation[],
  range: TimelineRange,
  observationBatches: readonly ObservationBatch[] = [],
): PortfolioTimelinePoint[] {
  const selectedKeys = [...new Set(workKeys)];
  const timelines = buildWorkTimelines(selectedKeys, samples, observations, range, observationBatches);
  const instants = new Map<string, TimelineInstant>();
  for (const timeline of timelines) for (const point of timeline) addInstant(instants, point.at, point.runId, range);
  const times = timelines.map(points => points.map(point => Date.parse(point.at)));
  const cursors = timelines.map(() => -1);
  const growthByWork = timelines.map(() => ({ views: 0, bookmarks: 0, likes: 0, comments: 0 }));
  return orderedInstants(instants).flatMap(instant => {
    const metrics = { views: null, bookmarks: null, likes: null, comments: null } as PortfolioTimelinePoint["metrics"];
    let incrementObserved = false;
    const growth = { views: null, bookmarks: null, likes: null, comments: null } as PortfolioTimelinePoint["metrics"];
    timelines.forEach((points, index) => {
      while (cursors[index]! + 1 < points.length && times[index]![cursors[index]! + 1]! <= instant.at) {
        const previous = points[cursors[index]!];
        const next = points[++cursors[index]!]!;
        for (const key of ADDITIVE_KEYS) {
          if (previous && times[index]![cursors[index]!]! > times[index]![cursors[index]! - 1]! && previous.metrics[key] != null && next.metrics[key] != null) {
            incrementObserved = true;
            growthByWork[index]![key] += next.metrics[key]! - previous.metrics[key]!;
          }
        }
      }
      const point = points[cursors[index]!];
      if (!point) return;
      for (const key of ADDITIVE_KEYS) if (point.metrics[key] != null) {
        metrics[key] = (metrics[key] ?? 0) + point.metrics[key]!;
        growth[key] = (growth[key] ?? 0) + growthByWork[index]![key];
      }
    });
    return ADDITIVE_KEYS.some(key => metrics[key] != null) ? [{ at: instant.iso, runId: instant.runId, metrics, growth, incrementObserved }] : [];
  });
}
