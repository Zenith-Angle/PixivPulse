import type { IDBPDatabase } from "idb";
import {
  assignWorkOrdinal,
  createWorkDictionary,
  compareMetricFrameRecords,
  METRIC_FRAME_METRIC_KEYS,
  metricMaskForKey,
  type MetricFrame,
  type MetricFrameChangeInput,
  type MetricRangeState,
  type WorkDictionary,
} from "../domain/metric-frames";
import type { ObservationBatch, WorkSample } from "../domain/types";
import {
  applyMetricFrame,
  createMetricFrame,
  decodeWorkDictionary,
  encodeWorkDictionary,
  encodeMetricFrame,
  unpackMetricOrdinals,
} from "./metric-frame-codec";
import type { AnalyticsSchemaState, PixivPulseSchema } from "./database";
import {
  retentionBucketKey,
  retentionTierForAge,
} from "../domain/temporal-compaction";

export interface FrameWriteContext {
  dictionary: WorkDictionary;
  ordinals: Map<string, number>;
  newOrdinals: Set<number>;
  runSeq: number;
}

type FrameWriteTransaction = {
  objectStore(name: "workDictionary"): {
    get(key: string): Promise<unknown>;
    put(value: unknown, key: string): Promise<unknown>;
  };
  objectStore(name: "analyticsSchemaState"): {
    get(key: string): Promise<AnalyticsSchemaState | undefined>;
    put(value: AnalyticsSchemaState): Promise<unknown>;
  };
};

export async function prepareFrameWrite(
  tx: FrameWriteTransaction,
  workKeys: Iterable<string>,
  updatedAt: string,
  options: { migration?: boolean } = {},
): Promise<FrameWriteContext> {
  const dictionaryStore = tx.objectStore("workDictionary");
  const stateStore = tx.objectStore("analyticsSchemaState");
  const storedDictionary = await dictionaryStore.get("root");
  let dictionary = storedDictionary == null ? createWorkDictionary() : decodeWorkDictionary(storedDictionary);
  const newOrdinals = new Set<number>();
  const ordinals = new Map<string, number>();
  for (const workKey of workKeys) {
    const before = dictionary.entries.length;
    const assignment = assignWorkOrdinal(dictionary, workKey);
    dictionary = assignment.dictionary;
    ordinals.set(workKey, assignment.ordinal);
    if (dictionary.entries.length > before) newOrdinals.add(assignment.ordinal);
  }
  const current = await stateStore.get("root");
  if (current?.migrationStatus === "running" && options.migration !== true) {
    throw new Error("Analytics history migration is running");
  }
  const runSeq = current?.nextRunSeq ?? 0;
  await dictionaryStore.put(encodeWorkDictionary(dictionary), "root");
  await stateStore.put({
    key: "root",
    activeSchema: "frames",
    nextRunSeq: runSeq + 1,
    migrationStatus: current?.migrationStatus ?? "pending",
    migrationCursor: current?.migrationCursor ?? null,
    migrationSnapshot: current?.migrationSnapshot ?? null,
    updatedAt,
  });
  return { dictionary, ordinals, newOrdinals, runSeq };
}

export function buildMetricFrame(input: {
  runId: string;
  runSeq: number;
  collectedAt: string;
  scope: "complete" | "partial";
  parser: number;
  quality: number;
  observedOrdinals: readonly number[];
  changes: readonly MetricFrameChangeInput[];
}): MetricFrame {
  const epochMs = Date.parse(input.collectedAt);
  if (!Number.isSafeInteger(epochMs)) throw new Error("Invalid metric frame timestamp");
  return createMetricFrame({
    runId: input.runId,
    runSeq: input.runSeq,
    epochMs,
    scope: input.scope,
    parser: input.parser,
    quality: input.quality,
    kind: "normal",
    observedOrdinals: input.observedOrdinals,
    changes: input.changes,
  });
}

export interface PublicFrameHistory {
  samples: WorkSample[];
  observationBatches: ObservationBatch[];
}

export function decodePublicFrameHistory(
  storedDictionary: unknown,
  frames: readonly MetricFrame[],
): PublicFrameHistory {
  if (storedDictionary == null || frames.length === 0) return { samples: [], observationBatches: [] };
  const dictionary = decodeWorkDictionary(storedDictionary);
  const keyByOrdinal = new Map(dictionary.entries.map((entry) => [entry.ordinal, entry.workKey]));
  const ordered = [...frames].sort(compareMetricFrameRecords);
  const samples: WorkSample[] = [];
  const observationBatches: ObservationBatch[] = [];
  let state: MetricRangeState = new Map();
  for (const frame of ordered) {
    state = applyMetricFrame(frame, state, dictionary);
    const observed = unpackMetricOrdinals(frame.observed);
    const workKeys = observed.map((ordinal) => keyByOrdinal.get(ordinal)).filter((key): key is string => key != null);
    const changedWorkKeys: string[] = [];
    for (const change of frame.changes) {
      const workKey = keyByOrdinal.get(change[0]);
      const current = state.get(change[0]);
      if (!workKey || !current) continue;
      changedWorkKeys.push(workKey);
      const ranking = change[4];
      samples.push({
        workKey,
        runId: frame.runId,
        collectedAt: new Date(frame.epochMs).toISOString(),
        metrics: { ...current.metrics, rank: ranking?.status === "ranked" ? current.metrics.rank : null },
        rankingStatus: ranking?.status ?? "unknown",
        rankingObservedAt: ranking?.status === "unknown" || ranking == null ? null : ranking.observedAt,
        rankingSource: ranking?.status === "unknown" || ranking == null ? null : ranking.source,
        parserVersion: current.parser,
        dataQuality: current.quality,
        kind: "change",
      });
    }
    observationBatches.push({
      runId: frame.runId,
      observedAt: new Date(frame.epochMs).toISOString(),
      workKeys,
      changedWorkKeys,
      scope: frame.scope,
    });
  }
  return { samples, observationBatches };
}

/** Decode frame storage at the repository boundary. UI and portable backups
 * continue to receive stable work-key based public records. */
export async function readPublicFrameHistory(
  db: IDBPDatabase<PixivPulseSchema>,
): Promise<PublicFrameHistory> {
  const tx = db.transaction(["workDictionary", "metricFrames"], "readonly");
  const [storedDictionary, frames] = await Promise.all([
    tx.objectStore("workDictionary").get("root"),
    tx.objectStore("metricFrames").getAll(),
  ]);
  await tx.done;
  return decodePublicFrameHistory(storedDictionary, frames);
}

function frameBucket(frame: MetricFrame, nowMs: number): string | null {
  const tier = retentionTierForAge(nowMs - frame.epochMs);
  if (tier === "lossless") return null;
  return retentionBucketKey(frame.epochMs, tier);
}

/** Stable identity for the IndexedDB metric-frame key. */
export function metricFrameIdentity(frame: Pick<MetricFrame, "epochMs" | "runSeq" | "runId">): string {
  return `${frame.epochMs}:${frame.runSeq}:${frame.runId}`;
}

const FNV64_PRIME = 0x100000001b3n;
const METRIC_FRAME_DIGEST_SEEDS = [
  0xcbf29ce484222325n,
  0x84222325cbf29ce4n,
  0x9e3779b185ebca87n,
  0x243f6a8885a308d3n,
] as const;

function fnv64(value: string, seed: bigint): bigint {
  let hash = seed;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * FNV64_PRIME);
  }
  return hash;
}

/** Return a synchronous, deterministic digest of the canonical stored frame.
 * This is an internal CAS token rather than a cryptographic signature. Four
 * independent 64-bit lanes keep accidental collisions vanishingly unlikely
 * without depending on asynchronous Web Crypto APIs. */
export function metricFrameDigest(frame: MetricFrame): string {
  const canonical = JSON.stringify(encodeMetricFrame(frame));
  return METRIC_FRAME_DIGEST_SEEDS
    .map((seed) => fnv64(canonical, seed).toString(16).padStart(16, "0"))
    .join("");
}

function valuesByMetric(change: MetricFrame["changes"][number]): Partial<Record<(typeof METRIC_FRAME_METRIC_KEYS)[number], number | null>> {
  const result: Partial<Record<(typeof METRIC_FRAME_METRIC_KEYS)[number], number | null>> = {};
  let valueIndex = 0;
  for (const key of METRIC_FRAME_METRIC_KEYS) {
    const bit = metricMaskForKey(key);
    if ((change[1] & bit) === 0) continue;
    result[key] = (change[2] & bit) !== 0 ? null : change[3][valueIndex++]!;
  }
  return result;
}

export interface FrameCompactionResult {
  considered: number;
  rewritten: number;
  deleted: number;
}

export interface MetricFrameCompactionRewrite {
  sourceIdentity: string;
  sourceDigest: string;
  frame: MetricFrame;
}

export interface MetricFrameCompactionDelete {
  sourceIdentity: string;
  sourceDigest: string;
  key: [number, number, string];
}

export interface MetricFrameCompactionPlan {
  considered: number;
  rewrites: MetricFrameCompactionRewrite[];
  deletes: MetricFrameCompactionDelete[];
  lossySources: MetricFrame[];
}

export interface StoredRetentionTierCounts {
  lossless: number;
  "30m": number;
  "1h": number;
  "6h": number;
}

function retentionNowMs(now: string | number | Date): number {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  if (!Number.isFinite(nowMs)) throw new Error("Invalid metric frame compaction timestamp");
  return nowMs;
}

/** Count every stored legacy row with a valid timestamp and every frame
 * change. Invalid legacy timestamps are excluded; an invalid frame age follows
 * retentionTierForAge and therefore remains in the lossless tier. */
export function countStoredRetentionTiers(
  legacySamples: readonly Pick<WorkSample, "collectedAt">[],
  frames: readonly MetricFrame[],
  now: string | number | Date = Date.now(),
): StoredRetentionTierCounts {
  const nowMs = retentionNowMs(now);
  const counts: StoredRetentionTierCounts = { lossless: 0, "30m": 0, "1h": 0, "6h": 0 };
  for (const sample of legacySamples) {
    const collectedAt = typeof sample.collectedAt === "string" ? Date.parse(sample.collectedAt) : Number.NaN;
    if (!Number.isFinite(collectedAt)) continue;
    counts[retentionTierForAge(nowMs - collectedAt)] += 1;
  }
  for (const frame of frames) {
    const tier = retentionTierForAge(nowMs - frame.epochMs);
    counts[tier] += frame.changes.length;
  }
  return counts;
}

function semanticFrameMaterial(frame: MetricFrame): string {
  const encoded = encodeMetricFrame(frame);
  return JSON.stringify({
    runId: encoded.runId,
    runSeq: encoded.runSeq,
    epochMs: encoded.epochMs,
    scope: encoded.scope,
    parser: encoded.parser,
    quality: encoded.quality,
    observed: encoded.observed,
    changes: encoded.changes.map((change) => [
      change[0],
      change[1],
      change[2],
      change[3],
      change[4],
      change[5],
    ]),
  });
}

function isSemanticallyEquivalentFrame(left: MetricFrame, right: MetricFrame): boolean {
  return semanticFrameMaterial(left) === semanticFrameMaterial(right);
}

/** Build a deterministic, side-effect-free frame compaction plan. Winners are
 * chosen independently per work and metric, so staggered changes in one time
 * bucket are not lost merely because another work changed later. */
export function buildMetricFrameCompactionPlan(
  frames: readonly MetricFrame[],
  now: string | number | Date = Date.now(),
): MetricFrameCompactionPlan {
  const nowMs = retentionNowMs(now);
  const ordered = [...frames].sort((left, right) =>
    compareMetricFrameRecords(left, right) || metricFrameIdentity(left).localeCompare(metricFrameIdentity(right)));
  const fieldWinners = new Map<string, MetricFrame>();
  const rankingWinners = new Map<string, MetricFrame>();
  const firstChangeByOrdinal = new Map<number, MetricFrame>();
  let considered = 0;
  for (const frame of ordered) {
    const bucket = frameBucket(frame, nowMs);
    if (!bucket) continue;
    considered += 1;
    for (const change of frame.changes) {
      if (!firstChangeByOrdinal.has(change[0])) firstChangeByOrdinal.set(change[0], frame);
      for (const key of METRIC_FRAME_METRIC_KEYS) {
        const bit = metricMaskForKey(key);
        if ((change[1] & bit) !== 0) fieldWinners.set(`${change[0]}:${bit}:${bucket}`, frame);
      }
      if (change[4] !== null) rankingWinners.set(`${change[0]}:${bucket}`, frame);
    }
  }
  if (considered === 0) return { considered: 0, rewrites: [], deletes: [], lossySources: [] };

  const rewrites: MetricFrameCompactionRewrite[] = [];
  const deletes: MetricFrameCompactionDelete[] = [];
  const lossySources: MetricFrame[] = [];
  const digestByFrame = new Map<MetricFrame, string>();
  const digestOf = (frame: MetricFrame): string => {
    const existing = digestByFrame.get(frame);
    if (existing !== undefined) return existing;
    const digest = metricFrameDigest(frame);
    digestByFrame.set(frame, digest);
    return digest;
  };
  for (const frame of ordered) {
    const bucket = frameBucket(frame, nowMs);
    if (!bucket) continue;
    // Observation membership is semantic even for partial frames: a work can
    // reappear without changing a metric. The packed ordinal set is cheap, so
    // retain it while applying time thinning only to metric changes.
    const keepsObservation = true;
    const changes: MetricFrameChangeInput[] = [];
    for (const change of frame.changes) {
      const sourceValues = valuesByMetric(change);
      const metrics: MetricFrameChangeInput["metrics"] = {};
      for (const key of METRIC_FRAME_METRIC_KEYS) {
        const bit = metricMaskForKey(key);
        if ((change[1] & bit) !== 0 && (firstChangeByOrdinal.get(change[0]) === frame
          || fieldWinners.get(`${change[0]}:${bit}:${bucket}`) === frame)) {
          metrics[key] = sourceValues[key]!;
        }
      }
      const ranking = (firstChangeByOrdinal.get(change[0]) === frame
        || rankingWinners.get(`${change[0]}:${bucket}`) === frame) ? change[4] : null;
      if (Object.keys(metrics).length > 0 || ranking !== null) {
        changes.push({
          ordinal: change[0],
          metrics,
          ...(ranking === null ? {} : { ranking }),
          ...(change[5] === null ? {} : { quality: change[5] }),
          provenance: change[6] ?? {
            sourceRunId: frame.runId,
            sourceRunSeq: frame.runSeq,
            sourceEpochMs: frame.epochMs,
          },
        });
      }
    }
    const observedOrdinals = keepsObservation
      ? unpackMetricOrdinals(frame.observed)
      : [...new Set(changes.map((change) => change.ordinal))].sort((left, right) => left - right);
    const key: [number, number, string] = [frame.epochMs, frame.runSeq, frame.runId];
    // An empty complete frame means every known work is absent. It is a state
    // transition, not an empty record, and must survive compaction.
    if (observedOrdinals.length === 0 && changes.length === 0 && frame.scope !== "complete") {
      deletes.push({
        sourceIdentity: metricFrameIdentity(frame),
        sourceDigest: digestOf(frame),
        key,
      });
      lossySources.push(frame);
      continue;
    }
    const resultingFrame = createMetricFrame({
      runId: frame.runId,
      runSeq: frame.runSeq,
      epochMs: frame.epochMs,
      scope: keepsObservation ? frame.scope : "partial",
      parser: frame.parser,
      quality: frame.quality,
      kind: "compacted",
      observedOrdinals,
      changes,
      provenance: frame.provenance ?? {
        sourceRunId: frame.runId,
        sourceRunSeq: frame.runSeq,
        sourceEpochMs: frame.epochMs,
      },
    });
    if (!isSemanticallyEquivalentFrame(frame, resultingFrame)) lossySources.push(frame);
    const sourceDigest = digestOf(frame);
    if (sourceDigest !== metricFrameDigest(resultingFrame)) {
      rewrites.push({
        sourceIdentity: metricFrameIdentity(frame),
        sourceDigest,
        frame: resultingFrame,
      });
    }
  }
  return { considered, rewrites, deletes, lossySources };
}
