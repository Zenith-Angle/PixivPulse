import { COVER_CACHE_MAX_BLOB_BYTES } from "./constants";
import type { CoverRecord } from "./types";

/**
 * The queue deliberately contains no Blob values. It is a small, JSON-safe
 * state machine that can be stored in chrome.storage.local and reconstructed
 * after a service-worker restart.
 */
export const COVER_QUEUE_VERSION = 1 as const;
export const COVER_QUEUE_MAX_ATTEMPTS = 3;
export const COVER_QUEUE_MAX_PENDING_ENTRIES = 512;
export const COVER_QUEUE_MAX_GENERATION_SUMMARIES = 20;
export const COVER_QUEUE_MAX_WORK_OUTCOMES = 512;
export const COVER_QUEUE_MAX_SERIALIZED_BYTES = 256 * 1024;
export const COVER_QUEUE_MAX_ERROR_AGGREGATES = 8;

export type CoverQueueItemStatus = "pending" | "in-flight";

export interface CoverQueueItem {
  /** `${generationId}|${workKey}`; this is the durable obligation identity. */
  key: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  /** Media identity captured when this obligation was enqueued. */
  revision?: number;
  fingerprint?: string;
  generationId: string;
  enqueuedAt: string;
  attempts: number;
  lastErrorCode: string | null;
  /** In-flight is persisted only as a claim; deserialization recovers it. */
  status: CoverQueueItemStatus;
  claimedAt: string | null;
}

export interface CoverQueueErrorAggregate {
  code: string;
  count: number;
}

export type CoverQueueGenerationStatus = "pending" | "completed" | "failed" | "skipped" | "partial";

export interface CoverQueueGenerationSummary {
  generationId: string;
  enqueuedAt: string;
  updatedAt: string;
  enqueued: number;
  pending: number;
  completed: number;
  failed: number;
  skipped: number;
  status: CoverQueueGenerationStatus;
  errorCounts: CoverQueueErrorAggregate[];
}

export type CoverQueueOutcomeStatus = "ready" | "failed" | "skipped-capacity";

export interface CoverQueueWorkOutcome {
  workKey: string;
  generationId: string;
  status: CoverQueueOutcomeStatus;
  completedAt: string;
  errorCode: string | null;
}

export interface CoverQueueState {
  version: typeof COVER_QUEUE_VERSION;
  pending: CoverQueueItem[];
  generationSummaries: CoverQueueGenerationSummary[];
  workOutcomes: CoverQueueWorkOutcome[];
}

export interface CoverQueueLimits {
  /** Preferred name. `maxEntries` is accepted as a compatibility alias. */
  maxPendingEntries?: number;
  maxEntries?: number;
  /** Preferred name. `maxBytes` is accepted as a compatibility alias. */
  maxSerializedBytes?: number;
  maxBytes?: number;
  maxAttempts?: number;
  maxGenerationSummaries?: number;
  maxWorkOutcomes?: number;
  maxErrorAggregates?: number;
}

interface NormalizedCoverQueueLimits {
  maxPendingEntries: number;
  maxSerializedBytes: number;
  maxAttempts: number;
  maxGenerationSummaries: number;
  maxWorkOutcomes: number;
  maxErrorAggregates: number;
}

export class CoverQueueError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CoverQueueError";
    this.code = code;
  }
}

export class CoverQueueCapacityError extends CoverQueueError {
  readonly limit: "entries" | "bytes";
  readonly requested: number;
  readonly available: number;

  constructor(
    limit: "entries" | "bytes",
    requested: number,
    available: number,
    message = limit === "entries"
      ? "Cover queue pending-entry capacity is full"
      : "Cover queue serialized-byte capacity is full",
  ) {
    super("CAPACITY", message);
    this.name = "CoverQueueCapacityError";
    this.limit = limit;
    this.requested = requested;
    this.available = available;
  }
}

export interface CoverQueueWorkInput {
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  revision?: number;
  fingerprint?: string;
}

export interface EnqueueCoverGenerationInput {
  generationId: string;
  enqueuedAt?: string;
  /** `works` is the canonical name; `candidates` is accepted for callers
   * that already use the cover-cache terminology. */
  works?: readonly CoverQueueWorkInput[];
  candidates?: readonly CoverQueueWorkInput[];
}

export interface CoverQueueEnqueueResult {
  state: CoverQueueState;
  enqueued: CoverQueueItem[];
  alreadySatisfied: string[];
  error: CoverQueueCapacityError | null;
  ok: boolean;
}

export interface CoverQueueClaim {
  key: string;
  generationId: string;
  workKey: string;
  attempt: number;
}

export interface CoverQueueBeginResult {
  state: CoverQueueState;
  item: CoverQueueItem | null;
  claim: CoverQueueClaim | null;
  /** True when an item reached the attempt ceiling and was terminally failed. */
  exhausted: boolean;
  failedKey: string | null;
}

export interface CoverQueuePersistenceAcknowledgement {
  /** The caller must set this only after the Blob record is durably stored. */
  persisted: true;
  workKey?: string;
  sourceUrl?: string;
  pipelineVersion?: number;
}

export interface CoverQueueTransitionOptions {
  now?: string;
  completedAt?: string;
  limits?: CoverQueueLimits;
}

const DEFAULT_LIMITS: NormalizedCoverQueueLimits = {
  maxPendingEntries: COVER_QUEUE_MAX_PENDING_ENTRIES,
  maxSerializedBytes: COVER_QUEUE_MAX_SERIALIZED_BYTES,
  maxAttempts: COVER_QUEUE_MAX_ATTEMPTS,
  maxGenerationSummaries: COVER_QUEUE_MAX_GENERATION_SUMMARIES,
  maxWorkOutcomes: COVER_QUEUE_MAX_WORK_OUTCOMES,
  maxErrorAggregates: COVER_QUEUE_MAX_ERROR_AGGREGATES,
};

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  return value == null || !Number.isFinite(value) ? fallback : Math.max(minimum, Math.floor(value));
}

function limitsOf(input: CoverQueueLimits = {}): NormalizedCoverQueueLimits {
  return {
    maxPendingEntries: boundedInteger(input.maxPendingEntries ?? input.maxEntries, DEFAULT_LIMITS.maxPendingEntries, 0),
    maxSerializedBytes: boundedInteger(input.maxSerializedBytes ?? input.maxBytes, DEFAULT_LIMITS.maxSerializedBytes, 0),
    maxAttempts: boundedInteger(input.maxAttempts, DEFAULT_LIMITS.maxAttempts, 1),
    maxGenerationSummaries: boundedInteger(input.maxGenerationSummaries, DEFAULT_LIMITS.maxGenerationSummaries, 0),
    maxWorkOutcomes: boundedInteger(input.maxWorkOutcomes, DEFAULT_LIMITS.maxWorkOutcomes, 0),
    maxErrorAggregates: boundedInteger(input.maxErrorAggregates, DEFAULT_LIMITS.maxErrorAggregates, 0),
  };
}

function boundedErrorCode(value: string | null | undefined): string | null {
  if (value == null) return null;
  const code = String(value).trim().slice(0, 96);
  return code || null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoverQueueError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

function validPipelineVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CoverQueueError("INVALID_INPUT", "pipelineVersion must be a positive integer");
  }
  return value as number;
}

function timestampOf(value: string | undefined): string {
  return value ?? new Date().toISOString();
}

function entryKey(generationId: string, workKey: string): string {
  return `${generationId}|${workKey}`;
}

export function coverQueueEntryKey(generationId: string, workKey: string): string {
  return entryKey(generationId, workKey);
}

export function emptyCoverQueueState(): CoverQueueState {
  return {
    version: COVER_QUEUE_VERSION,
    pending: [],
    generationSummaries: [],
    workOutcomes: [],
  };
}

function cloneState(state: CoverQueueState): CoverQueueState {
  return {
    version: COVER_QUEUE_VERSION,
    pending: state.pending.map((item) => ({ ...item })),
    generationSummaries: state.generationSummaries.map((summary) => ({
      ...summary,
      errorCounts: summary.errorCounts.map((error) => ({ ...error })),
    })),
    workOutcomes: state.workOutcomes.map((outcome) => ({ ...outcome })),
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function coverQueueSerializedBytes(state: CoverQueueState): number {
  return byteLength(JSON.stringify(state));
}

function statusOf(summary: CoverQueueGenerationSummary): CoverQueueGenerationStatus {
  if (summary.pending > 0) return "pending";
  if (summary.failed > 0 && summary.completed === 0 && summary.skipped === 0) return "failed";
  if (summary.skipped > 0 && summary.completed === 0 && summary.failed === 0) return "skipped";
  if (summary.failed > 0 || summary.skipped > 0) return "partial";
  return "completed";
}

function compactErrorCounts(
  errors: CoverQueueErrorAggregate[],
  maxErrorAggregates: number,
): CoverQueueErrorAggregate[] {
  if (maxErrorAggregates === 0) return [];
  const counts = new Map<string, number>();
  for (const item of errors) {
    const code = boundedErrorCode(item.code) ?? "UNKNOWN";
    const count = Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0;
    if (count > 0) counts.set(code, (counts.get(code) ?? 0) + count);
  }
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (sorted.length <= maxErrorAggregates) {
    return sorted.map(([code, count]) => ({ code, count }));
  }
  if (maxErrorAggregates === 1) {
    return [{ code: "OTHER", count: sorted.reduce((total, [, count]) => total + count, 0) }];
  }
  // Keep only one OTHER bucket even when a previous compaction already
  // produced one and a later failure arrives.
  const retained = sorted.filter(([code]) => code !== "OTHER").slice(0, maxErrorAggregates - 1);
  const retainedCodes = new Set(retained.map(([code]) => code));
  const other = sorted
    .filter(([code]) => !retainedCodes.has(code))
    .reduce((total, [, count]) => total + count, 0);
  return [...retained.map(([code, count]) => ({ code, count })), { code: "OTHER", count: other }];
}

function normalizeSummary(summary: CoverQueueGenerationSummary, limits: NormalizedCoverQueueLimits): CoverQueueGenerationSummary {
  const enqueued = Number.isSafeInteger(summary.enqueued) && summary.enqueued >= 0 ? summary.enqueued : 0;
  const completed = Number.isSafeInteger(summary.completed) && summary.completed >= 0 ? summary.completed : 0;
  const failed = Number.isSafeInteger(summary.failed) && summary.failed >= 0 ? summary.failed : 0;
  const skipped = Number.isSafeInteger(summary.skipped) && summary.skipped >= 0 ? summary.skipped : 0;
  const pending = Math.max(0, enqueued - completed - failed - skipped);
  const normalized: CoverQueueGenerationSummary = {
    generationId: requiredText(summary.generationId, "generationId"),
    enqueuedAt: requiredText(summary.enqueuedAt, "enqueuedAt"),
    updatedAt: requiredText(summary.updatedAt, "updatedAt"),
    enqueued,
    pending,
    completed,
    failed,
    skipped,
    status: "completed",
    errorCounts: compactErrorCounts(Array.isArray(summary.errorCounts) ? summary.errorCounts : [], limits.maxErrorAggregates),
  };
  normalized.status = statusOf(normalized);
  return normalized;
}

function normalizeItem(item: CoverQueueItem, limits: NormalizedCoverQueueLimits): CoverQueueItem {
  const generationId = requiredText(item.generationId, "generationId");
  const workKey = requiredText(item.workKey, "workKey");
  const sourceUrl = requiredText(item.sourceUrl, "sourceUrl");
  const attempts = Number.isSafeInteger(item.attempts) && item.attempts >= 0
    ? Math.min(item.attempts, limits.maxAttempts)
    : 0;
  const key = item.key === entryKey(generationId, workKey) ? item.key : entryKey(generationId, workKey);
  const revision = Number.isSafeInteger(item.revision) && (item.revision ?? 0) >= 1
    ? item.revision
    : undefined;
  const fingerprint = typeof item.fingerprint === "string" && item.fingerprint.trim() !== ""
    ? item.fingerprint
    : undefined;
  return {
    key,
    workKey,
    sourceUrl,
    pipelineVersion: validPipelineVersion(item.pipelineVersion),
    ...(revision === undefined ? {} : { revision }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    generationId,
    enqueuedAt: requiredText(item.enqueuedAt, "enqueuedAt"),
    attempts,
    lastErrorCode: boundedErrorCode(item.lastErrorCode),
    status: item.status === "in-flight" ? "in-flight" : "pending",
    claimedAt: item.claimedAt == null ? null : requiredText(item.claimedAt, "claimedAt"),
  };
}

function normalizeOutcome(outcome: CoverQueueWorkOutcome): CoverQueueWorkOutcome {
  const status: CoverQueueOutcomeStatus = outcome.status === "ready"
    || outcome.status === "failed"
    || outcome.status === "skipped-capacity"
    ? outcome.status
    : "failed";
  return {
    workKey: requiredText(outcome.workKey, "workKey"),
    generationId: requiredText(outcome.generationId, "generationId"),
    status,
    completedAt: requiredText(outcome.completedAt, "completedAt"),
    errorCode: boundedErrorCode(outcome.errorCode),
  };
}

function compactOutcomes(state: CoverQueueState, limits: NormalizedCoverQueueLimits): void {
  const byWork = new Map<string, CoverQueueWorkOutcome>();
  for (const raw of state.workOutcomes) {
    const outcome = normalizeOutcome(raw);
    const current = byWork.get(outcome.workKey);
    if (!current || outcome.completedAt >= current.completedAt) byWork.set(outcome.workKey, outcome);
  }
  state.workOutcomes = [...byWork.values()]
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || left.workKey.localeCompare(right.workKey))
    .slice(0, limits.maxWorkOutcomes);
}

function compactSummaries(state: CoverQueueState, limits: NormalizedCoverQueueLimits): void {
  const byGeneration = new Map<string, CoverQueueGenerationSummary>();
  for (const raw of state.generationSummaries) {
    const summary = normalizeSummary(raw, limits);
    const current = byGeneration.get(summary.generationId);
    if (!current || summary.updatedAt >= current.updatedAt) byGeneration.set(summary.generationId, summary);
  }
  state.generationSummaries = [...byGeneration.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.generationId.localeCompare(left.generationId))
    .slice(0, limits.maxGenerationSummaries);
}

function compactState(state: CoverQueueState, limits: NormalizedCoverQueueLimits): CoverQueueState {
  const result = cloneState(state);
  result.pending = result.pending.map((item) => normalizeItem(item, limits));
  compactSummaries(result, limits);
  compactOutcomes(result, limits);
  return result;
}

function summaryFor(state: CoverQueueState, generationId: string, at: string): CoverQueueGenerationSummary {
  const found = state.generationSummaries.find((summary) => summary.generationId === generationId);
  if (found) return found;
  const created: CoverQueueGenerationSummary = {
    generationId,
    enqueuedAt: at,
    updatedAt: at,
    enqueued: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    status: "completed",
    errorCounts: [],
  };
  state.generationSummaries.push(created);
  return created;
}

function addError(summary: CoverQueueGenerationSummary, errorCode: string, limits: NormalizedCoverQueueLimits): void {
  summary.errorCounts = compactErrorCounts([
    ...summary.errorCounts,
    { code: errorCode, count: 1 },
  ], limits.maxErrorAggregates);
}

function recordOutcome(
  state: CoverQueueState,
  item: CoverQueueItem,
  status: CoverQueueOutcomeStatus,
  completedAt: string,
  errorCode: string | null,
  limits: NormalizedCoverQueueLimits,
): void {
  const summary = summaryFor(state, item.generationId, item.enqueuedAt);
  summary.updatedAt = completedAt;
  // A pending item may outlive its summary when an old summary is compacted.
  // Reconstruct that one obligation before accounting for its terminal result.
  summary.pending = Math.max(1, summary.pending);
  summary.enqueued = Math.max(
    summary.enqueued,
    summary.completed + summary.failed + summary.skipped + summary.pending,
  );
  summary.pending = Math.max(0, summary.pending - 1);
  if (status === "ready") summary.completed += 1;
  if (status === "failed") {
    summary.failed += 1;
    if (errorCode) addError(summary, errorCode, limits);
  }
  if (status === "skipped-capacity") {
    summary.skipped += 1;
    if (errorCode) addError(summary, errorCode, limits);
  }
  summary.status = statusOf(summary);
  state.workOutcomes = state.workOutcomes.filter((outcome) => outcome.workKey !== item.workKey);
  state.workOutcomes.push({
    workKey: item.workKey,
    generationId: item.generationId,
    status,
    completedAt,
    errorCode,
  });
}

function outcomeFor(state: CoverQueueState, generationId: string, workKey: string): CoverQueueWorkOutcome | undefined {
  return state.workOutcomes.find((outcome) => outcome.generationId === generationId && outcome.workKey === workKey);
}

function normalizedWorks(input: EnqueueCoverGenerationInput): CoverQueueWorkInput[] {
  const supplied = input.works ?? input.candidates ?? [];
  const seen = new Set<string>();
  return supplied.map((work) => {
    const workKey = requiredText(work.workKey, "workKey");
    const sourceUrl = requiredText(work.sourceUrl, "sourceUrl");
    const pipelineVersion = validPipelineVersion(work.pipelineVersion);
    const revision = Number.isSafeInteger(work.revision) && (work.revision ?? 0) >= 1
      ? work.revision
      : undefined;
    const fingerprint = typeof work.fingerprint === "string" && work.fingerprint.trim() !== ""
      ? work.fingerprint
      : undefined;
    return {
      workKey,
      sourceUrl,
      pipelineVersion,
      ...(revision === undefined ? {} : { revision }),
      ...(fingerprint === undefined ? {} : { fingerprint }),
    };
  }).filter((work) => {
    if (seen.has(work.workKey)) return false;
    seen.add(work.workKey);
    return true;
  });
}

/**
 * Add obligations for one completed synchronization generation. This reducer
 * is idempotent for existing obligations and for outcomes already recorded
 * for the same generation/work pair. Older generations remain untouched.
 */
export function enqueueCoverGeneration(
  state: CoverQueueState,
  input: EnqueueCoverGenerationInput,
  requestedLimits: CoverQueueLimits = {},
): CoverQueueEnqueueResult {
  const limits = limitsOf(requestedLimits);
  const generationId = requiredText(input.generationId, "generationId");
  const enqueuedAt = timestampOf(input.enqueuedAt);
  const base = compactState(state, limits);
  const works = normalizedWorks(input);
  const existing = new Set(base.pending.map((item) => item.key));
  const additions: CoverQueueItem[] = [];
  const alreadySatisfied: string[] = [];
  for (const work of works) {
    const key = entryKey(generationId, work.workKey);
    if (existing.has(key) || outcomeFor(base, generationId, work.workKey)) {
      alreadySatisfied.push(work.workKey);
      continue;
    }
    additions.push({
      key,
      workKey: work.workKey,
      sourceUrl: work.sourceUrl,
      pipelineVersion: work.pipelineVersion,
      ...(work.revision === undefined ? {} : { revision: work.revision }),
      ...(work.fingerprint === undefined ? {} : { fingerprint: work.fingerprint }),
      generationId,
      enqueuedAt,
      attempts: 0,
      lastErrorCode: null,
      status: "pending",
      claimedAt: null,
    });
  }
  if (additions.length === 0) {
    if (!base.generationSummaries.some((summary) => summary.generationId === generationId)) {
      summaryFor(base, generationId, enqueuedAt);
      compactSummaries(base, limits);
    }
    return { state: base, enqueued: [], alreadySatisfied, error: null, ok: true };
  }
  if (base.pending.length + additions.length > limits.maxPendingEntries) {
    return {
      state: base,
      enqueued: [],
      alreadySatisfied,
      error: new CoverQueueCapacityError("entries", additions.length, Math.max(0, limits.maxPendingEntries - base.pending.length)),
      ok: false,
    };
  }
  const candidate = cloneState(base);
  candidate.pending.push(...additions);
  const summary = summaryFor(candidate, generationId, enqueuedAt);
  summary.updatedAt = enqueuedAt;
  summary.enqueued += additions.length;
  summary.pending += additions.length;
  summary.status = statusOf(summary);
  compactSummaries(candidate, limits);
  compactOutcomes(candidate, limits);
  const baseBytes = coverQueueSerializedBytes(base);
  const candidateBytes = coverQueueSerializedBytes(candidate);
  if (candidateBytes > limits.maxSerializedBytes) {
    return {
      state: base,
      enqueued: [],
      alreadySatisfied,
      error: new CoverQueueCapacityError(
        "bytes",
        Math.max(0, candidateBytes - baseBytes),
        Math.max(0, limits.maxSerializedBytes - baseBytes),
      ),
      ok: false,
    };
  }
  return { state: candidate, enqueued: additions, alreadySatisfied, error: null, ok: true };
}

function transitionOptions(value: CoverQueueTransitionOptions | undefined): { at: string; limits: NormalizedCoverQueueLimits } {
  return {
    at: timestampOf(value?.completedAt ?? value?.now),
    limits: limitsOf(value?.limits),
  };
}

function claimKey(value: CoverQueueClaim | string): string {
  return typeof value === "string" ? value : value.key;
}

function currentItem(state: CoverQueueState, claim: CoverQueueClaim | string): CoverQueueItem | undefined {
  const item = state.pending.find((candidate) => candidate.key === claimKey(claim));
  if (!item) return undefined;
  if (typeof claim !== "string" && (item.attempts !== claim.attempt || item.generationId !== claim.generationId || item.workKey !== claim.workKey)) {
    throw new CoverQueueError("STALE_CLAIM", "Cover queue claim no longer owns this obligation");
  }
  return item;
}

function nextPending(state: CoverQueueState, key?: string): CoverQueueItem | undefined {
  const candidates = state.pending
    .filter((item) => item.status === "pending" && (key === undefined || item.key === key))
    .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.key.localeCompare(right.key));
  return candidates[0];
}

/** Recover in-flight claims after loading persisted state. */
export function recoverCoverQueueState(
  state: CoverQueueState,
  requestedLimits: CoverQueueLimits = {},
): CoverQueueState {
  const result = compactState(state, limitsOf(requestedLimits));
  result.pending = result.pending.map((item) => item.status === "in-flight"
    ? { ...item, status: "pending", claimedAt: null }
    : item);
  return result;
}

/** Claim the oldest obligation and increment its bounded attempt counter. */
export function beginCoverQueueItem(
  state: CoverQueueState,
  options: { key?: string; now?: string; limits?: CoverQueueLimits } = {},
): CoverQueueBeginResult {
  const limits = limitsOf(options.limits);
  const result = compactState(state, limits);
  const item = nextPending(result, options.key);
  if (!item) return { state: result, item: null, claim: null, exhausted: false, failedKey: null };
  if (item.attempts >= limits.maxAttempts) {
    const exhaustedState = cloneState(result);
    exhaustedState.pending = exhaustedState.pending.filter((candidate) => candidate.key !== item.key);
    recordOutcome(exhaustedState, item, "failed", timestampOf(options.now), "ATTEMPT_LIMIT", limits);
    compactSummaries(exhaustedState, limits);
    compactOutcomes(exhaustedState, limits);
    return { state: exhaustedState, item: null, claim: null, exhausted: true, failedKey: item.key };
  }
  const attempt = Math.min(limits.maxAttempts, item.attempts + 1);
  const claimed = { ...item, attempts: attempt, status: "in-flight" as const, claimedAt: timestampOf(options.now) };
  const claimedState = cloneState(result);
  claimedState.pending = claimedState.pending.map((candidate) => candidate.key === item.key ? claimed : candidate);
  return {
    state: claimedState,
    item: claimed,
    claim: { key: claimed.key, generationId: claimed.generationId, workKey: claimed.workKey, attempt },
    exhausted: false,
    failedKey: null,
  };
}

function assertPersistenceAcknowledged(
  item: CoverQueueItem,
  acknowledgement: CoverQueuePersistenceAcknowledgement | boolean,
): void {
  if (acknowledgement !== true && (typeof acknowledgement !== "object" || acknowledgement.persisted !== true)) {
    throw new CoverQueueError("PERSISTENCE_NOT_ACKNOWLEDGED", "A cover Blob must be persisted before completing its queue obligation");
  }
  if (acknowledgement === true) return;
  if (acknowledgement.workKey !== undefined && acknowledgement.workKey !== item.workKey) {
    throw new CoverQueueError("PERSISTENCE_MISMATCH", "Persisted cover work key does not match the queue obligation");
  }
  if (acknowledgement.sourceUrl !== undefined && acknowledgement.sourceUrl !== item.sourceUrl) {
    throw new CoverQueueError("PERSISTENCE_MISMATCH", "Persisted cover source does not match the queue obligation");
  }
  if (acknowledgement.pipelineVersion !== undefined && acknowledgement.pipelineVersion !== item.pipelineVersion) {
    throw new CoverQueueError("PERSISTENCE_MISMATCH", "Persisted cover pipeline does not match the queue obligation");
  }
}

/**
 * Complete only after the repository has acknowledged durable Blob storage.
 * Passing `true` is the compact form; the object form can also verify the
 * work/source/pipeline identity written by the repository.
 */
export function completeCoverQueueItem(
  state: CoverQueueState,
  claim: CoverQueueClaim | string,
  acknowledgement: CoverQueuePersistenceAcknowledgement | boolean,
  options: CoverQueueTransitionOptions = {},
): CoverQueueState {
  const { at, limits } = transitionOptions(options);
  const result = compactState(state, limits);
  const item = currentItem(result, claim);
  if (!item) return result;
  assertPersistenceAcknowledged(item, acknowledgement);
  const next = cloneState(result);
  next.pending = next.pending.filter((candidate) => candidate.key !== item.key);
  recordOutcome(next, item, "ready", at, null, limits);
  compactSummaries(next, limits);
  compactOutcomes(next, limits);
  return next;
}

export function failCoverQueueItem(
  state: CoverQueueState,
  claim: CoverQueueClaim | string,
  errorCode: string,
  options: CoverQueueTransitionOptions = {},
): CoverQueueState {
  const { at, limits } = transitionOptions(options);
  const result = compactState(state, limits);
  const item = currentItem(result, claim);
  if (!item) return result;
  const code = boundedErrorCode(errorCode) ?? "UNKNOWN";
  const next = cloneState(result);
  next.pending = next.pending.filter((candidate) => candidate.key !== item.key);
  recordOutcome(next, item, "failed", at, code, limits);
  compactSummaries(next, limits);
  compactOutcomes(next, limits);
  return next;
}

/** Capacity skips are terminal for this generation, just like failures. */
export function skipCoverQueueItem(
  state: CoverQueueState,
  claim: CoverQueueClaim | string,
  options: CoverQueueTransitionOptions = {},
): CoverQueueState {
  const { at, limits } = transitionOptions(options);
  const result = compactState(state, limits);
  const item = currentItem(result, claim);
  if (!item) return result;
  const next = cloneState(result);
  next.pending = next.pending.filter((candidate) => candidate.key !== item.key);
  recordOutcome(next, item, "skipped-capacity", at, "CAPACITY", limits);
  compactSummaries(next, limits);
  compactOutcomes(next, limits);
  return next;
}

export const completeCoverObligation = completeCoverQueueItem;
export const failCoverObligation = failCoverQueueItem;
export const beginCoverObligation = beginCoverQueueItem;

export function pendingCoverQueueItems(state: CoverQueueState): CoverQueueItem[] {
  return state.pending
    .map((item) => ({ ...item }))
    .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.key.localeCompare(right.key));
}

export function serializeCoverQueueState(
  state: CoverQueueState,
  requestedLimits: CoverQueueLimits = {},
): string {
  const limits = limitsOf(requestedLimits);
  const compacted = compactState(state, limits);
  if (compacted.pending.length > limits.maxPendingEntries) {
    throw new CoverQueueCapacityError(
      "entries",
      compacted.pending.length,
      limits.maxPendingEntries,
    );
  }
  const serialized = JSON.stringify(compacted);
  const bytes = byteLength(serialized);
  if (bytes > limits.maxSerializedBytes) {
    throw new CoverQueueCapacityError("bytes", bytes, limits.maxSerializedBytes);
  }
  return serialized;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Parse and recover a storage blob. Invalid state is rejected explicitly so
 * a corrupt storage value can never be mistaken for an empty queue. */
export function deserializeCoverQueueState(
  serialized: string,
  requestedLimits: CoverQueueLimits = {},
): CoverQueueState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CoverQueueError("INVALID_STATE", "Cover queue storage is not valid JSON");
  }
  if (parsed == null || typeof parsed !== "object") {
    throw new CoverQueueError("INVALID_STATE", "Cover queue storage is not an object");
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== COVER_QUEUE_VERSION) {
    throw new CoverQueueError("UNSUPPORTED_VERSION", "Cover queue storage version is unsupported");
  }
  const limits = limitsOf(requestedLimits);
  const pending = arrayValue(raw.pending).map((item) => normalizeItem(item as CoverQueueItem, limits));
  const generationSummaries = arrayValue(raw.generationSummaries)
    .map((summary) => normalizeSummary(summary as CoverQueueGenerationSummary, limits));
  const workOutcomes = arrayValue(raw.workOutcomes).map((outcome) => normalizeOutcome(outcome as CoverQueueWorkOutcome));
  return recoverCoverQueueState({
    version: COVER_QUEUE_VERSION,
    pending,
    generationSummaries,
    workOutcomes,
  }, requestedLimits);
}

export const encodeCoverQueueState = serializeCoverQueueState;
export const decodeCoverQueueState = deserializeCoverQueueState;

/** A serializable acknowledgement helper for repository adapters. */
export function coverBlobPersistenceAcknowledged(
  item: Pick<CoverQueueItem, "workKey" | "sourceUrl" | "pipelineVersion">,
): CoverQueuePersistenceAcknowledgement {
  return {
    persisted: true,
    workKey: item.workKey,
    sourceUrl: item.sourceUrl,
    pipelineVersion: item.pipelineVersion,
  };
}

export interface CoverQueueValidationExpectation {
  sourceUrl?: string | null;
  currentSourceUrl?: string | null;
  pipelineVersion?: number;
  currentPipelineVersion?: number;
  maxBytes?: number;
}

export type CoverQueueValidationCode =
  | "MISSING"
  | "SOURCE_MISMATCH"
  | "PIPELINE_MISMATCH"
  | "STATUS_NOT_READY"
  | "BLOB_MISSING"
  | "INVALID_DIMENSIONS"
  | "INVALID_BYTES"
  | "BLOB_SIZE_MISMATCH"
  | "MIME_NOT_ALLOWED"
  | "MAX_BYTES_EXCEEDED";

export interface CoverQueueValidationResult {
  ok: boolean;
  code: CoverQueueValidationCode | null;
}

/** Pure structural validation shared by callers that read a cached cover. */
export function validateUsableCoverRecord(
  record: CoverRecord | null | undefined,
  expectation: CoverQueueValidationExpectation = {},
): CoverQueueValidationResult {
  if (!record) return { ok: false, code: "MISSING" };
  const expectedSource = expectation.currentSourceUrl ?? expectation.sourceUrl;
  const expectedPipeline = expectation.currentPipelineVersion ?? expectation.pipelineVersion;
  if ((Object.prototype.hasOwnProperty.call(expectation, "sourceUrl")
    || Object.prototype.hasOwnProperty.call(expectation, "currentSourceUrl"))
    && record.sourceUrl !== expectedSource) {
    return { ok: false, code: "SOURCE_MISMATCH" };
  }
  if (expectedPipeline !== undefined && record.pipelineVersion !== expectedPipeline) {
    return { ok: false, code: "PIPELINE_MISMATCH" };
  }
  if (record.status !== "ready") return { ok: false, code: "STATUS_NOT_READY" };
  if (!(record.blob instanceof Blob)) return { ok: false, code: "BLOB_MISSING" };
  if (!Number.isFinite(record.width) || !Number.isFinite(record.height) || record.width <= 0 || record.height <= 0) {
    return { ok: false, code: "INVALID_DIMENSIONS" };
  }
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) return { ok: false, code: "INVALID_BYTES" };
  if (record.blob.size !== record.bytes) return { ok: false, code: "BLOB_SIZE_MISMATCH" };
  if (record.blob.type.toLocaleLowerCase() !== "image/webp") return { ok: false, code: "MIME_NOT_ALLOWED" };
  const maxBytes = expectation.maxBytes ?? COVER_CACHE_MAX_BLOB_BYTES;
  if (!Number.isFinite(maxBytes) || record.bytes > maxBytes) return { ok: false, code: "MAX_BYTES_EXCEEDED" };
  return { ok: true, code: null };
}

export function isUsableCoverRecord(
  record: CoverRecord | null | undefined,
  expectation: CoverQueueValidationExpectation = {},
): boolean {
  return validateUsableCoverRecord(record, expectation).ok;
}

export const validateCoverRecord = validateUsableCoverRecord;
export const isValidCoverRecord = isUsableCoverRecord;
export const isUsableReadyCover = isUsableCoverRecord;
