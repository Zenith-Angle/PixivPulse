import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import {
  COVER_CACHE_BATCH_SIZE,
  COVER_CACHE_ALARM,
  COVER_CACHE_INTER_IMAGE_DELAY_MS,
  COVER_CACHE_MAX_BLOB_BYTES,
  COVER_CACHE_MAX_READY_BYTES,
  COVER_CACHE_PIPELINE_VERSION,
  LOCK_LEASE_MS,
  MAX_SYNC_PAGES,
  MAX_SYNC_RETRIES,
  PAGE_READY_TIMEOUT_MS,
  PIXIV_WORKS_URL,
  RETENTION_MAINTENANCE_ALARM,
  SYNC_ALARM,
  SYNC_ROUTE_MARKER,
  SYNC_WATCHDOG_ALARM,
} from "../src/domain/constants";
import {
  fetchAndEncodeCover,
  isUsableCoverRecord,
} from "../src/domain/cover-cache";
import { COVER_REFERRER_RULE_ID, createCoverReferrerRule } from "../src/domain/cover-network";
import {
  beginCoverQueueItem,
  coverBlobPersistenceAcknowledged,
  completeCoverQueueItem,
  deserializeCoverQueueState,
  emptyCoverQueueState,
  enqueueCoverGeneration,
  failCoverQueueItem,
  recoverCoverQueueState,
  serializeCoverQueueState,
  skipCoverQueueItem,
  type CoverQueueClaim,
  type CoverQueueItem,
  type CoverQueueState,
} from "../src/domain/cover-queue";
import type { RuntimeMessage, RuntimeResponse } from "../src/domain/messages";
import type { StorageCenterInfo } from "../src/domain/messages";
import type { CoverRecord, DashboardData, PagePayload, PixivAccount, SyncErrorCode, SyncRun, SyncState } from "../src/domain/types";
import { canStartSyncForTrigger, syncPolicyFor } from "../src/domain/sync-policy";
import { isBeijingSyncSlot, nextBeijingSyncSlot } from "../src/domain/sync-schedule";
import {
  collectPixivDashboardPage,
  collectPixivFollowerCount,
  PixivApiError,
  type PixivFollowerCount,
} from "../src/domain/pixiv-api";
import {
  bumpDataRevision,
  clearStagedPages,
  cleanupCoverRecords,
  clearLocalData,
  completeSync,
  cleanupRetention,
  maintainLocalData,
  failSyncRun,
  getDashboardData,
  getDataRevision,
  getCoverCacheSummary,
  getLatestCompleteSyncRunId,
  getCombinedRetentionTierCounts,
  getTrustedStagedAccount,
  getSettings,
  getStorageHealth,
  getStorageStats,
  getStoredWorkCount,
  getSyncRun,
  getSyncState,
  mergePassivePageSnapshot,
  saveSettings,
  saveSyncState,
  reserveAccountFollowerCollection,
  scanCoverCandidates,
  settleAccountFollowerCollection,
  stagePage,
  writeCoverAttempt,
  AccountMismatchError,
  validatePassivePagePayload,
} from "../src/data/repository";
import {
  canRetry,
  createApiSyncState,
  createTabFallbackState,
  isApiSyncState,
  isActiveSyncState,
  makeExpectedUrl,
  makeRunId,
  needsFirstPageRecheck,
  reduceSyncState,
  shouldFallbackToTab,
  validateEmptyPage,
  validatePagePayload,
} from "../src/data/sync-machine";
import { getBackupCenterStatus } from "../src/data/backup-directory";
import { getPendingPreCompactionCount } from "../src/data/retention-backup";

const MIN_NAVIGATION_DELAY_MS = 3_000;
const MAX_NAVIGATION_DELAY_MS = 5_000;
const KNOWN_ERROR_CODES = new Set<SyncErrorCode>([
  "CHALLENGE",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "PAGE_TIMEOUT",
  "TAB_CLOSED",
  "SCHEMA_DRIFT",
  "PAGINATION_MUTATED",
  "REPEATED_PAGE",
  "MAX_PAGES",
  "STORAGE_LIMIT",
  "ACCOUNT_MISMATCH",
  "UNKNOWN",
]);

const COVER_QUEUE_STORAGE_KEY = "pixivPulse.coverQueue";
const COVER_CACHE_REVISION_STORAGE_KEY = "pixivPulse.coverCacheRevision";
const DASHBOARD_DATA_REVISION_STORAGE_KEY = "pixivPulse.dataRevision";
const DASHBOARD_SETTINGS_STORAGE_KEY = "pixivPulse.settings";
const DASHBOARD_SYNC_STATE_STORAGE_KEY = "pixivPulse.syncState";
const SYNC_SCHEDULE_STORAGE_KEY = "pixivPulse.syncSchedule";
const SYNC_SCHEDULE_REPAIR_ALARM = "pixiv-pulse-sync-repair";
const COVER_QUEUE_BATCH_DELAY_MINUTES = 0.5;

const DASHBOARD_CACHE_STORAGE_KEYS = [
  DASHBOARD_DATA_REVISION_STORAGE_KEY,
  COVER_CACHE_REVISION_STORAGE_KEY,
  DASHBOARD_SETTINGS_STORAGE_KEY,
  DASHBOARD_SYNC_STATE_STORAGE_KEY,
] as const;
const MAX_CACHED_DASHBOARD_RECORDS = 25_000;
const MAX_STABLE_DASHBOARD_READ_ATTEMPTS = 3;

let dashboardDataCache: { fingerprint: string; data: DashboardData } | null = null;
let dashboardDataRequest: { fingerprint: string; promise: Promise<DashboardData> } | null = null;

function canCacheDashboardData(data: DashboardData): boolean {
  return data.works.length
    + data.samples.length
    + data.observations.length
    + (data.observationBatches?.length ?? 0)
    + data.runs.length
    + (data.accountFollowerSamples?.length ?? 0) <= MAX_CACHED_DASHBOARD_RECORDS;
}

async function dashboardCacheFingerprint(): Promise<string> {
  const [localState, repositoryRevision] = await Promise.all([
    browser.storage.local.get([...DASHBOARD_CACHE_STORAGE_KEYS]),
    getDataRevision(),
  ]);
  return JSON.stringify({ localState, repositoryRevision });
}

async function getCachedDashboardData(): Promise<DashboardData> {
  const fingerprint = await dashboardCacheFingerprint();
  if (dashboardDataCache?.fingerprint === fingerprint) return dashboardDataCache.data;
  if (dashboardDataRequest?.fingerprint === fingerprint) return dashboardDataRequest.promise;
  const promise = (async () => {
    let expectedFingerprint = fingerprint;
    for (let attempt = 0; attempt < MAX_STABLE_DASHBOARD_READ_ATTEMPTS; attempt += 1) {
      const data = await getDashboardData();
      const finalFingerprint = await dashboardCacheFingerprint();
      if (finalFingerprint === expectedFingerprint) {
        if (canCacheDashboardData(data)) dashboardDataCache = { fingerprint: finalFingerprint, data };
        return data;
      }
      expectedFingerprint = finalFingerprint;
    }
    throw new Error("本地数据在读取期间持续更新，请稍后重试");
  })();
  dashboardDataRequest = { fingerprint, promise };
  try {
    return await promise;
  } finally {
    if (dashboardDataRequest?.promise === promise) dashboardDataRequest = null;
  }
}

export interface SyncScheduleControl {
  version: 1;
  generation: string;
  intervalMinutes: number;
  nextAt: number;
  pendingSlotAt: number | null;
}

const syncAlarmName = (generation: string): string => `${SYNC_ALARM}:${generation}`;

export function syncAlarmGeneration(name: string): string | null {
  const prefix = `${SYNC_ALARM}:`;
  if (!name.startsWith(prefix)) return null;
  const generation = name.slice(prefix.length);
  return /^[A-Za-z0-9-]{8,80}$/.test(generation) ? generation : null;
}

export function normalizeSyncScheduleControl(value: unknown): SyncScheduleControl | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SyncScheduleControl>;
  const generation = candidate.generation;
  const intervalMinutes = candidate.intervalMinutes;
  const nextAt = candidate.nextAt;
  const pendingSlotAt = candidate.pendingSlotAt;
  if (candidate.version !== 1
    || typeof generation !== "string"
    || syncAlarmGeneration(syncAlarmName(generation)) !== generation
    || typeof intervalMinutes !== "number"
    || !Number.isSafeInteger(intervalMinutes)
    || typeof nextAt !== "number"
    || !Number.isSafeInteger(nextAt)
    || !isBeijingSyncSlot(nextAt, intervalMinutes)
    || (pendingSlotAt !== null && (typeof pendingSlotAt !== "number"
      || !Number.isSafeInteger(pendingSlotAt)
      || !isBeijingSyncSlot(pendingSlotAt, intervalMinutes)))) {
    return null;
  }
  return {
    version: 1,
    generation,
    intervalMinutes,
    nextAt,
    pendingSlotAt,
  };
}

export function advanceSyncScheduleControl(
  control: SyncScheduleControl,
  alarmName: string,
  scheduledTime: number,
  now: number,
): SyncScheduleControl | null {
  if (syncAlarmGeneration(alarmName) !== control.generation || scheduledTime !== control.nextAt) return null;
  const nextAt = nextBeijingSyncSlot(Math.max(now, scheduledTime), control.intervalMinutes);
  if (nextAt == null) return null;
  return {
    ...control,
    nextAt,
    pendingSlotAt: control.pendingSlotAt == null
      ? scheduledTime
      : Math.max(control.pendingSlotAt, scheduledTime),
  };
}

export function clearPendingSyncSlot(
  control: SyncScheduleControl,
  generation: string,
  slotAt: number,
): SyncScheduleControl {
  if (control.generation !== generation || control.pendingSlotAt !== slotAt) return control;
  return { ...control, pendingSlotAt: null };
}

export function hasMatchingOneShotAlarm(
  control: SyncScheduleControl,
  alarms: readonly Pick<chrome.alarms.Alarm, "name" | "scheduledTime" | "periodInMinutes">[],
): boolean {
  return alarms.some((alarm) => alarm.name === syncAlarmName(control.generation)
    && alarm.scheduledTime === control.nextAt
    && alarm.periodInMinutes == null);
}

export function pendingScheduledDisposition(
  state: SyncState | null,
  slotAt: number,
  now = Date.now(),
): "start" | "retain" | "drop" {
  if (!state) return "start";
  if (state.trigger === "scheduled") {
    if (isActiveSyncState(state, now)) return "drop";
    const updatedAt = Date.parse(state.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt >= slotAt) return "drop";
    return "start";
  }
  return isActiveSyncState(state, now) ? "retain" : "start";
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function errorCode(value: string): SyncErrorCode {
  return KNOWN_ERROR_CODES.has(value as SyncErrorCode) ? value as SyncErrorCode : "UNKNOWN";
}

function isPixivDashboardUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.pixiv.net" && /^\/dashboard\/works\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function pageFromUrl(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const page = Number(new URL(value).searchParams.get("p") ?? 1);
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

export function classifyOwnedTabUrl(value: string | undefined): { code: SyncErrorCode; message: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    const path = url.pathname.toLocaleLowerCase();
    if (url.protocol === "https:" && host === "www.pixiv.net" && /^\/dashboard\/works\/?$/.test(path)) return null;
    if (host === "www.pixiv.net" || host === "pixiv.net" || host.endsWith(".pixiv.net")) {
      return { code: "SCHEMA_DRIFT", message: `Pixiv 作品看板暂不可用（当前地址：${path || "/"}），请返回作品管理页后重试` };
    }
    return { code: "UNKNOWN", message: "Pixiv 作品看板暂不可用，请返回作品管理页后重试" };
  } catch {
    return { code: "UNKNOWN", message: "同步标签页地址无效" };
  }
}

function settingsForPolicy(outcome: "in-flight" | "completed" | SyncErrorCode, now = Date.now()): {
  nextAllowedSyncAt: string;
  nextAllowedSyncReason: import("../src/domain/types").SyncPolicyReason;
} {
  const decision = syncPolicyFor(outcome, now);
  return { nextAllowedSyncAt: decision.nextAllowedSyncAt, nextAllowedSyncReason: decision.reason };
}

function optionsForRun(state: SyncState): { runId: string; trigger: SyncRun["trigger"]; startedAt: string; expectedPageCount?: number; accountId?: string | null } {
  return {
    runId: state.runId,
    trigger: state.trigger,
    startedAt: state.startedAt,
    ...(state.accountId === undefined ? {} : { accountId: state.accountId }),
    ...(state.expectedPageCount == null ? {} : { expectedPageCount: state.expectedPageCount }),
  };
}

function followerCollectionErrorCode(error: unknown): SyncErrorCode {
  if (error instanceof PixivApiError) return error.code;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") {
    return "PAGE_TIMEOUT";
  }
  const message = error instanceof Error ? error.message : "";
  if (/quota|storage|limit/i.test(message)) return "STORAGE_LIMIT";
  return "UNKNOWN";
}

export interface FollowerCollectionDependencies {
  collectPixivFollowerCount: typeof collectPixivFollowerCount;
  getTrustedStagedAccount: typeof getTrustedStagedAccount;
  reserveAccountFollowerCollection: typeof reserveAccountFollowerCollection;
  settleAccountFollowerCollection: typeof settleAccountFollowerCollection;
  now?: () => string;
}

/** Reserve and settle the one account-level request attached to a full run. */
export async function collectFollowerForRun(
  state: Pick<SyncState, "runId" | "accountId" | "fallbackReason">,
  dependencies: FollowerCollectionDependencies,
): Promise<void> {
  if (state.fallbackReason === "RATE_LIMITED"
    || state.fallbackReason === "CHALLENGE"
    || state.fallbackReason === "AUTH_REQUIRED") return;

  let account: PixivAccount | null;
  try {
    account = await dependencies.getTrustedStagedAccount(state.runId, state.accountId ?? undefined);
  } catch {
    return;
  }
  if (!account) return;

  const reservedAt = dependencies.now?.() ?? new Date().toISOString();
  let reserved = false;
  try {
    reserved = await dependencies.reserveAccountFollowerCollection({
      runId: state.runId,
      accountId: account.id,
      collectedAt: reservedAt,
    });
  } catch {
    return;
  }
  if (!reserved) return;

  let collected: PixivFollowerCount;
  try {
    collected = await dependencies.collectPixivFollowerCount(account.id);
    if (collected.accountId !== account.id) {
      throw new PixivApiError("ACCOUNT_MISMATCH", "Pixiv follower account identity changed");
    }
  } catch (error) {
    try {
      await dependencies.settleAccountFollowerCollection({
        runId: state.runId,
        accountId: account.id,
        collectedAt: reservedAt,
        followers: null,
        errorCode: followerCollectionErrorCode(error),
      });
    } catch {
      // Follower collection is best-effort and must never fail the work run.
    }
    return;
  }

  try {
    await dependencies.settleAccountFollowerCollection({
      runId: state.runId,
      accountId: account.id,
      // The repository reservation is a compare-and-set keyed by this exact
      // timestamp; use it even though the collector returns its own time.
      collectedAt: reservedAt,
      followers: collected.followers,
      errorCode: null,
    });
  } catch {
    // The reservation remains durable if settlement is interrupted; a later
    // recovery must not issue a second follower request.
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function randomizedNavigationDelay(randomValue = Math.random()): number {
  const clamped = Math.max(0, Math.min(0.999999, randomValue));
  return MIN_NAVIGATION_DELAY_MS + Math.floor(clamped * (MAX_NAVIGATION_DELAY_MS - MIN_NAVIGATION_DELAY_MS + 1));
}

export function shouldNavigateOnRecovery(visibleUrl: string | undefined, expectedUrl: string): boolean {
  return visibleUrl !== expectedUrl;
}

export interface TabFallbackPlan {
  initialUrl: "about:blank";
  finalUrl: string;
  active: false;
}

export function makeTabFallbackPlan(expectedUrl: string): TabFallbackPlan {
  return { initialUrl: "about:blank", finalUrl: expectedUrl, active: false };
}

export function buildSyncUrl(page: number, runId: string): string {
  return makeExpectedUrl(page, runId);
}

export function validateSenderForState(
  sender: chrome.runtime.MessageSender,
  state: SyncState,
): boolean {
  const tabId = sender.tab?.id;
  const senderUrl = sender.tab?.url ?? sender.url;
  return tabId != null && state.ownedTabId === tabId && isPixivDashboardUrl(senderUrl)
    && pageFromUrl(senderUrl) === state.expectedPage;
}

/** Passive observations are accepted only from the user's visible dashboard,
 * never from a sync URL carrying the private run marker. */
export function isPassiveDashboardUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "www.pixiv.net"
      && /^\/dashboard\/works\/?$/.test(url.pathname)
      && !url.searchParams.has(SYNC_ROUTE_MARKER);
  } catch {
    return false;
  }
}

export const isPassiveSnapshotUrl = isPassiveDashboardUrl;

export default defineBackground(() => {
  let startInFlight: Promise<RuntimeResponse> | null = null;
  let schedulerMutation: Promise<void> = Promise.resolve();
  let passiveSyncInFlight = 0;
  let drainPendingSchedule: () => Promise<void> = async () => undefined;
  let recoveryInFlight: Promise<void> | null = null;
  let clearingLocalData = false;
  let activeSyncWrites = 0;
  const syncWriteWaiters: Array<() => void> = [];
  let coverQueueState: CoverQueueState | null = null;
  let coverQueueMutation: Promise<void> = Promise.resolve();
  let coverQueueProcessor: Promise<void> | null = null;
  let coverQueueWakeRequested = false;
  let coverQueueTaskCount = 0;
  const coverQueueTaskWaiters: Array<() => void> = [];
  let retentionInFlight: ReturnType<typeof cleanupRetention> | null = null;
  const runRetentionMaintenance = (): ReturnType<typeof cleanupRetention> => {
    if (retentionInFlight) return retentionInFlight;
    retentionInFlight = cleanupRetention({ temporalCompaction: true }).finally(() => {
      retentionInFlight = null;
    });
    return retentionInFlight;
  };
  const storageCenterInfo = async (): Promise<StorageCenterInfo> => {
    const [health, stats, covers, tiers, pendingFrames] = await Promise.all([
      getStorageHealth(),
      getStorageStats(),
      getCoverCacheSummary(),
      getCombinedRetentionTierCounts(),
      getPendingPreCompactionCount(),
    ]);
    const backup = await getBackupCenterStatus(pendingFrames);
    return {
      originUsageBytes: health.usageBytes,
      originQuotaBytes: health.quotaBytes,
      logical: { works: stats.works, samples: stats.samples, observationBatches: stats.observationBatches, coverBytes: covers.bytes },
      tiers,
      backup,
    };
  };

  const withCoverQueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = coverQueueMutation.then(operation, operation);
    coverQueueMutation = next.then(() => undefined, () => undefined);
    return next;
  };

  const loadCoverQueue = async (): Promise<CoverQueueState> => {
    if (coverQueueState) return coverQueueState;
    const stored = await browser.storage.local.get(COVER_QUEUE_STORAGE_KEY);
    const raw = stored[COVER_QUEUE_STORAGE_KEY];
    if (raw == null) {
      coverQueueState = emptyCoverQueueState();
    } else if (typeof raw !== "string") {
      throw new Error("封面队列存储格式无效");
    } else {
      coverQueueState = deserializeCoverQueueState(raw);
    }
    coverQueueState = recoverCoverQueueState(coverQueueState);
    return coverQueueState;
  };

  const persistCoverQueue = async (state: CoverQueueState): Promise<void> => {
    const serialized = serializeCoverQueueState(state);
    await browser.storage.local.set({ [COVER_QUEUE_STORAGE_KEY]: serialized });
    coverQueueState = state;
  };

  const trackCoverQueueTask = async <T>(operation: () => Promise<T>): Promise<T> => {
    coverQueueTaskCount += 1;
    try {
      return await operation();
    } finally {
      coverQueueTaskCount -= 1;
      if (coverQueueTaskCount === 0) {
        while (coverQueueTaskWaiters.length > 0) coverQueueTaskWaiters.shift()?.();
      }
    }
  };

  const waitForCoverQueueTasks = async (): Promise<void> => {
    if (coverQueueTaskCount === 0) return;
    await new Promise<void>((resolve) => coverQueueTaskWaiters.push(resolve));
  };

  const waitForCoverQueueIdle = async (): Promise<void> => {
    await waitForCoverQueueTasks();
    while (coverQueueProcessor) {
      const running = coverQueueProcessor;
      await running.catch(() => undefined);
      if (coverQueueProcessor === running) break;
    }
    await coverQueueMutation.catch(() => undefined);
  };

  const withSyncWrite = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
    if (clearingLocalData) return fallback;
    activeSyncWrites += 1;
    try {
      return await operation();
    } finally {
      activeSyncWrites -= 1;
      if (activeSyncWrites === 0) {
        while (syncWriteWaiters.length > 0) syncWriteWaiters.shift()?.();
      }
    }
  };

  const waitForSyncWrites = async (): Promise<void> => {
    if (activeSyncWrites === 0) return;
    await new Promise<void>((resolve) => syncWriteWaiters.push(resolve));
  };

  const clearAlarm = async (name: string): Promise<void> => {
    try {
      await browser.alarms.clear(name);
    } catch {
      // The alarm API can be unavailable while the extension is shutting down.
    }
  };

  const ensureRetentionMaintenanceAlarm = async (): Promise<void> => {
    const current = await browser.alarms.get(RETENTION_MAINTENANCE_ALARM);
    if (current?.periodInMinutes === 60) return;
    await browser.alarms.create(RETENTION_MAINTENANCE_ALARM, { delayInMinutes: 10, periodInMinutes: 60 });
  };

  const withSchedulerCoordinator = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = schedulerMutation.then(operation, operation);
    schedulerMutation = result.then(() => undefined, () => undefined);
    return result;
  };

  const readScheduleControl = async (): Promise<SyncScheduleControl | null> => {
    const stored = await browser.storage.local.get(SYNC_SCHEDULE_STORAGE_KEY);
    return normalizeSyncScheduleControl(stored[SYNC_SCHEDULE_STORAGE_KEY]);
  };

  const writeScheduleControl = async (control: SyncScheduleControl): Promise<void> => {
    await browser.storage.local.set({ [SYNC_SCHEDULE_STORAGE_KEY]: control });
  };

  const removeScheduleControl = async (): Promise<void> => {
    await browser.storage.local.remove(SYNC_SCHEDULE_STORAGE_KEY);
  };

  const clearSyncAlarms = async (exceptName?: string): Promise<void> => {
    let alarms: chrome.alarms.Alarm[] = [];
    try {
      alarms = await browser.alarms.getAll();
    } catch {
      return;
    }
    await Promise.all(alarms.flatMap((alarm) => (
      (alarm.name === SYNC_ALARM || alarm.name === SYNC_SCHEDULE_REPAIR_ALARM || alarm.name.startsWith(`${SYNC_ALARM}:`)) && alarm.name !== exceptName
        ? [clearAlarm(alarm.name)]
        : []
    )));
  };

  const armScheduleRepair = async (): Promise<void> => {
    try {
      await browser.alarms.create(SYNC_SCHEDULE_REPAIR_ALARM, { delayInMinutes: 1 });
    } catch {
      // A later worker wake also runs configureSchedule. Never loop against a
      // temporarily unavailable alarms API.
    }
  };

  const installCoverRequestRule = async (): Promise<void> => {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [COVER_REFERRER_RULE_ID],
      addRules: [createCoverReferrerRule(chrome.runtime.id)],
    });
  };

  const scheduleCoverCache = async (delayInMinutes = 0.5): Promise<void> => {
    await browser.alarms.create(COVER_CACHE_ALARM, { delayInMinutes });
  };

  const coverErrorCode = (error: unknown): string => {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code.trim() !== "") return code.slice(0, 96);
    return error instanceof Error ? "UNKNOWN" : "UNKNOWN";
  };

  const notifyCoverCacheRevision = async (): Promise<void> => {
    await browser.storage.local.set({ [COVER_CACHE_REVISION_STORAGE_KEY]: new Date().toISOString() });
  };

  const missingCoversForGeneration = async (
    generationId: string,
    workKeys?: ReadonlySet<string>,
  ): Promise<Array<{
    workKey: string;
    sourceUrl: string;
    pipelineVersion: number;
    revision: number;
    fingerprint: string;
  }>> => {
    const candidates = await scanCoverCandidates({ runId: generationId });
    return workKeys ? candidates.filter((candidate) => workKeys.has(candidate.workKey)) : candidates;
  };

  const enqueueMissingCovers = async (
    generationId: string,
    workKeys?: ReadonlySet<string>,
  ): Promise<void> => {
    if (clearingLocalData) return;
    const missing = await missingCoversForGeneration(generationId, workKeys);
    const result = await withCoverQueueMutation(async () => {
      if (clearingLocalData) return null;
      const current = await loadCoverQueue();
      const next = enqueueCoverGeneration(current, {
        generationId,
        enqueuedAt: new Date().toISOString(),
        candidates: missing,
      });
      // Persist compaction even when this generation does not fit. The
      // reducer leaves every prior pending obligation intact and returns an
      // explicit capacity error for the caller.
      await persistCoverQueue(next.state);
      return next;
    });
    if (!result) return;
    if (result.error) throw result.error;
  };

  const finishCoverQueueItem = async (
    claim: CoverQueueClaim,
    transition: (state: CoverQueueState) => CoverQueueState,
  ): Promise<void> => {
    await withCoverQueueMutation(async () => {
      const current = await loadCoverQueue();
      await persistCoverQueue(transition(current));
    });
  };

  const persistCoverFailure = async (item: CoverQueueItem, attemptedAt: string, errorCode: string): Promise<boolean> => {
    try {
      return await writeCoverAttempt({
        key: item.workKey,
        workKey: item.workKey,
        sourceUrl: item.sourceUrl,
        pipelineVersion: item.pipelineVersion,
        ...(item.revision === undefined ? {} : { revision: item.revision }),
        ...(item.fingerprint === undefined ? {} : { fingerprint: item.fingerprint }),
        lastAttemptRunId: item.generationId,
        status: "failed",
        width: 0,
        height: 0,
        bytes: 0,
        attemptedAt,
        errorCode,
      });
    } catch {
      return false;
    }
  };

  const processCoverQueueItem = async (item: CoverQueueItem, claim: CoverQueueClaim): Promise<boolean> => {
    const attemptedAt = new Date().toISOString();
    let recordPersisted = false;
    try {
      const summary = await getCoverCacheSummary({ pipelineVersion: item.pipelineVersion });
      if (summary.bytes >= COVER_CACHE_MAX_READY_BYTES) {
        const persisted = await writeCoverAttempt({
          key: item.workKey,
          workKey: item.workKey,
          sourceUrl: item.sourceUrl,
          pipelineVersion: item.pipelineVersion,
          ...(item.revision === undefined ? {} : { revision: item.revision }),
          ...(item.fingerprint === undefined ? {} : { fingerprint: item.fingerprint }),
          lastAttemptRunId: item.generationId,
          status: "skipped-capacity",
          width: 0,
          height: 0,
          bytes: 0,
          attemptedAt,
          errorCode: "CAPACITY",
        });
        if (!persisted) return false;
        recordPersisted = true;
        await finishCoverQueueItem(claim, (state) => skipCoverQueueItem(state, claim, { completedAt: attemptedAt }));
        return recordPersisted;
      }

      const asset = await fetchAndEncodeCover(item.sourceUrl);
      const readyRecord: CoverRecord = {
        key: item.workKey,
        workKey: item.workKey,
        sourceUrl: item.sourceUrl,
        pipelineVersion: item.pipelineVersion,
        lastAttemptRunId: item.generationId,
        status: "ready",
        blob: asset.blob,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        attemptedAt,
      };
      if (!isUsableCoverRecord(readyRecord, {
        sourceUrl: item.sourceUrl,
        pipelineVersion: item.pipelineVersion,
        maxBytes: COVER_CACHE_MAX_BLOB_BYTES,
      })) {
        throw new Error("封面处理结果无效");
      }
      if (asset.bytes > COVER_CACHE_MAX_READY_BYTES - summary.bytes) {
        const persisted = await writeCoverAttempt({
          key: item.workKey,
          workKey: item.workKey,
          sourceUrl: item.sourceUrl,
          pipelineVersion: item.pipelineVersion,
          ...(item.revision === undefined ? {} : { revision: item.revision }),
          ...(item.fingerprint === undefined ? {} : { fingerprint: item.fingerprint }),
          lastAttemptRunId: item.generationId,
          status: "skipped-capacity",
          width: 0,
          height: 0,
          bytes: 0,
          attemptedAt,
          errorCode: "CAPACITY",
        });
        if (!persisted) return recordPersisted;
        recordPersisted = true;
        await finishCoverQueueItem(claim, (state) => skipCoverQueueItem(state, claim, { completedAt: attemptedAt }));
        return recordPersisted;
      }
      const persisted = await writeCoverAttempt({
        key: item.workKey,
        workKey: item.workKey,
        sourceUrl: item.sourceUrl,
        pipelineVersion: item.pipelineVersion,
        ...(item.revision === undefined ? {} : { revision: item.revision }),
        ...(item.fingerprint === undefined ? {} : { fingerprint: item.fingerprint }),
        lastAttemptRunId: item.generationId,
        status: "ready",
        blob: asset.blob,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        attemptedAt,
      });
      // The ACK is intentionally after the repository resolves true. A
      // worker restart before this point sees the durable in-flight item.
      if (!persisted) return false;
      recordPersisted = true;
      await finishCoverQueueItem(claim, (state) => completeCoverQueueItem(
        state,
        claim,
        coverBlobPersistenceAcknowledged(item),
        { completedAt: attemptedAt },
      ));
      return recordPersisted;
    } catch (error) {
      const code = coverErrorCode(error);
      const persisted = await persistCoverFailure(item, attemptedAt, code);
      // Keep the in-flight claim durable when even the failure record could
      // not be written. Recovery will retry it with the bounded attempt cap.
      if (!persisted) return recordPersisted;
      recordPersisted = true;
      await finishCoverQueueItem(claim, (state) => failCoverQueueItem(state, claim, code, { completedAt: attemptedAt }));
      return recordPersisted;
    }
  };

  const processCoverQueue = async (): Promise<void> => {
    if (clearingLocalData) return;
    // Recover a claim left by a prior processor invocation. Claims remain
    // in-flight while a repository write is unresolved, so recovery belongs
    // at the processor boundary rather than in every queue read; otherwise a
    // concurrent enqueue could make the active item claimable twice.
    await withCoverQueueMutation(async () => {
      const current = await loadCoverQueue();
      await persistCoverQueue(recoverCoverQueueState(current));
    });
    let processed = 0;
    let recordPersisted = false;
    while (!clearingLocalData && processed < COVER_CACHE_BATCH_SIZE) {
      const begun = await withCoverQueueMutation(async () => {
        const current = await loadCoverQueue();
        const next = beginCoverQueueItem(current, { now: new Date().toISOString() });
        await persistCoverQueue(next.state);
        return next;
      });
      if (!begun.claim || !begun.item) {
        if (begun.exhausted) {
          processed += 1;
          continue;
        }
        break;
      }
      if (processed > 0 && COVER_CACHE_INTER_IMAGE_DELAY_MS > 0) {
        await wait(COVER_CACHE_INTER_IMAGE_DELAY_MS);
      }
      processed += 1;
      recordPersisted = await processCoverQueueItem(begun.item, begun.claim) || recordPersisted;
    }
    if (clearingLocalData) return;
    if (recordPersisted) await notifyCoverCacheRevision().catch(() => undefined);
    const pending = await withCoverQueueMutation(async () => {
      const current = await loadCoverQueue();
      return current.pending.some((item) => item.status === "pending" || item.status === "in-flight");
    });
    // A completed queue pass must not clear the recovery alarm while a
    // generation scan is still discovering obligations. That task may fail
    // after this pass and needs the alarm to retry discovery after restart.
    if (pending || coverQueueTaskCount > 0) await scheduleCoverCache(COVER_QUEUE_BATCH_DELAY_MINUTES);
    else await clearAlarm(COVER_CACHE_ALARM);
  };

  const ensureCoverQueueProcessor = (): void => {
    coverQueueWakeRequested = true;
    if (coverQueueProcessor) return;
    coverQueueWakeRequested = false;
    coverQueueProcessor = processCoverQueue().finally(() => {
      coverQueueProcessor = null;
      if (coverQueueWakeRequested && !clearingLocalData) {
        coverQueueWakeRequested = false;
        ensureCoverQueueProcessor();
      }
    });
  };

  const runCoverCacheForRun = async (
    generationId: string,
    workKeys?: ReadonlySet<string>,
  ): Promise<void> => {
    if (clearingLocalData) return;
    await trackCoverQueueTask(async () => {
      if (clearingLocalData) return;
      // Create a recovery point before doing work. A terminated service worker
      // can resume this generation from storage without waiting for another sync.
      await scheduleCoverCache(5);
      await installCoverRequestRule();
      await cleanupCoverRecords();
      if (clearingLocalData) return;
      await enqueueMissingCovers(generationId, workKeys);
      if (!clearingLocalData) ensureCoverQueueProcessor();
    });
  };

  const resumeCoverCache = async (): Promise<void> => {
    const runId = await getLatestCompleteSyncRunId();
    if (runId) await runCoverCacheForRun(runId);
    else ensureCoverQueueProcessor();
  };

  const armWatchdog = async (state: SyncState): Promise<void> => {
    if (clearingLocalData) return;
    if (!isActiveSyncState(state, Date.now())) {
      await clearAlarm(SYNC_WATCHDOG_ALARM);
      return;
    }
    const when = Math.max(Date.now() + 1_000, Math.min(state.deadlineAt, state.leaseExpiresAt));
    await browser.alarms.create(SYNC_WATCHDOG_ALARM, { when });
  };

  const persist = async (state: SyncState): Promise<void> => {
    if (clearingLocalData) return;
    await saveSyncState(state);
    await armWatchdog(state);
  };

  const closeOwnedTab = async (tabId: number | null): Promise<void> => {
    if (tabId == null) return;
    try {
      await browser.tabs.remove(tabId);
    } catch {
      // A tab already closed is the desired terminal state.
    }
  };

  const isFallbackBlankTab = (state: SyncState, url: string | undefined): boolean => (
    state.transport === "tab" && state.fallbackUsed === true && url === "about:blank"
  );

  const failRunUnsafe = async (state: SyncState, code: SyncErrorCode, message: string): Promise<RuntimeResponse> => {
    const ownedTabId = state.ownedTabId;
    const failedState = reduceSyncState(state, { type: "FAILED", code, message });
    let failedRunPersisted = false;
    try {
      await failSyncRun(optionsForRun(state), code, message);
      failedRunPersisted = true;
    } catch {
      // Keep the persistent state failure even if IndexedDB itself is unavailable.
    }
    try {
      await saveSettings(settingsForPolicy(code));
    } catch {
      // The failed state remains authoritative if local settings are unavailable.
    }
    await persist(failedState);
    if (failedRunPersisted) await bumpDataRevision().catch(() => undefined);
    await closeOwnedTab(ownedTabId);
    void drainPendingSchedule().catch(() => undefined);
    return { ok: false, error: message };
  };

  const failRun = (state: SyncState, code: SyncErrorCode, message: string): Promise<RuntimeResponse> =>
    withSyncWrite(
      () => failRunUnsafe(state, code, message),
      { ok: false, error: "本地数据正在清理，请稍后再试" },
    );

  const scheduleNavigation = (
    runId: string,
    delay = randomizedNavigationDelay(),
    options: { reloadIfAlreadyAtTarget?: boolean } = {},
  ): void => {
    void (async () => {
      await wait(delay);
      if (clearingLocalData) return;
      const current = await getSyncState();
      if (!current || current.runId !== runId || !isActiveSyncState(current)) return;
      if (current.ownedTabId == null) return;
      try {
        const tab = await browser.tabs.get(current.ownedTabId);
        if (tab.url === current.expectedUrl && options.reloadIfAlreadyAtTarget !== false) {
          await browser.tabs.reload(current.ownedTabId);
        } else {
          await browser.tabs.update(current.ownedTabId, { url: current.expectedUrl, active: false });
        }
      } catch {
        await failRun(current, "TAB_CLOSED", "The owned Pixiv tab could not be reached");
      }
    })();
  };

  const configureSchedule = (): Promise<void> => withSchedulerCoordinator(async () => {
    if (clearingLocalData) return;
    const settings = await getSettings();
    if (!settings.scheduledSyncEnabled) {
      // Removing the durable generation first makes any late Chrome event
      // harmless even if alarm cleanup is interrupted.
      await removeScheduleControl();
      await clearSyncAlarms();
      return;
    }

    const intervalMinutes = settings.syncIntervalHours * 60;
    let control = await readScheduleControl();
    if (!control || control.intervalMinutes !== intervalMinutes) {
      const nextAt = nextBeijingSyncSlot(Date.now(), intervalMinutes);
      if (nextAt == null) return;
      control = {
        version: 1,
        generation: globalThis.crypto?.randomUUID?.() ?? `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        intervalMinutes,
        nextAt,
        pendingSlotAt: null,
      };
      // Persist intent before touching alarms. A restarted worker can recreate
      // the exact same slot without re-anchoring it to startup time.
      await writeScheduleControl(control);
    }

    const expectedName = syncAlarmName(control.generation);
    let alarms: chrome.alarms.Alarm[] = [];
    try {
      alarms = await browser.alarms.getAll();
    } catch {
      await armScheduleRepair();
      return;
    }
    if (hasMatchingOneShotAlarm(control, alarms)) {
      // Preserve even an overdue matching alarm: Chrome may be about to
      // deliver it after sleep and clearing it here would lose that slot.
      await clearSyncAlarms(expectedName);
      return;
    }
    await clearSyncAlarms();
    if (control.nextAt <= Date.now()) {
      // The persisted alarm intent survived but Chrome no longer reports the
      // alarm (for example after a worker/browser interruption). Consume that
      // one overdue slot exactly once, then repair the future alarm. This is a
      // single delayed sample, never a loop over every missed interval.
      const recovered = advanceSyncScheduleControl(
        control,
        expectedName,
        control.nextAt,
        Date.now(),
      );
      if (!recovered) return;
      control = recovered;
      await writeScheduleControl(control);
    }
    await browser.alarms.create(expectedName, { when: control.nextAt });
  });

  const startSyncUnsafe = async (trigger: "manual" | "scheduled" | "recovery"): Promise<RuntimeResponse> => {
    const now = Date.now();
    const settings = await getSettings();
    const gate = canStartSyncForTrigger(settings, trigger, now);
    if (!gate.allowed) return { ok: false, error: gate.message };
    const existing = await getSyncState();
    if (existing && isActiveSyncState(existing, now)) {
      return { ok: false, error: "A synchronization is already running" };
    }
    if (existing && ["opening", "collecting", "rechecking", "committing"].includes(existing.status)) {
      return failRun(existing, "PAGE_TIMEOUT", "The previous synchronization lease expired");
    }

    const storage = await getStorageHealth();
    if (storage.ceiling) {
      return { ok: false, error: "本地历史数据已达到 500 MB 安全上限，请先导出备份并清理扩展数据" };
    }

    try {
      await saveSettings(settingsForPolicy("in-flight", now));
    } catch {
      return { ok: false, error: "同步策略暂不可用，请稍后再试" };
    }
    const state = createApiSyncState(makeRunId(), trigger, now, settings.boundAccount?.id ?? null);
    try {
      await persist(state);
    } catch {
      return { ok: false, error: "同步状态暂不可用，请稍后再试" };
    }
    void runApiSync(state);
    return { ok: true, syncState: state };
  };

  const startSync = (trigger: "manual" | "scheduled" | "recovery"): Promise<RuntimeResponse> =>
    withSyncWrite(
      () => startSyncUnsafe(trigger),
      { ok: false, error: "本地数据正在清理，请稍后再试" },
    );

  const runStart = (trigger: "manual" | "scheduled" | "recovery"): Promise<RuntimeResponse> =>
    withSchedulerCoordinator(async () => {
      if (startInFlight) return { ok: false, error: "同步正在进行，请稍后再试" };
      startInFlight = startSync(trigger).finally(() => {
        startInFlight = null;
      });
      return startInFlight;
    });

  const compareAndClearPendingSlot = async (generation: string, slotAt: number): Promise<void> => {
    const current = await readScheduleControl();
    if (!current) return;
    const cleared = clearPendingSyncSlot(current, generation, slotAt);
    if (cleared !== current) await writeScheduleControl(cleared);
  };

  drainPendingSchedule = (): Promise<void> => withSchedulerCoordinator(async () => {
    if (clearingLocalData || passiveSyncInFlight > 0) return;
    const [settings, control] = await Promise.all([getSettings(), readScheduleControl()]);
    if (!settings.scheduledSyncEnabled || !control
      || control.intervalMinutes !== settings.syncIntervalHours * 60
      || control.pendingSlotAt == null) return;

    const generation = control.generation;
    const slotAt = control.pendingSlotAt;
    const state = await getSyncState();
    const disposition = pendingScheduledDisposition(state, slotAt);
    if (disposition === "retain") return;
    if (disposition === "drop") {
      await compareAndClearPendingSlot(generation, slotAt);
      return;
    }

    const response = await startSync("scheduled");
    if (response.ok) {
      await compareAndClearPendingSlot(generation, slotAt);
      return;
    }

    // A manual/recovery start may have won immediately before the durable
    // state check in startSyncUnsafe. Keep this slot for its terminal path.
    const currentState = await getSyncState();
    const afterStartDisposition = pendingScheduledDisposition(currentState, slotAt);
    if (afterStartDisposition === "retain") return;
    await compareAndClearPendingSlot(generation, slotAt);
  });

  const finalizeCompletedRun = async (state: SyncState): Promise<RuntimeResponse> => {
    if (clearingLocalData) return { ok: false, error: "本地数据正在清理，请稍后再试" };
    let retentionCompleted = false;
    try {
      const retention = await runRetentionMaintenance();
      retentionCompleted = retention.pendingReason == null;
    } catch {
      // Retention maintenance is independent from the already committed run.
    }
    try {
      if (retentionCompleted) {
        await saveSettings({ ...settingsForPolicy("completed"), lastCompactedAt: new Date().toISOString() });
      }
    } catch {
      // The committed run is still valid if policy metadata cannot be saved.
    }
    const ownedTabId = state.ownedTabId;
    const completed = reduceSyncState(state, { type: "COMPLETED" });
    await persist(completed);
    await bumpDataRevision().catch(() => undefined);
    await closeOwnedTab(ownedTabId);
    void runCoverCacheForRun(completed.runId).catch(() => undefined);
    void drainPendingSchedule().catch(() => undefined);
    return { ok: true, syncState: completed };
  };

  const completeRunUnsafe = async (state: SyncState): Promise<RuntimeResponse> => {
    await collectFollowerForRun(state, {
      collectPixivFollowerCount,
      getTrustedStagedAccount,
      reserveAccountFollowerCollection,
      settleAccountFollowerCollection,
    });
    const committing = reduceSyncState(state, { type: "COMMITTING" });
    await persist(committing);
    try {
      await completeSync(optionsForRun(committing));
    } catch (error) {
      const text = error instanceof Error ? error.message : "IndexedDB rejected the atomic snapshot";
      const code: SyncErrorCode = error instanceof AccountMismatchError || /ACCOUNT_MISMATCH/.test(text)
        ? "ACCOUNT_MISMATCH"
        : /storage|quota|limit/i.test(text) ? "STORAGE_LIMIT" : "UNKNOWN";
      return failRun(committing, code, text);
    }
    return finalizeCompletedRun(committing);
  };

  const completeRun = (state: SyncState): Promise<RuntimeResponse> =>
    withSyncWrite(
      () => completeRunUnsafe(state),
      { ok: false, error: "本地数据正在清理，请稍后再试" },
    );

  const beginTabFallback = async (state: SyncState, reason: SyncErrorCode): Promise<void> => {
    if (state.fallbackUsed || !shouldFallbackToTab(reason)) {
      await failRun(state, reason, "Pixiv API snapshot could not be used and tab fallback is not allowed");
      return;
    }
    try {
      await clearStagedPages(state.runId);
    } catch {
      await failRun(state, "STORAGE_LIMIT", "无法清理本次同步的暂存数据");
      return;
    }
    const fallback = createTabFallbackState(state, reason);
    try {
      await persist(fallback);
    } catch {
      await failRun(fallback, "STORAGE_LIMIT", "同步状态无法保存，本次同步已停止");
      return;
    }
    let tab: chrome.tabs.Tab;
    const plan = makeTabFallbackPlan(fallback.expectedUrl);
    try {
      tab = await browser.tabs.create({ url: plan.initialUrl, active: plan.active });
    } catch {
      await failRun(fallback, "UNKNOWN", "Pixiv 作品页无法打开");
      return;
    }
    if (tab.id == null) {
      await failRun(fallback, "UNKNOWN", "同步标签页没有有效 id");
      return;
    }
    const opened = reduceSyncState(fallback, { type: "TAB_CREATED", tabId: tab.id });
    try {
      await persist(opened);
      scheduleNavigation(opened.runId, randomizedNavigationDelay(), { reloadIfAlreadyAtTarget: false });
    } catch {
      await closeOwnedTab(tab.id);
      await failRun(fallback, "STORAGE_LIMIT", "同步状态无法保存，本次同步已停止");
    }
  };

  const runApiSyncUnsafe = async (state: SyncState): Promise<void> => {
    if (clearingLocalData) return;
    const collecting = reduceSyncState(state, { type: "API_COLLECTING" });
    try {
      await persist(collecting);
    } catch {
      await failRun(collecting, "STORAGE_LIMIT", "同步状态无法保存，本次同步已停止");
      return;
    }
    let stageStarted = false;
    try {
      const existingWorkCount = await getStoredWorkCount();
      const payload = await collectPixivDashboardPage(state.runId);
      const current = await getSyncState();
      if (clearingLocalData || !current || current.runId !== state.runId || !isActiveSyncState(current)) return;
      const validation = validatePagePayload(payload, current);
      if (!validation.ok) {
        await beginTabFallback(current, validation.code);
        return;
      }
      const emptyValidation = validateEmptyPage(payload, existingWorkCount);
      if (!emptyValidation.ok) {
        await beginTabFallback(current, emptyValidation.code);
        return;
      }
      stageStarted = true;
      await stagePage(payload);
      const accepted = reduceSyncState(current, { type: "PAGE_ACCEPTED", payload });
      await completeRun(accepted);
    } catch (error) {
      if (clearingLocalData) return;
      const current = await getSyncState();
      if (!current || current.runId !== state.runId || !isActiveSyncState(current)) return;
      const message = error instanceof Error ? error.message : "Pixiv API did not provide a usable snapshot";
      const code: SyncErrorCode = error instanceof PixivApiError
        ? error.code
        : /quota|storage|limit/i.test(message) ? "STORAGE_LIMIT" : "UNKNOWN";
      if (stageStarted) {
        await failRun(current, code, message);
      } else {
        await beginTabFallback(current, code);
      }
    }
  };

  const runApiSync = (state: SyncState): Promise<void> => withSyncWrite(
    () => runApiSyncUnsafe(state),
    undefined,
  );

  const recoverCommittingUnsafe = async (state: SyncState): Promise<RuntimeResponse> => {
    const existingRun = await getSyncRun(state.runId);
    if (existingRun?.status === "completed") return finalizeCompletedRun(state);
    try {
      // The staged-page transaction is idempotent. It does not re-run the
      // page guards used while collecting, so a worker restart cannot turn a
      // durable commit payload into a duplicate-page failure.
      await completeSync(optionsForRun(state));
    } catch (error) {
      const text = error instanceof Error ? error.message : "IndexedDB rejected the recovered atomic snapshot";
      const code: SyncErrorCode = error instanceof AccountMismatchError || /ACCOUNT_MISMATCH/.test(text)
        ? "ACCOUNT_MISMATCH"
        : /storage|quota|limit/i.test(text) ? "STORAGE_LIMIT" : "UNKNOWN";
      return failRun(state, code, text);
    }
    return finalizeCompletedRun(state);
  };

  const recoverCommitting = (state: SyncState): Promise<RuntimeResponse> =>
    withSyncWrite(
      () => recoverCommittingUnsafe(state),
      { ok: false, error: "本地数据正在清理，请稍后再试" },
    );

  const handlePageReadyUnsafe = async (
    payload: PagePayload,
    sender: chrome.runtime.MessageSender,
  ): Promise<RuntimeResponse> => {
    const state = await getSyncState();
    if (!state || !isActiveSyncState(state)) return { ok: true };
    if (isApiSyncState(state)) return { ok: true };
    if (state.status === "committing") return { ok: true };
    if (!validateSenderForState(sender, state)) return { ok: true };
    // A delayed message from a prior navigation/run must never mutate the
    // currently-held lease, even if Chrome reused a tab id.
    if (payload.runId !== state.runId) return { ok: true };
    const recheck = state.status === "rechecking";
    const validation = validatePagePayload(payload, state, { allowRecheck: recheck });
    if (!validation.ok) {
      if (recheck && (validation.code === "PAGINATION_MUTATED" || validation.code === "REPEATED_PAGE")) {
        if (state.mutationRetryCount < 1) {
          await clearStagedPages(state.runId);
          const retry = reduceSyncState(state, { type: "RETRY_MUTATION" });
          await persist(retry);
          scheduleNavigation(retry.runId);
          return { ok: true, syncState: retry };
        }
      }
      return failRun(state, validation.code, validation.message);
    }

    let existingWorkCount: number;
    try {
      existingWorkCount = await getStoredWorkCount();
    } catch {
      return failRun(state, "STORAGE_LIMIT", "本地作品索引无法读取，本次同步已停止");
    }
    const emptyValidation = validateEmptyPage(payload, existingWorkCount);
    if (!emptyValidation.ok) return failRun(state, emptyValidation.code, emptyValidation.message);

    if (recheck) {
      if (payload.fingerprint !== state.firstPageFingerprint) {
        if (state.mutationRetryCount < 1) {
          await clearStagedPages(state.runId);
          const retry = reduceSyncState(state, { type: "RETRY_MUTATION" });
          await persist(retry);
          scheduleNavigation(retry.runId);
          return { ok: true, syncState: retry };
        }
        return failRun(state, "PAGINATION_MUTATED", "The first page changed during the consistency recheck");
      }
      return completeRun(state);
    }

    try {
      await stagePage(payload);
    } catch (error) {
      const text = error instanceof Error ? error.message : "The page could not be staged";
      return failRun(state, /quota|storage|limit/i.test(text) ? "STORAGE_LIMIT" : "UNKNOWN", text);
    }
    const accepted = reduceSyncState(state, { type: "PAGE_ACCEPTED", payload });
    if (payload.page >= MAX_SYNC_PAGES && payload.hasNext) return failRun(accepted, "MAX_PAGES", "The dashboard exceeded the page safety ceiling");
    if (payload.hasNext) {
      await persist(accepted);
      scheduleNavigation(accepted.runId);
      return { ok: true, syncState: accepted };
    }
    if (payload.page === 1 && !needsFirstPageRecheck(payload.pageCount)) {
      return completeRun(accepted);
    }
    const checking = reduceSyncState(accepted, { type: "BEGIN_RECHECK" });
    await persist(checking);
    scheduleNavigation(checking.runId);
    return { ok: true, syncState: checking };
  };

  const handlePageReady = (payload: PagePayload, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> =>
    withSyncWrite(
      () => handlePageReadyUnsafe(payload, sender),
      { ok: true },
    );

  const handlePassivePageSnapshotUnsafe = async (
    payload: PagePayload,
    sender: chrome.runtime.MessageSender,
  ): Promise<RuntimeResponse> => {
    const senderUrl = sender.tab?.url ?? sender.url;
    if (!isPassiveDashboardUrl(senderUrl)) return { ok: false, error: "Passive snapshots are only accepted from the Pixiv works dashboard" };
    const settings = await getSettings();
    const accountId = settings.boundAccount?.id ?? null;
    const validation = validatePassivePagePayload(payload, accountId);
    if (!validation.ok) return { ok: false, error: validation.message };
    try {
      await mergePassivePageSnapshot(payload, { accountId });
      await bumpDataRevision().catch(() => undefined);
      return { ok: true, data: await getDashboardData() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Passive snapshot could not be applied" };
    }
  };

  const handlePassivePageSnapshot = async (
    payload: PagePayload,
    sender: chrome.runtime.MessageSender,
  ): Promise<RuntimeResponse> => {
    await withSchedulerCoordinator(async () => { passiveSyncInFlight += 1; });
    try {
      return await withSyncWrite(
        () => handlePassivePageSnapshotUnsafe(payload, sender),
        { ok: false, error: "本地数据正在清理，请稍后再试" },
      );
    } finally {
      await withSchedulerCoordinator(async () => { passiveSyncInFlight = Math.max(0, passiveSyncInFlight - 1); });
      void drainPendingSchedule().catch(() => undefined);
    }
  };

  const handlePageFailedUnsafe = async (
    runId: string,
    codeValue: string,
    message: string,
    sender: chrome.runtime.MessageSender,
  ): Promise<RuntimeResponse> => {
    const state = await getSyncState();
    if (!state || state.runId !== runId || !isActiveSyncState(state)) return { ok: true };
    if (isApiSyncState(state)) return { ok: true };
    if (!validateSenderForState(sender, state)) return { ok: true };
    const code = errorCode(codeValue);
    if (canRetry(code, state.retryCount)) {
      const retry = reduceSyncState(state, { type: "RETRY_PAGE" });
      await persist(retry);
      scheduleNavigation(retry.runId);
      return { ok: true, syncState: retry };
    }
    return failRun(state, code, message || "Pixiv did not provide a usable dashboard page");
  };

  const handlePageFailed = (runId: string, code: string, message: string, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> =>
    withSyncWrite(
      () => handlePageFailedUnsafe(runId, code, message, sender),
      { ok: true },
    );

  const recoverUnsafe = async (): Promise<void> => {
    const state = await getSyncState();
    if (!state || !["opening", "collecting", "rechecking", "committing"].includes(state.status)) return;
    if (isApiSyncState(state)) {
      await failRun(state, "PAGE_TIMEOUT", "API synchronization was interrupted; it will run again on the next scheduled attempt");
      return;
    }
    if (state.status === "committing") {
      await recoverCommitting(state);
      return;
    }
    if (!isActiveSyncState(state)) {
      await failRun(state, "PAGE_TIMEOUT", "The synchronization lease expired");
      return;
    }
    if (state.ownedTabId == null) {
      await failRun(state, "TAB_CLOSED", "The recorded synchronization tab is missing");
      return;
    }
    try {
      const tab = await browser.tabs.get(state.ownedTabId);
      const visibleFailure = classifyOwnedTabUrl(tab.url);
      if (visibleFailure && !isFallbackBlankTab(state, tab.url)) {
        await failRun(state, visibleFailure.code, visibleFailure.message);
        return;
      }
      await persist(state);
      // A target URL can still be loading or waiting for readiness after a
      // worker restart. Let the existing content script report it; reloading
      // here would create a needless duplicate request. Only redirect when
      // the visible URL is not the persisted target.
      if (shouldNavigateOnRecovery(tab.url, state.expectedUrl)) scheduleNavigation(state.runId, 0);
    } catch {
      await failRun(state, "TAB_CLOSED", "The recorded synchronization tab was closed");
    }
  };

  const recover = (): Promise<void> => withSyncWrite(
    () => recoverUnsafe(),
    undefined,
  );

  const runRecovery = (): Promise<void> => {
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight = recover().finally(() => {
      recoveryInFlight = null;
    });
    return recoveryInFlight;
  };

  browser.runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> | undefined => {
    if (!isRuntimeMessage(message)) return undefined;
    if (message.type === "REPAIR_COVERS") {
      return (async (): Promise<RuntimeResponse> => {
        if (clearingLocalData) return { ok: false, error: "本地数据正在清理，请稍后再试" };
        const raw = message as unknown as { repairId?: unknown; workKeys?: unknown };
        const requestedId = typeof raw.repairId === "string" && raw.repairId.trim() !== ""
          ? raw.repairId.trim().slice(0, 120)
          : `repair-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const requestedKeys = Array.isArray(raw.workKeys)
          ? new Set(raw.workKeys.filter((key): key is string => typeof key === "string" && key.trim() !== ""))
          : undefined;
        try {
          await runCoverCacheForRun(requestedId, requestedKeys);
          return { ok: true, data: await getDashboardData() };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "封面修复队列无法启动" };
        }
      })();
    }
    switch (message.type) {
      case "GET_DASHBOARD_DATA":
        return getCachedDashboardData().then((data): RuntimeResponse => ({ ok: true, data })).catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "Dashboard data is unavailable" }));
      case "GET_SYNC_STATE":
        return getSyncState().then((syncState): RuntimeResponse => ({ ok: true, syncState })).catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "Sync state is unavailable" }));
      case "GET_COVER_CACHE_SUMMARY":
        return getCoverCacheSummary().then((coverCache): RuntimeResponse => ({ ok: true, coverCache })).catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "Cover cache summary is unavailable" }));
      case "START_SYNC":
        return runStart(message.trigger ?? "manual");
      case "PAGE_READY":
        return handlePageReady(message.payload, sender);
      case "PASSIVE_PAGE_SNAPSHOT":
        return handlePassivePageSnapshot(message.payload, sender);
      case "PAGE_FAILED":
        return handlePageFailed(message.runId, message.code, message.message, sender);
      case "OPEN_DASHBOARD":
        return browser.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }).then((): RuntimeResponse => ({ ok: true })).catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "Dashboard could not be opened" }));
      case "SET_SCHEDULED_SYNC":
        if (clearingLocalData) return Promise.resolve({ ok: false, error: "本地数据正在清理，请稍后再试" });
        return saveSettings({ scheduledSyncEnabled: message.enabled, syncIntervalHours: message.intervalHours })
          .then(async () => { await configureSchedule(); await drainPendingSchedule(); return getDashboardData(); })
          .then((data): RuntimeResponse => ({ ok: true, data }))
          .catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "Schedule could not be saved" }));
      case "SET_SHOW_CHIPS":
        if (clearingLocalData) return Promise.resolve({ ok: false, error: "本地数据正在清理，请稍后再试" });
        return saveSettings({ showPixivChips: message.enabled })
          .then(async () => {
            const pages = await browser.tabs.query({ url: ["https://www.pixiv.net/dashboard/works*"] });
            await Promise.all(pages.flatMap((tab) => tab.id == null ? [] : [browser.tabs.sendMessage(tab.id, message).catch(() => undefined)]));
            return getDashboardData();
          })
          .then((data): RuntimeResponse => ({ ok: true, data }))
          .catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "Chip setting could not be saved" }));
      case "SET_ONBOARDING_COMPLETE":
        if (clearingLocalData) return Promise.resolve({ ok: false, error: "本地数据正在清理，请稍后再试" });
        if (!message.complete) return Promise.resolve({ ok: false, error: "只能确认已完成初始化" });
        return saveSettings({ onboardingComplete: true })
          .then(() => getDashboardData())
          .then((data): RuntimeResponse => ({ ok: true, data }))
          .catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "初始化状态无法保存" }));
      case "CLEAR_LOCAL_DATA":
        return (async (): Promise<RuntimeResponse> => {
          if (clearingLocalData) return { ok: false, error: "本地数据正在清理，请稍后再试" };
          clearingLocalData = true;
          try {
            const pendingStart = startInFlight;
            const pendingResult = pendingStart ? await pendingStart.catch(() => undefined) : undefined;
            await waitForSyncWrites();
            await waitForCoverQueueIdle();
            const current = await getSyncState();
            const pendingOwnedTabId = pendingResult && "syncState" in pendingResult
              ? pendingResult.syncState?.ownedTabId ?? null
              : null;
            await withSchedulerCoordinator(async () => {
              await removeScheduleControl();
              await clearSyncAlarms();
            });
            await clearAlarm(SYNC_WATCHDOG_ALARM);
            await clearAlarm(COVER_CACHE_ALARM);
            if (current?.ownedTabId != null) await closeOwnedTab(current.ownedTabId);
            if (pendingOwnedTabId != null && pendingOwnedTabId !== current?.ownedTabId) await closeOwnedTab(pendingOwnedTabId);
            await clearLocalData(message.rebindAccount ?? null);
            await browser.storage.local.remove(COVER_QUEUE_STORAGE_KEY);
            coverQueueState = null;
            await bumpDataRevision().catch(() => undefined);
            return { ok: true, data: await getDashboardData() };
          } finally {
            clearingLocalData = false;
          }
        })().catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "本地数据清除失败" }));
      case "MAINTAIN_LOCAL_DATA":
        if (clearingLocalData) return Promise.resolve({ ok: false, error: "本地数据正在清理，请稍后再试" });
        return (async (): Promise<RuntimeResponse> => {
          const normalized = await maintainLocalData();
          const retention = await runRetentionMaintenance();
          const stats = await getStorageStats();
          return {
            ok: true,
            maintenance: {
              ...normalized,
              retainedSamples: stats.samples,
              deletedSamples: retention.deletedSamples + retention.temporalDeletedSamples,
              deletedBatches: retention.deletedBatches,
              pendingReason: retention.pendingReason,
            },
            data: await getDashboardData(),
          };
        })()
          .catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "本地数据整理失败" }));
      case "GET_STORAGE_CENTER":
        return storageCenterInfo()
          .then((storageCenter): RuntimeResponse => ({ ok: true, storageCenter }))
          .catch((error: unknown): RuntimeResponse => ({ ok: false, error: error instanceof Error ? error.message : "本地存储状态读取失败" }));
      default:
        return Promise.resolve({ ok: false, error: "Unsupported message" });
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      if (clearingLocalData) return;
      const state = await getSyncState();
      if (!state || state.ownedTabId !== tabId || !isActiveSyncState(state)) return;
      await failRun(state, "TAB_CLOSED", "The owned Pixiv tab was closed before synchronization completed");
    })();
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    void (async () => {
      if (clearingLocalData) return;
      const state = await getSyncState();
      if (!state || state.ownedTabId !== tabId || !isActiveSyncState(state)) return;
      const visibleFailure = classifyOwnedTabUrl(changeInfo.url);
      if (visibleFailure && !isFallbackBlankTab(state, changeInfo.url)) await failRun(state, visibleFailure.code, visibleFailure.message);
    })();
  });

  browser.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
    if (alarm.name === COVER_CACHE_ALARM) {
      void resumeCoverCache().catch(() => undefined);
      return;
    }
    if (alarm.name === RETENTION_MAINTENANCE_ALARM) {
      void runRetentionMaintenance().catch(() => undefined);
      return;
    }
    if (alarm.name === SYNC_SCHEDULE_REPAIR_ALARM) {
      void configureSchedule()
        .then(drainPendingSchedule)
        .catch(() => armScheduleRepair());
      return;
    }
    if (syncAlarmGeneration(alarm.name) != null) {
      void (async () => {
        const accepted = await withSchedulerCoordinator(async (): Promise<boolean> => {
          if (clearingLocalData) return false;
          const [settings, control] = await Promise.all([getSettings(), readScheduleControl()]);
          if (!settings.scheduledSyncEnabled || !control
            || control.intervalMinutes !== settings.syncIntervalHours * 60) return false;
          const advanced = advanceSyncScheduleControl(control, alarm.name, alarm.scheduledTime, Date.now());
          if (!advanced) return false;

          // One atomic local record contains both the delivered-slot marker
          // and the next alarm intent. Persist it before creating the alarm so
          // worker recovery can repair either side without changing cadence.
          await writeScheduleControl(advanced);
          const nextName = syncAlarmName(advanced.generation);
          await clearSyncAlarms(nextName);
          await browser.alarms.create(nextName, { when: advanced.nextAt });
          return true;
        });
        if (accepted) await drainPendingSchedule();
      })().catch(() => {
        void armScheduleRepair();
      });
      return;
    }
    void withSyncWrite(async () => {
      if (clearingLocalData || alarm.name !== SYNC_WATCHDOG_ALARM) return;
      {
        const state = await getSyncState();
        if (!state || !["opening", "collecting", "rechecking", "committing"].includes(state.status)) return;
        if (isApiSyncState(state)) {
          await failRun(state, "PAGE_TIMEOUT", `API synchronization did not finish within ${PAGE_READY_TIMEOUT_MS / 1000} seconds`);
          return;
        }
        if (Date.now() < state.deadlineAt && Date.now() < state.leaseExpiresAt) {
          await armWatchdog(state);
          return;
        }
        if (canRetry("PAGE_TIMEOUT", state.retryCount)) {
          const retry = reduceSyncState(state, { type: "RETRY_PAGE" });
          await persist(retry);
          scheduleNavigation(retry.runId);
        } else {
          await failRun(state, "PAGE_TIMEOUT", `Page ${state.expectedPage} did not become ready within ${PAGE_READY_TIMEOUT_MS / 1000} seconds`);
        }
      }
    }, undefined);
  });

  browser.runtime.onStartup.addListener(() => {
    void installCoverRequestRule().catch(() => undefined);
    void ensureRetentionMaintenanceAlarm().catch(() => undefined);
    void configureSchedule()
      .then(runRecovery)
      .then(drainPendingSchedule)
      .catch(() => armScheduleRepair())
      .finally(() => { void resumeCoverCache().catch(() => undefined); });
  });
  browser.runtime.onInstalled.addListener(() => {
    void installCoverRequestRule().catch(() => undefined);
    void ensureRetentionMaintenanceAlarm().catch(() => undefined);
    void configureSchedule()
      .then(runRecovery)
      .then(drainPendingSchedule)
      .catch(() => armScheduleRepair())
      .finally(() => { void resumeCoverCache().catch(() => undefined); });
  });
  void installCoverRequestRule().catch(() => undefined);
  void ensureRetentionMaintenanceAlarm().catch(() => undefined);
  void configureSchedule()
    .then(runRecovery)
    .then(drainPendingSchedule)
    .catch(() => armScheduleRepair())
    .finally(() => { void resumeCoverCache().catch(() => undefined); });
});
