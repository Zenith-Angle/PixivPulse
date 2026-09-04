import { parseInstant } from "./time";
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
}

export interface PortfolioTimelinePoint {
  at: string;
  runId: string;
  metrics: Pick<WorkMetrics, (typeof ADDITIVE_KEYS)[number]>;
}

interface ParsedSample {
  at: number;
  sample: WorkSample;
}

interface TimelineInstant {
  at: number;
  iso: string;
  runId: string;
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
  if (range.startMs == null) return;
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
  const workSamples = samplesByWork(samples).get(workKey) ?? [];
  const instants = new Map<string, TimelineInstant>();
  addBoundaryInstant(instants, range);

  for (const observation of observations) {
    if (observation.workKey === workKey) addInstant(instants, observation.observedAt, observation.runId, range);
  }
  for (const batch of observationBatches) {
    if (batch.workKeys.includes(workKey)) addInstant(instants, batch.observedAt, batch.runId, range);
  }
  for (const { at, sample } of workSamples) {
    if (!inRange(at, range)) continue;
    const runId = sample.kind === "daily-rollup" ? `daily:${sample.collectedAt}` : sample.runId;
    addInstant(instants, sample.collectedAt, runId, range);
  }

  return orderedInstants(instants).flatMap((instant) => {
    const sample = latestSampleAtOrBefore(workSamples, instant.at);
    return sample ? [{ workKey, at: instant.iso, runId: instant.runId, metrics: sample.metrics }] : [];
  });
}

/** Aggregate works at every real observation instant without dropping unchanged works. */
export function buildPortfolioTimeline(
  workKeys: readonly string[],
  samples: readonly WorkSample[],
  observations: readonly WorkObservation[],
  range: TimelineRange,
  observationBatches: readonly ObservationBatch[] = [],
): PortfolioTimelinePoint[] {
  const selectedKeys = new Set(workKeys);
  const indexedSamples = samplesByWork(samples);
  const instants = new Map<string, TimelineInstant>();
  addBoundaryInstant(instants, range);

  for (const observation of observations) {
    if (selectedKeys.has(observation.workKey)) addInstant(instants, observation.observedAt, observation.runId, range);
  }
  for (const batch of observationBatches) {
    if (batch.workKeys.some((workKey) => selectedKeys.has(workKey))) addInstant(instants, batch.observedAt, batch.runId, range);
  }
  for (const [workKey, workSamples] of indexedSamples) {
    if (!selectedKeys.has(workKey)) continue;
    for (const { at, sample } of workSamples) {
      if (!inRange(at, range)) continue;
      const runId = sample.kind === "daily-rollup" ? `daily:${sample.collectedAt}` : sample.runId;
      addInstant(instants, sample.collectedAt, runId, range);
    }
  }

  return orderedInstants(instants).flatMap((instant) => {
    const metrics = { views: null, bookmarks: null, likes: null, comments: null } as PortfolioTimelinePoint["metrics"];
    for (const workKey of selectedKeys) {
      const sample = latestSampleAtOrBefore(indexedSamples.get(workKey) ?? [], instant.at);
      if (!sample) continue;
      for (const key of ADDITIVE_KEYS) {
        const value = sample.metrics[key];
        if (value != null) metrics[key] = (metrics[key] ?? 0) + value;
      }
    }
    return ADDITIVE_KEYS.some((key) => metrics[key] != null)
      ? [{ at: instant.iso, runId: instant.runId, metrics }]
      : [];
  });
}
