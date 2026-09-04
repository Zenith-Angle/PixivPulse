import { parseInstant } from "./time";
import {
  LOSSLESS_RETENTION_HOURS,
  RETENTION_30M_MAX_DAYS,
  RETENTION_1H_MAX_DAYS,
} from "./constants";
import type { WorkMetrics, WorkSample } from "./types";

export type RetentionTier = "lossless" | "30m" | "1h" | "6h";

/** Fixed retention policy boundaries shared by repository planning and pure
 * tests. Age is measured from the supplied endpoint instant. */
export function retentionTierForAge(ageMs: number): RetentionTier {
  if (!Number.isFinite(ageMs) || ageMs < LOSSLESS_RETENTION_HOURS * 3_600_000) return "lossless";
  if (ageMs < RETENTION_30M_MAX_DAYS * 86_400_000) return "30m";
  if (ageMs < RETENTION_1H_MAX_DAYS * 86_400_000) return "1h";
  return "6h";
}

export const retentionTierFor = retentionTierForAge;

export type TemporalCompactionLevel = Exclude<RetentionTier, "lossless">;

export const TEMPORAL_COMPACTION_LEVELS = ["30m", "1h", "6h"] as const satisfies readonly TemporalCompactionLevel[];
export const TEMPORAL_COMPACTION_30M_AGE_MS = LOSSLESS_RETENTION_HOURS * 60 * 60 * 1_000;
export const TEMPORAL_COMPACTION_1H_AGE_MS = RETENTION_30M_MAX_DAYS * 24 * 60 * 60 * 1_000;
export const TEMPORAL_COMPACTION_6H_AGE_MS = RETENTION_1H_MAX_DAYS * 24 * 60 * 60 * 1_000;
export const TEMPORAL_COMPACTION_30M_BUCKET_MINUTES = 30;
export const TEMPORAL_COMPACTION_1H_BUCKET_MINUTES = 60;
export const TEMPORAL_COMPACTION_6H_BUCKET_MINUTES = 360;

const METRIC_KEYS = [
  "likes",
  "bookmarks",
  "views",
  "comments",
  "rank",
  "responses",
  "illustrations",
] as const satisfies readonly (keyof WorkMetrics)[];

const NON_RANK_METRIC_KEYS = METRIC_KEYS.filter((key) => key !== "rank");

interface BeijingClockParts {
  date: string;
  hour: number;
  minute: number;
}

const BEIJING_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US-u-nu-latn", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function beijingClockParts(timestamp: number): BeijingClockParts | null {
  try {
    const parts = BEIJING_CLOCK_FORMATTER.formatToParts(new Date(timestamp));
    const read = (type: Intl.DateTimeFormatPartTypes): number | null => {
      const raw = parts.find((part) => part.type === type)?.value;
      if (raw == null || !/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) ? value : null;
    };
    const year = read("year");
    const month = read("month");
    const day = read("day");
    const hour = read("hour");
    const minute = read("minute");
    if (year == null || month == null || day == null || hour == null || minute == null) return null;
    return {
      date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      hour,
      minute,
    };
  } catch {
    return null;
  }
}

/** Stable Asia/Shanghai bucket shared by frame and legacy planning. */
export function retentionBucketKey(value: string | number | Date, tier: Exclude<RetentionTier, "lossless">): string | null {
  const timestamp = parseInstant(value);
  if (timestamp == null) return null;
  const clock = beijingClockParts(timestamp);
  if (!clock) return null;
  const bucketMinutes = tier === "30m"
    ? TEMPORAL_COMPACTION_30M_BUCKET_MINUTES
    : tier === "1h"
      ? TEMPORAL_COMPACTION_1H_BUCKET_MINUTES
      : TEMPORAL_COMPACTION_6H_BUCKET_MINUTES;
  const start = Math.floor((clock.hour * 60 + clock.minute) / bucketMinutes) * bucketMinutes;
  const hour = Math.floor(start / 60);
  const minute = start % 60;
  return `${tier}:${clock.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export const retentionBucket = retentionBucketKey;

/** Return the stable Beijing civil-time bucket key for an instant. The key is
 * intentionally independent of the machine timezone and includes its tier,
 * so a sample promoted from 30 minutes to two hours cannot collide with an
 * old key in a caller-side map. */
export function temporalBucketKey(
  value: string | number | Date,
  level: TemporalCompactionLevel,
): string | null {
  return retentionBucketKey(value, level);
}

export const fixedTemporalBucketKey = temporalBucketKey;
export const bucketKeyFor = temporalBucketKey;

/** Return the desired temporal tier for a sample age. Boundaries are
 * inclusive on the older tier: 3d enters 30m, 7d enters 1h and 30d enters 6h. */
export function temporalCompactionLevelForAge(ageMs: number): TemporalCompactionLevel | null {
  const tier = retentionTierForAge(ageMs);
  return tier === "lossless" ? null : tier;
}

export function temporalCompactionLevelFor(
  value: string | number | Date,
  now: string | number | Date = Date.now(),
): TemporalCompactionLevel | null {
  const timestamp = parseInstant(value);
  const nowTimestamp = parseInstant(now);
  if (timestamp == null || nowTimestamp == null) return null;
  return temporalCompactionLevelForAge(nowTimestamp - timestamp);
}

export const compactionLevelForAge = temporalCompactionLevelForAge;
export const compactionLevelFor = temporalCompactionLevelFor;

function metricCompleteness(sample: WorkSample): number {
  return METRIC_KEYS.reduce((count, key) => count + (sample.metrics[key] != null ? 1 : 0), 0);
}

function nonRankMetricSum(sample: WorkSample): number {
  return NON_RANK_METRIC_KEYS.reduce((sum, key) => {
    const value = sample.metrics[key];
    return typeof value === "number" && Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function numericId(sample: WorkSample): number {
  return sample.id != null && Number.isSafeInteger(sample.id) ? sample.id : Number.NEGATIVE_INFINITY;
}

/** Compare whole samples. Returning a positive value means `left` wins. */
export function compareTemporalCandidates(
  left: WorkSample,
  right: WorkSample,
): number {
  const completeness = metricCompleteness(left) - metricCompleteness(right);
  if (completeness !== 0) return completeness;
  const sum = nonRankMetricSum(left) - nonRankMetricSum(right);
  if (sum !== 0) return sum;
  const leftAt = parseInstant(left.collectedAt) ?? Number.NEGATIVE_INFINITY;
  const rightAt = parseInstant(right.collectedAt) ?? Number.NEGATIVE_INFINITY;
  if (leftAt !== rightAt) return leftAt - rightAt;
  const id = numericId(left) - numericId(right);
  if (id !== 0) return id;
  // Database rows normally have an id. This final stable comparison keeps the
  // pure reducer deterministic for imported samples that do not have one.
  return left.runId.localeCompare(right.runId) || left.collectedAt.localeCompare(right.collectedAt);
}

export interface TemporalCompactionBucket {
  key: string;
  workKey: string;
  level: TemporalCompactionLevel;
  candidates: WorkSample[];
  selected: WorkSample;
}

export interface TemporalCompactionPlan {
  /** Full rows to put back. Only `compactionLevel` is changed on an existing
   * row, preserving its metrics, run id and actual collection timestamp. */
  updates: WorkSample[];
  /** Existing database keys that can be deleted in the same transaction. */
  deleteIds: number[];
  /** Selected rows, useful to callers that need a post-compaction preview. */
  kept: WorkSample[];
  buckets: TemporalCompactionBucket[];
  considered: number;
  skipped: number;
}

function validNow(value: string | number | Date): number | null {
  return parseInstant(value);
}

/** Build a deterministic, side-effect-free compaction plan.
 *
 * This reducer intentionally does not merge metric fields. A bucket is
 * represented by one complete historical sample, selected as a whole row;
 * that keeps every metric set internally consistent and preserves provenance.
 * Daily rollups, malformed timestamps and future samples are not candidates
 * and are never deleted. */
export function reduceTemporalCompaction(
  samples: readonly WorkSample[],
  now: string | number | Date = Date.now(),
): TemporalCompactionPlan {
  const nowTimestamp = validNow(now);
  if (nowTimestamp == null) return { updates: [], deleteIds: [], kept: [], buckets: [], considered: 0, skipped: samples.length };

  const groups = new Map<string, TemporalCompactionBucket>();
  // The most recent valid change point for a work is a hard anchor. A lower
  // quality row in that last bucket must not make the visible latest point
  // disappear merely because an older row has more populated fields.
  const latestByWork = new Map<string, WorkSample>();
  let considered = 0;
  let skipped = 0;
  for (const sample of samples) {
    if (sample.kind !== "change") {
      skipped += 1;
      continue;
    }
    const collectedAt = parseInstant(sample.collectedAt);
    if (collectedAt == null) {
      skipped += 1;
      continue;
    }
    const latest = latestByWork.get(sample.workKey);
    const latestAt = latest == null ? null : parseInstant(latest.collectedAt);
    if (latest == null || collectedAt > (latestAt ?? Number.NEGATIVE_INFINITY)
      || (collectedAt === latestAt && numericId(sample) > numericId(latest))) {
      latestByWork.set(sample.workKey, sample);
    }
    const level = temporalCompactionLevelForAge(nowTimestamp - collectedAt);
    if (level == null) continue;
    const bucket = temporalBucketKey(collectedAt, level);
    if (bucket == null || !sample.workKey) {
      skipped += 1;
      continue;
    }
    considered += 1;
    const key = `${sample.workKey}\u0000${bucket}`;
    const existing = groups.get(key);
    if (existing) existing.candidates.push(sample);
    else groups.set(key, { key, workKey: sample.workKey, level, candidates: [sample], selected: sample });
  }

  const updates: WorkSample[] = [];
  const deleteIds: number[] = [];
  const kept: WorkSample[] = [];
  const buckets = [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
  for (const bucket of buckets) {
    const latest = latestByWork.get(bucket.workKey);
    // Keep the newest point as the representative of its bucket whenever it
    // is itself eligible. This is the one intentional guard above the quality
    // ranking: history may be approximate, but the current endpoint must not
    // move backwards or vanish after cleanup.
    const selected = latest && bucket.candidates.includes(latest)
      ? latest
      : bucket.candidates.slice().sort((left, right) => compareTemporalCandidates(right, left))[0];
    if (!selected) continue;
    bucket.selected = selected;
    kept.push(selected);
    if (selected.compactionLevel !== bucket.level) {
      updates.push({ ...selected, compactionLevel: bucket.level });
    }
    for (const candidate of bucket.candidates) {
      if (candidate === selected) continue;
      if (candidate.id != null && Number.isSafeInteger(candidate.id)) deleteIds.push(candidate.id);
    }
  }
  deleteIds.sort((left, right) => left - right);
  return { updates, deleteIds, kept, buckets, considered, skipped };
}

export const buildTemporalCompactionPlan = reduceTemporalCompaction;
export const compactTemporalSamples = reduceTemporalCompaction;
export const reduceSamplesForTemporalCompaction = reduceTemporalCompaction;
