import {
  compareMetricFrameRecords,
  createWorkDictionary,
  METRIC_FRAME_CODEC,
  METRIC_FRAME_CODEC_VERSION,
  METRIC_FRAME_FULL_MASK,
  METRIC_FRAME_METRIC_KEYS,
  metricKeysForMask,
  normalizeMetricRanking,
  observationStamp,
  type MetricChangeTuple,
  type MetricFrame,
  type MetricFrameChangeInput,
  type MetricFrameDraft,
  type MetricFrameHeader,
  type MetricFrameInput,
  type MetricFrameKind,
  type MetricFrameMetricKey,
  type MetricFramePresence,
  type MetricFrameProvenance,
  type MetricFrameRecord,
  type MetricRankingOverride,
  type MetricKeyframe,
  type MetricKeyframeState,
  type MetricObservationStamp,
  type MetricRange,
  type MetricRangeState,
  type RankingSource,
  type RankingStatus,
  type WorkDictionary,
  type WorkDictionaryEntry,
} from "../domain/metric-frames";
import type { WorkMetrics } from "../domain/types";

export class MetricFrameCodecError extends Error {
  readonly code = "METRIC_FRAME_INTEGRITY" as const;

  constructor(message: string) {
    super(message);
    this.name = "MetricFrameCodecError";
  }
}

export const MetricFrameIntegrityError = MetricFrameCodecError;
export const MetricFrameDataError = MetricFrameCodecError;

export interface StoredWorkDictionary {
  codec: typeof METRIC_FRAME_CODEC;
  codecVersion: typeof METRIC_FRAME_CODEC_VERSION;
  nextOrdinal: number;
  entries: Array<[number, string]>;
}

export type StoredMetricFrame = MetricFrame;
export type StoredMetricKeyframe = MetricKeyframe;

function fail(message: string): never {
  throw new MetricFrameCodecError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKeyframeValue(value: unknown): boolean {
  return isRecord(value) && (value.kind === "keyframe" || Object.prototype.hasOwnProperty.call(value, "states"));
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`Invalid ${field}`);
  return value;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`Invalid ${field}`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`Invalid ${field}`);
  return value;
}

function finiteNumberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, field);
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    fail(`Invalid ${field}`);
  }
  return value;
}

function epochMilliseconds(value: unknown, field: string): number {
  const epochMs = safeInteger(value, field, Number.MIN_SAFE_INTEGER);
  if (!Number.isFinite(new Date(epochMs).getTime())) fail(`Invalid ${field}`);
  return epochMs;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return finiteNumber(value, field);
}

function cloneMetrics(metrics: WorkMetrics): WorkMetrics {
  return {
    likes: metrics.likes,
    bookmarks: metrics.bookmarks,
    views: metrics.views,
    comments: metrics.comments,
    rank: metrics.rank,
    responses: metrics.responses,
    illustrations: metrics.illustrations,
  };
}

function validateMetrics(value: unknown, field = "metrics"): WorkMetrics {
  if (!isRecord(value)) fail(`Missing or malformed ${field}`);
  return {
    likes: finiteNumberOrNull(value.likes, `${field}.likes`),
    bookmarks: finiteNumberOrNull(value.bookmarks, `${field}.bookmarks`),
    views: finiteNumberOrNull(value.views, `${field}.views`),
    comments: finiteNumberOrNull(value.comments, `${field}.comments`),
    rank: finiteNumberOrNull(value.rank, `${field}.rank`),
    responses: finiteNumberOrNull(value.responses, `${field}.responses`),
    illustrations: finiteNumberOrNull(value.illustrations, `${field}.illustrations`),
  };
}

function validateMetricKey(value: unknown): value is MetricFrameMetricKey {
  return typeof value === "string" && (METRIC_FRAME_METRIC_KEYS as readonly string[]).includes(value);
}

function cloneProvenance(value: MetricFrameProvenance | undefined | null): MetricFrameProvenance | null {
  if (value == null) return null;
  return {
    ...(value.sourceRunId === undefined ? {} : { sourceRunId: value.sourceRunId }),
    ...(value.sourceRunSeq === undefined ? {} : { sourceRunSeq: value.sourceRunSeq }),
    ...(value.sourceEpochMs === undefined ? {} : { sourceEpochMs: value.sourceEpochMs }),
    ...(value.sourceCollectedAt === undefined ? {} : { sourceCollectedAt: value.sourceCollectedAt }),
    ...(value.sourceFrameId === undefined ? {} : { sourceFrameId: value.sourceFrameId }),
  };
}

function normalizeProvenance(value: unknown, field: string): MetricFrameProvenance | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail(`Invalid ${field}`);
  const sourceRunId = value.sourceRunId ?? value.runId;
  const sourceRunSeq = value.sourceRunSeq ?? value.runSeq;
  const sourceEpochMs = value.sourceEpochMs ?? value.epochMs;
  const sourceCollectedAt = value.sourceCollectedAt ?? value.collectedAt;
  const sourceFrameId = value.sourceFrameId ?? value.frameId;
  if (sourceRunId !== undefined) nonEmptyString(sourceRunId, `${field}.sourceRunId`);
  if (sourceRunSeq !== undefined) safeInteger(sourceRunSeq, `${field}.sourceRunSeq`);
  if (sourceEpochMs !== undefined) epochMilliseconds(sourceEpochMs, `${field}.sourceEpochMs`);
  if (sourceCollectedAt !== undefined) nullableTimestamp(sourceCollectedAt, `${field}.sourceCollectedAt`);
  if (sourceFrameId !== undefined) nonEmptyString(sourceFrameId, `${field}.sourceFrameId`);
  if (sourceRunId === undefined && sourceRunSeq === undefined && sourceEpochMs === undefined
    && sourceCollectedAt === undefined && sourceFrameId === undefined) {
    fail(`${field} must retain at least one source field`);
  }
  return {
    ...(sourceRunId === undefined ? {} : { sourceRunId: sourceRunId as string }),
    ...(sourceRunSeq === undefined ? {} : { sourceRunSeq: sourceRunSeq as number }),
    ...(sourceEpochMs === undefined ? {} : { sourceEpochMs: sourceEpochMs as number }),
    ...(sourceCollectedAt === undefined ? {} : { sourceCollectedAt: sourceCollectedAt as string }),
    ...(sourceFrameId === undefined ? {} : { sourceFrameId: sourceFrameId as string }),
  };
}

function provenanceFromRecord(value: Record<string, unknown>, field = "frame provenance"): MetricFrameProvenance | null {
  return normalizeProvenance(value.provenance ?? value.sourceProvenance ?? value.source, field);
}

function rankingSource(value: unknown, field: string): RankingSource {
  if (value === null) return null;
  if (value === "api" || value === "page") return value;
  fail(`Invalid ${field}`);
}

function rankingStatus(value: unknown, field: string): RankingStatus {
  if (value === "unknown" || value === "ranked" || value === "unranked") return value;
  fail(`Invalid ${field}`);
}

function normalizeRankingOverride(value: unknown, field: string): MetricRankingOverride | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail(`Invalid ${field}`);
  const status = rankingStatus(value.status ?? value.rankingStatus, `${field}.status`);
  const observedAt = nullableTimestamp(value.observedAt ?? value.rankingObservedAt ?? null, `${field}.observedAt`);
  const source = rankingSource(value.source ?? value.rankingSource ?? null, `${field}.source`);
  if (status === "unknown" && (observedAt !== null || source !== null)) fail(`${field} unknown status must have null metadata`);
  return { status, observedAt: status === "unknown" ? null : observedAt, source: status === "unknown" ? null : source };
}

function codecFields(value: Record<string, unknown>, field: string): void {
  if (value.codec !== undefined && value.codec !== METRIC_FRAME_CODEC) fail(`Unknown ${field} codec`);
  if (value.codecVersion !== undefined && value.codecVersion !== METRIC_FRAME_CODEC_VERSION) fail(`Unknown ${field} codec version`);
}

function frameHeader(value: Record<string, unknown>, field: string): MetricFrameHeader {
  const runId = nonEmptyString(value.runId, `${field} runId`);
  const runSeq = safeInteger(value.runSeq, `${field} runSeq`);
  const epochMs = epochMilliseconds(value.epochMs, `${field} epochMs`);
  const scope = value.scope;
  if (scope !== "complete" && scope !== "partial") fail(`Invalid ${field} scope`);
  const parserValue = value.parser ?? value.parserVersion;
  const qualityValue = value.quality ?? value.dataQuality;
  const parser = safeInteger(parserValue, `${field} parser`);
  const quality = finiteNumber(qualityValue, `${field} quality`);
  return { runId, runSeq, epochMs, scope, parser, quality };
}

/** Pack an iterable of absolute ordinals into sorted deltas. */
export function packMetricOrdinals(ordinals: Iterable<number>): number[] {
  const sorted = [...ordinals].map((ordinal) => safeInteger(ordinal, "work ordinal")).sort((left, right) => left - right);
  const unique: number[] = [];
  for (const ordinal of sorted) {
    if (unique.at(-1) !== ordinal) unique.push(ordinal);
  }
  const packed: number[] = [];
  let previous = 0;
  for (const ordinal of unique) {
    packed.push(ordinal - previous);
    previous = ordinal;
  }
  return packed;
}

/** Decode a delta-packed ordinal array and enforce ascending uniqueness. */
export function unpackMetricOrdinals(value: unknown): number[] {
  if (!Array.isArray(value)) fail("Malformed observed ordinal deltas");
  const result: number[] = [];
  let previous = 0;
  for (let index = 0; index < value.length; index += 1) {
    const delta = safeInteger(value[index], `observed ordinal delta ${index}`);
    if (index > 0 && delta === 0) fail("Observed ordinals must be strictly ascending");
    const ordinal = previous + delta;
    if (!Number.isSafeInteger(ordinal)) fail("Observed ordinal exceeds safe integer range");
    result.push(ordinal);
    previous = ordinal;
  }
  return result;
}

export const packOrdinals = packMetricOrdinals;
export const unpackOrdinals = unpackMetricOrdinals;
export const deltaPackOrdinals = packMetricOrdinals;
export const deltaUnpackOrdinals = unpackMetricOrdinals;

function popcount(mask: number): number {
  let count = 0;
  for (let bit = mask; bit !== 0; bit >>>= 1) count += bit & 1;
  return count;
}

function validateMask(value: unknown, field: string): number {
  const mask = safeInteger(value, field);
  if (mask > METRIC_FRAME_FULL_MASK) fail(`Invalid ${field}`);
  return mask;
}

function normalizeChangeTuple(value: unknown, field: string): MetricChangeTuple {
  if (!Array.isArray(value) || value.length < 4 || value.length > 7) fail(`Malformed ${field}`);
  const ordinal = safeInteger(value[0], `${field} ordinal`);
  const changedMask = validateMask(value[1], `${field} changedMask`);
  const nullMask = validateMask(value[2], `${field} nullMask`);
  if ((nullMask & ~changedMask) !== 0) fail(`${field} nullMask must be a subset of changedMask`);
  const valuesRaw = value[3];
  if (!Array.isArray(valuesRaw)) fail(`Invalid ${field} values`);
  const values = valuesRaw.map((item, index) => finiteNumber(item, `${field} value ${index}`));
  if (values.length !== popcount(changedMask & ~nullMask)) {
    fail(`${field} values do not match changedMask/nullMask`);
  }
  const ranking = normalizeRankingOverride(value.length > 4 ? value[4] : null, `${field} rankingOverride`);
  const quality = value.length > 5 && value[5] !== undefined && value[5] !== null
    ? finiteNumber(value[5], `${field} qualityOverride`)
    : null;
  const provenance = normalizeProvenance(value.length > 6 ? value[6] : null, `${field} provenance`);
  return [ordinal, changedMask, nullMask, values, ranking, quality, provenance];
}

function changeTupleFromInput(value: MetricFrameChangeInput | MetricChangeTuple, field: string): MetricChangeTuple {
  if (Array.isArray(value)) return normalizeChangeTuple(value, field);
  if (!isRecord(value)) fail(`Malformed ${field}`);
  const ordinal = safeInteger(value.ordinal, `${field} ordinal`);
  const metrics = value.metrics;
  if (!isRecord(metrics)) fail(`Invalid ${field} metrics`);
  let changedMask = 0;
  let nullMask = 0;
  const values: number[] = [];
  for (let index = 0; index < METRIC_FRAME_METRIC_KEYS.length; index += 1) {
    const key = METRIC_FRAME_METRIC_KEYS[index]!;
    if (!Object.prototype.hasOwnProperty.call(metrics, key)) continue;
    const metricValue = metrics[key];
    if (metricValue !== null && typeof metricValue !== "number") fail(`Invalid ${field} metrics.${key}`);
    if (typeof metricValue === "number") finiteNumber(metricValue, `${field} metrics.${key}`);
    const bit = 1 << index;
    changedMask |= bit;
    if (metricValue === null) nullMask |= bit;
    else values.push(metricValue as number);
  }
  const ranking = normalizeRankingOverride(value.ranking, `${field} rankingOverride`);
  const quality = optionalFiniteNumber(value.quality, `${field} qualityOverride`) ?? null;
  const provenance = normalizeProvenance(value.provenance ?? value.sourceProvenance, `${field} provenance`);
  return [ordinal, changedMask, nullMask, values, ranking, quality, provenance];
}

function changesFromRaw(value: unknown): MetricChangeTuple[] {
  if (!Array.isArray(value)) fail("Missing or malformed frame changes");
  const changes = value.map((item, index) => normalizeChangeTuple(item, `frame change ${index}`));
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index - 1]![0] >= changes[index]![0]) fail("Frame changes must be strictly ordinal-sorted");
  }
  return changes;
}

function validateObservedAndChanges(observedPacked: number[], changes: readonly MetricChangeTuple[]): void {
  const observed = unpackMetricOrdinals(observedPacked);
  const observedSet = new Set(observed);
  const seen = new Set<number>();
  for (const change of changes) {
    const ordinal = change[0];
    if (seen.has(ordinal)) fail("Frame contains duplicate ordinal changes");
    seen.add(ordinal);
    if (!observedSet.has(ordinal)) fail("Every changed ordinal must be observed in the same frame");
  }
}

function validateSharedRunHeaders(records: readonly MetricFrameRecord[]): void {
  const byRunId = new Map<string, MetricFrameHeader>();
  for (const record of records) {
    const previous = byRunId.get(record.runId);
    if (previous === undefined) {
      byRunId.set(record.runId, record);
      continue;
    }
    if (previous.runSeq !== record.runSeq || previous.epochMs !== record.epochMs
      || previous.scope !== record.scope || previous.parser !== record.parser || previous.quality !== record.quality) {
      fail(`MetricFrame run ${record.runId} has inconsistent shared header`);
    }
  }
}

function frameKind(value: unknown): MetricFrameKind {
  if (value === undefined || value === null) return "normal";
  if (value === "normal" || value === "compacted") return value;
  if (value === true) return "compacted";
  if (value === false) return "normal";
  fail("Invalid frame kind");
}

function validateFrameObject(value: unknown): MetricFrame {
  if (!isRecord(value)) fail("Missing or malformed MetricFrame");
  codecFields(value, "MetricFrame");
  const header = frameHeader(value, "MetricFrame");
  const kind = frameKind(value.kind ?? value.compacted);
  const observedRaw = value.observed;
  const observed = Array.isArray(observedRaw)
    ? observedRaw.map((item, index) => safeInteger(item, `observed ordinal delta ${index}`))
    : fail("Missing or malformed frame observed ordinals");
  unpackMetricOrdinals(observed);
  const changes = changesFromRaw(value.changes);
  validateObservedAndChanges(observed, changes);
  const provenance = provenanceFromRecord(value);
  if (kind === "compacted" && provenance === null && (changes.length === 0 || changes.some((change) => change[6] === null))) {
    fail("Compacted frame must retain source provenance");
  }
  const frame: MetricFrame = {
    ...header,
    codec: METRIC_FRAME_CODEC,
    codecVersion: METRIC_FRAME_CODEC_VERSION,
    kind,
    observed,
    changes,
  };
  if (provenance !== null) frame.provenance = provenance;
  return frame;
}

/** Validate a stored/public frame and return a detached canonical copy. */
export function validateMetricFrame(value: unknown): MetricFrame {
  return validateFrameObject(value);
}

function headerFromDraft(value: MetricFrameDraft): MetricFrameHeader {
  const parser = value.parser ?? value.parserVersion;
  const quality = value.quality ?? value.dataQuality;
  return frameHeader({ ...value, parser, quality }, "MetricFrame");
}

/** Build a frame from expanded observed ordinals and logical sparse changes. */
export function createMetricFrame(value: MetricFrameDraft): MetricFrame {
  const header = headerFromDraft(value);
  const observedOrdinals = value.observedOrdinals ?? value.observed ?? [];
  const observed = packMetricOrdinals(observedOrdinals);
  const rawChanges = value.changes.map((change, index) => changeTupleFromInput(change, `frame change ${index}`));
  rawChanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < rawChanges.length; index += 1) {
    if (rawChanges[index - 1]![0] === rawChanges[index]![0]) fail("Frame contains duplicate ordinal changes");
  }
  const frame: MetricFrame = {
    ...header,
    codec: METRIC_FRAME_CODEC,
    codecVersion: METRIC_FRAME_CODEC_VERSION,
    kind: value.kind ?? (value.compacted === true ? "compacted" : "normal"),
    observed,
    changes: rawChanges,
  };
  const provenance = normalizeProvenance(value.provenance ?? value.sourceProvenance, "frame provenance");
  if (provenance !== null) frame.provenance = provenance;
  return validateMetricFrame(frame);
}

export interface MetricKeyframeDraft extends MetricFrameHeader {
  states: readonly (MetricKeyframeState | Record<string, unknown>)[] | ReadonlyMap<number, MetricKeyframeState>;
  provenance?: MetricFrameProvenance | null;
  sourceProvenance?: MetricFrameProvenance | null;
}

function observationFromRaw(value: unknown, header: MetricFrameHeader, field: string): MetricObservationStamp | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    nullableTimestamp(value, field);
    const epochMs = Date.parse(value);
    return { runId: header.runId, runSeq: header.runSeq, epochMs, collectedAt: value };
  }
  if (!isRecord(value)) fail(`Invalid ${field}`);
  const runId = nonEmptyString(value.runId ?? header.runId, `${field}.runId`);
  const runSeq = safeInteger(value.runSeq ?? header.runSeq, `${field}.runSeq`);
  const collectedAtValue = value.collectedAt;
  const epochValue = value.epochMs ?? (typeof collectedAtValue === "string" ? Date.parse(collectedAtValue) : undefined);
  const epochMs = safeInteger(epochValue, `${field}.epochMs`, Number.MIN_SAFE_INTEGER);
  const collectedAt = collectedAtValue === undefined
    ? new Date(epochMs).toISOString()
    : nonEmptyString(collectedAtValue, `${field}.collectedAt`);
  if (!Number.isFinite(Date.parse(collectedAt))) fail(`Invalid ${field}.collectedAt`);
  if (Date.parse(collectedAt) !== epochMs) fail(`${field}.epochMs does not match collectedAt`);
  return { runId, runSeq, epochMs, collectedAt };
}

function presence(value: unknown, field: string): MetricFramePresence {
  if (value === "present" || value === true) return "present";
  if (value === "absent" || value === false) return "absent";
  fail(`Invalid ${field}`);
}

function keyframeState(value: unknown, header: MetricFrameHeader, index: number): MetricKeyframeState {
  if (!isRecord(value)) fail(`Malformed keyframe state ${index}`);
  const ordinal = safeInteger(value.ordinal, `keyframe state ${index} ordinal`);
  const rawMetrics = validateMetrics(value.metrics, `keyframe state ${index} metrics`);
  const normalizedRanking = normalizeMetricRanking(
    rawMetrics,
    value.rankingStatus,
    value.rankingObservedAt,
    value.rankingSource,
  );
  const statePresence = presence(value.presence ?? value.present, `keyframe state ${index} presence`);
  const absentSince = nullableTimestamp(value.absentSince ?? null, `keyframe state ${index} absentSince`);
  if (statePresence === "present" && absentSince !== null) fail("Present keyframe state cannot have absentSince");
  const lastObserved = observationFromRaw(value.lastObserved ?? value.lastObservedAt, header, `keyframe state ${index} lastObserved`);
  if (statePresence === "present" && lastObserved === null) fail("Present keyframe state must have lastObserved");
  const parser = value.parser === undefined ? header.parser : safeInteger(value.parser, `keyframe state ${index} parser`);
  const quality = value.quality === undefined ? header.quality : finiteNumber(value.quality, `keyframe state ${index} quality`);
  const stateProvenance = normalizeProvenance(value.provenance ?? value.sourceProvenance ?? value.source, `keyframe state ${index} provenance`);
  return {
    ordinal,
    metrics: normalizedRanking.metrics,
    rankingStatus: normalizedRanking.rankingStatus,
    rankingObservedAt: normalizedRanking.rankingObservedAt,
    rankingSource: normalizedRanking.rankingSource,
    presence: statePresence,
    absentSince,
    lastObserved,
    parser,
    quality,
    provenance: stateProvenance,
  };
}

function statesFromRaw(value: unknown, header: MetricFrameHeader): MetricKeyframeState[] {
  if (value instanceof Map) {
    for (const [mapOrdinal, state] of value.entries()) {
      const ordinal = safeInteger(mapOrdinal, "keyframe map ordinal");
      if (!isRecord(state) || state.ordinal !== ordinal) fail("Keyframe map key does not match state ordinal");
    }
  }
  const rawStates = value instanceof Map ? [...value.values()] : value;
  if (!Array.isArray(rawStates)) fail("Missing or malformed keyframe states");
  const states = rawStates.map((state, index) => keyframeState(state, header, index));
  states.sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 1; index < states.length; index += 1) {
    if (states[index - 1]!.ordinal === states[index]!.ordinal) fail("Keyframe contains duplicate ordinal state");
  }
  return states;
}

function validateKeyframeObject(value: unknown): MetricKeyframe {
  if (!isRecord(value)) fail("Missing or malformed MetricKeyframe");
  codecFields(value, "MetricKeyframe");
  const header = frameHeader(value, "MetricKeyframe");
  if (value.kind !== undefined && value.kind !== "keyframe") fail("Invalid keyframe kind");
  const states = statesFromRaw(value.states, header);
  const provenance = provenanceFromRecord(value, "keyframe provenance");
  const keyframe: MetricKeyframe = {
    ...header,
    codec: METRIC_FRAME_CODEC,
    codecVersion: METRIC_FRAME_CODEC_VERSION,
    kind: "keyframe",
    states,
  };
  if (provenance !== null) keyframe.provenance = provenance;
  return keyframe;
}

export function validateMetricKeyframe(value: unknown): MetricKeyframe {
  return validateKeyframeObject(value);
}

/** Build a detached full-state keyframe from an array or state map. */
export function createMetricKeyframe(
  header: MetricFrameHeader,
  states: readonly MetricKeyframeState[] | ReadonlyMap<number, MetricKeyframeState>,
  provenance?: MetricFrameProvenance | null,
): MetricKeyframe {
  const normalizedHeader = frameHeader({ ...header }, "MetricKeyframe");
  const keyframe: MetricKeyframe = {
    ...normalizedHeader,
    codec: METRIC_FRAME_CODEC,
    codecVersion: METRIC_FRAME_CODEC_VERSION,
    kind: "keyframe",
    states: statesFromRaw(states instanceof Map ? states : states, normalizedHeader),
  };
  const normalizedProvenance = normalizeProvenance(provenance, "keyframe provenance");
  if (normalizedProvenance !== null) keyframe.provenance = normalizedProvenance;
  return validateMetricKeyframe(keyframe);
}

function stateMap(value: MetricRangeState | ReadonlyMap<number, MetricKeyframeState> | undefined): Map<number, MetricKeyframeState> {
  const result = new Map<number, MetricKeyframeState>();
  if (value === undefined) return result;
  for (const [ordinal, state] of value.entries()) {
    result.set(ordinal, cloneKeyframeState(state));
  }
  return result;
}

function cloneStamp(value: MetricObservationStamp | null): MetricObservationStamp | null {
  return value === null ? null : { ...value };
}

function cloneKeyframeState(value: MetricKeyframeState): MetricKeyframeState {
  return {
    ...value,
    metrics: cloneMetrics(value.metrics),
    lastObserved: cloneStamp(value.lastObserved),
    provenance: cloneProvenance(value.provenance),
  };
}

function compareStamps(left: MetricObservationStamp, right: MetricObservationStamp): number {
  return left.epochMs - right.epochMs || left.runSeq - right.runSeq;
}

function applyValues(metrics: WorkMetrics, change: MetricChangeTuple): WorkMetrics {
  const next = cloneMetrics(metrics);
  let valueIndex = 0;
  const [ordinal, changedMask, nullMask, values] = change;
  void ordinal;
  for (const key of metricKeysForMask(changedMask)) {
    const bit = 1 << METRIC_FRAME_METRIC_KEYS.indexOf(key);
    next[key] = (nullMask & bit) !== 0 ? null : values[valueIndex++]!;
  }
  return next;
}

function stateWithChange(
  previous: MetricKeyframeState | undefined,
  change: MetricChangeTuple | undefined,
  header: MetricFrameHeader,
  frameProvenance: MetricFrameProvenance | undefined,
): MetricKeyframeState {
  const first = previous === undefined || previous.lastObserved === null;
  if (change === undefined && first) {
    fail("A new observed work requires a full metric change");
  }
  if (first && change![1] !== METRIC_FRAME_FULL_MASK) fail("The first frame for a work must contain the full metric mask");
  const initialMetrics: WorkMetrics = {
    likes: null,
    bookmarks: null,
    views: null,
    comments: null,
    rank: null,
    responses: null,
    illustrations: null,
  };
  const metrics = change === undefined ? cloneMetrics(previous!.metrics) : applyValues(first ? initialMetrics : previous!.metrics, change);
  const rankChanged = change !== undefined && (change[1] & (1 << METRIC_FRAME_METRIC_KEYS.indexOf("rank"))) !== 0;
  const ranking = change?.[4] ?? null;
  const normalizedRanking = normalizeMetricRanking(
    metrics,
    ranking !== null ? ranking.status : rankChanged ? undefined : previous?.rankingStatus,
    ranking !== null ? ranking.observedAt : rankChanged ? undefined : previous?.rankingObservedAt,
    ranking !== null ? ranking.source : rankChanged ? undefined : previous?.rankingSource,
  );
  const stamp = observationStamp(header);
  const lastObserved = previous?.lastObserved === null || previous?.lastObserved === undefined
    ? stamp
    : compareStamps(previous.lastObserved, stamp) <= 0 ? stamp : cloneStamp(previous.lastObserved);
  const quality = change?.[5] ?? header.quality;
  const provenance = change?.[6] ?? (frameProvenance ?? previous?.provenance ?? null);
  return {
    ordinal: change?.[0] ?? previous!.ordinal,
    metrics: normalizedRanking.metrics,
    rankingStatus: normalizedRanking.rankingStatus,
    rankingObservedAt: normalizedRanking.rankingObservedAt,
    rankingSource: normalizedRanking.rankingSource,
    presence: "present",
    absentSince: null,
    lastObserved,
    parser: header.parser,
    quality,
    provenance: cloneProvenance(provenance),
  };
}

function absentState(previous: MetricKeyframeState | undefined, ordinal: number, header: MetricFrameHeader): MetricKeyframeState {
  if (previous === undefined) {
    return {
      ordinal,
      metrics: { likes: null, bookmarks: null, views: null, comments: null, rank: null, responses: null, illustrations: null },
      rankingStatus: "unknown",
      rankingObservedAt: null,
      rankingSource: null,
      presence: "absent",
      absentSince: new Date(header.epochMs).toISOString(),
      lastObserved: null,
      parser: header.parser,
      quality: header.quality,
      provenance: null,
    };
  }
  return {
    ...cloneKeyframeState(previous),
    presence: "absent",
    absentSince: previous.absentSince ?? new Date(header.epochMs).toISOString(),
  };
}

function validateDictionaryReference(dictionary: WorkDictionary | undefined, ordinal: number): void {
  if (dictionary !== undefined && !dictionary.entries.some((entry) => entry.ordinal === ordinal)) {
    fail(`Ordinal ${ordinal} is not present in the work dictionary`);
  }
}

/** Apply one frame immutably. A missing previous state proves that this is a
 * new work, so its first change is required to carry the full metric mask. */
export function applyMetricFrame(
  value: MetricFrame,
  previous: MetricRangeState = new Map<number, MetricKeyframeState>(),
  dictionary?: WorkDictionary,
): MetricRangeState {
  const frame = validateMetricFrame(value);
  const checkedDictionary = dictionary === undefined ? undefined : decodeWorkDictionary(dictionary);
  const result = stateMap(previous);
  const observed = unpackMetricOrdinals(frame.observed);
  const changes = new Map(frame.changes.map((change) => [change[0], change] as const));
  for (const ordinal of observed) validateDictionaryReference(checkedDictionary, ordinal);
  if (checkedDictionary !== undefined) {
    for (const change of frame.changes) validateDictionaryReference(checkedDictionary, change[0]);
  }
  if (frame.scope === "complete") {
    const knownOrdinals = checkedDictionary?.entries.map((entry) => entry.ordinal) ?? [...result.keys()];
    const observedSet = new Set(observed);
    for (const ordinal of knownOrdinals) {
      if (!observedSet.has(ordinal)) result.set(ordinal, absentState(result.get(ordinal), ordinal, frame));
    }
  }
  for (const ordinal of observed) {
    const state = stateWithChange(result.get(ordinal), changes.get(ordinal), frame, frame.provenance);
    result.set(ordinal, state);
  }
  return result;
}

export function applyMetricKeyframe(
  value: MetricKeyframe,
  _previous: MetricRangeState = new Map<number, MetricKeyframeState>(),
  dictionary?: WorkDictionary,
): MetricRangeState {
  const keyframe = validateMetricKeyframe(value);
  const result = new Map<number, MetricKeyframeState>();
  for (const state of keyframe.states) {
    validateDictionaryReference(dictionary, state.ordinal);
    result.set(state.ordinal, cloneKeyframeState(state));
  }
  return result;
}

function sortedRecords(records: readonly MetricFrameRecord[]): MetricFrameRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => compareMetricFrameRecords(left.record, right.record) || left.index - right.index)
    .map((item) => item.record);
}

/** Apply frames in timestamp/run sequence order. Same-millisecond frames are
 * ordered by runSeq and retain input order for an equal sequence. */
export function applyMetricFrames(
  values: readonly MetricFrameRecord[],
  previous: MetricRangeState = new Map<number, MetricKeyframeState>(),
  dictionary?: WorkDictionary,
): MetricRangeState {
  const records = values.map((value) => isKeyframeValue(value)
    ? validateMetricKeyframe(value)
    : validateMetricFrame(value));
  validateSharedRunHeaders(records);
  let state = stateMap(previous);
  for (const record of sortedRecords(records)) {
    state = record.kind === "keyframe"
      ? new Map(applyMetricKeyframe(record, state, dictionary))
      : new Map(applyMetricFrame(record, state, dictionary));
  }
  return state;
}

/** Rebuild the state at the end of a range, restarting at the nearest
 * keyframe at or before the range start/end boundary when one is available. */
export function reconstructMetricRange(
  values: readonly MetricFrameRecord[],
  range: MetricRange = {},
  previous: MetricRangeState = new Map<number, MetricKeyframeState>(),
  dictionary?: WorkDictionary,
): MetricRangeState {
  const startMs = rangeBound(range.startMs, "metric range startMs", Number.NEGATIVE_INFINITY);
  const endMs = rangeBound(range.endMs, "metric range endMs", Number.POSITIVE_INFINITY);
  if (startMs > endMs) fail("Metric range start is after range end");
  const records = sortedRecords(values.map((value) => isKeyframeValue(value)
    ? validateMetricKeyframe(value)
    : validateMetricFrame(value)));
  validateSharedRunHeaders(records);
  let keyframeIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.kind === "keyframe" && record.epochMs <= (Number.isFinite(startMs) ? startMs : endMs)) {
      keyframeIndex = index;
    }
  }
  let state = stateMap(previous);
  if (keyframeIndex >= 0) state = new Map(applyMetricKeyframe(records[keyframeIndex] as MetricKeyframe, state, dictionary));
  const baselineIndex = keyframeIndex >= 0 ? keyframeIndex + 1 : 0;
  for (let index = baselineIndex; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.epochMs > endMs) break;
    if (record.kind === "keyframe") {
      state = new Map(applyMetricKeyframe(record, state, dictionary));
    } else {
      state = new Map(applyMetricFrame(record, state, dictionary));
    }
  }
  return state;
}

export const rebuildMetricRange = reconstructMetricRange;
export const reconstructRangeState = reconstructMetricRange;
export const rebuildRangeFromKeyframe = reconstructMetricRange;
export const applyFrame = applyMetricFrame;
export const applyFrames = applyMetricFrames;

function rangeBound(value: number | null | undefined, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return epochMilliseconds(value, field);
}

/** Validate a whole sequence by applying it to a fresh state. */
export function validateMetricFrameSequence(
  values: readonly MetricFrameRecord[],
  dictionary?: WorkDictionary,
): true {
  applyMetricFrames(values, new Map<number, MetricKeyframeState>(), dictionary);
  return true;
}

export const validateFrameInvariants = validateMetricFrameSequence;

export function encodeWorkDictionary(value: WorkDictionary): StoredWorkDictionary {
  const dictionary = decodeWorkDictionary(value);
  return {
    codec: METRIC_FRAME_CODEC,
    codecVersion: METRIC_FRAME_CODEC_VERSION,
    nextOrdinal: dictionary.nextOrdinal,
    entries: dictionary.entries.map((entry) => [entry.ordinal, entry.workKey]),
  };
}

export function decodeWorkDictionary(value: unknown): WorkDictionary {
  if (!isRecord(value)) fail("Missing or malformed WorkDictionary");
  codecFields(value, "WorkDictionary");
  const rawEntries = value.entries;
  if (!Array.isArray(rawEntries)) fail("Missing or malformed WorkDictionary entries");
  const entries: WorkDictionaryEntry[] = rawEntries.map((entry, index) => {
    if (Array.isArray(entry) && entry.length === 2) {
      return { ordinal: safeInteger(entry[0], `dictionary entry ${index} ordinal`), workKey: nonEmptyString(entry[1], `dictionary entry ${index} workKey`) };
    }
    if (isRecord(entry)) {
      return { ordinal: safeInteger(entry.ordinal, `dictionary entry ${index} ordinal`), workKey: nonEmptyString(entry.workKey, `dictionary entry ${index} workKey`) };
    }
    fail(`Malformed dictionary entry ${index}`);
  });
  const dictionary = createWorkDictionary(entries);
  const nextOrdinal = value.nextOrdinal === undefined
    ? dictionary.nextOrdinal
    : safeInteger(value.nextOrdinal, "dictionary nextOrdinal");
  if (nextOrdinal < dictionary.nextOrdinal) fail("Dictionary nextOrdinal would reuse an ordinal");
  return { ...dictionary, nextOrdinal };
}

export const encodeDictionary = encodeWorkDictionary;
export const decodeDictionary = decodeWorkDictionary;

export function encodeMetricFrame(value: MetricFrame | MetricFrameInput): StoredMetricFrame {
  const frame = isRecord(value) && Object.prototype.hasOwnProperty.call(value, "observedOrdinals")
    ? createMetricFrame(value as MetricFrameDraft)
    : validateMetricFrame(value);
  return {
    ...frame,
    observed: [...frame.observed],
    changes: frame.changes.map((change) => [
      change[0],
      change[1],
      change[2],
      [...change[3]],
      change[4] ?? null,
      change[5] ?? null,
      cloneProvenance(change[6]),
    ]),
    ...(frame.provenance === undefined ? {} : { provenance: cloneProvenance(frame.provenance)! }),
  };
}

export function decodeMetricFrame(value: unknown): MetricFrame {
  return validateMetricFrame(value);
}

export function decodeMetricRecord(value: unknown): MetricFrameRecord {
  return isKeyframeValue(value) ? decodeMetricKeyframe(value) : decodeMetricFrame(value);
}

export const encodeFrame = encodeMetricFrame;
export const decodeFrame = decodeMetricFrame;
export const decodeRecord = decodeMetricRecord;
export const decodeMetricFrameRecord = decodeMetricRecord;
export const encodeStoredMetricFrame = encodeMetricFrame;
export const decodeStoredMetricFrame = decodeMetricFrame;
export const buildMetricFrame = createMetricFrame;
export const makeMetricFrame = createMetricFrame;
export const buildMetricKeyframe = createMetricKeyframe;
export const makeMetricKeyframe = createMetricKeyframe;
export const validateFrame = validateMetricFrame;
export const validateKeyframe = validateMetricKeyframe;
export const encodeMetricFrames = (values: readonly (MetricFrame | MetricFrameInput)[]): StoredMetricFrame[] => values.map(encodeMetricFrame);
export const encodeMetricRecords = (values: readonly MetricFrameRecord[]): MetricFrameRecord[] => values.map((value) =>
  isKeyframeValue(value) ? encodeMetricKeyframe(value as MetricKeyframe) : encodeMetricFrame(value as MetricFrame));
export const decodeMetricFrames = (values: unknown): MetricFrame[] => {
  if (!Array.isArray(values)) fail("Missing or malformed MetricFrame sequence");
  return values.map(decodeMetricFrame);
};
export const decodeMetricRecords = (values: unknown): MetricFrameRecord[] => {
  if (!Array.isArray(values)) fail("Missing or malformed MetricFrame sequence");
  return values.map(decodeMetricRecord);
};

export function encodeMetricKeyframe(value: MetricKeyframe): StoredMetricKeyframe {
  const keyframe = validateMetricKeyframe(value);
  return {
    ...keyframe,
    states: keyframe.states.map((state) => cloneKeyframeState(state)),
    ...(keyframe.provenance === undefined ? {} : { provenance: cloneProvenance(keyframe.provenance)! }),
  };
}

export function decodeMetricKeyframe(value: unknown): MetricKeyframe {
  return validateMetricKeyframe(value);
}

export const encodeKeyframe = encodeMetricKeyframe;
export const decodeKeyframe = decodeMetricKeyframe;
