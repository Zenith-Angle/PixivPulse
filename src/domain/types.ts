export type WorkType = "illust" | "novel";

export type WorkContentType = "novel" | "illustration" | "manga" | "ugoira" | "unknown";

export function normalizeWorkContentType(value: unknown, workType: WorkType): WorkContentType {
  if (workType === "novel") return "novel";
  if (value === 0 || value === "0") return "illustration";
  if (value === 1 || value === "1") return "manga";
  if (value === 2 || value === "2") return "ugoira";
  if (typeof value === "string") {
    const normalized = value.trim().toLocaleLowerCase();
    if (normalized === "novel") return "unknown";
    if (normalized === "illustration" || normalized === "illust") return "illustration";
    if (normalized === "manga") return "manga";
    if (normalized === "ugoira") return "ugoira";
  }
  return "unknown";
}

export type NullableMetric = number | null;

export type RankingStatus = "unknown" | "ranked" | "unranked";
export type RankingSource = "api" | "page" | null;

export interface NormalizedRanking {
  rank: number | null;
  rankingStatus: RankingStatus;
  rankingObservedAt: string | null;
  rankingSource: RankingSource;
}

/** Normalize ranking values at the storage boundary while accepting legacy
 * records that only carried metrics.rank. */
export function normalizeRankingRank(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function normalizeRankingStatus(status: unknown, rank: unknown = null): RankingStatus {
  const normalizedRank = normalizeRankingRank(rank);
  if (status === "ranked") return normalizedRank == null ? "unknown" : "ranked";
  if (status === "unranked") return "unranked";
  if (status === "unknown") return "unknown";
  return normalizedRank == null ? "unknown" : "ranked";
}

export function normalizeRankingSource(value: unknown): RankingSource {
  return value === "api" || value === "page" ? value : null;
}

export function normalizeRankingObservedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? value : null;
}

export function normalizeRankingFields(input: {
  rank?: unknown;
  metrics?: { rank?: unknown } | null;
  rankingStatus?: unknown;
  rankingObservedAt?: unknown;
  rankingSource?: unknown;
}): NormalizedRanking {
  const rank = input.rank !== undefined ? input.rank : input.metrics?.rank;
  const rankingStatus = normalizeRankingStatus(input.rankingStatus, rank);
  return {
    rank: rankingStatus === "ranked" ? normalizeRankingRank(rank) : null,
    rankingStatus,
    rankingObservedAt: rankingStatus === "unknown" ? null : normalizeRankingObservedAt(input.rankingObservedAt),
    rankingSource: rankingStatus === "unknown" ? null : normalizeRankingSource(input.rankingSource),
  };
}

export const normalizeRanking = normalizeRankingFields;

export interface WorkMetrics {
  likes: NullableMetric;
  bookmarks: NullableMetric;
  views: NullableMetric;
  comments: NullableMetric;
  rank: NullableMetric;
  responses: NullableMetric;
  illustrations: NullableMetric;
}

export interface ParsedWork {
  id: string;
  type: WorkType;
  contentType?: WorkContentType;
  description?: string | null;
  title: string;
  seriesTitle: string | null;
  publishedAt: string | null;
  wordCount: number | null;
  pageCount: number | null;
  isAi: boolean | null;
  isR18: boolean | null;
  thumbnailUrl: string | null;
  workUrl: string;
  metrics: WorkMetrics;
  /** Optional so snapshots exported by older versions remain assignable. */
  rankingStatus?: RankingStatus;
  rankingObservedAt?: string | null;
  rankingSource?: RankingSource;
  rawLabels: Record<string, string>;
  missingFields: string[];
  parserVersion: number;
}

export interface WorkRecord extends ParsedWork {
  key: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastObservedRunId: string;
  absentSince: string | null;
}

/** Mostly-static v4 storage representation of a work. Runtime metrics and
 * observation timestamps live in WorkState so metadata changes do not rewrite
 * the large current snapshot. */
export interface WorkDocument {
  key: string;
  id: string;
  type: WorkType;
  contentType?: WorkContentType;
  description?: string | null;
  title: string;
  seriesTitle: string | null;
  publishedAt: string | null;
  wordCount: number | null;
  pageCount: number | null;
  isAi: boolean | null;
  isR18: boolean | null;
  thumbnailUrl: string | null;
  workUrl: string;
  firstSeenAt: string;
  rawLabels: Record<string, string>;
  missingFields: string[];
  parserVersion: number;
}

export type RankingStatusCode = 0 | 1 | 2;
export type RankingSourceCode = 0 | 1 | 2;

/** Fixed-order, no-undefined state tuple used by the v4 storage codec. */
export type WorkStateValues = [
  NullableMetric,
  NullableMetric,
  NullableMetric,
  NullableMetric,
  NullableMetric,
  NullableMetric,
  NullableMetric,
  RankingStatusCode,
  string | null,
  RankingSourceCode,
  string,
  string,
  string | null,
];

export interface WorkState {
  key: string;
  version: 1;
  values: WorkStateValues;
}

export type CoverStatus = "ready" | "failed" | "skipped-capacity";

/** A single encoded thumbnail in the local cover cache. The key is the
 * current work key, so a source URL change replaces the stale record after
 * the compare-and-set guard in the repository. */
export interface CoverRecord {
  key: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  lastAttemptRunId: string;
  status: CoverStatus;
  blob?: Blob;
  width: number;
  height: number;
  bytes: number;
  attemptedAt: string;
  errorCode?: string;
}

export interface CoverCacheSummary {
  ready: number;
  failed: number;
  skipped: number;
  pending: number;
  bytes: number;
  total: number;
}

export interface WorkSample {
  id?: number;
  workKey: string;
  runId: string;
  collectedAt: string;
  metrics: WorkMetrics;
  /** Optional so samples exported by older versions remain assignable. */
  rankingStatus?: RankingStatus;
  rankingObservedAt?: string | null;
  rankingSource?: RankingSource;
  parserVersion: number;
  dataQuality: number;
  kind: "change" | "daily-rollup";
  /** Optional automatic temporal-compaction tier. `kind` intentionally stays
   * `change` so existing chart and export consumers remain compatible. */
  compactionLevel?: "30m" | "1h" | "2h" | "6h" | "day" | "daily";
  /** Original fine-grained sample used to build a daily rollup. */
  rollupSourceCollectedAt?: string;
}

export interface WorkObservation {
  id?: number;
  workKey: string;
  runId: string;
  observedAt: string;
  metricsChanged: boolean;
}

/** A compact observation for one completed synchronization generation. */
export interface ObservationBatch {
  runId: string;
  observedAt: string;
  workKeys: string[];
  changedWorkKeys: string[];
  scope: "complete" | "partial";
}

/** Monotonic IndexedDB-side revision for analytical data. It deliberately
 * lives outside chrome.storage so a snapshot/retention transaction can
 * compare and advance it atomically. */
export interface StorageMeta {
  key: "root";
  dataRevision: number;
}

/** Bounded import staging record. Payload chunks are kept in IndexedDB and
 * never routed through chrome.storage. */
export interface ImportStagingRecord {
  key: string;
  sessionId: string;
  chunk: number;
  payload: unknown;
  createdAt: string;
  checksum?: string;
}

/** Durable maintenance marker used by retention orchestration. The
 * repository does not make this marker authoritative for analytical data. */
export interface MaintenanceState {
  key: "retention";
  status: "idle" | "applying";
  planId?: string;
  revision?: number;
  updatedAt: string;
  reason?: string;
}

export interface PixivAccount {
  id: string;
  name: string;
  profileUrl: string;
}

export type AccountSnapshot = PixivAccount;

export interface PagePayload {
  runId: string;
  page: number;
  pageCount: number;
  hasNext: boolean;
  positivelyEmpty: boolean;
  fingerprint: string;
  works: ParsedWork[];
  account?: PixivAccount | null;
  parserVersion: number;
  collectedAt: string;
  quality: {
    totalCards: number;
    validCards: number;
    missingRequired: number;
    missingMetricFields: number;
  };
}

export type SyncStatus =
  | "idle"
  | "opening"
  | "collecting"
  | "rechecking"
  | "committing"
  | "completed"
  | "failed";

export interface SyncState {
  runId: string;
  status: SyncStatus;
  trigger: "manual" | "scheduled" | "recovery";
  /** New runs use the service-worker API transport; omitted means legacy tab transport. */
  transport?: "api" | "tab";
  fallbackUsed?: boolean;
  fallbackReason?: SyncErrorCode | null;
  /** Present on runtime state; optional for backwards-compatible exported snapshots. */
  accountId?: string | null;
  ownedTabId: number | null;
  expectedPage: number;
  expectedPageCount: number | null;
  expectedUrl: string;
  seenFingerprints: string[];
  seenWorkIds: string[];
  firstPageFingerprint: string | null;
  retryCount: number;
  mutationRetryCount: number;
  leaseExpiresAt: number;
  deadlineAt: number;
  startedAt: string;
  updatedAt: string;
  errorCode: SyncErrorCode | null;
  errorMessage: string | null;
}

export type SyncErrorCode =
  | "CHALLENGE"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "PAGE_TIMEOUT"
  | "TAB_CLOSED"
  | "SCHEMA_DRIFT"
  | "PAGINATION_MUTATED"
  | "REPEATED_PAGE"
  | "MAX_PAGES"
  | "STORAGE_LIMIT"
  | "ACCOUNT_MISMATCH"
  | "UNKNOWN";

export type SyncPolicyReason =
  | "in-flight"
  | "completed"
  | "transient-failure"
  | "challenge"
  | "rate-limited";

export interface SyncRun {
  runId: string;
  trigger: SyncState["trigger"] | "passive";
  startedAt: string;
  finishedAt: string | null;
  status: "completed" | "failed";
  pages: number;
  works: number;
  changedWorks: number;
  errorCode: SyncErrorCode | null;
  errorMessage: string | null;
}

/** Durable account-level follower collection state. The run id is also the
 * IndexedDB primary key, so a synchronization generation can reserve at most
 * one follower request. */
export interface AccountFollowerRecord {
  runId: string;
  accountId: string;
  collectedAt: string;
  status: "pending" | "ready" | "unavailable";
  followers: number | null;
  errorCode: SyncErrorCode | null;
}

/** Public follower sample exposed by dashboard/export reads. Non-ready
 * collection attempts intentionally never cross this boundary. */
export interface AccountFollowerSample {
  runId: string;
  accountId: string;
  collectedAt: string;
  followers: number;
}

export interface AppSettings {
  onboardingComplete: boolean;
  scheduledSyncEnabled: boolean;
  syncIntervalHours: number;
  showPixivChips: boolean;
  theme: "light" | "dark" | "system";
  lastCompactedAt: string | null;
  storageWarningBytes: number;
  boundAccount?: PixivAccount | null;
  nextAllowedSyncAt?: string | null;
  nextAllowedSyncReason?: SyncPolicyReason | null;
  pageFailureClassifierVersion?: number;
}

export interface DashboardData {
  works: WorkRecord[];
  samples: WorkSample[];
  observations: WorkObservation[];
  /** Compact observation generations introduced in database v3. */
  observationBatches?: ObservationBatch[];
  runs: SyncRun[];
  /** Optional for imported snapshots written before local cover caching. */
  coverCache?: CoverCacheSummary;
  /** Optional for fixtures and snapshots created before account follower
   * sampling was introduced. Runtime reads expose only trusted ready rows. */
  accountFollowerSamples?: AccountFollowerSample[];
  settings: AppSettings;
  syncState: SyncState | null;
}

export interface MetricDelta {
  value: number | null;
  fromAt: string | null;
  toAt: string | null;
  elapsedHours: number | null;
  confidence: "exact" | "approximate" | "insufficient";
}

export interface WorkAnalysis {
  work: WorkRecord;
  latestSample: WorkSample | null;
  previousSample: WorkSample | null;
  lastDelta: Record<keyof WorkMetrics, MetricDelta>;
  bookmarkRate: number | null;
  likeRate: number | null;
  sparkline: Array<{ at: string; views: number | null; bookmarks: number | null; likes: number | null }>;
  confidence: "high" | "medium" | "low";
}
