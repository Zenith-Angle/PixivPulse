import {
  LOCK_LEASE_MS,
  MAX_SYNC_PAGES,
  MAX_SYNC_RETRIES,
  PAGE_READY_TIMEOUT_MS,
  PARSER_VERSION,
  PIXIV_WORKS_URL,
  SYNC_ROUTE_MARKER,
} from "../domain/constants";
import { computePageFingerprint } from "../domain/parser";
import type { PagePayload, SyncErrorCode, SyncState } from "../domain/types";

export type SyncStateEvent =
  | { type: "TAB_CREATED"; tabId: number; now?: number }
  | { type: "API_COLLECTING"; now?: number }
  | { type: "PAGE_ACCEPTED"; payload: PagePayload; now?: number }
  | { type: "BEGIN_RECHECK"; now?: number }
  | { type: "RETRY_MUTATION"; now?: number }
  | { type: "RETRY_PAGE"; now?: number }
  | { type: "COMMITTING"; now?: number }
  | { type: "COMPLETED"; now?: number }
  | { type: "FAILED"; code: SyncErrorCode; message: string; now?: number }
  | { type: "TAB_CLOSED"; now?: number };

export function isActiveSyncState(state: SyncState | null, now = Date.now()): boolean {
  return state != null
    && ["opening", "collecting", "rechecking", "committing"].includes(state.status)
    && state.leaseExpiresAt > now
    && state.deadlineAt > now;
}

export function makeRunId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `pixiv-pulse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function makeExpectedUrl(page: number, runId: string): string {
  const url = new URL(PIXIV_WORKS_URL);
  url.searchParams.set("p", String(page));
  url.searchParams.set(SYNC_ROUTE_MARKER, runId);
  return url.toString();
}

export function createSyncState(
  runId: string,
  trigger: SyncState["trigger"],
  now = Date.now(),
  accountId: string | null = null,
): SyncState {
  return {
    runId,
    status: "opening",
    trigger,
    transport: "tab",
    fallbackUsed: false,
    fallbackReason: null,
    accountId,
    ownedTabId: null,
    expectedPage: 1,
    expectedPageCount: null,
    expectedUrl: makeExpectedUrl(1, runId),
    seenFingerprints: [],
    seenWorkIds: [],
    firstPageFingerprint: null,
    retryCount: 0,
    mutationRetryCount: 0,
    leaseExpiresAt: now + LOCK_LEASE_MS,
    deadlineAt: now + PAGE_READY_TIMEOUT_MS,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    errorCode: null,
    errorMessage: null,
  };
}

export function createApiSyncState(
  runId: string,
  trigger: SyncState["trigger"],
  now = Date.now(),
  accountId: string | null = null,
): SyncState {
  return { ...createSyncState(runId, trigger, now, accountId), transport: "api" };
}

export function createTabFallbackState(
  source: SyncState,
  reason: SyncErrorCode,
  now = Date.now(),
): SyncState {
  const fallback = createSyncState(source.runId, source.trigger, now, source.accountId ?? null);
  return {
    ...fallback,
    startedAt: source.startedAt,
    transport: "tab",
    fallbackUsed: true,
    fallbackReason: reason,
  };
}

export function isApiSyncState(state: SyncState | null): boolean {
  return state?.transport === "api";
}

export function shouldFallbackToTab(code: SyncErrorCode): boolean {
  return code === "UNKNOWN"
    || code === "PAGE_TIMEOUT"
    || code === "SCHEMA_DRIFT"
    || code === "PAGINATION_MUTATED"
    || code === "REPEATED_PAGE"
    || code === "AUTH_REQUIRED";
}

export function validateEmptyPage(
  payload: PagePayload,
  existingWorkCount: number,
): { ok: true } | { ok: false; code: "SCHEMA_DRIFT"; message: string } {
  if (payload.works.length > 0) return { ok: true };
  if (existingWorkCount > 0) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "本轮未返回作品，已保留本地历史并停止同步" };
  }
  if (!payload.positivelyEmpty) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "作品列表为空但未确认账号确实为空" };
  }
  return { ok: true };
}

export const validateEmptyResult = validateEmptyPage;

function refresh(state: SyncState, now: number, updates: Partial<SyncState> = {}): SyncState {
  return {
    ...state,
    ...updates,
    leaseExpiresAt: now + LOCK_LEASE_MS,
    deadlineAt: now + PAGE_READY_TIMEOUT_MS,
    updatedAt: new Date(now).toISOString(),
  };
}

export function reduceSyncState(state: SyncState, event: SyncStateEvent): SyncState {
  const now = event.now ?? Date.now();
  switch (event.type) {
    case "TAB_CREATED":
      return refresh(state, now, { ownedTabId: event.tabId, status: "opening" });
    case "API_COLLECTING":
      return refresh(state, now, { status: "collecting", ownedTabId: null });
    case "PAGE_ACCEPTED": {
      const payload = event.payload;
      const ids = payload.works.map((work) => `${work.type}:${work.id}`);
      const nextPage = payload.hasNext ? payload.page + 1 : payload.page;
      return refresh(state, now, {
        status: "collecting",
        accountId: state.accountId ?? (payload.page === 1 ? payload.account?.id ?? null : null),
        expectedPageCount: state.expectedPageCount ?? payload.pageCount,
        expectedPage: nextPage,
        expectedUrl: makeExpectedUrl(nextPage, state.runId),
        seenFingerprints: state.seenFingerprints.includes(payload.fingerprint)
          ? state.seenFingerprints
          : [...state.seenFingerprints, payload.fingerprint],
        seenWorkIds: [...state.seenWorkIds, ...ids],
        firstPageFingerprint: payload.page === 1 && !state.firstPageFingerprint ? payload.fingerprint : state.firstPageFingerprint,
      });
    }
    case "BEGIN_RECHECK":
      return refresh(state, now, { status: "rechecking", expectedPage: 1, expectedUrl: makeExpectedUrl(1, state.runId) });
    case "RETRY_MUTATION":
      return refresh(state, now, {
        status: "opening",
        expectedPage: 1,
        expectedPageCount: null,
        expectedUrl: makeExpectedUrl(1, state.runId),
        seenFingerprints: [],
        seenWorkIds: [],
        firstPageFingerprint: null,
        retryCount: 0,
        mutationRetryCount: state.mutationRetryCount + 1,
      });
    case "RETRY_PAGE":
      return refresh(state, now, { status: "opening", retryCount: state.retryCount + 1 });
    case "COMMITTING":
      return refresh(state, now, { status: "committing" });
    case "COMPLETED":
      return {
        ...state,
        status: "completed",
        ownedTabId: null,
        updatedAt: new Date(now).toISOString(),
        leaseExpiresAt: now,
        deadlineAt: now,
        errorCode: null,
        errorMessage: null,
      };
    case "TAB_CLOSED":
      return {
        ...state,
        status: "failed",
        ownedTabId: null,
        updatedAt: new Date(now).toISOString(),
        leaseExpiresAt: now,
        deadlineAt: now,
        errorCode: "TAB_CLOSED",
        errorMessage: "Owned Pixiv tab was closed before synchronization completed",
      };
    case "FAILED":
      return {
        ...state,
        status: "failed",
        ownedTabId: null,
        updatedAt: new Date(now).toISOString(),
        leaseExpiresAt: now,
        deadlineAt: now,
        errorCode: event.code,
        errorMessage: event.message.slice(0, 1000),
      };
  }
}

export function validatePagePayload(
  payload: PagePayload,
  state: SyncState,
  options: { allowRecheck?: boolean } = {},
): { ok: true } | { ok: false; code: SyncErrorCode; message: string } {
  if (payload.runId !== state.runId) return { ok: false, code: "UNKNOWN", message: "Run id does not match active synchronization" };
  if (payload.parserVersion !== PARSER_VERSION) return { ok: false, code: "SCHEMA_DRIFT", message: "Parser version does not match the background contract" };
  if (payload.account != null && !/^\d+$/.test(payload.account.id)) return { ok: false, code: "SCHEMA_DRIFT", message: "Pixiv account identity is invalid" };
  if (payload.page === 1 && payload.account == null) return { ok: false, code: "SCHEMA_DRIFT", message: "Pixiv account profile link was not found" };
  if (state.accountId != null && payload.account?.id !== state.accountId) {
    return { ok: false, code: "ACCOUNT_MISMATCH", message: "当前 Pixiv 账号与已绑定账号不一致，请先清除本地数据后重新绑定" };
  }
  if (payload.page !== state.expectedPage) return { ok: false, code: "PAGINATION_MUTATED", message: "Received an unexpected dashboard page" };
  const recomputed = computePageFingerprint({
    page: payload.page,
    pageCount: payload.pageCount,
    hasNext: payload.hasNext,
    workIds: payload.works.map((work) => `${work.type}:${work.id}`),
  });
  if (payload.fingerprint !== recomputed) return { ok: false, code: "SCHEMA_DRIFT", message: "Page fingerprint does not match its work order" };
  if (payload.quality.validCards > payload.quality.totalCards || payload.quality.missingRequired > payload.quality.totalCards) {
    return { ok: false, code: "SCHEMA_DRIFT", message: "Page quality counters are inconsistent" };
  }
  if (payload.quality.totalCards > 0 && payload.quality.validCards === 0) return { ok: false, code: "SCHEMA_DRIFT", message: "Dashboard cards were found but none could be parsed" };
  if (payload.page > MAX_SYNC_PAGES || payload.pageCount > MAX_SYNC_PAGES) return { ok: false, code: "MAX_PAGES", message: "Dashboard contains more pages than the safety ceiling" };
  if (state.expectedPageCount != null && payload.pageCount !== state.expectedPageCount && !(options.allowRecheck && payload.page === 1)) {
    return { ok: false, code: "PAGINATION_MUTATED", message: "Dashboard page count changed during synchronization" };
  }
  if (!options.allowRecheck && state.seenFingerprints.includes(payload.fingerprint)) return { ok: false, code: "REPEATED_PAGE", message: "Dashboard returned a previously collected page" };
  if (!options.allowRecheck && payload.works.some((work) => state.seenWorkIds.includes(`${work.type}:${work.id}`))) {
    return { ok: false, code: "REPEATED_PAGE", message: "Dashboard returned a previously collected work" };
  }
  if (!payload.hasNext && payload.page < (state.expectedPageCount ?? payload.page)) return { ok: false, code: "PAGINATION_MUTATED", message: "Dashboard ended before all advertised pages were collected" };
  return { ok: true };
}

export function canRetry(code: SyncErrorCode, retryCount: number): boolean {
  if (retryCount >= MAX_SYNC_RETRIES) return false;
  return code === "PAGE_TIMEOUT" || code === "UNKNOWN";
}

export function needsFirstPageRecheck(pageCount: number): boolean {
  return Number.isFinite(pageCount) && pageCount > 1;
}

export const shouldRecheckFirstPage = needsFirstPageRecheck;
