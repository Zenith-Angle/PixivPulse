import type {
  CoverIdentity,
  CoverJob,
  CoverJobStatus,
  CoverManifest,
  CoverManifestStatus,
  MediaJsonValue,
  MediaMetaRecord,
  MigrationCheckpointRecord,
  MigrationJournalRecord,
} from "./media-database";
import {
  getMediaDatabase,
  MEDIA_DATABASE_NAME,
  type MediaDatabaseSchema,
} from "./media-database";
import type { IDBPTransaction } from "idb";

type MediaReadWriteTransaction = IDBPTransaction<MediaDatabaseSchema, any, "readwrite">;

export { MEDIA_DATABASE_NAME };
export type {
  CoverIdentity,
  CoverJob,
  CoverJobStatus,
  CoverManifest,
  CoverManifestStatus,
  MediaJsonValue,
  MediaMetaRecord,
  MigrationCheckpointRecord,
  MigrationJournalRecord,
} from "./media-database";

export const DEFAULT_MEDIA_PIPELINE_VERSION = 1;

const COVER_STATUS_VALUES = new Set<CoverManifestStatus>([
  "pending",
  "ready",
  "failed",
  "skipped-capacity",
]);
const JOB_STATUS_VALUES = new Set<CoverJobStatus>([
  "pending",
  "claimed",
  "fetching",
  "validating",
  "committing",
  "completed",
  "failed",
  "cancelled",
]);
const MIGRATION_STATUS_VALUES = new Set<MigrationJournalRecord["status"]>([
  "pending",
  "running",
  "completed",
  "failed",
]);
const DEFAULT_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type MediaValidationCode =
  | "INVALID_WORK_KEY"
  | "INVALID_SOURCE_URL"
  | "INVALID_PIPELINE_VERSION"
  | "INVALID_REVISION"
  | "INVALID_FINGERPRINT"
  | "INVALID_BLOB"
  | "INVALID_MIME"
  | "MIME_MISMATCH"
  | "MIME_NOT_ALLOWED"
  | "INVALID_DIMENSIONS"
  | "INVALID_SIZE"
  | "SIZE_MISMATCH"
  | "MAX_SIZE_EXCEEDED"
  | "INVALID_STATUS"
  | "INVALID_JOB"
  | "INVALID_META"
  | "CAS_MISMATCH"
  | "STALE_REVISION"
  | "TRANSACTION_FAILED";

export class MediaValidationError extends Error {
  readonly code: MediaValidationCode;

  constructor(code: MediaValidationCode, message: string = code) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

export interface CoverIdentityInput {
  workKey: string;
  sourceUrl: string;
  pipelineVersion?: number | undefined;
  revision?: number | undefined;
  fingerprint?: string | undefined;
  /** Compatibility name for callers that call the source token a digest. */
  sourceFingerprint?: string | undefined;
}

export interface CoverSourceSnapshot extends CoverIdentityInput {
  /** Compatibility aliases used by work snapshots. */
  key?: string | undefined;
  thumbnailUrl?: string | undefined;
}

export interface CoverCandidate extends CoverIdentity {
  key: string;
}

export interface CoverBlobValidationInput {
  blob: Blob;
  width: number;
  height: number;
  bytes?: number | undefined;
  mime?: string | undefined;
  maxBytes?: number | undefined;
  allowedMimeTypes?: readonly string[] | undefined;
}

export interface CoverBlobValidationSuccess {
  ok: true;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

export interface CoverBlobValidationFailure {
  ok: false;
  code: Extract<
    MediaValidationCode,
    | "INVALID_BLOB"
    | "INVALID_MIME"
    | "MIME_MISMATCH"
    | "MIME_NOT_ALLOWED"
    | "INVALID_DIMENSIONS"
    | "INVALID_SIZE"
    | "SIZE_MISMATCH"
    | "MAX_SIZE_EXCEEDED"
  >;
  message: string;
}

export type CoverBlobValidationResult = CoverBlobValidationSuccess | CoverBlobValidationFailure;

export interface CoverCommitInput extends CoverIdentityInput {
  key?: string | undefined;
  blob: Blob;
  width: number;
  height: number;
  bytes?: number | undefined;
  mime?: string | undefined;
  blobKey?: string | undefined;
  attemptedAt?: string | undefined;
  lastAttemptRunId?: string | null | undefined;
  now?: string | undefined;
  maxBytes?: number | undefined;
  allowedMimeTypes?: readonly string[] | undefined;
  expectedIdentity?: CoverIdentity | null | undefined;
  expectedSourceUrl?: string | null | undefined;
  expectedPipelineVersion?: number | undefined;
  expectedRevision?: number | undefined;
  expectedFingerprint?: string | undefined;
  /** Optional durable job row written by the same transaction. */
  job?: CoverJobWriteInput | null | undefined;
  /** Optional journal/checkpoint/meta rows written by the same transaction. */
  meta?: MediaMetaWriteInput | readonly MediaMetaWriteInput[] | null | undefined;
}

export interface CoverCommitSuccess {
  committed: true;
  manifest: CoverManifest;
  job: CoverJob | null;
  metaKeys: string[];
}

export interface CoverCommitFailure {
  committed: false;
  reason: MediaValidationCode;
  current: CoverManifest | null;
}

export type CoverCommitResult = CoverCommitSuccess | CoverCommitFailure;

export interface CoverManifestWriteInput extends CoverIdentityInput {
  key?: string | undefined;
  status: Exclude<CoverManifestStatus, "ready">;
  attemptedAt?: string | undefined;
  lastAttemptRunId?: string | null | undefined;
  errorCode?: string | null | undefined;
  now?: string | undefined;
  expectedIdentity?: CoverIdentity | null | undefined;
  expectedSourceUrl?: string | null | undefined;
  expectedPipelineVersion?: number | undefined;
  expectedRevision?: number | undefined;
  expectedFingerprint?: string | undefined;
}

export interface CoverLookupOptions {
  sourceUrl?: string | null | undefined;
  pipelineVersion?: number | undefined;
  revision?: number | undefined;
  fingerprint?: string | undefined;
}

export type CurrentCover = CoverManifest & { blob: Blob };

export interface CoverCandidateScanOptions {
  sources?: readonly CoverSourceSnapshot[] | undefined;
  works?: readonly CoverSourceSnapshot[] | undefined;
  candidates?: readonly CoverSourceSnapshot[] | undefined;
  pipelineVersion?: number | undefined;
  runId?: string | null | undefined;
  limit?: number | undefined;
}

export interface CoverAttemptWriteInput extends CoverIdentityInput {
  status: "failed" | "skipped-capacity";
  runId?: string | null | undefined;
  attemptedAt?: string | undefined;
  errorCode?: string | null | undefined;
  now?: string | undefined;
}

export interface CoverAttemptRecord extends CoverIdentity {
  key: string;
  status: "failed" | "skipped-capacity";
  runId: string | null;
  attemptedAt: string;
  errorCode: string | null;
  updatedAt: string;
}

export interface CoverSummary {
  ready: number;
  failed: number;
  skipped: number;
  pending: number;
  bytes: number;
  total: number;
}

export interface CoverListOptions {
  workKeys?: readonly string[] | undefined;
  pipelineVersion?: number | undefined;
  status?: CoverManifestStatus | readonly CoverManifestStatus[] | undefined;
}

export interface CoverJobWriteInput extends CoverIdentityInput {
  key?: string | undefined;
  status?: CoverJobStatus | undefined;
  attempts?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  nextAttemptAt?: string | null | undefined;
  leaseToken?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
  lastErrorCode?: string | null | undefined;
  lastErrorMessage?: string | null | undefined;
  expectedIdentity?: CoverIdentity | null | undefined;
  expectedSourceUrl?: string | null | undefined;
  expectedPipelineVersion?: number | undefined;
  expectedRevision?: number | undefined;
  expectedFingerprint?: string | undefined;
}

export interface CoverJobStatusUpdate {
  identity: CoverIdentityInput;
  status: CoverJobStatus;
  now?: string | undefined;
  attempts?: number | undefined;
  nextAttemptAt?: string | null | undefined;
  leaseToken?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  expectedIdentity?: CoverIdentity | null | undefined;
}

export interface ClaimCoverJobOptions {
  workerId: string;
  now?: string | undefined;
  leaseMs?: number | undefined;
}

export interface RecoverCoverJobsResult {
  recovered: number;
  jobs: CoverJob[];
}

export interface MigrationJournalWriteInput {
  migrationId: string;
  migrationVersion: number;
  status: MigrationJournalRecord["status"];
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  completedAt?: string | null | undefined;
  errorCode?: string | null | undefined;
  details?: MediaJsonValue | null | undefined;
}

export interface MigrationCheckpointWriteInput {
  migrationId: string;
  migrationVersion: number;
  sequence: number;
  cursor?: string | null | undefined;
  state?: MediaJsonValue | null | undefined;
  updatedAt?: string | undefined;
}

export interface MediaValueWriteInput {
  key: string;
  value: MediaJsonValue;
  updatedAt?: string | undefined;
}

export type MediaMetaWriteInput =
  | MigrationJournalWriteInput & { kind: "migration-journal" }
  | MigrationCheckpointWriteInput & { kind: "migration-checkpoint" }
  | MediaValueWriteInput & { kind: "value" };

export interface MigrationRecovery {
  migrationId: string;
  journal: MigrationJournalRecord | null;
  checkpoint: MigrationCheckpointRecord | null;
  resumeCursor: string | null;
  recoverable: boolean;
}

export interface ReconcileOptions {
  /** Snapshot read from the other database. It is not part of this transaction. */
  current?: readonly CoverSourceSnapshot[];
  currentSources?: readonly CoverSourceSnapshot[];
  currentByWorkKey?: ReadonlyMap<string, CoverIdentity | null>;
  removeStaleManifests?: boolean;
  removeOrphanBlobs?: boolean;
  removeMissingBlobManifests?: boolean;
  now?: string;
}

export interface ReconcileResult {
  /** A media DB transaction cannot be atomic with the work DB snapshot. */
  crossDatabaseAtomic: false;
  checkedAt: string;
  removedManifestCount: number;
  removedBlobCount: number;
  orphanBlobKeys: string[];
  staleWorkKeys: string[];
  missingBlobWorkKeys: string[];
  invalidManifestWorkKeys: string[];
}

export interface ReconcileJobsResult {
  removed: number;
  staleJobKeys: string[];
  crossDatabaseAtomic: false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const text = String(value).trim().slice(0, max);
  return text || null;
}

function isBlob(value: unknown): value is Blob {
  return (typeof Blob !== "undefined" && value instanceof Blob)
    || Object.prototype.toString.call(value) === "[object Blob]";
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSourceUrl(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function validPipelineVersion(value: unknown): value is number {
  return isSafePositiveInteger(value);
}

function validRevision(value: unknown): value is number {
  return isSafeNonNegativeInteger(value);
}

function validFingerprint(value: unknown): value is string {
  return nonEmpty(value);
}

function validTimestamp(value: unknown): value is string {
  return nonEmpty(value);
}

function identityEquals(left: CoverIdentity, right: CoverIdentity): boolean {
  return left.workKey === right.workKey
    && left.sourceUrl === right.sourceUrl
    && left.pipelineVersion === right.pipelineVersion
    && left.revision === right.revision
    && left.fingerprint === right.fingerprint;
}

function identityDiffersBySource(left: CoverIdentity, right: CoverIdentity): boolean {
  return left.sourceUrl !== right.sourceUrl
    || left.pipelineVersion !== right.pipelineVersion
    || left.fingerprint !== right.fingerprint;
}

function normalizeIdentity(input: CoverIdentityInput): CoverIdentity {
  if (!nonEmpty(input.workKey)) throw new MediaValidationError("INVALID_WORK_KEY", "workKey must be non-empty");
  if (!validSourceUrl(input.sourceUrl)) throw new MediaValidationError("INVALID_SOURCE_URL", "sourceUrl must be an http(s) URL");
  const pipelineVersion = input.pipelineVersion ?? DEFAULT_MEDIA_PIPELINE_VERSION;
  if (!validPipelineVersion(pipelineVersion)) {
    throw new MediaValidationError("INVALID_PIPELINE_VERSION", "pipelineVersion must be a positive integer");
  }
  const revision = input.revision ?? 1;
  if (!validRevision(revision)) throw new MediaValidationError("INVALID_REVISION", "revision must be a non-negative integer");
  const fingerprint = input.fingerprint ?? input.sourceFingerprint ?? `${input.sourceUrl}|${pipelineVersion}|${revision}`;
  if (!validFingerprint(fingerprint)) throw new MediaValidationError("INVALID_FINGERPRINT", "fingerprint must be non-empty");
  return {
    workKey: input.workKey,
    sourceUrl: input.sourceUrl,
    pipelineVersion,
    revision,
    fingerprint,
  };
}

export function coverAttemptKey(input: CoverIdentityInput): string {
  const identity = normalizeIdentity(input);
  return [
    "cover-attempt",
    identity.workKey,
    identity.sourceUrl,
    identity.pipelineVersion.toString(10),
    identity.revision.toString(10),
    identity.fingerprint,
  ].map((part) => encodeURIComponent(part)).join(":");
}

function normalizeCoverAttempt(input: CoverAttemptWriteInput): CoverAttemptRecord {
  const identity = normalizeIdentity(input);
  if (input.status !== "failed" && input.status !== "skipped-capacity") {
    throw new MediaValidationError("INVALID_STATUS", "cover attempt status must describe a failed attempt");
  }
  if (input.runId !== undefined && input.runId !== null && !nonEmpty(input.runId)) {
    throw new MediaValidationError("INVALID_META", "runId must be non-empty when present");
  }
  const attemptedAt = input.attemptedAt ?? input.now ?? nowIso();
  const updatedAt = input.now ?? attemptedAt;
  if (!validTimestamp(attemptedAt) || !validTimestamp(updatedAt)) {
    throw new MediaValidationError("INVALID_META", "attempt timestamps must be non-empty");
  }
  return {
    ...identity,
    key: coverAttemptKey(identity),
    status: input.status,
    runId: input.runId ?? null,
    attemptedAt,
    errorCode: boundedText(input.errorCode, 160),
    updatedAt,
  };
}

function normalizeExpectedIdentity(input: CoverIdentity | null | undefined): CoverIdentity | null | undefined {
  if (input === undefined || input === null) return input;
  return normalizeIdentity(input);
}

function hasExpectedCas(input: {
  expectedIdentity?: CoverIdentity | null | undefined;
  expectedSourceUrl?: string | null | undefined;
  expectedPipelineVersion?: number | undefined;
  expectedRevision?: number | undefined;
  expectedFingerprint?: string | undefined;
}): boolean {
  return input.expectedIdentity !== undefined
    || input.expectedSourceUrl !== undefined
    || input.expectedPipelineVersion !== undefined
    || input.expectedRevision !== undefined
    || input.expectedFingerprint !== undefined;
}

function expectedMatches(
  existing: CoverIdentity | null,
  input: {
    expectedIdentity?: CoverIdentity | null | undefined;
    expectedSourceUrl?: string | null | undefined;
    expectedPipelineVersion?: number | undefined;
    expectedRevision?: number | undefined;
    expectedFingerprint?: string | undefined;
  },
): boolean {
  if (input.expectedIdentity !== undefined) {
    if (input.expectedIdentity === null) {
      if (existing !== null) return false;
    } else if (existing === null || !identityEquals(existing, input.expectedIdentity)) {
      return false;
    }
  }
  if (input.expectedSourceUrl !== undefined
    && (existing === null || existing.sourceUrl !== input.expectedSourceUrl)) return false;
  if (input.expectedPipelineVersion !== undefined
    && (existing === null || existing.pipelineVersion !== input.expectedPipelineVersion)) return false;
  if (input.expectedRevision !== undefined
    && (existing === null || existing.revision !== input.expectedRevision)) return false;
  if (input.expectedFingerprint !== undefined
    && (existing === null || existing.fingerprint !== input.expectedFingerprint)) return false;
  return true;
}

/**
 * CAS policy for the current manifest row. A source/pipeline/fingerprint
 * replacement needs an explicit token for the row that was observed. This is
 * what prevents a worker that fetched an older URL from blindly replacing a
 * newer source. Same-identity retries are idempotent.
 */
function acceptsManifestWrite(
  existing: CoverManifest | null,
  incoming: CoverIdentity,
  input: {
    expectedIdentity?: CoverIdentity | null | undefined;
    expectedSourceUrl?: string | null | undefined;
    expectedPipelineVersion?: number | undefined;
    expectedRevision?: number | undefined;
    expectedFingerprint?: string | undefined;
  },
): MediaValidationCode | null {
  const currentIdentity = existing === null ? null : existing;
  if (!expectedMatches(currentIdentity, input)) return "CAS_MISMATCH";
  if (existing === null) return null;

  if (incoming.revision < existing.revision) return "STALE_REVISION";
  if (incoming.revision === existing.revision && !identityEquals(existing, incoming) && !hasExpectedCas(input)) {
    return "CAS_MISMATCH";
  }
  if (identityDiffersBySource(existing, incoming) && !hasExpectedCas(input)) return "CAS_MISMATCH";
  return null;
}

function identityKey(identity: CoverIdentity): string {
  return [
    "cover",
    encodeURIComponent(identity.workKey),
    encodeURIComponent(identity.sourceUrl),
    identity.pipelineVersion,
    identity.revision,
    encodeURIComponent(identity.fingerprint),
  ].join(":");
}

export function coverBlobKey(identityInput: CoverIdentityInput): string {
  return `${identityKey(normalizeIdentity(identityInput))}:blob`;
}

export function coverJobKey(identityInput: CoverIdentityInput): string {
  return `${identityKey(normalizeIdentity(identityInput))}:job`;
}

export function migrationJournalKey(migrationId: string): string {
  if (!nonEmpty(migrationId)) throw new MediaValidationError("INVALID_META", "migrationId must be non-empty");
  return `migration:${migrationId}`;
}

export function migrationCheckpointKey(migrationId: string): string {
  if (!nonEmpty(migrationId)) throw new MediaValidationError("INVALID_META", "migrationId must be non-empty");
  return `checkpoint:${migrationId}`;
}

function normalizeMime(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function validateCoverBlob(input: CoverBlobValidationInput): CoverBlobValidationResult {
  if (!isBlob(input.blob)) return { ok: false, code: "INVALID_BLOB", message: "blob must be a Blob" };
  if (!isSafePositiveInteger(input.width) || !isSafePositiveInteger(input.height)) {
    return { ok: false, code: "INVALID_DIMENSIONS", message: "width and height must be positive integers" };
  }
  const mime = normalizeMime(input.blob.type);
  if (!/^image\/[a-z0-9.+-]+$/.test(mime)) {
    return { ok: false, code: "INVALID_MIME", message: "blob MIME must be an image MIME type" };
  }
  if (input.mime !== undefined && normalizeMime(input.mime) !== mime) {
    return { ok: false, code: "MIME_MISMATCH", message: "declared MIME does not match blob.type" };
  }
  const allowed = input.allowedMimeTypes === undefined
    ? DEFAULT_MIME_TYPES
    : new Set(input.allowedMimeTypes.map(normalizeMime));
  if (!allowed.has(mime)) {
    return { ok: false, code: "MIME_NOT_ALLOWED", message: `MIME ${mime} is not allowed` };
  }
  if (!isSafePositiveInteger(input.blob.size)) {
    return { ok: false, code: "INVALID_SIZE", message: "blob size must be positive" };
  }
  if (input.bytes !== undefined && input.bytes !== input.blob.size) {
    return { ok: false, code: "SIZE_MISMATCH", message: "declared bytes do not match blob.size" };
  }
  if (input.maxBytes !== undefined
    && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.blob.size > input.maxBytes)) {
    return { ok: false, code: "MAX_SIZE_EXCEEDED", message: "blob exceeds maxBytes" };
  }
  return {
    ok: true,
    mime,
    bytes: input.blob.size,
    width: input.width,
    height: input.height,
  };
}

export const validateCoverPayload = validateCoverBlob;
export const validateCover = validateCoverBlob;

function coverAttemptFromMeta(meta: MediaMetaRecord | null): CoverAttemptRecord | null {
  if (!meta || meta.kind !== "value" || typeof meta.value !== "object" || meta.value === null || Array.isArray(meta.value)) {
    return null;
  }
  const value = meta.value as Record<string, unknown>;
  if (value.kind !== "cover-attempt"
    || (value.status !== "failed" && value.status !== "skipped-capacity")
    || typeof value.workKey !== "string"
    || typeof value.sourceUrl !== "string"
    || typeof value.pipelineVersion !== "number"
    || typeof value.revision !== "number"
    || typeof value.fingerprint !== "string"
    || (value.runId !== null && typeof value.runId !== "string")
    || typeof value.attemptedAt !== "string"
    || (value.errorCode !== null && typeof value.errorCode !== "string")
    || typeof value.updatedAt !== "string") {
    return null;
  }
  try {
    const identity = normalizeIdentity({
      workKey: value.workKey,
      sourceUrl: value.sourceUrl,
      pipelineVersion: value.pipelineVersion,
      revision: value.revision,
      fingerprint: value.fingerprint,
    });
    const result: CoverAttemptRecord = {
      ...identity,
      key: meta.key,
      status: value.status,
      runId: value.runId,
      attemptedAt: value.attemptedAt,
      errorCode: value.errorCode,
      updatedAt: value.updatedAt,
    };
    return result.key === coverAttemptKey(identity) ? result : null;
  } catch {
    return null;
  }
}

/** Persist a failed/capacity attempt without replacing the last ready cover. */
export async function writeCoverAttemptMetadata(input: CoverAttemptWriteInput): Promise<boolean> {
  let attempt: CoverAttemptRecord;
  try {
    attempt = normalizeCoverAttempt(input);
  } catch {
    return false;
  }
  return putMediaMeta({
    key: attempt.key,
    kind: "value",
    value: {
      kind: "cover-attempt",
      workKey: attempt.workKey,
      sourceUrl: attempt.sourceUrl,
      pipelineVersion: attempt.pipelineVersion,
      revision: attempt.revision,
      fingerprint: attempt.fingerprint,
      status: attempt.status,
      runId: attempt.runId,
      attemptedAt: attempt.attemptedAt,
      errorCode: attempt.errorCode,
      updatedAt: attempt.updatedAt,
    },
    updatedAt: attempt.updatedAt,
  });
}

export const saveCoverAttemptMetadata = writeCoverAttemptMetadata;

export async function getCoverAttempt(identityInput: CoverIdentityInput): Promise<CoverAttemptRecord | null> {
  let key: string;
  try {
    key = coverAttemptKey(identityInput);
  } catch {
    return null;
  }
  return coverAttemptFromMeta(await getMediaMeta(key));
}

export async function listCoverAttempts(): Promise<CoverAttemptRecord[]> {
  const records = await listMediaMetadata();
  return records
    .map(coverAttemptFromMeta)
    .filter((attempt): attempt is CoverAttemptRecord => attempt !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function manifestMetadataValid(manifest: CoverManifest): boolean {
  return manifest.status === "ready"
    && nonEmpty(manifest.blobKey)
    && /^image\/[a-z0-9.+-]+$/.test(manifest.mime ?? "")
    && isSafePositiveInteger(manifest.width)
    && isSafePositiveInteger(manifest.height)
    && isSafePositiveInteger(manifest.bytes)
    && validSourceUrl(manifest.sourceUrl)
    && validPipelineVersion(manifest.pipelineVersion)
    && validRevision(manifest.revision)
    && validFingerprint(manifest.fingerprint);
}

function normalizeStatus(value: unknown): CoverManifestStatus {
  if (typeof value !== "string" || !COVER_STATUS_VALUES.has(value as CoverManifestStatus)) {
    throw new MediaValidationError("INVALID_STATUS", "unsupported cover status");
  }
  return value as CoverManifestStatus;
}

function normalizeManifestWrite(input: CoverManifestWriteInput): {
  identity: CoverIdentity;
  manifest: CoverManifest;
  expected: CoverManifestWriteInput;
} {
  const identity = normalizeIdentity(input);
  if (input.key !== undefined && input.key !== identity.workKey) {
    throw new MediaValidationError("INVALID_WORK_KEY", "manifest key must equal workKey");
  }
  const status = normalizeStatus(input.status);
  if (status === "ready") throw new MediaValidationError("INVALID_STATUS", "ready covers require commitCover");
  const at = input.now ?? input.attemptedAt ?? nowIso();
  if (!validTimestamp(at)) throw new MediaValidationError("INVALID_META", "timestamp must be non-empty");
  const attemptedAt = input.attemptedAt ?? at;
  if (!validTimestamp(attemptedAt)) throw new MediaValidationError("INVALID_META", "attemptedAt must be non-empty");
  const manifest: CoverManifest = {
    ...identity,
    key: identity.workKey,
    blobKey: null,
    status,
    mime: null,
    width: 0,
    height: 0,
    bytes: 0,
    lastAttemptRunId: boundedText(input.lastAttemptRunId, 200),
    attemptedAt,
    createdAt: at,
    updatedAt: at,
    errorCode: boundedText(input.errorCode, 120),
  };
  return { identity, manifest, expected: input };
}

function normalizeCommit(input: CoverCommitInput): {
  identity: CoverIdentity;
  manifest: CoverManifest;
  expected: CoverCommitInput;
  job: CoverJob | null;
  meta: MediaMetaRecord[];
} {
  const identity = normalizeIdentity(input);
  if (input.key !== undefined && input.key !== identity.workKey) {
    throw new MediaValidationError("INVALID_WORK_KEY", "manifest key must equal workKey");
  }
  const validation = validateCoverBlob({
    blob: input.blob,
    width: input.width,
    height: input.height,
    bytes: input.bytes,
    mime: input.mime,
    maxBytes: input.maxBytes,
    allowedMimeTypes: input.allowedMimeTypes,
  });
  if (!validation.ok) throw new MediaValidationError(validation.code, validation.message);
  const at = input.now ?? input.attemptedAt ?? nowIso();
  if (!validTimestamp(at)) throw new MediaValidationError("INVALID_META", "timestamp must be non-empty");
  const attemptedAt = input.attemptedAt ?? at;
  if (!validTimestamp(attemptedAt)) throw new MediaValidationError("INVALID_META", "attemptedAt must be non-empty");
  const blobKey = input.blobKey ?? coverBlobKey(identity);
  if (!nonEmpty(blobKey)) throw new MediaValidationError("INVALID_META", "blobKey must be non-empty");
  const manifest: CoverManifest = {
    ...identity,
    key: identity.workKey,
    blobKey,
    status: "ready",
    mime: validation.mime,
    width: validation.width,
    height: validation.height,
    bytes: validation.bytes,
    lastAttemptRunId: boundedText(input.lastAttemptRunId, 200),
    attemptedAt,
    createdAt: at,
    updatedAt: at,
    errorCode: null,
  };
  const job = input.job === undefined || input.job === null
    ? null
    : normalizeJob(input.job, at, "completed", identity);
  const metaInput = input.meta === undefined || input.meta === null
    ? []
    : Array.isArray(input.meta) ? input.meta : [input.meta];
  const meta = metaInput.map((item) => normalizeMetaWrite(item, at));
  return { identity, manifest, expected: input, job, meta };
}

function normalizeJob(
  input: CoverJobWriteInput,
  at: string,
  defaultStatus: CoverJobStatus,
  fallbackIdentity?: CoverIdentity,
): CoverJob {
  const identity = normalizeIdentity(input);
  if (fallbackIdentity && !identityEquals(identity, fallbackIdentity)) {
    throw new MediaValidationError("INVALID_JOB", "job identity must equal cover identity");
  }
  const key = input.key ?? coverJobKey(identity);
  if (!nonEmpty(key)) throw new MediaValidationError("INVALID_JOB", "job key must be non-empty");
  const status = input.status ?? defaultStatus;
  if (!JOB_STATUS_VALUES.has(status)) throw new MediaValidationError("INVALID_JOB", "unsupported job status");
  const attempts = input.attempts ?? 0;
  if (!isSafeNonNegativeInteger(attempts)) throw new MediaValidationError("INVALID_JOB", "attempts must be non-negative");
  const createdAt = input.createdAt ?? at;
  const updatedAt = input.updatedAt ?? at;
  if (!validTimestamp(createdAt) || !validTimestamp(updatedAt)) {
    throw new MediaValidationError("INVALID_JOB", "job timestamps must be non-empty");
  }
  return {
    ...identity,
    key,
    status,
    attempts,
    createdAt,
    updatedAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? (status === "completed" ? at : null),
    nextAttemptAt: input.nextAttemptAt ?? null,
    leaseToken: input.leaseToken ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    lastErrorCode: boundedText(input.lastErrorCode, 120),
    lastErrorMessage: boundedText(input.lastErrorMessage, 500),
  };
}

function isJsonValue(value: unknown): value is MediaJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (typeof value !== "object" || isBlob(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}

function normalizeMetaWrite(input: MediaMetaWriteInput, at: string): MediaMetaRecord {
  if (!input || typeof input !== "object" || typeof input.kind !== "string") {
    throw new MediaValidationError("INVALID_META", "metadata kind is required");
  }
  if (input.kind === "migration-journal") {
    const migrationId = input.migrationId;
    if (!nonEmpty(migrationId)
      || !validPipelineVersion(input.migrationVersion)
      || !MIGRATION_STATUS_VALUES.has(input.status)
      || !isJsonValue(input.details ?? null)) {
      throw new MediaValidationError("INVALID_META", "invalid migration journal");
    }
    const updatedAt = input.updatedAt ?? at;
    const startedAt = input.startedAt ?? updatedAt;
    if (!validTimestamp(updatedAt) || !validTimestamp(startedAt)) {
      throw new MediaValidationError("INVALID_META", "invalid migration journal timestamp");
    }
    return {
      key: migrationJournalKey(migrationId),
      kind: "migration-journal",
      migrationId,
      migrationVersion: input.migrationVersion,
      status: input.status,
      startedAt,
      updatedAt,
      completedAt: input.completedAt ?? null,
      errorCode: boundedText(input.errorCode, 120),
      details: input.details ?? null,
    };
  }
  if (input.kind === "migration-checkpoint") {
    if (!nonEmpty(input.migrationId)
      || !validPipelineVersion(input.migrationVersion)
      || !isSafeNonNegativeInteger(input.sequence)
      || !isJsonValue(input.state ?? null)) {
      throw new MediaValidationError("INVALID_META", "invalid migration checkpoint");
    }
    const updatedAt = input.updatedAt ?? at;
    if (!validTimestamp(updatedAt)) throw new MediaValidationError("INVALID_META", "invalid checkpoint timestamp");
    return {
      key: migrationCheckpointKey(input.migrationId),
      kind: "migration-checkpoint",
      migrationId: input.migrationId,
      migrationVersion: input.migrationVersion,
      sequence: input.sequence,
      cursor: input.cursor ?? null,
      state: input.state ?? null,
      updatedAt,
    };
  }
  if (input.kind === "value") {
    if (!nonEmpty(input.key) || !isJsonValue(input.value)) {
      throw new MediaValidationError("INVALID_META", "invalid media metadata value");
    }
    const updatedAt = input.updatedAt ?? at;
    if (!validTimestamp(updatedAt)) throw new MediaValidationError("INVALID_META", "invalid metadata timestamp");
    return { key: input.key, kind: "value", value: input.value, updatedAt };
  }
  throw new MediaValidationError("INVALID_META", "unsupported metadata kind");
}

function failure(reason: MediaValidationCode, current: CoverManifest | null): CoverCommitFailure {
  return { committed: false, reason, current };
}

/**
 * Commit the Blob and its Blob-free manifest atomically. Optional job and
 * metadata rows participate in this same media DB transaction. This function
 * never opens the work database; callers must reconcile against it separately.
 */
export async function commitCoverDetailed(input: CoverCommitInput): Promise<CoverCommitResult> {
  let normalized: ReturnType<typeof normalizeCommit>;
  try {
    normalized = normalizeCommit(input);
  } catch (error) {
    const reason = error instanceof MediaValidationError ? error.code : "INVALID_META";
    return failure(reason, null);
  }

  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction(["coverManifest", "coverBlobs", "coverJobs", "mediaMeta"], "readwrite");
    const manifests = tx.objectStore("coverManifest");
    const blobs = tx.objectStore("coverBlobs");
    const existing = await manifests.get(normalized.identity.workKey);
    const casReason = acceptsManifestWrite(existing ?? null, normalized.identity, {
      expectedIdentity: normalizeExpectedIdentity(input.expectedIdentity),
      expectedSourceUrl: input.expectedSourceUrl,
      expectedPipelineVersion: input.expectedPipelineVersion,
      expectedRevision: input.expectedRevision,
      expectedFingerprint: input.expectedFingerprint,
    });
    if (casReason !== null) {
      await tx.done;
      return failure(casReason, existing ?? null);
    }
    const manifest: CoverManifest = {
      ...normalized.manifest,
      createdAt: existing?.createdAt ?? normalized.manifest.createdAt,
    };
    await blobs.put(input.blob, manifest.blobKey!);
    if (existing?.blobKey && existing.blobKey !== manifest.blobKey) await blobs.delete(existing.blobKey);
    await manifests.put(manifest);
    if (normalized.job) await tx.objectStore("coverJobs").put(normalized.job);
    for (const meta of normalized.meta) await tx.objectStore("mediaMeta").put(meta);
    await tx.done;
    return {
      committed: true,
      manifest,
      job: normalized.job,
      metaKeys: normalized.meta.map((meta) => meta.key),
    };
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return failure("TRANSACTION_FAILED", null);
  }
}

/** Boolean CAS form for workers that only need to know whether they won. */
export async function commitCover(input: CoverCommitInput): Promise<boolean> {
  return (await commitCoverDetailed(input)).committed;
}

export const commitCoverCAS = commitCover;
export const saveCover = commitCover;
export const writeCover = commitCover;

export async function writeCoverManifest(input: CoverManifestWriteInput): Promise<boolean> {
  let normalized: ReturnType<typeof normalizeManifestWrite>;
  try {
    normalized = normalizeManifestWrite(input);
  } catch {
    return false;
  }
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction(["coverManifest", "coverBlobs"], "readwrite");
    const manifests = tx.objectStore("coverManifest");
    const blobs = tx.objectStore("coverBlobs");
    const existing = await manifests.get(normalized.identity.workKey);
    // A failure/capacity result must never demote the last durable ready cover,
    // even when the attempted source is a newer identity.
    if (existing?.status === "ready") {
      await tx.done;
      return false;
    }
    const casReason = acceptsManifestWrite(existing ?? null, normalized.identity, {
      expectedIdentity: normalizeExpectedIdentity(input.expectedIdentity),
      expectedSourceUrl: input.expectedSourceUrl,
      expectedPipelineVersion: input.expectedPipelineVersion,
      expectedRevision: input.expectedRevision,
      expectedFingerprint: input.expectedFingerprint,
    });
    if (casReason !== null) {
      await tx.done;
      return false;
    }
    if (existing?.blobKey) await blobs.delete(existing.blobKey);
    await manifests.put({ ...normalized.manifest, createdAt: existing?.createdAt ?? normalized.manifest.createdAt });
    await tx.done;
    return true;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return false;
  }
}

export const writeCoverAttempt = writeCoverManifest;
export const saveCoverManifest = writeCoverManifest;

function lookupOf(sourceOrOptions?: string | null | CoverLookupOptions): CoverLookupOptions {
  if (typeof sourceOrOptions === "string" || sourceOrOptions === null) return { sourceUrl: sourceOrOptions };
  return sourceOrOptions ?? {};
}

function lookupMatches(manifest: CoverManifest, options: CoverLookupOptions): boolean {
  if (options.sourceUrl !== undefined && manifest.sourceUrl !== options.sourceUrl) return false;
  if (options.pipelineVersion !== undefined && manifest.pipelineVersion !== options.pipelineVersion) return false;
  if (options.revision !== undefined && manifest.revision !== options.revision) return false;
  if (options.fingerprint !== undefined && manifest.fingerprint !== options.fingerprint) return false;
  return true;
}

/** Metadata-only current-cover read. It never opens or clones coverBlobs. */
export async function getCurrentCoverMetadata(
  workKey: string,
  sourceOrOptions?: string | null | CoverLookupOptions,
): Promise<CoverManifest | null> {
  if (!nonEmpty(workKey)) return null;
  const options = lookupOf(sourceOrOptions);
  const db = await getMediaDatabase();
  const manifest = await db.get("coverManifest", workKey);
  if (!manifest || manifest.key !== workKey || !lookupMatches(manifest, options)) return null;
  return manifest;
}

/** Read a complete current cover; the manifest and Blob are read together. */
export async function getCurrentCover(
  workKey: string,
  sourceOrOptions?: string | null | CoverLookupOptions,
): Promise<CurrentCover | null> {
  if (!nonEmpty(workKey)) return null;
  const options = lookupOf(sourceOrOptions);
  const db = await getMediaDatabase();
  const tx = db.transaction(["coverManifest", "coverBlobs"], "readonly");
  const manifests = tx.objectStore("coverManifest");
  const blobs = tx.objectStore("coverBlobs");
  const manifest = await manifests.get(workKey);
  if (!manifest || manifest.key !== workKey || !lookupMatches(manifest, options) || !manifestMetadataValid(manifest)) {
    await tx.done;
    return null;
  }
  const blob = await blobs.get(manifest.blobKey!);
  await tx.done;
  if (!blob || !isBlob(blob) || blob.size !== manifest.bytes || normalizeMime(blob.type) !== manifest.mime) return null;
  return { ...manifest, blob };
}

export const getCover = getCurrentCover;
export const readCurrentCover = getCurrentCover;
export const getCoverMetadata = getCurrentCoverMetadata;

export async function getCoverManifest(workKey: string): Promise<CoverManifest | null> {
  if (!nonEmpty(workKey)) return null;
  const db = await getMediaDatabase();
  return (await db.get("coverManifest", workKey)) ?? null;
}

export async function listCoverMetadata(options: CoverListOptions = {}): Promise<CoverManifest[]> {
  const db = await getMediaDatabase();
  const manifests = await db.getAll("coverManifest");
  const workKeys = options.workKeys === undefined ? null : new Set(options.workKeys);
  const statuses = options.status === undefined
    ? null
    : new Set(Array.isArray(options.status) ? options.status : [options.status]);
  return manifests
    .filter((manifest) => (workKeys === null || workKeys.has(manifest.workKey))
      && (options.pipelineVersion === undefined || manifest.pipelineVersion === options.pipelineVersion)
      && (statuses === null || statuses.has(manifest.status)))
    .sort((left, right) => left.workKey.localeCompare(right.workKey));
}

export const listCoverManifests = listCoverMetadata;
export const listMediaCovers = listCoverMetadata;

/** Summary reads only coverManifest, so a dashboard scan cannot clone Blob values. */
export async function getCoverSummary(options: { pipelineVersion?: number } = {}): Promise<CoverSummary> {
  const db = await getMediaDatabase();
  const manifests = await db.getAll("coverManifest");
  const summary: CoverSummary = { ready: 0, failed: 0, skipped: 0, pending: 0, bytes: 0, total: 0 };
  for (const manifest of manifests) {
    if (options.pipelineVersion !== undefined && manifest.pipelineVersion !== options.pipelineVersion) continue;
    summary.total += 1;
    if (manifest.status === "ready" && manifestMetadataValid(manifest)) {
      summary.ready += 1;
      summary.bytes += manifest.bytes;
    } else if (manifest.status === "failed") {
      summary.failed += 1;
    } else if (manifest.status === "skipped-capacity") {
      summary.skipped += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}

export const summarizeCovers = getCoverSummary;
export const getCoverCacheSummary = getCoverSummary;

function sourceSnapshotsOf(
  sourcesOrOptions: readonly CoverSourceSnapshot[] | CoverCandidateScanOptions,
): readonly CoverSourceSnapshot[] {
  if (Array.isArray(sourcesOrOptions)) return sourcesOrOptions;
  const options = sourcesOrOptions as CoverCandidateScanOptions;
  return options.sources ?? options.works ?? options.candidates ?? [];
}

function normalizeSnapshot(input: CoverSourceSnapshot, defaultPipelineVersion?: number): CoverIdentity | null {
  try {
    return normalizeIdentity({
      workKey: input.workKey || input.key || "",
      sourceUrl: input.sourceUrl || input.thumbnailUrl || "",
      pipelineVersion: input.pipelineVersion ?? defaultPipelineVersion,
      revision: input.revision,
      fingerprint: input.fingerprint,
      sourceFingerprint: input.sourceFingerprint,
    });
  } catch {
    return null;
  }
}

export async function scanCoverCandidates(
  sources: readonly CoverSourceSnapshot[],
  options?: Omit<CoverCandidateScanOptions, "sources" | "works" | "candidates">,
): Promise<CoverCandidate[]>;
export async function scanCoverCandidates(options: CoverCandidateScanOptions): Promise<CoverCandidate[]>;
export async function scanCoverCandidates(
  sourcesOrOptions: readonly CoverSourceSnapshot[] | CoverCandidateScanOptions = [],
  options: Omit<CoverCandidateScanOptions, "sources" | "works" | "candidates"> = {},
): Promise<CoverCandidate[]> {
  const sourceOptions: Omit<CoverCandidateScanOptions, "sources" | "works" | "candidates"> = Array.isArray(sourcesOrOptions)
    ? options
    : sourcesOrOptions as CoverCandidateScanOptions;
  const sources = sourceSnapshotsOf(sourcesOrOptions);
  const normalizedSources = sources
    .map((source) => normalizeSnapshot(source, sourceOptions.pipelineVersion))
    .filter((source): source is CoverIdentity => source !== null);
  const db = await getMediaDatabase();
  // Intentionally only reads the manifest store. Candidate discovery is a
  // metadata operation and must never structured-clone a Blob.
  const [manifests, attempts] = await Promise.all([
    db.getAll("coverManifest"),
    listCoverAttempts(),
  ]);
  const byWorkKey = new Map(manifests.map((manifest) => [manifest.workKey, manifest]));
  const attemptsByKey = new Map(attempts.map((attempt) => [attempt.key, attempt]));
  const candidates: CoverCandidate[] = [];
  for (const source of normalizedSources) {
    const current = byWorkKey.get(source.workKey);
    if (current) {
      if (current.revision > source.revision) continue;
      if (identityEquals(current, source)) {
        if (current.status === "ready" && manifestMetadataValid(current)) continue;
        if (sourceOptions.runId != null && current.lastAttemptRunId === sourceOptions.runId) continue;
      }
    }
    const attempt = attemptsByKey.get(coverAttemptKey(source));
    if (attempt && sourceOptions.runId != null && attempt.runId === sourceOptions.runId) continue;
    candidates.push({ key: source.workKey, ...source });
  }
  candidates.sort((left, right) => left.workKey.localeCompare(right.workKey));
  return sourceOptions.limit === undefined
    ? candidates
    : candidates.slice(0, Math.max(0, Math.floor(sourceOptions.limit)));
}

export const getCoverCandidates = scanCoverCandidates;
export const listCoverCandidates = scanCoverCandidates;

export async function deleteCover(workKey: string, expectedIdentity?: CoverIdentity | null): Promise<boolean> {
  if (!nonEmpty(workKey)) return false;
  let expected: CoverIdentity | null | undefined;
  try {
    expected = normalizeExpectedIdentity(expectedIdentity);
  } catch {
    return false;
  }
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction(["coverManifest", "coverBlobs"], "readwrite");
    const manifests = tx.objectStore("coverManifest");
    const blobs = tx.objectStore("coverBlobs");
    const existing = await manifests.get(workKey);
    if (!existing || (expected !== undefined && (expected === null || !identityEquals(existing, expected)))) {
      await tx.done;
      return false;
    }
    await manifests.delete(workKey);
    if (existing.blobKey) await blobs.delete(existing.blobKey);
    await tx.done;
    return true;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return false;
  }
}

export const removeCover = deleteCover;
export const deleteCoverRecord = deleteCover;

export async function putCoverJob(input: CoverJobWriteInput): Promise<boolean> {
  let job: CoverJob;
  try {
    const at = input.updatedAt ?? nowIso();
    if (!validTimestamp(at)) return false;
    job = normalizeJob(input, at, input.status ?? "pending");
  } catch {
    return false;
  }
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction("coverJobs", "readwrite");
    const store = tx.objectStore("coverJobs");
    const existing = await store.get(job.key);
    const reason = acceptsManifestWrite(existing ? existing as unknown as CoverManifest : null, job, {
      expectedIdentity: normalizeExpectedIdentity(input.expectedIdentity),
      expectedSourceUrl: input.expectedSourceUrl,
      expectedPipelineVersion: input.expectedPipelineVersion,
      expectedRevision: input.expectedRevision,
      expectedFingerprint: input.expectedFingerprint,
    });
    if (reason !== null) {
      await tx.done;
      return false;
    }
    await store.put(job);
    await tx.done;
    return true;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return false;
  }
}

export const saveCoverJob = putCoverJob;
export const writeCoverJob = putCoverJob;

export async function getCoverJob(key: string | CoverIdentityInput): Promise<CoverJob | null> {
  let jobKey: string;
  try {
    jobKey = typeof key === "string" ? key : coverJobKey(key);
  } catch {
    return null;
  }
  const db = await getMediaDatabase();
  return (await db.get("coverJobs", jobKey)) ?? null;
}

export async function listCoverJobs(options: { status?: CoverJobStatus | readonly CoverJobStatus[]; workKey?: string } = {}): Promise<CoverJob[]> {
  const db = await getMediaDatabase();
  const jobs = await db.getAll("coverJobs");
  const statuses = options.status === undefined
    ? null
    : new Set(Array.isArray(options.status) ? options.status : [options.status]);
  return jobs
    .filter((job) => (statuses === null || statuses.has(job.status))
      && (options.workKey === undefined || job.workKey === options.workKey))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.key.localeCompare(right.key));
}

export async function updateCoverJobStatus(update: CoverJobStatusUpdate): Promise<boolean> {
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const identity = normalizeIdentity(update.identity);
    if (!JOB_STATUS_VALUES.has(update.status)) return false;
    const at = update.now ?? nowIso();
    const db = await getMediaDatabase();
    tx = db.transaction("coverJobs", "readwrite");
    const store = tx.objectStore("coverJobs");
    const key = coverJobKey(identity);
    const existing = await store.get(key);
    if (!existing || !identityEquals(existing, identity)) {
      await tx.done;
      return false;
    }
    if (!expectedMatches(existing, { expectedIdentity: normalizeExpectedIdentity(update.expectedIdentity) })) {
      await tx.done;
      return false;
    }
    const next: CoverJob = {
      ...existing,
      status: update.status,
      updatedAt: at,
      attempts: update.attempts ?? existing.attempts,
      nextAttemptAt: update.nextAttemptAt === undefined ? existing.nextAttemptAt : update.nextAttemptAt,
      leaseToken: update.leaseToken === undefined ? existing.leaseToken : update.leaseToken,
      leaseExpiresAt: update.leaseExpiresAt === undefined ? existing.leaseExpiresAt : update.leaseExpiresAt,
      completedAt: update.status === "completed" ? at : existing.completedAt,
      lastErrorCode: boundedText(update.errorCode, 120) ?? existing.lastErrorCode,
      lastErrorMessage: boundedText(update.errorMessage, 500) ?? existing.lastErrorMessage,
    };
    if (!isSafeNonNegativeInteger(next.attempts) || !validTimestamp(next.updatedAt)) {
      await tx.done;
      return false;
    }
    await store.put(next);
    await tx.done;
    return true;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return false;
  }
}

export async function claimCoverJob(key: string, options: ClaimCoverJobOptions): Promise<CoverJob | null> {
  if (!nonEmpty(key) || !nonEmpty(options.workerId)) return null;
  const now = options.now ?? nowIso();
  const leaseMs = options.leaseMs ?? 60_000;
  if (!validTimestamp(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1) return null;
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction("coverJobs", "readwrite");
    const store = tx.objectStore("coverJobs");
    const existing = await store.get(key);
    if (!existing || existing.status === "completed" || existing.status === "cancelled") {
      await tx.done;
      return null;
    }
    const expires = existing.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : NaN;
    const nowMs = Date.parse(now);
    if (existing.leaseToken && Number.isFinite(expires) && Number.isFinite(nowMs) && expires > nowMs) {
      await tx.done;
      return null;
    }
    const leaseExpiresAt = Number.isFinite(nowMs)
      ? new Date(nowMs + leaseMs).toISOString()
      : now;
    const claimed: CoverJob = {
      ...existing,
      status: "claimed",
      attempts: existing.attempts + 1,
      updatedAt: now,
      startedAt: existing.startedAt ?? now,
      leaseToken: `${options.workerId}:${now}:${existing.attempts + 1}`,
      leaseExpiresAt,
    };
    await store.put(claimed);
    await tx.done;
    return claimed;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return null;
  }
}

/** Recover claims left by a terminated worker into durable pending jobs. */
export async function recoverCoverJobs(now = nowIso()): Promise<RecoverCoverJobsResult> {
  if (!validTimestamp(now)) return { recovered: 0, jobs: [] };
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction("coverJobs", "readwrite");
    const store = tx.objectStore("coverJobs");
    const jobs = await store.getAll();
    const nowMs = Date.parse(now);
    const recovered: CoverJob[] = [];
    for (const job of jobs) {
      if (job.status !== "claimed" && job.status !== "fetching" && job.status !== "validating" && job.status !== "committing") continue;
      const expires = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : NaN;
      if (Number.isFinite(expires) && Number.isFinite(nowMs) && expires > nowMs) continue;
      const next: CoverJob = {
        ...job,
        status: "pending",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        lastErrorCode: job.lastErrorCode ?? "WORKER_RECOVERY",
      };
      await store.put(next);
      recovered.push(next);
    }
    await tx.done;
    return { recovered: recovered.length, jobs: recovered };
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return { recovered: 0, jobs: [] };
  }
}

export const recoverDurableCoverJobs = recoverCoverJobs;

export async function putMediaMeta(input: MediaMetaWriteInput): Promise<boolean> {
  let meta: MediaMetaRecord;
  try {
    meta = normalizeMetaWrite(input, input.updatedAt ?? nowIso());
  } catch {
    return false;
  }
  const db = await getMediaDatabase();
  try {
    await db.put("mediaMeta", meta);
    return true;
  } catch {
    return false;
  }
}

export const saveMediaMeta = putMediaMeta;

export async function getMediaMeta(key: string): Promise<MediaMetaRecord | null> {
  if (!nonEmpty(key)) return null;
  const db = await getMediaDatabase();
  return (await db.get("mediaMeta", key)) ?? null;
}

export async function listMediaMetadata(): Promise<MediaMetaRecord[]> {
  const db = await getMediaDatabase();
  return (await db.getAll("mediaMeta")).sort((left, right) => left.key.localeCompare(right.key));
}

export async function writeMigrationJournal(input: MigrationJournalWriteInput): Promise<boolean> {
  return putMediaMeta({ ...input, kind: "migration-journal" });
}

export const putMigrationJournal = writeMigrationJournal;
export const saveMigrationJournal = writeMigrationJournal;

export async function getMigrationJournal(migrationId: string): Promise<MigrationJournalRecord | null> {
  const record = await getMediaMeta(migrationJournalKey(migrationId));
  return record?.kind === "migration-journal" ? record : null;
}

export async function writeMigrationCheckpoint(input: MigrationCheckpointWriteInput): Promise<boolean> {
  let normalized: MigrationCheckpointRecord;
  try {
    normalized = normalizeMetaWrite({ ...input, kind: "migration-checkpoint" }, input.updatedAt ?? nowIso()) as MigrationCheckpointRecord;
  } catch {
    return false;
  }
  const db = await getMediaDatabase();
  let tx: MediaReadWriteTransaction | undefined;
  try {
    tx = db.transaction("mediaMeta", "readwrite");
    const store = tx.objectStore("mediaMeta");
    const previous = await store.get(normalized.key);
    if (previous?.kind === "migration-checkpoint" && previous.sequence > normalized.sequence) {
      await tx.done;
      return false;
    }
    await store.put(normalized);
    await tx.done;
    return true;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return false;
  }
}

export const putMigrationCheckpoint = writeMigrationCheckpoint;
export const saveMigrationCheckpoint = writeMigrationCheckpoint;

export async function getMigrationCheckpoint(migrationId: string): Promise<MigrationCheckpointRecord | null> {
  const record = await getMediaMeta(migrationCheckpointKey(migrationId));
  return record?.kind === "migration-checkpoint" ? record : null;
}

export async function recoverMigration(migrationId: string): Promise<MigrationRecovery> {
  const db = await getMediaDatabase();
  const tx = db.transaction("mediaMeta", "readonly");
  const [journal, checkpoint] = await Promise.all([
    tx.objectStore("mediaMeta").get(migrationJournalKey(migrationId)),
    tx.objectStore("mediaMeta").get(migrationCheckpointKey(migrationId)),
  ]);
  await tx.done;
  const typedJournal = journal?.kind === "migration-journal" ? journal : null;
  const typedCheckpoint = checkpoint?.kind === "migration-checkpoint" ? checkpoint : null;
  return {
    migrationId,
    journal: typedJournal,
    checkpoint: typedCheckpoint,
    resumeCursor: typedCheckpoint?.cursor ?? null,
    recoverable: typedJournal?.status === "running"
      || (typedJournal?.status === "failed" && typedCheckpoint !== null),
  };
}

export const recoverMigrationState = recoverMigration;
export const readMigrationRecovery = recoverMigration;

export async function deleteMigrationCheckpoint(migrationId: string): Promise<boolean> {
  const db = await getMediaDatabase();
  try {
    await db.delete("mediaMeta", migrationCheckpointKey(migrationId));
    return true;
  } catch {
    return false;
  }
}

function mapCurrentSources(options: ReconcileOptions): Map<string, CoverIdentity> {
  const map = new Map<string, CoverIdentity>();
  for (const source of options.current ?? options.currentSources ?? []) {
    const normalized = normalizeSnapshot(source);
    if (normalized) map.set(normalized.workKey, normalized);
  }
  for (const [workKey, source] of options.currentByWorkKey ?? []) {
    if (source === null) continue;
    try {
      map.set(workKey, normalizeIdentity(source));
    } catch {
      // An invalid external snapshot cannot be used as a deletion authority.
    }
  }
  return map;
}

/**
 * Reconcile orphaned blobs and stale manifests after an external work DB
 * snapshot. The snapshot and this transaction cannot be atomic across DBs;
 * callers should repeat reconcile if the source DB may have changed during
 * the operation.
 */
export async function reconcileMedia(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const checkedAt = options.now ?? nowIso();
  const removeStale = options.removeStaleManifests ?? true;
  const removeOrphans = options.removeOrphanBlobs ?? true;
  const removeMissing = options.removeMissingBlobManifests ?? true;
  const current = mapCurrentSources(options);
  const hasExternalSnapshot = options.current !== undefined
    || options.currentSources !== undefined
    || options.currentByWorkKey !== undefined;
  const result: ReconcileResult = {
    crossDatabaseAtomic: false,
    checkedAt,
    removedManifestCount: 0,
    removedBlobCount: 0,
    orphanBlobKeys: [],
    staleWorkKeys: [],
    missingBlobWorkKeys: [],
    invalidManifestWorkKeys: [],
  };
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction(["coverManifest", "coverBlobs"], "readwrite");
    const manifestsStore = tx.objectStore("coverManifest");
    const blobsStore = tx.objectStore("coverBlobs");
    const [manifests, blobKeys] = await Promise.all([manifestsStore.getAll(), blobsStore.getAllKeys()]);
    const availableBlobKeys = new Set(blobKeys.map((key) => String(key)));
    const manifestDeletes = new Set<string>();
    const referenced = new Set<string>();
    const deletedBlobKeys = new Set<string>();

    const deleteBlob = async (key: string): Promise<void> => {
      if (deletedBlobKeys.has(key)) return;
      await blobsStore.delete(key);
      deletedBlobKeys.add(key);
    };

    for (const manifest of manifests) {
      let remove = false;
      if (manifest.key !== manifest.workKey || !validSourceUrl(manifest.sourceUrl)
        || !validPipelineVersion(manifest.pipelineVersion) || !validRevision(manifest.revision)
        || !validFingerprint(manifest.fingerprint)) {
        result.invalidManifestWorkKeys.push(manifest.workKey);
        remove = true;
      }
      const expected = current.get(manifest.workKey);
      const hasCompleteWorkSnapshot = options.currentByWorkKey !== undefined;
      const knownWork = hasCompleteWorkSnapshot && options.currentByWorkKey!.has(manifest.workKey);
      if (!remove && hasExternalSnapshot && removeStale && !expected
        && hasCompleteWorkSnapshot && !knownWork) {
        result.staleWorkKeys.push(manifest.workKey);
        remove = true;
      }
      if (!remove && hasExternalSnapshot && removeStale && expected && !identityEquals(manifest, expected)) {
        // A changed authoritative source is stale only as a refresh target.
        // Keep the old ready row and Blob as the stale-while-revalidate value;
        // a successful commit will replace both atomically.
        if (manifest.status !== "ready") {
          result.staleWorkKeys.push(manifest.workKey);
          remove = true;
        }
      }
      if (!remove && manifest.status === "ready") {
        if (!manifest.blobKey || !availableBlobKeys.has(manifest.blobKey)) {
          result.missingBlobWorkKeys.push(manifest.workKey);
          remove = removeMissing;
        } else {
          referenced.add(manifest.blobKey);
        }
      } else if (!remove && manifest.blobKey) {
        // Non-ready rows never own a Blob. Treat a stray key as an orphan.
        if (removeOrphans) await deleteBlob(manifest.blobKey);
      }
      if (remove) {
        manifestDeletes.add(manifest.key);
        if (manifest.blobKey) await deleteBlob(manifest.blobKey);
      }
    }
    for (const key of blobKeys) {
      const blobKey = String(key);
      if (!referenced.has(blobKey) && removeOrphans) {
        result.orphanBlobKeys.push(blobKey);
        await deleteBlob(blobKey);
      }
    }
    for (const key of manifestDeletes) await manifestsStore.delete(key);
    result.removedManifestCount = manifestDeletes.size;
    result.removedBlobCount = deletedBlobKeys.size;
    await tx.done;
    result.staleWorkKeys.sort();
    result.missingBlobWorkKeys.sort();
    result.invalidManifestWorkKeys.sort();
    result.orphanBlobKeys.sort();
    return result;
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return result;
  }
}

export const reconcileMediaStorage = reconcileMedia;
export const reconcileCovers = reconcileMedia;

export async function reconcileCoverJobs(options: ReconcileOptions = {}): Promise<ReconcileJobsResult> {
  const current = mapCurrentSources(options);
  const hasExternalSnapshot = options.current !== undefined
    || options.currentSources !== undefined
    || options.currentByWorkKey !== undefined;
  const staleJobKeys: string[] = [];
  let removed = 0;
  let tx: MediaReadWriteTransaction | undefined;
  try {
    const db = await getMediaDatabase();
    tx = db.transaction("coverJobs", "readwrite");
    const store = tx.objectStore("coverJobs");
    const jobs = await store.getAll();
    for (const job of jobs) {
      const expected = current.get(job.workKey);
      if (!hasExternalSnapshot || !expected || identityEquals(job, expected)) continue;
      staleJobKeys.push(job.key);
      await store.delete(job.key);
      removed += 1;
    }
    await tx.done;
    staleJobKeys.sort();
    return { removed, staleJobKeys, crossDatabaseAtomic: false };
  } catch {
    if (tx) await tx.done.catch(() => undefined);
    return { removed, staleJobKeys, crossDatabaseAtomic: false };
  }
}

export const reconcileJobs = reconcileCoverJobs;

/** Read a Blob by key for explicit media reads; metadata scans do not call it. */
export async function getCoverBlob(blobKey: string): Promise<Blob | null> {
  if (!nonEmpty(blobKey)) return null;
  const db = await getMediaDatabase();
  return (await db.get("coverBlobs", blobKey)) ?? null;
}

export async function deleteCoverBlob(blobKey: string): Promise<boolean> {
  if (!nonEmpty(blobKey)) return false;
  const db = await getMediaDatabase();
  try {
    await db.delete("coverBlobs", blobKey);
    return true;
  } catch {
    return false;
  }
}
