import {
  COVER_CACHE_PIPELINE_VERSION,
  COVER_CACHE_MAX_BLOB_BYTES,
  LOSSLESS_RETENTION_HOURS,
  MAX_STORAGE_BYTES,
  PARSER_VERSION,
  RETENTION_30M_MAX_DAYS,
  RETENTION_1H_MAX_DAYS,
  RETENTION_SCHEMA_VERSION,
} from "../domain/constants";
import type {
  AppSettings,
  AccountFollowerRecord,
  AccountFollowerSample,
  CoverCacheSummary,
  CoverRecord,
  CoverStatus,
  PixivAccount,
  DashboardData,
  ObservationBatch,
  PagePayload,
  ParsedWork,
  SyncRun,
  SyncState,
  StorageMeta,
  ImportStagingRecord,
  MaintenanceState,
  WorkMetrics,
  WorkObservation,
  WorkRecord,
  WorkSample,
} from "../domain/types";
import { normalizeRankingFields, type NormalizedRanking } from "../domain/types";
import {
  canonicalMetadataEqual,
  decodeObservationBatch,
  decodeWorkSample,
  decodeWorkDocument,
  decodeWorkState,
  encodeObservationBatch,
  encodeWorkSample,
  encodeWorkDocument,
  encodeWorkState,
  materializeWorkRecord,
  canonicalWorkSample,
  sampleCanonicalHash,
  sampleIdentityFor,
  observationBatchCanonicalHash,
  type StoredWorkSample,
  type StoredObservationBatch,
} from "./storage-codec";
import { beijingDateKey } from "../domain/time";
import { isUsableCoverRecord } from "../domain/cover-queue";
import {
  retentionBucketKey as sharedRetentionBucketKey,
  retentionTierForAge as sharedRetentionTierForAge,
  type RetentionTier as SharedRetentionTier,
} from "../domain/temporal-compaction";
import {
  getSettings,
  getSyncState,
  saveSettings,
  saveSyncState,
  clearSettings,
  clearSyncState,
  DEFAULT_SETTINGS,
} from "./local-state";
import {
  clearDatabase,
  getDatabase,
  stagedPageKey,
  type AnalyticsMigrationSnapshot,
  type AnalyticsSchemaState,
  type PixivPulseSchema,
  type StagedPage,
} from "./database";
import type { IDBPDatabase, IDBPTransaction } from "idb";
import type { MetricFrameChangeInput, MetricFrameMetricKey, MetricKeyframeState } from "../domain/metric-frames";
import { createMetricKeyframe, decodeWorkDictionary } from "./metric-frame-codec";
import { buildMetricFrame, countStoredRetentionTiers, prepareFrameWrite, readPublicFrameHistory } from "./frame-storage";
import { runGuardedFrameCompaction } from "./retention-backup";
import {
  cleanupBridgedCovers,
  clearBridgedCoverData,
  readBridgedCover,
  scanBridgedCoverCandidates,
  summarizeBridgedCovers,
  writeBridgedCover,
} from "./cover-media-bridge";

export interface CompleteSyncOptions {
  runId: string;
  trigger: SyncRun["trigger"];
  startedAt: string;
  expectedPageCount?: number;
  accountId?: string | null;
  finishedAt?: string;
}

export class AccountMismatchError extends Error {
  readonly code = "ACCOUNT_MISMATCH" as const;

  constructor(message = "当前 Pixiv 账号与已绑定账号不一致，请先清除本地数据后重新绑定") {
    super(message);
    this.name = "AccountMismatchError";
  }
}

export interface StorageHealth {
  usageBytes: number | null;
  quotaBytes: number | null;
  warning: boolean;
  ceiling: boolean;
}

export interface RetentionResult extends StorageHealth {
  deletedSamples: number;
  deletedBatches: number;
  createdRollups: number;
  updatedRollups: number;
  skippedBecauseCeiling: boolean;
  temporalCompactedSamples: number;
  temporalDeletedSamples: number;
  temporalSkippedBecauseCeiling: boolean;
  tierCounts: RetentionTierCounts;
  pendingReason: RetentionPendingReason | null;
  dataRevision: number;
}

export interface TemporalCompactionOptions {
  /** Explicit opt-in used by scheduled background cleanup. Manual sync and
   * maintenance calls leave this disabled. */
  enabled?: boolean;
  now?: string | number | Date;
}

export interface TemporalCompactionResult {
  updatedSamples: number;
  deletedSamples: number;
  considered: number;
  skipped: number;
  skippedBecauseCeiling: boolean;
  pendingReason?: RetentionPendingReason | undefined;
}

export interface RetentionHooks {
  warningBytes?: number;
  ceilingBytes?: number;
  onWarning?: (health: StorageHealth) => void | Promise<void>;
  onCeiling?: (health: StorageHealth) => void | Promise<void>;
  /** Automatic temporal compaction is deliberately opt-in. The background
   * passes this only for scheduled runs; manual maintenance never does. */
  temporalCompaction?: boolean | TemporalCompactionOptions;
  now?: string | number | Date;
}

export interface ExportBundle {
  formatVersion: 5;
  exportedAt: string;
  timeZone: "Asia/Shanghai";
  account: PixivAccount | null;
  works: WorkRecord[];
  samples: WorkSample[];
  observationBatches: ObservationBatch[];
  observations: WorkObservation[];
  accountFollowerSamples: AccountFollowerSample[];
  runs: SyncRun[];
  settings: PortableSettings;
}

export interface PortableSettings {
  onboardingComplete: boolean;
  scheduledSyncEnabled: boolean;
  syncIntervalHours: number;
  showPixivChips: boolean;
  theme: AppSettings["theme"];
}

export type RetentionTier = SharedRetentionTier;
export type RetentionPendingReason =
  | "revision-race"
  | "source-mismatch"
  | "corrupt-source"
  | "apply-failed"
  | "backup-directory-required"
  | "backup-verification-failed"
  | "unsafe-legacy-plan"
  | null;

export interface RetentionTierCounts {
  lossless: number;
  "30m": number;
  "1h": number;
  "6h": number;
}

export interface RetentionSourceSample {
  id: number | null;
  identity: string;
  hash: string;
  sample: WorkSample;
}

export interface RetentionSourceBatch {
  runId: string;
  identity: string;
  hash: string;
  batch: ObservationBatch;
}

export interface RetentionSamplePut {
  sample: WorkSample;
  /** Existing inline primary key, when this put replaces a source row. */
  replaceId?: number;
  reason: "compaction" | "daily-rollup";
}

export interface RetentionPlanInput {
  samples: readonly WorkSample[];
  observationBatches: readonly ObservationBatch[];
  accountId?: string | null;
  revision?: number;
  now?: string | number | Date;
}

export interface RetentionPlan {
  version: typeof RETENTION_SCHEMA_VERSION;
  planId: string;
  accountId: string | null;
  revision: number;
  now: string;
  policy: {
    timeZone: "Asia/Shanghai";
    losslessHours: typeof LOSSLESS_RETENTION_HOURS;
    tiers: { "30m": number; "1h": number; "6h": number };
  };
  samplePuts: RetentionSamplePut[];
  sampleDeletes: RetentionSourceSample[];
  batchDeletes: RetentionSourceBatch[];
  sourceSamples: RetentionSourceSample[];
  sourceBatches: RetentionSourceBatch[];
  tierCounts: RetentionTierCounts;
}

export interface RetentionApplyResult {
  applied: boolean;
  deletedSamples: number;
  deletedBatches: number;
  createdRollups: number;
  updatedRollups: number;
  dataRevision: number;
  pendingReason: RetentionPendingReason;
}

export interface StorageStats {
  dataRevision: number;
  works: number;
  samples: number;
  observationBatches: number;
  observations: number;
  runs: number;
  stagedPages: number;
  importStaging: number;
  accountFollowerRecords: number;
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

export const PASSIVE_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export function workKeyFor(type: WorkRecord["type"], id: string): string {
  return `${type}-${id}`;
}

export function metricsEqual(left: WorkMetrics, right: WorkMetrics): boolean {
  return METRIC_KEYS.every((key) => key === "rank"
    ? normalizeRankingFields({ rank: left.rank }).rank === normalizeRankingFields({ rank: right.rank }).rank
    : left[key] === right[key]);
}

function rankingOf(value: {
  metrics: WorkMetrics;
  rankingStatus?: unknown;
  rankingObservedAt?: unknown;
  rankingSource?: unknown;
}): NormalizedRanking {
  return normalizeRankingFields({
    rank: value.metrics.rank,
    rankingStatus: value.rankingStatus,
    rankingObservedAt: value.rankingObservedAt,
    rankingSource: value.rankingSource,
  });
}

function rankingsEqual(left: NormalizedRanking, right: NormalizedRanking): boolean {
  return left.rankingStatus === right.rankingStatus && left.rank === right.rank;
}

function additiveMetricsEqual(left: WorkMetrics, right: WorkMetrics): boolean {
  return ADDITIVE_METRIC_KEYS.every((key) => left[key] === right[key]);
}

function metricsWithRanking(metrics: WorkMetrics, ranking: NormalizedRanking): WorkMetrics {
  return { ...metrics, rank: ranking.rank };
}

function sampleRankingFor(incoming: NormalizedRanking): NormalizedRanking {
  // Unknown observations are deliberately not allowed to carry forward a
  // record's ranking into a new sample.
  return incoming.rankingStatus === "unknown"
    ? { rank: null, rankingStatus: "unknown", rankingObservedAt: null, rankingSource: null }
    : incoming;
}

export function observationForRun(
  workKey: string,
  runId: string,
  observedAt: string,
  metricsChanged: boolean,
): WorkObservation {
  return { workKey, runId, observedAt, metricsChanged };
}

function sortedUniqueWorkKeys(workKeys: Iterable<string>): string[] {
  return [...new Set(workKeys)].filter(Boolean).sort();
}

export function observationBatchForRun(
  runId: string,
  observedAt: string,
  workKeys: Iterable<string>,
  changedWorkKeys: Iterable<string>,
  scope: ObservationBatch["scope"],
): ObservationBatch {
  const observed = sortedUniqueWorkKeys(workKeys);
  const observedSet = new Set(observed);
  return {
    runId,
    observedAt,
    workKeys: observed,
    changedWorkKeys: sortedUniqueWorkKeys(changedWorkKeys).filter((workKey) => observedSet.has(workKey)),
    scope,
  };
}

function pagePayloadOf(value: PagePayload | Pick<StagedPage, "payload">): PagePayload {
  return "payload" in value ? value.payload : value;
}

export interface AccountConsistencyResult {
  account: PixivAccount | null;
  accountId: string | null;
}

/** Validate the immutable account identity before any staged data is applied. */
export function validateAccountConsistency(
  values: readonly (PagePayload | Pick<StagedPage, "payload">)[],
  boundAccountId: string | null = null,
): AccountConsistencyResult {
  const payloads = values.map(pagePayloadOf);
  const accounts = payloads.map((payload) => payload.account ?? null);
  for (const account of accounts) {
    if (account != null && (!/^\d+$/.test(account.id) || account.profileUrl !== `https://www.pixiv.net/users/${account.id}`)) {
      throw new AccountMismatchError("Pixiv account identity is invalid");
    }
  }
  const ids = new Set(accounts.filter((account): account is PixivAccount => account != null).map((account) => account.id));
  if (ids.size > 1) throw new AccountMismatchError();
  const accountId = [...ids][0] ?? null;
  if (boundAccountId != null && accountId !== boundAccountId) throw new AccountMismatchError();
  if (accountId != null && accounts.some((account) => account == null)) throw new AccountMismatchError();
  let account: PixivAccount | null = null;
  for (const item of accounts) if (item != null) account = item;
  return { account, accountId };
}

function nowIso(): string {
  return new Date().toISOString();
}

const STORAGE_META_KEY = "root" as const;

async function incrementDataRevision(
  tx: IDBPTransaction<PixivPulseSchema, any, "readwrite">,
): Promise<number> {
  const store = tx.objectStore("storageMeta");
  const current = await store.get(STORAGE_META_KEY);
  const previous = current?.dataRevision ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error("Stored data revision is corrupt");
  const next = previous + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Stored data revision overflow");
  await store.put({ key: STORAGE_META_KEY, dataRevision: next } satisfies StorageMeta);
  return next;
}

export async function getDataRevision(): Promise<number> {
  const db = await getDatabase();
  const value = await db.get("storageMeta", STORAGE_META_KEY);
  const revision = value?.dataRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Stored data revision is corrupt");
  return revision;
}

export const readDataRevision = getDataRevision;
export const getStorageRevision = getDataRevision;

function emptyAnalyticsSchemaState(): AnalyticsSchemaState {
  return {
    key: "root",
    activeSchema: "legacy",
    nextRunSeq: 0,
    migrationStatus: "pending",
    migrationCursor: null,
    migrationSnapshot: null,
    updatedAt: nowIso(),
  };
}

async function assertAnalyticsWritableInTransaction(
  tx: IDBPTransaction<PixivPulseSchema, any, "readwrite">,
): Promise<void> {
  const state = await tx.objectStore("analyticsSchemaState").get("root");
  if (state?.migrationStatus === "running") throw new Error("Analytics history migration is running");
}

async function assertAnalyticsWritable(): Promise<void> {
  const state = await (await getDatabase()).get("analyticsSchemaState", "root");
  if (state?.migrationStatus === "running") throw new Error("Analytics history migration is running");
}

export async function getStorageStats(): Promise<StorageStats> {
  const db = await getDatabase();
  const tx = db.transaction([
    "storageMeta", "works", "samples", "observationBatches", "metricFrames", "observations", "syncRuns", "stagedPages", "importStaging", "accountFollowerRecords",
  ], "readonly");
  const [meta, works, legacySamples, legacyBatches, frames, observations, runs, stagedPages, importStaging, accountFollowerRecords] = await Promise.all([
    tx.objectStore("storageMeta").get(STORAGE_META_KEY),
    tx.objectStore("works").count(),
    tx.objectStore("samples").count(),
    tx.objectStore("observationBatches").count(),
    tx.objectStore("metricFrames").getAll(),
    tx.objectStore("observations").count(),
    tx.objectStore("syncRuns").count(),
    tx.objectStore("stagedPages").count(),
    tx.objectStore("importStaging").count(),
    tx.objectStore("accountFollowerRecords").count(),
  ]);
  await tx.done;
  const dataRevision = meta?.dataRevision ?? 0;
  if (!Number.isSafeInteger(dataRevision) || dataRevision < 0) throw new Error("Stored data revision is corrupt");
  const samples = legacySamples + frames.reduce((count, frame) => count + frame.changes.length, 0);
  const observationBatches = legacyBatches + frames.length;
  return { dataRevision, works, samples, observationBatches, observations, runs, stagedPages, importStaging, accountFollowerRecords };
}

export const readStorageStats = getStorageStats;

export function importStagingKey(sessionId: string, chunk: number): string {
  if (!sessionId || !Number.isSafeInteger(chunk) || chunk < 0) throw new Error("Invalid import staging key");
  return `${sessionId}:${chunk}`;
}

export async function stageImportChunk(input: Omit<ImportStagingRecord, "key"> & { key?: string }): Promise<ImportStagingRecord> {
  if (!input.sessionId || !Number.isSafeInteger(input.chunk) || input.chunk < 0) throw new Error("Invalid import staging chunk");
  if (!input.createdAt || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("Invalid import staging timestamp");
  const expectedKey = importStagingKey(input.sessionId, input.chunk);
  if (input.key !== undefined && input.key !== expectedKey) throw new Error("Invalid import staging key");
  const record: ImportStagingRecord = {
    ...input,
    key: expectedKey,
  };
  const db = await getDatabase();
  await db.put("importStaging", record);
  return record;
}

export const putImportStaging = stageImportChunk;

export async function getImportStaging(sessionId: string): Promise<ImportStagingRecord[]> {
  const db = await getDatabase();
  const rows = await db.getAllFromIndex("importStaging", "by-session", sessionId);
  return rows.sort((left, right) => left.chunk - right.chunk);
}

export async function clearImportStaging(sessionId: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction("importStaging", "readwrite");
  const keys = await tx.objectStore("importStaging").index("by-session").getAllKeys(sessionId);
  for (const key of keys) await tx.objectStore("importStaging").delete(key);
  await tx.done;
}

export interface ImportedAnalyticalData {
  /** The caller supplies only work rows selected by its import conflict plan. */
  works?: readonly WorkRecord[];
  samples?: readonly WorkSample[];
  observationBatches?: readonly ObservationBatch[];
  runs?: readonly SyncRun[];
  /** Delete this session's staged chunks as part of the final commit. */
  stagingSessionId?: string;
}

/** Publish an already-validated import selection in one IndexedDB transaction.
 * Chunks stay in `importStaging` until the caller has completed its own
 * account/conflict checks. Imported sample ids are intentionally discarded so
 * the destination auto-increment sequence cannot collide with source ids. */
export async function commitImportedAnalyticalData(input: ImportedAnalyticalData): Promise<number> {
  await assertAnalyticsWritable();
  const works = [...(input.works ?? [])];
  const samples = [...(input.samples ?? [])];
  const observationBatches = [...(input.observationBatches ?? [])];
  const runs = [...(input.runs ?? [])];
  if (input.stagingSessionId !== undefined && !input.stagingSessionId) throw new Error("Invalid import staging session");
  const encodedWorks = works.map((work) => ({
    document: encodeWorkDocument(work),
    state: encodeWorkState(work),
  }));
  const encodedSamples = samples.map((sample) => {
    const { id: _sourceId, ...withoutId } = sample;
    return encodeWorkSample(withoutId);
  });
  const encodedBatches = observationBatches.map((batch) => encodeObservationBatch(batch));

  const sampleIdentities = new Set<string>();
  for (const sample of samples) {
    const identity = sampleIdentityFor(sample);
    if (sampleIdentities.has(identity)) throw new Error("Import contains duplicate sample identities");
    sampleIdentities.add(identity);
  }
  const batchIds = new Set<string>();
  for (const batch of observationBatches) {
    if (batchIds.has(batch.runId)) throw new Error("Import contains duplicate observation batches");
    batchIds.add(batch.runId);
  }
  const runIds = new Set<string>();
  for (const run of runs) {
    if (!run.runId || runIds.has(run.runId)) throw new Error("Import contains duplicate sync runs");
    runIds.add(run.runId);
  }

  const db = await getDatabase();
  const transactionStores = [
    "works", "workStates", "samples", "observationBatches", "syncRuns", "storageMeta", "analyticsSchemaState",
    ...(input.stagingSessionId === undefined ? [] : ["importStaging"]),
  ] as ["works", "workStates", "samples", "observationBatches", "syncRuns", "storageMeta", "analyticsSchemaState", ..."importStaging"[]];
  const tx = db.transaction(transactionStores, "readwrite");
  await assertAnalyticsWritableInTransaction(tx);
  const workStore = tx.objectStore("works");
  const stateStore = tx.objectStore("workStates");
  const sampleStore = tx.objectStore("samples");
  const batchStore = tx.objectStore("observationBatches");
  const runStore = tx.objectStore("syncRuns");
  for (const entry of encodedWorks) {
    await workStore.put(entry.document, entry.document.key);
    await stateStore.put(entry.state, entry.state.key);
  }
  for (const sample of encodedSamples) await sampleStore.put(sample);
  for (const batch of encodedBatches) await batchStore.put(batch);
  for (const run of runs) await runStore.put(run, run.runId);
  if (input.stagingSessionId !== undefined) {
    const stagingStore = tx.objectStore("importStaging");
    const stagedKeys = await stagingStore.index("by-session").getAllKeys(input.stagingSessionId);
    for (const key of stagedKeys) await stagingStore.delete(key);
  }
  const revision = samples.length > 0 || observationBatches.length > 0
    ? await incrementDataRevision(tx)
    : await getRevisionFromTransaction(tx);
  await tx.done;
  return revision;
}

async function getRevisionFromTransaction(
  tx: IDBPTransaction<PixivPulseSchema, any, "readwrite">,
): Promise<number> {
  const value = await tx.objectStore("storageMeta").get(STORAGE_META_KEY);
  const revision = value?.dataRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Stored data revision is corrupt");
  return revision;
}

export const commitImportData = commitImportedAnalyticalData;
export const commitImportedRecords = commitImportedAnalyticalData;

export async function getMaintenanceState(): Promise<MaintenanceState | null> {
  const db = await getDatabase();
  return (await db.get("maintenanceState", "retention")) ?? null;
}

export async function setMaintenanceState(state: Omit<MaintenanceState, "key">): Promise<MaintenanceState> {
  const record: MaintenanceState = { ...state, key: "retention" };
  const db = await getDatabase();
  await db.put("maintenanceState", record);
  return record;
}

function runBase(options: CompleteSyncOptions): SyncRun {
  return {
    runId: options.runId,
    trigger: options.trigger,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt ?? nowIso(),
    status: "completed",
    pages: 0,
    works: 0,
    changedWorks: 0,
    errorCode: null,
    errorMessage: null,
  };
}

function qualityScore(payload: PagePayload): number {
  if (payload.quality.totalCards === 0) return payload.positivelyEmpty ? 1 : 0;
  return Math.max(0, Math.min(1, payload.quality.validCards / payload.quality.totalCards));
}

function getStagedPageMap(staged: StagedPage[], runId: string, expectedPageCount?: number): Map<number, StagedPage> {
  const pages = staged.filter((item) => item.runId === runId);
  const map = new Map<number, StagedPage>();
  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page < 1 || map.has(page.page)) {
      throw new Error("Invalid or duplicate staged page");
    }
    map.set(page.page, page);
  }
  const declaredCount = expectedPageCount ?? Math.max(...pages.map((page) => page.payload.pageCount), 0);
  if (declaredCount < 1 || map.size !== declaredCount) throw new Error("Not all pages have been staged");
  for (let page = 1; page <= declaredCount; page += 1) {
    if (!map.has(page)) throw new Error(`Missing staged page ${page}`);
  }
  const last = map.get(declaredCount);
  if (!last || last.payload.hasNext) throw new Error("Staged pagination is incomplete");
  return map;
}

function publicAccountFollowerSample(
  record: AccountFollowerRecord,
  completedRunIds: ReadonlySet<string>,
  boundAccountId: string | null,
): AccountFollowerSample | null {
  // Follower rows are an independent, worker-owned state machine. Keep the
  // public boundary deliberately defensive so pending, failed, malformed, or
  // cross-account rows can never leak into dashboard/export snapshots.
  const followers = record?.followers;
  if (boundAccountId == null
    || !record
    || record.status !== "ready"
    || record.accountId !== boundAccountId
    || typeof record.runId !== "string"
    || !completedRunIds.has(record.runId)
    || typeof record.collectedAt !== "string"
    || !record.collectedAt
    || !Number.isFinite(Date.parse(record.collectedAt))
    || typeof followers !== "number"
    || !Number.isSafeInteger(followers)
    || followers < 0) return null;
  return {
    runId: record.runId,
    accountId: record.accountId,
    collectedAt: record.collectedAt,
    followers,
  };
}

async function allRecords(db: IDBPDatabase<PixivPulseSchema>, boundAccountId: string | null = null): Promise<{
  works: WorkRecord[];
  samples: WorkSample[];
  observationBatches: ObservationBatch[];
  observations: WorkObservation[];
  runs: SyncRun[];
  accountFollowerSamples: AccountFollowerSample[];
}> {
  const tx = db.transaction(["works", "workStates", "samples", "observationBatches", "observations", "syncRuns", "accountFollowerRecords"], "readonly");
  const frameHistoryPromise = readPublicFrameHistory(db);
  const [rawWorks, rawStates, samples, rawObservationBatches, observations, runs, rawAccountFollowerRecords] = await Promise.all([
    tx.objectStore("works").getAll(),
    tx.objectStore("workStates").getAll(),
    tx.objectStore("samples").getAll(),
    tx.objectStore("observationBatches").getAll(),
    tx.objectStore("observations").getAll(),
    tx.objectStore("syncRuns").getAll(),
    tx.objectStore("accountFollowerRecords").getAll(),
  ]);
  await tx.done;
  const frameHistory = await frameHistoryPromise;
  const stateMap = new Map(rawStates.map((state) => [state.key, state]));
  const works = rawWorks.map((document) => materializeWorkRecord(document, stateMap.get(document.key)));
  const publicSamples = samples.map((sample) => decodeWorkSample(sample));
  const observationBatches = rawObservationBatches.map((batch) => decodeObservationBatch(batch));
  const completedRunIds = new Set(runs.filter((run) => run.status === "completed").map((run) => run.runId));
  const accountFollowerSamples = rawAccountFollowerRecords
    .map((record) => publicAccountFollowerSample(record, completedRunIds, boundAccountId))
    .filter((sample): sample is AccountFollowerSample => sample != null);
  const mergedSamples = mergeByStableIdentity(
    [...publicSamples, ...frameHistory.samples],
    (sample) => sampleIdentityFor(sample),
  );
  const mergedObservationBatches = mergeByStableIdentity(
    [...observationBatches, ...frameHistory.observationBatches],
    (batch) => observationBatchIdentity(batch),
  );
  return {
    works,
    samples: mergedSamples,
    observationBatches: mergedObservationBatches,
    observations,
    runs,
    accountFollowerSamples,
  };
}

function mergeByStableIdentity<T>(values: readonly T[], identity: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = identity(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function stagePage(payload: PagePayload): Promise<void> {
  if (!payload.runId || payload.page < 1 || !payload.fingerprint) throw new Error("Invalid page payload");
  const db = await getDatabase();
  const staged: StagedPage = {
    key: stagedPageKey(payload.runId, payload.page),
    runId: payload.runId,
    page: payload.page,
    payload,
    stagedAt: nowIso(),
  };
  await db.put("stagedPages", staged, staged.key);
}

export async function getStagedPages(runId: string): Promise<StagedPage[]> {
  const db = await getDatabase();
  const pages = await db.getAllFromIndex("stagedPages", "by-run-id", runId);
  return pages.sort((left, right) => left.page - right.page);
}

/** Resolve the account identity from a complete staged run before a worker
 * makes an account-level request. This intentionally shares the same page
 * completeness and immutable-account checks as completeSync; callers never
 * receive a best-effort account parsed from one page. */
export async function getTrustedStagedAccount(
  runId: string,
  expectedAccountId?: string | null,
): Promise<PixivAccount> {
  if (typeof runId !== "string" || !runId) throw new AccountMismatchError();
  try {
    const settings = await getSettings();
    const boundAccountId = expectedAccountId ?? settings.boundAccount?.id ?? null;
    const db = await getDatabase();
    const staged = await db.getAllFromIndex("stagedPages", "by-run-id", runId);
    const pageMap = getStagedPageMap(staged, runId);
    const pages = [...pageMap.values()].sort((left, right) => left.page - right.page);
    const result = validateAccountConsistency(pages, boundAccountId);
    if (!result.account) throw new AccountMismatchError("Pixiv account identity was not found on the dashboard");
    return result.account;
  } catch (error) {
    if (error instanceof AccountMismatchError) throw error;
    throw new AccountMismatchError();
  }
}

export interface AccountFollowerCollectionReservation {
  runId: string;
  accountId: string;
  collectedAt: string;
}

export interface AccountFollowerCollectionSettlement extends AccountFollowerCollectionReservation {
  followers: number | null;
  errorCode: SyncRun["errorCode"];
}

function validateAccountFollowerReservation(input: AccountFollowerCollectionReservation): void {
  if (typeof input.runId !== "string" || !input.runId
    || typeof input.accountId !== "string" || !input.accountId
    || typeof input.collectedAt !== "string" || !input.collectedAt
    || !Number.isFinite(Date.parse(input.collectedAt))) {
    throw new Error("Invalid account follower collection reservation");
  }
}

function safeFollowerCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reserve the one follower request associated with a run. The primary-key
 * read and add are in one transaction; an existing row (including pending or
 * unavailable) always wins, which makes worker recovery idempotent. */
export async function reserveAccountFollowerCollection(
  input: AccountFollowerCollectionReservation,
): Promise<boolean> {
  validateAccountFollowerReservation(input);
  const db = await getDatabase();
  const tx = db.transaction(["accountFollowerRecords", "storageMeta"], "readwrite");
  const store = tx.objectStore("accountFollowerRecords");
  const existing = await store.get(input.runId);
  if (existing) {
    await tx.done;
    return false;
  }
  const record: AccountFollowerRecord = {
    runId: input.runId,
    accountId: input.accountId,
    collectedAt: input.collectedAt,
    status: "pending",
    followers: null,
    errorCode: null,
  };
  try {
    await store.add(record);
    await incrementDataRevision(tx);
    await tx.done;
    return true;
  } catch (error) {
    await tx.done.catch(() => undefined);
    // Another extension context may have won the same reservation between
    // the read and add. Treat only that expected race as a lost reservation;
    // storage failures remain visible to the caller.
    if ((error as { name?: unknown } | null)?.name === "ConstraintError") return false;
    throw error;
  }
}

/** Compare-and-set a pending follower reservation into ready/unavailable.
 * Account and timestamp mismatches are rejected; a second settlement observes
 * the non-pending state and becomes a harmless no-op. */
export async function settleAccountFollowerCollection(
  input: AccountFollowerCollectionSettlement,
): Promise<void> {
  validateAccountFollowerReservation(input);
  const db = await getDatabase();
  const tx = db.transaction(["accountFollowerRecords", "storageMeta"], "readwrite");
  const store = tx.objectStore("accountFollowerRecords");
  const current = await store.get(input.runId);
  if (!current) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error("Account follower collection reservation was not found");
  }
  if (current.accountId !== input.accountId) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new AccountMismatchError();
  }
  if (current.collectedAt !== input.collectedAt) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error("Account follower collection reservation does not match");
  }
  if (current.status !== "pending") {
    await tx.done;
    return;
  }
  const ready = safeFollowerCount(input.followers);
  const settled: AccountFollowerRecord = {
    runId: input.runId,
    accountId: input.accountId,
    collectedAt: input.collectedAt,
    status: ready ? "ready" : "unavailable",
    followers: ready ? input.followers : null,
    errorCode: ready ? null : input.errorCode,
  };
  await store.put(settled);
  await incrementDataRevision(tx);
  await tx.done;
}

export async function clearStagedPages(runId: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction("stagedPages", "readwrite");
  const pages = await tx.store.index("by-run-id").getAllKeys(runId);
  for (const key of pages) await tx.store.delete(key);
  await tx.done;
}

export async function completeSync(options: CompleteSyncOptions): Promise<SyncRun> {
  await assertAnalyticsWritable();
  const settings = await getSettings();
  const persistedAccountId = settings.boundAccount?.id ?? null;
  if (options.accountId != null && persistedAccountId != null && options.accountId !== persistedAccountId) {
    throw new AccountMismatchError();
  }
  const db = await getDatabase();
  // Resolve account identity before opening the write transaction. The first
  // binding must be durable before any work/sample/observation is published.
  const stagedSnapshot = await db.getAll("stagedPages");
  const snapshotMap = getStagedPageMap(stagedSnapshot, options.runId, options.expectedPageCount);
  const snapshotPages = [...snapshotMap.values()].sort((left, right) => left.page - right.page);
  const snapshotAccount = validateAccountConsistency(snapshotPages, options.accountId ?? persistedAccountId);
  if (!snapshotAccount.account) throw new AccountMismatchError("Pixiv account identity was not found on the dashboard");
  const immutableAccountId = options.accountId ?? persistedAccountId ?? snapshotAccount.accountId;
  if (persistedAccountId == null) await saveSettings({ boundAccount: snapshotAccount.account });

  const tx = db.transaction(["stagedPages", "works", "workStates", "syncRuns", "storageMeta", "workDictionary", "metricFrames", "metricKeyframes", "analyticsSchemaState"], "readwrite");
  await assertAnalyticsWritableInTransaction(tx);
  const staged = await tx.objectStore("stagedPages").getAll();
  const pageMap = getStagedPageMap(staged, options.runId, options.expectedPageCount);
  const pages = [...pageMap.values()].sort((left, right) => left.page - right.page);
  const accountResult = validateAccountConsistency(pages, immutableAccountId);
  const parsedWorks = pages.flatMap((page) => page.payload.works);
  const uniqueWorks = new Map<string, { work: (typeof parsedWorks)[number]; quality: number }>();
  for (const work of parsedWorks) {
    const key = workKeyFor(work.type, work.id);
    if (!uniqueWorks.has(key)) {
      const sourcePage = pages.find((page) => page.payload.works.some((candidate) => workKeyFor(candidate.type, candidate.id) === key));
      uniqueWorks.set(key, { work, quality: sourcePage ? qualityScore(sourcePage.payload) : 0 });
    }
  }

  const workStore = tx.objectStore("works");
  const stateStore = tx.objectStore("workStates");
  // WorkRecord is the current authoritative snapshot. In particular, do not
  // scan all samples here: v3 intentionally keeps samples sparse and a full
  // sample read would turn every sync into an avoidable O(history) operation.
  const [existingDocuments, existingStates] = await Promise.all([workStore.getAll(), stateStore.getAll()]);
  const existingStateMap = new Map(existingStates.map((state) => [state.key, state]));
  const existingWorkMap = new Map(existingDocuments.map((document) => [
    document.key,
    materializeWorkRecord(document, existingStateMap.get(document.key)),
  ]));
  const existingDocumentMap = new Map(existingDocuments.map((document) => [document.key, document]));
  const finalWorkMap = new Map(existingWorkMap);

  const observedAt = pages.reduce((latest, page) => page.payload.collectedAt > latest ? page.payload.collectedAt : latest, "");
  const collectedAt = observedAt || nowIso();
  const frameContext = await prepareFrameWrite(tx, uniqueWorks.keys(), collectedAt);
  const frameChanges: MetricFrameChangeInput[] = [];
  let changedWorks = 0;
  for (const [key, entry] of uniqueWorks) {
    const existing = existingWorkMap.get(key);
    const normalizedWork = existing && !isCoverSourceUrl(entry.work.thumbnailUrl) && isCoverSourceUrl(existing.thumbnailUrl)
      ? { ...entry.work, thumbnailUrl: existing.thumbnailUrl }
      : entry.work;
    const nextDocument = encodeWorkDocument(normalizedWork, {
      key,
      firstSeenAt: existing?.firstSeenAt ?? collectedAt,
    });
    const incomingRanking = rankingOf(entry.work);
    const existingRanking = existing ? rankingOf(existing) : null;
    const sampleRanking = sampleRankingFor(incomingRanking);
    // An unknown incoming ranking is a partial ranking observation. Compare
    // the remaining metrics to the current record while preserving its known
    // rank; explicit ranked/unranked transitions are handled separately.
    const comparableRanking = incomingRanking.rankingStatus === "unknown"
      ? existingRanking ?? sampleRanking
      : incomingRanking;
    const comparableMetrics = metricsWithRanking(entry.work.metrics, comparableRanking);
    const metricsChanged = !existing || !metricsEqual(existing.metrics, comparableMetrics);
    const explicitRankingChanged = incomingRanking.rankingStatus !== "unknown"
      && (!existingRanking || !rankingsEqual(existingRanking, incomingRanking));
    const changed = metricsChanged || explicitRankingChanged;
    if (changed) {
      changedWorks += 1;
    }
    const recordRanking = incomingRanking.rankingStatus === "unknown"
      ? existingRanking ?? sampleRanking
      : incomingRanking;
    const recordRankingObservedAt = incomingRanking.rankingStatus === "unknown"
      ? existingRanking?.rankingObservedAt ?? null
      : recordRanking.rankingObservedAt ?? collectedAt;
    const recordRankingSource = incomingRanking.rankingStatus === "unknown"
      ? existingRanking?.rankingSource ?? null
      : recordRanking.rankingSource;
    const record: WorkRecord = {
      ...normalizedWork,
      key,
      metrics: metricsWithRanking(entry.work.metrics, recordRanking),
      rankingStatus: recordRanking.rankingStatus,
      rankingObservedAt: recordRanking.rankingStatus === "unknown" ? null : recordRankingObservedAt,
      rankingSource: recordRanking.rankingStatus === "unknown" ? null : recordRankingSource,
      firstSeenAt: existing?.firstSeenAt ?? collectedAt,
      lastSeenAt: collectedAt,
      lastObservedRunId: options.runId,
      absentSince: null,
    };
    const ordinal = frameContext.ordinals.get(key);
    if (ordinal == null) throw new Error(`Missing work ordinal for ${key}`);
    if (changed || frameContext.newOrdinals.has(ordinal)) {
      const sparseMetrics: Partial<Record<MetricFrameMetricKey, number | null>> = {};
      for (const metric of METRIC_KEYS) {
        if (!existing || frameContext.newOrdinals.has(ordinal) || existing.metrics[metric] !== record.metrics[metric]) {
          sparseMetrics[metric] = record.metrics[metric];
        }
      }
      const change: MetricFrameChangeInput = { ordinal, metrics: sparseMetrics };
      if (!existing || frameContext.newOrdinals.has(ordinal) || explicitRankingChanged) {
        change.ranking = {
          status: record.rankingStatus ?? "unknown",
          observedAt: record.rankingObservedAt ?? null,
          source: record.rankingSource ?? null,
        };
      }
      if (entry.quality !== 0) change.quality = entry.quality;
      frameChanges.push(change);
    }
    const existingDocument = existingDocumentMap.get(key);
    if (!existingDocument || !canonicalMetadataEqual(existingDocument, nextDocument)) {
      await workStore.put(nextDocument, key);
    }
    await stateStore.put(encodeWorkState(record), key);
    finalWorkMap.set(key, record);
  }

  for (const existing of existingWorkMap.values()) {
    if (uniqueWorks.has(existing.key)) continue;
    if (existing.absentSince) continue;
    const absentRecord = { ...existing, absentSince: collectedAt };
    await stateStore.put(encodeWorkState(absentRecord), existing.key);
    finalWorkMap.set(existing.key, absentRecord);
  }

  const run = runBase(options);
  run.pages = pages.length;
  run.works = uniqueWorks.size;
  run.changedWorks = changedWorks;
  const observedOrdinals = [...uniqueWorks.keys()].map((key) => frameContext.ordinals.get(key)!).sort((left, right) => left - right);
  const frame = buildMetricFrame({
    runId: options.runId,
    runSeq: frameContext.runSeq,
    collectedAt,
    scope: options.trigger === "passive" ? "partial" : "complete",
    parser: Math.max(0, ...[...uniqueWorks.values()].map((entry) => entry.work.parserVersion)),
    quality: 0,
    observedOrdinals,
    changes: frameChanges,
  });
  await tx.objectStore("metricFrames").put(frame);
  const day = beijingDateKey(frame.epochMs);
  const existingKeyframes = await tx.objectStore("metricKeyframes").getAll();
  if (day && !existingKeyframes.some((item) => beijingDateKey(item.epochMs) === day)) {
    const states: MetricKeyframeState[] = [];
    for (const entry of frameContext.dictionary.entries) {
      const record = finalWorkMap.get(entry.workKey);
      if (!record) continue;
      const lastEpochMs = Date.parse(record.lastSeenAt);
      states.push({
        ordinal: entry.ordinal,
        metrics: { ...record.metrics },
        rankingStatus: record.rankingStatus ?? "unknown",
        rankingObservedAt: record.rankingObservedAt ?? null,
        rankingSource: record.rankingSource ?? null,
        presence: record.absentSince ? "absent" : "present",
        absentSince: record.absentSince,
        lastObserved: Number.isFinite(lastEpochMs) ? {
          runId: record.lastObservedRunId,
          runSeq: frame.runSeq,
          epochMs: lastEpochMs,
          collectedAt: record.lastSeenAt,
        } : null,
        parser: record.parserVersion,
        quality: 0,
        provenance: null,
      });
    }
    await tx.objectStore("metricKeyframes").put(createMetricKeyframe({
      runId: `${options.runId}:keyframe`,
      runSeq: frame.runSeq,
      epochMs: frame.epochMs,
      scope: "complete",
      parser: frame.parser,
      quality: frame.quality,
    }, states));
  }
  await tx.objectStore("syncRuns").put(run, run.runId);
  for (const page of pages) await tx.objectStore("stagedPages").delete(page.key);
  await incrementDataRevision(tx);
  await tx.done;
  if (accountResult.account && (accountResult.account.id !== persistedAccountId
    || settings.boundAccount?.name !== accountResult.account.name
    || settings.boundAccount?.profileUrl !== accountResult.account.profileUrl)) {
    try {
      await saveSettings({ boundAccount: accountResult.account });
    } catch {
      // The IndexedDB snapshot is already committed; a local-storage outage
      // must not turn a successful run into a false failed run.
    }
  }
  return run;
}

export const commitSync = completeSync;
export const atomicCompleteSync = completeSync;

export type PassivePageValidation =
  | { ok: true }
  | { ok: false; code: "SCHEMA_DRIFT" | "ACCOUNT_MISMATCH" | "PAGE_TIMEOUT"; message: string };

export class PassiveSnapshotValidationError extends Error {
  readonly code: Exclude<PassivePageValidation, { ok: true }>["code"];

  constructor(code: Exclude<PassivePageValidation, { ok: true }>["code"], message: string) {
    super(message);
    this.name = "PassiveSnapshotValidationError";
    this.code = code;
  }
}

/** Validate a page snapshot before it is allowed to update existing records.
 * Passive observations never establish a new account binding. */
export function validatePassivePagePayload(
  payload: PagePayload,
  boundAccountId: string | null,
  now = Date.now(),
  maxAgeMs = PASSIVE_SNAPSHOT_MAX_AGE_MS,
): PassivePageValidation {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.works)
    || !payload.quality || typeof payload.quality !== "object") {
    return { ok: false, code: "SCHEMA_DRIFT", message: "Passive snapshot payload is invalid" };
  }
  if (payload.parserVersion !== PARSER_VERSION) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "Parser version does not match the background contract" };
  }
  if (boundAccountId == null || payload.account == null || payload.account.id !== boundAccountId) {
    return { ok: false, code: "ACCOUNT_MISMATCH", message: "当前 Pixiv 账号与已绑定账号不一致，请先清除本地数据后重新绑定" };
  }
  if (!/^\d+$/.test(payload.account.id) || payload.account.profileUrl !== `https://www.pixiv.net/users/${payload.account.id}`) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "Pixiv account identity is invalid" };
  }
  const collectedAt = Date.parse(payload.collectedAt);
  if (!Number.isFinite(collectedAt)) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "Passive snapshot timestamp is invalid" };
  }
  if (collectedAt > now + 60_000) {
    return { ok: false, code: "PAGE_TIMEOUT", message: "Passive snapshot timestamp is in the future" };
  }
  if (now - collectedAt > maxAgeMs) {
    return { ok: false, code: "PAGE_TIMEOUT", message: "Passive snapshot is too old to apply" };
  }
  if (![payload.quality.totalCards, payload.quality.validCards, payload.quality.missingRequired, payload.quality.missingMetricFields]
    .every((value) => Number.isInteger(value) && value >= 0)
    || payload.quality.validCards > payload.quality.totalCards
    || payload.quality.missingRequired > payload.quality.totalCards
    || (payload.quality.totalCards > 0 && payload.quality.validCards === 0)) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "Page quality counters are inconsistent" };
  }
  return { ok: true };
}

export class StaleObservationError extends Error {
  readonly code = "PAGE_TIMEOUT" as const;

  constructor(message = "Passive snapshot is older than the stored work observation") {
    super(message);
    this.name = "StaleObservationError";
  }
}

export interface PassivePageMergeOptions {
  accountId?: string | null;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  now?: number;
}

function passiveRunId(payload: PagePayload, options: PassivePageMergeOptions): string {
  if (options.runId) return options.runId;
  if (payload.runId) return payload.runId;
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `passive-${random}` : `passive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Atomically apply a read-only dashboard observation to existing works.
 * Unknown metrics/ranking are ignored for records, while the optional sample
 * represents only the fields actually reconstructed at this observation. */
export async function mergePassivePageSnapshot(
  payload: PagePayload,
  options: PassivePageMergeOptions = {},
): Promise<SyncRun> {
  await assertAnalyticsWritable();
  const settings = await getSettings();
  const boundAccountId = options.accountId ?? settings.boundAccount?.id ?? null;
  const validation = validatePassivePagePayload(payload, boundAccountId, options.now ?? Date.now());
  if (!validation.ok) {
    throw new PassiveSnapshotValidationError(validation.code, validation.message);
  }

  const runId = passiveRunId(payload, options);
  const startedAt = options.startedAt ?? payload.collectedAt;
  const collectedAt = payload.collectedAt;
  const db = await getDatabase();
  const tx = db.transaction(["works", "workStates", "syncRuns", "storageMeta", "workDictionary", "metricFrames", "analyticsSchemaState"], "readwrite");
  await assertAnalyticsWritableInTransaction(tx);
  const workStore = tx.objectStore("works");
  const stateStore = tx.objectStore("workStates");
  const [existingDocuments, existingStates] = await Promise.all([workStore.getAll(), stateStore.getAll()]);
  const existingStateMap = new Map(existingStates.map((state) => [state.key, state]));
  const existingWorkMap = new Map(existingDocuments.map((document) => [
    document.key,
    materializeWorkRecord(document, existingStateMap.get(document.key)),
  ]));
  const existingDocumentMap = new Map(existingDocuments.map((document) => [document.key, document]));

  const matched = new Map<string, ParsedWork>();
  for (const work of payload.works) {
    const key = workKeyFor(work.type, work.id);
    if (matched.has(key)) throw new Error("Passive snapshot contains duplicate works");
    if (existingWorkMap.has(key)) matched.set(key, work);
  }
  const observedTimestamp = Date.parse(collectedAt);
  for (const key of matched.keys()) {
    const existing = existingWorkMap.get(key);
    const previousTimestamp = existing ? Date.parse(existing.lastSeenAt) : NaN;
    if (existing && Number.isFinite(previousTimestamp) && observedTimestamp < previousTimestamp) {
      throw new StaleObservationError();
    }
  }

  let changedWorks = 0;
  const frameContext = await prepareFrameWrite(tx, matched.keys(), collectedAt);
  const frameChanges: MetricFrameChangeInput[] = [];
  for (const [key, incoming] of matched) {
    const existing = existingWorkMap.get(key);
    if (!existing) continue;
    const normalizedIncoming = !isCoverSourceUrl(incoming.thumbnailUrl) && isCoverSourceUrl(existing.thumbnailUrl)
      ? { ...incoming, thumbnailUrl: existing.thumbnailUrl }
      : incoming;
    const incomingDocument = encodeWorkDocument(normalizedIncoming, { key, firstSeenAt: existing.firstSeenAt });
    // Passive pages can omit optional metadata fields. Preserve an existing
    // optional value in that case, while still allowing explicit changes.
    const existingDocument = existingDocumentMap.get(key);
    const nextDocument = existingDocument
      ? { ...existingDocument, ...incomingDocument }
      : incomingDocument;
    const currentRanking = rankingOf(existing);
    const incomingRanking = rankingOf(incoming);
    const effectiveRanking = incomingRanking.rankingStatus === "unknown" ? currentRanking : incomingRanking;
    const mergedMetrics: WorkMetrics = { ...existing.metrics };
    for (const metric of ADDITIVE_METRIC_KEYS) {
      if (incoming.metrics[metric] != null) mergedMetrics[metric] = incoming.metrics[metric];
    }
    mergedMetrics.rank = effectiveRanking.rank;
    const metricsChanged = ADDITIVE_METRIC_KEYS.some((metric) => incoming.metrics[metric] != null
      && incoming.metrics[metric] !== existing.metrics[metric]);
    const rankingChanged = incomingRanking.rankingStatus !== "unknown"
      && !rankingsEqual(currentRanking, incomingRanking);
    const changed = metricsChanged || rankingChanged;
    if (changed) {
      changedWorks += 1;
    }
    const recordRanking = incomingRanking.rankingStatus === "unknown" ? currentRanking : incomingRanking;
    const recordRankingObservedAt = incomingRanking.rankingStatus === "unknown"
      ? currentRanking.rankingObservedAt ?? null
      : recordRanking.rankingObservedAt ?? collectedAt;
    const recordRankingSource = incomingRanking.rankingStatus === "unknown"
      ? currentRanking.rankingSource ?? null
      : recordRanking.rankingSource;
    const record: WorkRecord = {
      ...existing,
      ...nextDocument,
      metrics: mergedMetrics,
      rankingStatus: recordRanking.rankingStatus,
      rankingObservedAt: recordRanking.rankingStatus === "unknown" ? null : recordRankingObservedAt,
      rankingSource: recordRanking.rankingStatus === "unknown" ? null : recordRankingSource,
      lastSeenAt: collectedAt,
      lastObservedRunId: runId,
      absentSince: null,
    };
    const ordinal = frameContext.ordinals.get(key);
    if (ordinal == null) throw new Error(`Missing work ordinal for ${key}`);
    if (changed || frameContext.newOrdinals.has(ordinal)) {
      const sparseMetrics: Partial<Record<MetricFrameMetricKey, number | null>> = {};
      for (const metric of METRIC_KEYS) {
        if (frameContext.newOrdinals.has(ordinal) || existing.metrics[metric] !== record.metrics[metric]) {
          sparseMetrics[metric] = record.metrics[metric];
        }
      }
      const change: MetricFrameChangeInput = { ordinal, metrics: sparseMetrics, quality: qualityScore(payload) };
      if (frameContext.newOrdinals.has(ordinal) || rankingChanged) {
        change.ranking = {
          status: record.rankingStatus ?? "unknown",
          observedAt: record.rankingObservedAt ?? null,
          source: record.rankingSource ?? null,
        };
      }
      frameChanges.push(change);
    }
    if (!existingDocument || !canonicalMetadataEqual(existingDocument, nextDocument)) {
      await workStore.put(nextDocument, key);
    }
    await stateStore.put(encodeWorkState(record), key);
  }

  const runOptions: CompleteSyncOptions = {
    runId,
    trigger: "passive",
    startedAt,
  };
  if (options.finishedAt !== undefined) runOptions.finishedAt = options.finishedAt;
  const run = runBase(runOptions);
  run.pages = 1;
  run.works = matched.size;
  run.changedWorks = changedWorks;
  const frame = buildMetricFrame({
    runId,
    runSeq: frameContext.runSeq,
    collectedAt,
    scope: "partial",
    parser: payload.parserVersion,
    quality: qualityScore(payload),
    observedOrdinals: [...matched.keys()].map((key) => frameContext.ordinals.get(key)!).sort((left, right) => left - right),
    changes: frameChanges,
  });
  await tx.objectStore("metricFrames").put(frame);
  await tx.objectStore("syncRuns").put(run, run.runId);
  await incrementDataRevision(tx);
  await tx.done;
  return run;
}

export const mergePassiveSnapshot = mergePassivePageSnapshot;
export const completePassiveSync = mergePassivePageSnapshot;
export const atomicMergePassivePage = mergePassivePageSnapshot;

export async function failSyncRun(
  options: CompleteSyncOptions,
  errorCode: SyncRun["errorCode"],
  errorMessage: string,
): Promise<SyncRun> {
  const db = await getDatabase();
  const tx = db.transaction(["stagedPages", "syncRuns"], "readwrite");
  const run: SyncRun = {
    ...runBase(options),
    finishedAt: options.finishedAt ?? nowIso(),
    status: "failed",
    errorCode,
    errorMessage: errorMessage.slice(0, 1000),
  };
  const pages = await tx.objectStore("stagedPages").index("by-run-id").getAll(options.runId);
  run.pages = pages.length;
  run.works = pages.reduce((count, page) => count + page.payload.works.length, 0);
  for (const page of pages) await tx.objectStore("stagedPages").delete(page.key);
  await tx.objectStore("syncRuns").put(run, run.runId);
  await tx.done;
  return run;
}

export async function getDashboardData(): Promise<DashboardData> {
  const db = await getDatabase();
  const settings = await getSettings();
  const records = await allRecords(db, settings.boundAccount?.id ?? null);
  records.works.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  records.samples.sort((left, right) => right.collectedAt.localeCompare(left.collectedAt));
  records.observationBatches.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  records.observations.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  records.runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  records.accountFollowerSamples.sort((left, right) => right.collectedAt.localeCompare(left.collectedAt));
  return {
    ...records,
    coverCache: await getCoverCacheSummary(),
    settings,
    syncState: await getSyncState(),
  };
}

export async function getStoredWorkCount(): Promise<number> {
  const db = await getDatabase();
  return db.count("works");
}

export async function getSyncRun(runId: string): Promise<SyncRun | null> {
  const db = await getDatabase();
  return (await db.get("syncRuns", runId)) ?? null;
}

export interface CoverCandidate {
  key: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  revision: number;
  fingerprint: string;
}

export interface ScanCoverCandidatesOptions {
  /** The complete synchronization generation currently being processed. */
  runId?: string;
  latestRunId?: string | null;
  pipelineVersion?: number;
  limit?: number;
}

export interface CoverAttemptWrite {
  key?: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  /** Fixed media identity captured when the cover task was enqueued. */
  revision?: number;
  fingerprint?: string;
  lastAttemptRunId: string;
  status: CoverStatus;
  blob?: Blob;
  width?: number;
  height?: number;
  bytes?: number;
  attemptedAt?: string;
  errorCode?: string;
  /** If supplied, a different current record means this writer lost the CAS. */
  expectedLastAttemptRunId?: string | null;
}

const coverStatusValues = new Set<CoverStatus>(["ready", "failed", "skipped-capacity"]);

function isCoverSourceUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLocaleLowerCase() === "i.pximg.net"
      && !url.username
      && !url.password
      && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

export const isAllowedCoverSourceUrl = isCoverSourceUrl;

function validCoverStatus(value: unknown): value is CoverStatus {
  return typeof value === "string" && coverStatusValues.has(value as CoverStatus);
}

function coverAttemptedAt(value: string | undefined): string {
  return value ?? nowIso();
}

function normalizeCoverAttempt(input: CoverAttemptWrite): CoverRecord | null {
  if (!input.workKey || input.key !== undefined && input.key !== input.workKey) return null;
  if (!isCoverSourceUrl(input.sourceUrl) || !Number.isSafeInteger(input.pipelineVersion) || input.pipelineVersion < 1) return null;
  if (!input.lastAttemptRunId || !validCoverStatus(input.status)) return null;
  const width = Number.isFinite(input.width) && (input.width ?? 0) >= 0 ? Math.round(input.width ?? 0) : 0;
  const height = Number.isFinite(input.height) && (input.height ?? 0) >= 0 ? Math.round(input.height ?? 0) : 0;
  const bytes = Number.isFinite(input.bytes) && (input.bytes ?? 0) >= 0 ? Math.round(input.bytes ?? 0) : input.blob?.size ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  if (input.status === "ready" && !(input.blob instanceof Blob)) return null;
  if (input.status === "ready" && bytes > input.blob!.size) return null;
  const record: CoverRecord = {
    key: input.workKey,
    workKey: input.workKey,
    sourceUrl: input.sourceUrl,
    pipelineVersion: input.pipelineVersion,
    lastAttemptRunId: input.lastAttemptRunId,
    status: input.status,
    width,
    height,
    bytes: input.status === "ready" ? input.blob?.size ?? bytes : 0,
    attemptedAt: coverAttemptedAt(input.attemptedAt),
  };
  if (input.blob !== undefined && input.status === "ready") record.blob = input.blob;
  if (input.errorCode !== undefined && input.errorCode !== "") record.errorCode = input.errorCode.slice(0, 120);
  return record;
}

/** Return the latest full (non-passive) completed run id for cover-cache
 * generation checks. A passive page observation must never advance it. */
export async function getLatestCompleteSyncRunId(): Promise<string | null> {
  const db = await getDatabase();
  const runs = await db.getAllFromIndex("syncRuns", "by-status", "completed");
  const complete = runs
    .filter((run) => run.trigger !== "passive")
    .sort((left, right) => (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt));
  return complete[0]?.runId ?? null;
}

/** Scan only the current, safe thumbnail source for each work. Failed and
 * capacity-skipped attempts are suppressed for the same complete run and
 * become eligible again in the next complete run. */
export async function scanCoverCandidates(optionsOrRunId: ScanCoverCandidatesOptions | string = {}): Promise<CoverCandidate[]> {
  const options: ScanCoverCandidatesOptions = typeof optionsOrRunId === "string"
    ? { runId: optionsOrRunId }
    : optionsOrRunId;
  const pipelineVersion = options.pipelineVersion ?? COVER_CACHE_PIPELINE_VERSION;
  const runId = options.runId ?? options.latestRunId ?? await getLatestCompleteSyncRunId();
  if (pipelineVersion !== COVER_CACHE_PIPELINE_VERSION) return [];
  return scanBridgedCoverCandidates(runId, options.limit);
}

export const getCoverCandidates = scanCoverCandidates;
export const scanCoverCacheCandidates = scanCoverCandidates;

/** Read a cover only when its source matches the WorkRecord currently stored
 * for the work. Passing sourceUrl adds an explicit second source check. */
export async function getCurrentCover(workKey: string, sourceUrl?: string | null): Promise<CoverRecord | null> {
  if (!workKey) return null;
  const db = await getDatabase();
  const work = await db.get("works", workKey);
  if (!work || work.key !== workKey || !isCoverSourceUrl(work.thumbnailUrl)) return null;
  if (sourceUrl !== undefined && sourceUrl !== work.thumbnailUrl) return null;
  return readBridgedCover(workKey, work.thumbnailUrl);
}

export const getCover = getCurrentCover;
export const getCoverRecord = getCurrentCover;
export const getCurrentCoverRecord = getCurrentCover;
export const readCurrentCover = getCurrentCover;

/** Compare-and-set the current cover after re-reading the WorkRecord in the
 * same read/write transaction. A stale URL, key, or expected CAS token is a
 * harmless false result; it can never overwrite a newer work snapshot. */
export async function writeCoverAttempt(input: CoverAttemptWrite): Promise<boolean> {
  const record = normalizeCoverAttempt(input);
  if (!record) return false;
  const db = await getDatabase();
  const work = await db.get("works", record.workKey);
  const existing = await readBridgedCover(record.workKey, record.sourceUrl);
  const sourceMatches = work != null
    && work.key === record.workKey
    && work.thumbnailUrl === record.sourceUrl;
  const expectedMatches = input.expectedLastAttemptRunId === undefined
    || (existing?.lastAttemptRunId ?? null) === input.expectedLastAttemptRunId;
  const incomingTime = Date.parse(record.attemptedAt);
  const existingTime = existing ? Date.parse(existing.attemptedAt) : NaN;
  const notOlder = !Number.isFinite(incomingTime) || !Number.isFinite(existingTime) || incomingTime >= existingTime;
  // A valid ready item is never demoted by a late failed/capacity result.
  const doesNotDemoteReady = existing?.status !== "ready" || record.status === "ready"
    || existing.sourceUrl !== record.sourceUrl || existing.pipelineVersion !== record.pipelineVersion;
  if (!sourceMatches || !expectedMatches || !notOlder || !doesNotDemoteReady) {
    return false;
  }
  return writeBridgedCover({
    ...record,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
  });
}

export const casCoverAttempt = writeCoverAttempt;
export const compareAndSetCoverAttempt = writeCoverAttempt;
export const saveCoverAttempt = writeCoverAttempt;
export const saveCoverRecordCAS = writeCoverAttempt;

/** Remove records for deleted works and records whose source URL no longer
 * matches the current work. This is intentionally recoverable: only stale
 * cover records are removed and valid current entries are untouched. */
export async function cleanupCoverRecords(): Promise<number> {
  return cleanupBridgedCovers();
}

export const cleanupOrphanCovers = cleanupCoverRecords;
export const clearStaleCovers = cleanupCoverRecords;

/** Summarize only records matching the current WorkRecord URL and pipeline.
 * Pending therefore means a safe current source has no usable current
 * attempt; stale/orphan records and works without a safe thumbnail do not
 * inflate the counters. */
export async function getCoverCacheSummary(options: { pipelineVersion?: number; runId?: string | null } = {}): Promise<CoverCacheSummary> {
  const pipelineVersion = options.pipelineVersion ?? COVER_CACHE_PIPELINE_VERSION;
  const runId = options.runId === undefined ? await getLatestCompleteSyncRunId() : options.runId;
  if (pipelineVersion !== COVER_CACHE_PIPELINE_VERSION) {
    return { ready: 0, failed: 0, skipped: 0, pending: 0, bytes: 0, total: 0 };
  }
  return summarizeBridgedCovers(runId);
}

export const getCoverSummary = getCoverCacheSummary;

/** Explicitly erase all local records and state, optionally establishing a
 * fresh account binding for the next run. */
export async function clearLocalData(rebindAccount: PixivAccount | null = null): Promise<AppSettings> {
  await clearSyncState();
  await clearBridgedCoverData();
  await clearDatabase();
  await clearSettings();
  return saveSettings({
    boundAccount: rebindAccount,
    scheduledSyncEnabled: false,
  });
}

export const clearAndRebind = clearLocalData;

export { bumpDataRevision, getSettings, saveSettings, getSyncState, saveSyncState, DEFAULT_SETTINGS } from "./local-state";

export async function getStorageHealth(hooks: RetentionHooks = {}): Promise<StorageHealth> {
  const estimate = typeof navigator !== "undefined" && "storage" in navigator && navigator.storage?.estimate
    ? await navigator.storage.estimate()
    : {};
  const usageBytes = typeof estimate.usage === "number" ? estimate.usage : null;
  const quotaBytes = typeof estimate.quota === "number" ? estimate.quota : null;
  const warningBytes = hooks.warningBytes ?? DEFAULT_SETTINGS.storageWarningBytes;
  const quotaCeiling = quotaBytes == null ? MAX_STORAGE_BYTES : quotaBytes * 0.95;
  const ceilingBytes = hooks.ceilingBytes ?? Math.min(MAX_STORAGE_BYTES, quotaCeiling);
  return {
    usageBytes,
    quotaBytes,
    warning: usageBytes != null && usageBytes >= warningBytes,
    ceiling: usageBytes != null && usageBytes >= ceilingBytes,
  };
}

function emptyTemporalCompactionResult(skippedBecauseCeiling = false, pendingReason?: RetentionPendingReason): TemporalCompactionResult {
  return { updatedSamples: 0, deletedSamples: 0, considered: 0, skipped: 0, skippedBecauseCeiling, pendingReason };
}

function temporalOptionsFrom(
  hooks: RetentionHooks,
  options: TemporalCompactionOptions = {},
): TemporalCompactionOptions {
  const configured = hooks.temporalCompaction;
  if (configured === true) {
    const now = options.now ?? hooks.now;
    return now === undefined
      ? { ...options, enabled: true }
      : { ...options, enabled: true, now };
  }
  if (configured && typeof configured === "object") {
    const now = options.now ?? configured.now ?? hooks.now;
    return now === undefined
      ? { ...configured, ...options }
      : { ...configured, ...options, now };
  }
  const now = options.now ?? hooks.now;
  return now === undefined
    ? { ...options }
    : { ...options, now };
}

/** Compatibility entry point for callers of the former sample compactor.
 * Destructive work is delegated to the guarded metric-frame path. */
export async function compactTemporalSamples(
  options: TemporalCompactionOptions = {},
): Promise<TemporalCompactionResult> {
  if (options.enabled !== true) return emptyTemporalCompactionResult();
  const retention = await cleanupRetention({ temporalCompaction: { enabled: true, ...(options.now === undefined ? {} : { now: options.now }) } });
  return {
    updatedSamples: retention.temporalCompactedSamples,
    deletedSamples: retention.temporalDeletedSamples,
    considered: retention.temporalCompactedSamples + retention.temporalDeletedSamples,
    skipped: 0,
    skippedBecauseCeiling: retention.temporalSkippedBecauseCeiling,
    pendingReason: retention.pendingReason ?? undefined,
  };
}

export const runTemporalCompaction = compactTemporalSamples;
export const compactSamplesByAge = compactTemporalSamples;

export interface LocalMaintenanceResult {
  rewrittenBatches: number;
  retainedSamples: number;
  skippedLegacyObservations: number;
  cleanedCovers: number;
  cleanedStagedPages: number;
}

/** Normalize legacy local records without changing historical samples. This
 * is deliberately separate from temporal compaction: the user-facing
 * maintenance action only upgrades storage representations and removes safe
 * orphan cover records. Active staged pages are never touched. */
export async function maintainLocalData(): Promise<LocalMaintenanceResult> {
  await assertAnalyticsWritable();
  const db = await getDatabase();
  const tx = db.transaction(["observationBatches", "observations", "samples", "stagedPages", "syncRuns", "storageMeta"], "readwrite");
  const batchStore = tx.objectStore("observationBatches");
  const observationStore = tx.objectStore("observations");
  const sampleStore = tx.objectStore("samples");
  const [batches, observations, samples, stagedPages, runs] = await Promise.all([
    batchStore.getAll(),
    observationStore.getAll(),
    tx.objectStore("samples").getAll(),
    tx.objectStore("stagedPages").getAll(),
    tx.objectStore("syncRuns").getAll(),
  ]);
  let rewrittenBatches = 0;
  let wroteAnalyticalData = false;
  for (const value of samples) {
    try {
      const decoded = decodeWorkSample(value);
      const encoded = encodeWorkSample(decoded);
      const before = JSON.stringify(value);
      if (before !== JSON.stringify(encoded)) {
        await sampleStore.put(encoded);
        wroteAnalyticalData = true;
      }
    } catch {
      // Keep malformed rows available for recovery/export; the v5 open path
      // already fails closed for corruption during migration.
    }
  }
  const existingBatches = new Map<string, ReturnType<typeof decodeObservationBatch>>();
  for (const value of batches) {
    try {
      const decoded = decodeObservationBatch(value);
      existingBatches.set(decoded.runId, decoded);
      const normalized = encodeObservationBatch(decoded);
      if (JSON.stringify(normalized) !== JSON.stringify(value)) {
        await batchStore.put(normalized);
        rewrittenBatches += 1;
        wroteAnalyticalData = true;
      }
    } catch { /* retain malformed legacy rows for export/recovery */ }
  }
  // Migrate only provably equivalent observations. Staged runs are active and
  // remain untouched so a worker restart cannot lose an in-flight page.
  let skippedLegacyObservations = observations.length;
  if (observations.length > 0) {
    const activeRunIds = new Set(stagedPages.map((page) => page?.runId).filter((runId): runId is string => typeof runId === "string"));
    const passiveRuns = new Set(runs.filter((run) => run?.trigger === "passive").map((run) => run.runId));
    const grouped = new Map<string, { observedAt: string; workKeys: Set<string>; changedWorkKeys: Set<string>; observationIds: number[] }>();
    for (const item of observations) {
      if (!item || typeof item.runId !== "string" || !item.runId || typeof item.workKey !== "string" || !item.workKey || typeof item.observedAt !== "string" || !item.observedAt || !Number.isFinite(Date.parse(item.observedAt))) continue;
      if (activeRunIds.has(item.runId)) continue;
      const group = grouped.get(item.runId) ?? { observedAt: item.observedAt, workKeys: new Set<string>(), changedWorkKeys: new Set<string>(), observationIds: [] };
      if (item.observedAt > group.observedAt) group.observedAt = item.observedAt;
      group.workKeys.add(item.workKey);
      if (item.metricsChanged === true) group.changedWorkKeys.add(item.workKey);
      if (item.id != null && Number.isSafeInteger(item.id)) group.observationIds.push(item.id);
      grouped.set(item.runId, group);
    }
    let migrated = 0;
    for (const [runId, group] of grouped) {
      const scope = passiveRuns.has(runId) ? "partial" : "complete";
      const workKeys = [...group.workKeys].sort();
      const changedWorkKeys = [...group.changedWorkKeys].sort();
      const current = existingBatches.get(runId);
      const equivalent = current != null && current.observedAt === group.observedAt && current.scope === scope
        && JSON.stringify(current.workKeys) === JSON.stringify(workKeys)
        && JSON.stringify(current.changedWorkKeys) === JSON.stringify(changedWorkKeys);
      if (!equivalent) {
        await batchStore.put(encodeObservationBatch({ runId, observedAt: group.observedAt, workKeys, changedWorkKeys, scope }));
        wroteAnalyticalData = true;
      }
      for (const id of group.observationIds) { await observationStore.delete(id); migrated += 1; }
    }
    skippedLegacyObservations = Math.max(0, observations.length - migrated);
  }
  if (wroteAnalyticalData) await incrementDataRevision(tx);
  await tx.done;
  const cleanedCovers = await cleanupCoverRecords();
  return { rewrittenBatches, retainedSamples: samples.length, skippedLegacyObservations, cleanedCovers, cleanedStagedPages: 0 };
}

export const organizeLocalData = maintainLocalData;

function parsedTimestamp(value: string | number | Date): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Retention age tiers are fixed policy. The recent window is intentionally
 * represented separately so callers cannot accidentally thin it. */
export const retentionTierForAge = sharedRetentionTierForAge;

export const retentionTierFor = retentionTierForAge;

export function retentionBucketKey(value: string, tier: Exclude<RetentionTier, "lossless">): string | null {
  return sharedRetentionBucketKey(value, tier);
}

export const bucketKeyForRetention = retentionBucketKey;

function identityForSample(sample: WorkSample): string {
  try {
    return sampleIdentityFor(sample);
  } catch {
    return JSON.stringify([sample.workKey ?? "", sample.runId ?? "", sample.collectedAt ?? "", sample.kind ?? "", sample.rollupSourceCollectedAt ?? null]);
  }
}

function sampleSource(sample: WorkSample): RetentionSourceSample {
  return {
    id: sample.id ?? null,
    identity: identityForSample(sample),
    hash: sampleCanonicalHash(sample),
    sample: { ...sample },
  };
}

function hashMaterial(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function batchSource(batch: ObservationBatch): RetentionSourceBatch {
  const identity = observationBatchIdentity(batch);
  return { runId: batch.runId, identity, hash: observationBatchCanonicalHash(batch), batch: { ...batch, workKeys: [...batch.workKeys], changedWorkKeys: [...batch.changedWorkKeys] } };
}

function observationBatchIdentity(batch: Pick<ObservationBatch, "runId" | "observedAt">): string {
  return JSON.stringify([batch.runId, batch.observedAt]);
}

function retentionPolicy(): RetentionPlan["policy"] {
  return {
    timeZone: "Asia/Shanghai",
    losslessHours: LOSSLESS_RETENTION_HOURS,
    tiers: { "30m": RETENTION_30M_MAX_DAYS, "1h": RETENTION_1H_MAX_DAYS, "6h": Number.POSITIVE_INFINITY },
  };
}

function retentionNow(input: string | number | Date | undefined): { timestamp: number; iso: string } {
  const timestamp = parsedTimestamp(input ?? Date.now());
  if (timestamp == null) throw new Error("Invalid retention timestamp");
  return { timestamp, iso: new Date(timestamp).toISOString() };
}

function buildRetentionPlanPure(input: RetentionPlanInput): RetentionPlan {
  const { timestamp: nowTimestamp, iso: now } = retentionNow(input.now);
  const accountId = input.accountId ?? null;
  const samples = [...input.samples].map((sample) => ({ ...sample, metrics: { ...sample.metrics } }));
  const batches = [...input.observationBatches].map((batch) => ({ ...batch, workKeys: [...batch.workKeys], changedWorkKeys: [...batch.changedWorkKeys] }));
  const sourceSamples = samples.map(sampleSource);
  const sourceBatches = batches.map(batchSource);
  const tierCounts: RetentionTierCounts = { lossless: 0, "30m": 0, "1h": 0, "6h": 0 };
  for (const sample of samples) {
    const collectedAt = parsedTimestamp(sample.collectedAt);
    if (collectedAt != null) tierCounts[retentionTierForAge(nowTimestamp - collectedAt)] += 1;
  }
  for (const batch of batches) {
    const observedAt = parsedTimestamp(batch.observedAt);
    if (observedAt != null) tierCounts[retentionTierForAge(nowTimestamp - observedAt)] += 1;
  }

  // Legacy rows are either migrated losslessly into metric frames or retained
  // byte-for-byte. Destructive retention is only allowed through the guarded
  // metric-frame path, which requires a verified pre-compaction backup.
  const policy = retentionPolicy();
  const planMaterial = JSON.stringify({
    version: RETENTION_SCHEMA_VERSION,
    policy,
    accountId,
    revision: input.revision ?? 0,
    now,
    sourceSamples: sourceSamples.map((row) => [row.identity, row.hash]),
    sourceBatches: sourceBatches.map((row) => [row.identity, row.hash]),
  });
  return {
    version: RETENTION_SCHEMA_VERSION,
    planId: `retention-v${RETENTION_SCHEMA_VERSION}-${hashMaterial(planMaterial)}`,
    accountId,
    revision: input.revision ?? 0,
    now,
    policy,
    samplePuts: [],
    sampleDeletes: [],
    batchDeletes: [],
    sourceSamples: sourceSamples.slice().sort((left, right) => (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER) || left.identity.localeCompare(right.identity)),
    sourceBatches: sourceBatches.slice().sort((left, right) => left.runId.localeCompare(right.runId)),
    tierCounts,
  };
}

export function buildRetentionPlan(input: RetentionPlanInput): RetentionPlan {
  return buildRetentionPlanPure(input);
}

export const createRetentionPlan = buildRetentionPlan;

export async function planRetention(options: Omit<RetentionPlanInput, "samples" | "observationBatches"> & { now?: string | number | Date } = {}): Promise<RetentionPlan> {
  const settings = await getSettings();
  const db = await getDatabase();
  const tx = db.transaction(["samples", "observationBatches", "works", "workStates", "syncRuns", "storageMeta"], "readonly");
  const [rawSamples, rawBatches, rawWorks, rawStates, runs, meta] = await Promise.all([
    tx.objectStore("samples").getAll(),
    tx.objectStore("observationBatches").getAll(),
    tx.objectStore("works").getAll(),
    tx.objectStore("workStates").getAll(),
    tx.objectStore("syncRuns").getAll(),
    tx.objectStore("storageMeta").get(STORAGE_META_KEY),
  ]);
  await tx.done;
  const states = new Map(rawStates.map((state) => [state.key, state]));
  const works = rawWorks.map((document) => materializeWorkRecord(document, states.get(document.key)));
  const samples = rawSamples.map((sample) => decodeWorkSample(sample));
  const observationBatches = rawBatches.map((batch) => decodeObservationBatch(batch));
  const revision = meta?.dataRevision ?? 0;
  return buildRetentionPlan({
    ...options,
    samples,
    observationBatches,
    accountId: options.accountId ?? settings.boundAccount?.id ?? null,
    revision,
  });
}

export const createStorageRetentionPlan = planRetention;
export const getRetentionPlan = planRetention;

/** Read-only retention preview across both legacy rows and v7 frames. It is
 * separate from the mutation plan because frame compaction has its own
 * archive/checkpoint transaction path. */
export async function getCombinedRetentionTierCounts(now: string | number | Date = Date.now()): Promise<RetentionTierCounts> {
  const db = await getDatabase();
  const tx = db.transaction(["samples", "metricFrames"], "readonly");
  const [rawSamples, frames] = await Promise.all([
    tx.objectStore("samples").getAll(),
    tx.objectStore("metricFrames").getAll(),
  ]);
  await tx.done;
  return countStoredRetentionTiers(rawSamples.map((sample) => decodeWorkSample(sample)), frames, now);
}

export async function applyRetentionPlan(plan: RetentionPlan): Promise<RetentionApplyResult> {
  await assertAnalyticsWritable();
  const failure = (dataRevision: number, pendingReason: Exclude<RetentionPendingReason, null>): RetentionApplyResult => ({
    applied: false,
    deletedSamples: 0,
    deletedBatches: 0,
    createdRollups: 0,
    updatedRollups: 0,
    dataRevision,
    pendingReason,
  });
  const containsLegacyWrites = plan.samplePuts.length > 0 || plan.sampleDeletes.length > 0 || plan.batchDeletes.length > 0;
  if (Number(plan.version) !== RETENTION_SCHEMA_VERSION || containsLegacyWrites) {
    return failure(await getDataRevision(), "unsafe-legacy-plan");
  }
  const db = await getDatabase();
  const tx = db.transaction(["samples", "observationBatches", "storageMeta", "analyticsSchemaState"], "readwrite");
  try {
    await assertAnalyticsWritableInTransaction(tx);
    const meta = await tx.objectStore("storageMeta").get(STORAGE_META_KEY);
    const currentRevision = meta?.dataRevision ?? 0;
    if (currentRevision !== plan.revision) {
      tx.abort();
      await tx.done.catch(() => undefined);
      return failure(currentRevision, "revision-race");
    }
    const sampleStore = tx.objectStore("samples");
    for (const source of plan.sampleDeletes) {
      if (source.id == null) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
      const raw = await sampleStore.get(source.id);
      if (!raw) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
      let current: WorkSample;
      try { current = decodeWorkSample(raw); } catch {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "corrupt-source");
      }
      if (identityForSample(current) !== source.identity || sampleCanonicalHash(current) !== source.hash) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
    }
    // A replacement put is also a compare-and-set operation. It may not be
    // listed in sampleDeletes (for example, updating an existing daily
    // rollup), so validate its exact source row independently before any
    // writes are issued.
    const sourceById = new Map(
      plan.sourceSamples
        .filter((source): source is RetentionSourceSample & { id: number } => source.id != null)
        .map((source) => [source.id, source]),
    );
    for (const put of plan.samplePuts) {
      if (put.replaceId == null) continue;
      const expected = sourceById.get(put.replaceId);
      if (!expected) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
      const raw = await sampleStore.get(put.replaceId);
      if (!raw) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
      let current: WorkSample;
      try { current = decodeWorkSample(raw); } catch {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "corrupt-source");
      }
      if (identityForSample(current) !== expected.identity || sampleCanonicalHash(current) !== expected.hash) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
    }
    const batchStore = tx.objectStore("observationBatches");
    for (const source of plan.batchDeletes) {
      const raw = await batchStore.get(source.runId);
      if (!raw) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
      let current: ObservationBatch;
      try { current = decodeObservationBatch(raw); } catch {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "corrupt-source");
      }
      if (batchSource(current).hash !== source.hash || batchSource(current).identity !== source.identity) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return failure(currentRevision, "source-mismatch");
      }
    }
    for (const put of plan.samplePuts) await sampleStore.put(encodeWorkSample(put.sample));
    for (const source of plan.sampleDeletes) if (source.id != null) await sampleStore.delete(source.id);
    for (const source of plan.batchDeletes) await batchStore.delete(source.runId);
    const hasWrites = plan.samplePuts.length > 0 || plan.sampleDeletes.length > 0 || plan.batchDeletes.length > 0;
    const nextRevision = hasWrites ? await incrementDataRevision(tx) : currentRevision;
    await tx.done;
    return {
      applied: true,
      deletedSamples: plan.sampleDeletes.length,
      deletedBatches: plan.batchDeletes.length,
      createdRollups: plan.samplePuts.filter((put) => put.reason === "daily-rollup" && put.replaceId == null).length,
      updatedRollups: plan.samplePuts.filter((put) => put.reason === "daily-rollup" && put.replaceId != null).length,
      dataRevision: nextRevision,
      pendingReason: null,
    };
  } catch {
    try { tx.abort(); } catch { /* already aborted */ }
    await tx.done.catch(() => undefined);
    return failure(plan.revision, "apply-failed");
  }
}

export const applyStorageRetentionPlan = applyRetentionPlan;

function emptyRetentionResult(health: StorageHealth, revision: number, pendingReason: RetentionPendingReason = null): RetentionResult {
  return {
    ...health,
    deletedSamples: 0,
    deletedBatches: 0,
    createdRollups: 0,
    updatedRollups: 0,
    skippedBecauseCeiling: false,
    temporalCompactedSamples: 0,
    temporalDeletedSamples: 0,
    temporalSkippedBecauseCeiling: false,
    tierCounts: { lossless: 0, "30m": 0, "1h": 0, "6h": 0 },
    pendingReason,
    dataRevision: revision,
  };
}

export interface LegacyFrameMigrationResult {
  migratedRuns: number;
  migratedSamples: number;
  remainingRuns: number;
  status: "ready" | "pending" | "failed";
}

/** Convert legacy history into compact frames in bounded transactions. Each
 * chunk writes its frames and removes its source rows atomically. */
export async function migrateLegacyAnalyticsToFrames(options: {
  chunkSize?: number;
} = {}): Promise<LegacyFrameMigrationResult> {
  const db = await getDatabase();
  const [rawBatches, rawSamples] = await Promise.all([
    db.getAll("observationBatches"),
    db.getAll("samples"),
  ]);
  if (rawBatches.length === 0) {
    const current = await db.get("analyticsSchemaState", "root");
    if (current) await db.put("analyticsSchemaState", { ...current, migrationStatus: "ready", migrationCursor: null, updatedAt: nowIso() });
    return { migratedRuns: 0, migratedSamples: 0, remainingRuns: 0, status: "ready" };
  }
  const batches = rawBatches.map((batch) => decodeObservationBatch(batch)).sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  const samples = rawSamples.map((sample) => decodeWorkSample(sample));

  const samplesByRun = new Map<string, WorkSample[]>();
  for (const sample of samples) {
    const current = samplesByRun.get(sample.runId) ?? [];
    current.push(sample);
    samplesByRun.set(sample.runId, current);
  }
  const size = Math.max(1, Math.min(500, Math.floor(options.chunkSize ?? 100)));
  const [storedDictionary, existingFrames] = await Promise.all([
    db.get("workDictionary", "root"),
    db.getAll("metricFrames"),
  ]);
  const initializedAtByWorkKey = new Map<string, number>();
  if (storedDictionary) {
    const dictionary = decodeWorkDictionary(storedDictionary);
    const keyByOrdinal = new Map(dictionary.entries.map((entry) => [entry.ordinal, entry.workKey]));
    for (const frame of existingFrames) {
      for (const change of frame.changes) {
        const key = keyByOrdinal.get(change[0]);
        if (key) initializedAtByWorkKey.set(key, Math.min(initializedAtByWorkKey.get(key) ?? Number.POSITIVE_INFINITY, frame.epochMs));
      }
    }
  }
  let migratedRuns = 0;
  let migratedSamples = 0;
  try {
    const initial = await db.get("analyticsSchemaState", "root");
    if (initial) await db.put("analyticsSchemaState", { ...initial, migrationStatus: "running", updatedAt: nowIso() });
    for (let offset = 0; offset < batches.length; offset += size) {
      const chunk = batches.slice(offset, offset + size);
      const tx = db.transaction(["workDictionary", "metricFrames", "analyticsSchemaState", "samples", "observationBatches", "storageMeta"], "readwrite");
      for (const batch of chunk) {
        const already = await tx.objectStore("metricFrames").index("by-run-id").get(batch.runId);
        const runSamples = samplesByRun.get(batch.runId) ?? [];
        const sampledWorkKeys = new Set(runSamples.map((sample) => sample.workKey));
        const batchAt = Date.parse(batch.observedAt);
        const hasNonCanonicalSamples = runSamples.some((sample) => sample.kind !== "change"
          || sample.compactionLevel !== undefined
          || sample.rollupSourceCollectedAt !== undefined
          || sample.collectedAt !== batch.observedAt);
        if (already || hasNonCanonicalSamples || batch.workKeys.some((key) => {
          if (sampledWorkKeys.has(key)) return false;
          const initializedAt = initializedAtByWorkKey.get(key);
          return initializedAt === undefined || initializedAt > batchAt;
        })) {
          // Existing frames are not assumed equivalent, and a frame cannot
          // represent legacy rollups or invent a historical baseline. Keep
          // the complete legacy run unless this transaction creates it.
          continue;
        }
        const context = await prepareFrameWrite(tx, batch.workKeys, batch.observedAt, { migration: true });
        const changes: MetricFrameChangeInput[] = [];
        for (const sample of runSamples) {
          const ordinal = context.ordinals.get(sample.workKey);
          if (ordinal == null) continue;
          changes.push({
            ordinal,
            metrics: { ...sample.metrics },
            ranking: {
              status: sample.rankingStatus ?? "unknown",
              observedAt: sample.rankingObservedAt ?? null,
              source: sample.rankingSource ?? null,
            },
            quality: sample.dataQuality,
          });
        }
        const frame = buildMetricFrame({
          runId: batch.runId,
          runSeq: context.runSeq,
          collectedAt: batch.observedAt,
          scope: batch.scope,
          parser: Math.max(0, ...runSamples.map((sample) => sample.parserVersion)),
          quality: runSamples[0]?.dataQuality ?? 0,
          observedOrdinals: batch.workKeys.map((key) => context.ordinals.get(key)!).filter((value) => value != null),
          changes,
        });
        await tx.objectStore("metricFrames").put(frame);
        for (const key of sampledWorkKeys) initializedAtByWorkKey.set(key, Math.min(initializedAtByWorkKey.get(key) ?? Number.POSITIVE_INFINITY, batchAt));
        for (const sample of runSamples) {
          if (sample.id != null) await tx.objectStore("samples").delete(sample.id);
        }
        await tx.objectStore("observationBatches").delete(batch.runId);
        migratedRuns += 1;
        migratedSamples += runSamples.length;
      }
      const schema = await tx.objectStore("analyticsSchemaState").get("root");
      if (schema) await tx.objectStore("analyticsSchemaState").put({
        ...schema,
        migrationStatus: "running",
        migrationCursor: offset + chunk.length,
        updatedAt: nowIso(),
      });
      await incrementDataRevision(tx);
      await tx.done;
      await Promise.resolve();
    }
    const remainingRuns = await db.count("observationBatches");
    const status = remainingRuns === 0 ? "ready" as const : "pending" as const;
    const complete = await db.get("analyticsSchemaState", "root");
    if (complete) await db.put("analyticsSchemaState", { ...complete, migrationStatus: status, migrationCursor: null, updatedAt: nowIso() });
    return { migratedRuns, migratedSamples, remainingRuns, status };
  } catch {
    const failed = await db.get("analyticsSchemaState", "root");
    if (failed) await db.put("analyticsSchemaState", { ...failed, migrationStatus: "failed", updatedAt: nowIso() });
    return { migratedRuns, migratedSamples, remainingRuns: Math.max(0, batches.length - migratedRuns), status: "failed" };
  }
}

export async function cleanupRetention(hooks: RetentionHooks = {}): Promise<RetentionResult> {
  const before = await getStorageHealth(hooks);
  if (before.warning) await hooks.onWarning?.(before);
  if (before.ceiling) await hooks.onCeiling?.(before);
  await migrateLegacyAnalyticsToFrames();
  const temporalOptions = temporalOptionsFrom(hooks);
  const planOptions: { now?: string | number | Date } = {};
  const effectiveNow = temporalOptions.now ?? hooks.now;
  if (effectiveNow !== undefined) planOptions.now = effectiveNow;
  const plan = await planRetention(planOptions);
  const apply = await applyRetentionPlan(plan);
  let frameCompaction = { considered: 0, rewritten: 0, deleted: 0, pendingReason: null as RetentionPendingReason };
  if (temporalOptions.enabled === true) {
    const db = await getDatabase();
    const frameHistory = await readPublicFrameHistory(db);
    const hasAgedFrames = frameHistory.observationBatches.some((batch) => {
      const at = Date.parse(batch.observedAt);
      const nowAt = effectiveNow === undefined ? Date.now() : new Date(effectiveNow).getTime();
      return Number.isFinite(at) && Number.isFinite(nowAt) && nowAt - at >= LOSSLESS_RETENTION_HOURS * 3_600_000;
    });
    if (hasAgedFrames) {
      frameCompaction = await runGuardedFrameCompaction(effectiveNow ?? Date.now());
    }
  }
  const after = await getStorageHealth(hooks);
  if (after.warning) await hooks.onWarning?.(after);
  if (after.ceiling) await hooks.onCeiling?.(after);
  return {
    ...after,
    deletedSamples: apply.deletedSamples,
    deletedBatches: apply.deletedBatches,
    createdRollups: apply.createdRollups,
    updatedRollups: apply.updatedRollups,
    skippedBecauseCeiling: false,
    temporalCompactedSamples: frameCompaction.rewritten,
    temporalDeletedSamples: frameCompaction.deleted,
    temporalSkippedBecauseCeiling: false,
    tierCounts: plan.tierCounts,
    pendingReason: frameCompaction.pendingReason ?? apply.pendingReason,
    dataRevision: apply.dataRevision,
  };
}

export async function exportRepositoryData(): Promise<ExportBundle> {
  const db = await getDatabase();
  const settings = await getSettings();
  const records = await allRecords(db, settings.boundAccount?.id ?? null);
  records.accountFollowerSamples.sort((left, right) => right.collectedAt.localeCompare(left.collectedAt));
  return {
    formatVersion: 5,
    exportedAt: nowIso(),
    timeZone: "Asia/Shanghai",
    account: settings.boundAccount ?? null,
    ...records,
    settings: {
      onboardingComplete: settings.onboardingComplete,
      scheduledSyncEnabled: settings.scheduledSyncEnabled,
      syncIntervalHours: settings.syncIntervalHours,
      showPixivChips: settings.showPixivChips,
      theme: settings.theme,
    },
  };
}

export const exportData = exportRepositoryData;

export async function exportDataJson(): Promise<string> {
  return JSON.stringify(await exportRepositoryData());
}
