import {
  normalizeRankingFields,
  type RankingSource,
  type RankingStatus,
  type WorkMetrics,
} from "./types";

export const METRIC_FRAME_CODEC = "metric-frame-v1" as const;
export const METRIC_FRAME_CODEC_VERSION = 1 as const;

export const METRIC_FRAME_METRIC_KEYS = [
  "likes",
  "bookmarks",
  "views",
  "comments",
  "rank",
  "responses",
  "illustrations",
] as const satisfies readonly (keyof WorkMetrics)[];

export type MetricFrameMetricKey = (typeof METRIC_FRAME_METRIC_KEYS)[number];
export type MetricFrameValue = number | null;
export type MetricFrameMask = number;
export const METRIC_FRAME_FULL_MASK = (1 << METRIC_FRAME_METRIC_KEYS.length) - 1;

export type MetricFrameScope = "complete" | "partial";
export type MetricFrameKind = "normal" | "compacted";
export type MetricFramePresence = "present" | "absent";

/** A source pointer retained when a normal sample is represented by a
 * compacted frame. All members are optional because old rollups may only
 * retain a source collection timestamp, but at least one must be present. */
export interface MetricFrameProvenance {
  sourceRunId?: string;
  sourceRunSeq?: number;
  sourceEpochMs?: number;
  sourceCollectedAt?: string;
  sourceFrameId?: string;
}

export interface MetricRankingOverride {
  status: RankingStatus;
  observedAt: string | null;
  source: RankingSource;
}

export interface MetricObservationStamp {
  runId: string;
  runSeq: number;
  epochMs: number;
  collectedAt: string;
}

/** The logical shape accepted by frame builders. `metrics` contains only
 * fields that changed; an explicit null is a real change to null. */
export interface MetricFrameChangeInput {
  ordinal: number;
  metrics: Partial<Record<MetricFrameMetricKey, MetricFrameValue>>;
  ranking?: MetricRankingOverride | null;
  quality?: number | null;
  provenance?: MetricFrameProvenance | null;
  sourceProvenance?: MetricFrameProvenance | null;
}

/** Sparse, absolute-value change tuple. Values are listed in metric-key order
 * for changed, non-null fields. `nullMask` identifies changed fields whose
 * absolute value is null, so null values do not need an array slot. */
export type MetricChangeTuple = [
  ordinal: number,
  changedMask: MetricFrameMask,
  nullMask: MetricFrameMask,
  values: number[],
  rankingOverride: MetricRankingOverride | null,
  qualityOverride: number | null,
  provenance: MetricFrameProvenance | null,
];

export interface MetricFrameHeader {
  runId: string;
  runSeq: number;
  epochMs: number;
  scope: MetricFrameScope;
  parser: number;
  quality: number;
}

export interface MetricFrame extends MetricFrameHeader {
  codec: typeof METRIC_FRAME_CODEC;
  codecVersion: typeof METRIC_FRAME_CODEC_VERSION;
  kind: MetricFrameKind;
  /** Delta-packed, ascending ordinals. Decode with unpackMetricOrdinals. */
  observed: number[];
  changes: MetricChangeTuple[];
  provenance?: MetricFrameProvenance;
}

export interface MetricFrameDraft extends Partial<MetricFrameHeader> {
  runId: string;
  runSeq: number;
  epochMs: number;
  scope: MetricFrameScope;
  parser?: number;
  parserVersion?: number;
  quality?: number;
  dataQuality?: number;
  kind?: MetricFrameKind;
  compacted?: boolean;
  /** Expanded ordinals are packed by createMetricFrame. `observed` is an
   * accepted spelling for callers that build frames without a draft step. */
  observedOrdinals?: readonly number[];
  observed?: readonly number[];
  changes: readonly (MetricFrameChangeInput | MetricChangeTuple)[];
  provenance?: MetricFrameProvenance | null;
  sourceProvenance?: MetricFrameProvenance | null;
}

export interface MetricKeyframeState {
  ordinal: number;
  metrics: WorkMetrics;
  rankingStatus: RankingStatus;
  rankingObservedAt: string | null;
  rankingSource: RankingSource;
  presence: MetricFramePresence;
  absentSince: string | null;
  lastObserved: MetricObservationStamp | null;
  parser: number;
  quality: number;
  provenance: MetricFrameProvenance | null;
}

/** A full state snapshot used as a restart point for range reconstruction. */
export interface MetricKeyframe extends MetricFrameHeader {
  codec: typeof METRIC_FRAME_CODEC;
  codecVersion: typeof METRIC_FRAME_CODEC_VERSION;
  kind: "keyframe";
  states: MetricKeyframeState[];
  provenance?: MetricFrameProvenance;
}

export type MetricFrameRecord = MetricFrame | MetricKeyframe;
export type MetricRangeState = ReadonlyMap<number, MetricKeyframeState>;
export type MetricFrameState = MetricKeyframeState;
export type KeyframeState = MetricKeyframeState;
export type MetricFrameTuple = MetricChangeTuple;
export type FrameProvenance = MetricFrameProvenance;

export type { RankingSource, RankingStatus } from "./types";

export interface MetricRange {
  startMs?: number | null;
  endMs?: number | null;
}

export interface WorkDictionaryEntry {
  ordinal: number;
  workKey: string;
}

/** Dictionary entries are append-only. Retired works remain in entries so an
 * ordinal can never be assigned to another work. */
export interface WorkDictionary {
  codec: typeof METRIC_FRAME_CODEC;
  codecVersion: typeof METRIC_FRAME_CODEC_VERSION;
  nextOrdinal: number;
  entries: WorkDictionaryEntry[];
}

export type MetricFrameInput = MetricFrameDraft;

export function metricMaskForKey(key: MetricFrameMetricKey): number {
  const index = METRIC_FRAME_METRIC_KEYS.indexOf(key);
  if (index < 0) throw new RangeError(`Unknown metric key: ${key}`);
  return 1 << index;
}

export function metricKeysForMask(mask: MetricFrameMask): MetricFrameMetricKey[] {
  if (!Number.isSafeInteger(mask) || mask < 0 || mask > METRIC_FRAME_FULL_MASK) {
    throw new RangeError("Metric mask is outside the supported field range");
  }
  return METRIC_FRAME_METRIC_KEYS.filter((_, index) => (mask & (1 << index)) !== 0) as MetricFrameMetricKey[];
}

export function metricValueTuple(metrics: WorkMetrics): [
  MetricFrameValue,
  MetricFrameValue,
  MetricFrameValue,
  MetricFrameValue,
  MetricFrameValue,
  MetricFrameValue,
  MetricFrameValue,
] {
  return METRIC_FRAME_METRIC_KEYS.map((key) => metrics[key]) as [
    MetricFrameValue,
    MetricFrameValue,
    MetricFrameValue,
    MetricFrameValue,
    MetricFrameValue,
    MetricFrameValue,
    MetricFrameValue,
  ];
}

export function metricsFromTuple(values: readonly MetricFrameValue[]): WorkMetrics {
  if (values.length !== METRIC_FRAME_METRIC_KEYS.length) {
    throw new RangeError("A metric tuple must contain all metric fields");
  }
  return {
    likes: values[0]!,
    bookmarks: values[1]!,
    views: values[2]!,
    comments: values[3]!,
    rank: values[4]!,
    responses: values[5]!,
    illustrations: values[6]!,
  };
}

export function normalizeMetricRanking(
  metrics: WorkMetrics,
  rankingStatus?: unknown,
  rankingObservedAt?: unknown,
  rankingSource?: unknown,
): { metrics: WorkMetrics; rankingStatus: RankingStatus; rankingObservedAt: string | null; rankingSource: RankingSource } {
  const ranking = normalizeRankingFields({
    rank: metrics.rank,
    rankingStatus,
    rankingObservedAt,
    rankingSource,
  });
  return {
    metrics: { ...metrics, rank: ranking.rank },
    rankingStatus: ranking.rankingStatus,
    rankingObservedAt: ranking.rankingObservedAt,
    rankingSource: ranking.rankingSource,
  };
}

export function observationStamp(header: Pick<MetricFrameHeader, "runId" | "runSeq" | "epochMs">): MetricObservationStamp {
  return {
    runId: header.runId,
    runSeq: header.runSeq,
    epochMs: header.epochMs,
    collectedAt: new Date(header.epochMs).toISOString(),
  };
}

export function compareMetricFrameRecords(
  left: Pick<MetricFrameRecord, "epochMs" | "runSeq" | "runId">,
  right: Pick<MetricFrameRecord, "epochMs" | "runSeq" | "runId">,
): number {
  // Array#sort is stable in the supported runtimes. Keeping equal sequence
  // numbers equal preserves input order when two runs share a millisecond.
  return left.epochMs - right.epochMs || left.runSeq - right.runSeq;
}

export function createWorkDictionary(
  entries: readonly WorkDictionaryEntry[] = [],
  highWaterMark?: number,
): WorkDictionary {
  const sorted = [...entries].sort((left, right) => left.ordinal - right.ordinal);
  const seenOrdinals = new Set<number>();
  const seenKeys = new Set<string>();
  let nextOrdinal = 0;
  for (const entry of sorted) {
    if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0) throw new RangeError("Invalid work ordinal");
    if (typeof entry.workKey !== "string" || entry.workKey.length === 0) throw new RangeError("Invalid work key");
    if (seenOrdinals.has(entry.ordinal)) throw new RangeError("Work ordinal is reused");
    if (seenKeys.has(entry.workKey)) throw new RangeError("Work key is duplicated");
    seenOrdinals.add(entry.ordinal);
    seenKeys.add(entry.workKey);
    nextOrdinal = Math.max(nextOrdinal, entry.ordinal + 1);
  }
  if (!Number.isSafeInteger(nextOrdinal)) throw new RangeError("Work dictionary ordinal ceiling exceeded");
  if (highWaterMark !== undefined) {
    if (!Number.isSafeInteger(highWaterMark) || highWaterMark < nextOrdinal) {
      throw new RangeError("Work dictionary nextOrdinal would reuse an ordinal");
    }
    nextOrdinal = highWaterMark;
  }
  return {
    codec: METRIC_FRAME_CODEC,
    codecVersion: METRIC_FRAME_CODEC_VERSION,
    nextOrdinal,
    entries: sorted.map((entry) => ({ ...entry })),
  };
}

export function createWorkDictionaryWithHighWaterMark(
  entries: readonly WorkDictionaryEntry[],
  nextOrdinal: number,
): WorkDictionary {
  return createWorkDictionary(entries, nextOrdinal);
}

export function findWorkOrdinal(dictionary: WorkDictionary, workKey: string): number | null {
  return dictionary.entries.find((entry) => entry.workKey === workKey)?.ordinal ?? null;
}

export interface WorkOrdinalAssignment {
  dictionary: WorkDictionary;
  ordinal: number;
}

/** Return a new dictionary. Existing entries are never removed or renumbered. */
export function assignWorkOrdinal(dictionary: WorkDictionary, workKey: string): WorkOrdinalAssignment {
  if (typeof workKey !== "string" || workKey.length === 0) throw new RangeError("Invalid work key");
  const canonical = createWorkDictionary(dictionary.entries);
  if (!Number.isSafeInteger(dictionary.nextOrdinal) || dictionary.nextOrdinal < canonical.nextOrdinal) {
    throw new RangeError("Work dictionary nextOrdinal would reuse an ordinal");
  }
  const current: WorkDictionary = { ...canonical, nextOrdinal: dictionary.nextOrdinal };
  const existing = findWorkOrdinal(dictionary, workKey);
  if (existing !== null) return { dictionary: current, ordinal: existing };
  const ordinal = current.nextOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Work dictionary ordinal ceiling exceeded");
  }
  const next = createWorkDictionary([...current.entries, { ordinal, workKey }]);
  return {
    dictionary: { ...next, nextOrdinal: Math.max(current.nextOrdinal + 1, next.nextOrdinal) },
    ordinal,
  };
}

export const registerWorkOrdinal = assignWorkOrdinal;
export const addWorkToDictionary = assignWorkOrdinal;
export const ordinalForWork = findWorkOrdinal;
export const createAppendOnlyWorkDictionary = createWorkDictionaryWithHighWaterMark;
