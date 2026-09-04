import { describe, expect, it } from "vitest";
import { createApiSyncState, createSyncState, createTabFallbackState, isApiSyncState, needsFirstPageRecheck, reduceSyncState, shouldFallbackToTab, validateEmptyPage, validatePagePayload } from "./sync-machine";
import type { PagePayload } from "../domain/types";

const page = (runId: string, pageNumber: number, hasNext: boolean): PagePayload => ({
  runId,
  page: pageNumber,
  pageCount: hasNext ? 2 : pageNumber,
  hasNext,
  positivelyEmpty: false,
  fingerprint: JSON.stringify({ page: pageNumber, pageCount: hasNext ? 2 : pageNumber, hasNext, workIds: [`illust:${pageNumber}`] }),
  works: [{
    id: String(pageNumber),
    type: "illust",
    title: `Work ${pageNumber}`,
    seriesTitle: null,
    publishedAt: null,
    wordCount: null,
    pageCount: 1,
    isAi: null,
    isR18: null,
    thumbnailUrl: null,
    workUrl: `https://www.pixiv.net/artworks/${pageNumber}`,
    metrics: { likes: 1, bookmarks: 1, views: 1, comments: null, rank: null, responses: null, illustrations: 1 },
    rawLabels: {},
    missingFields: ["comments", "rank", "responses"],
    parserVersion: 1,
  }],
  account: { id: "24680", name: "Test account", profileUrl: "https://www.pixiv.net/users/24680" },
  parserVersion: 1,
  collectedAt: "2026-08-30T00:00:00.000Z",
  quality: { totalCards: 1, validCards: 1, missingRequired: 0, missingMetricFields: 3 },
});

describe("sync state reducer", () => {
  it("advances pages and retains stable first-page identity", () => {
    const initial = createSyncState("run-1", "manual", 0);
    const first = page("run-1", 1, true);
    const collecting = reduceSyncState(initial, { type: "PAGE_ACCEPTED", payload: first, now: 1_000 });
    expect(collecting.expectedPage).toBe(2);
    expect(collecting.firstPageFingerprint).toBe(first.fingerprint);
    expect(validatePagePayload(first, initial)).toEqual({ ok: true });
    const second = reduceSyncState(collecting, { type: "PAGE_ACCEPTED", payload: page("run-1", 2, false), now: 2_000 });
    const checking = reduceSyncState(second, { type: "BEGIN_RECHECK", now: 3_000 });
    expect(checking.status).toBe("rechecking");
    expect(checking.expectedPage).toBe(1);
  });

  it("clears page guards for one fresh mutation retry", () => {
    const initial = createSyncState("run-1", "manual", 0);
    const collecting = reduceSyncState(initial, { type: "PAGE_ACCEPTED", payload: page("run-1", 1, false), now: 1_000 });
    const retry = reduceSyncState(collecting, { type: "RETRY_MUTATION", now: 2_000 });
    expect(retry.status).toBe("opening");
    expect(retry.mutationRetryCount).toBe(1);
    expect(retry.seenFingerprints).toEqual([]);
    expect(retry.seenWorkIds).toEqual([]);
    expect(retry.accountId).toBe("24680");
  });

  it("binds the first account and rejects a later account mismatch", () => {
    const initial = createSyncState("run-1", "manual", 0);
    const first = page("run-1", 1, true);
    const collecting = reduceSyncState(initial, { type: "PAGE_ACCEPTED", payload: first, now: 1_000 });
    expect(collecting.accountId).toBe("24680");
    const other = { ...page("run-1", 2, false), account: { id: "99999", name: "Other", profileUrl: "https://www.pixiv.net/users/99999" } };
    expect(validatePagePayload(other, collecting)).toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });

  it("skips the first-page recheck for a one-page result", () => {
    expect(needsFirstPageRecheck(1)).toBe(false);
    expect(needsFirstPageRecheck(2)).toBe(true);
  });

  it("marks service-worker API runs without an owned tab", () => {
    const state = createApiSyncState("api-run", "manual", 0, "24680");
    expect(isApiSyncState(state)).toBe(true);
    expect(state.ownedTabId).toBeNull();
    expect(reduceSyncState(state, { type: "API_COLLECTING", now: 1_000 })).toMatchObject({
      transport: "api",
      status: "collecting",
      ownedTabId: null,
    });
  });

  it("creates a same-run tab fallback with fresh page guards", () => {
    const api = createApiSyncState("same-run", "manual", 0, "24680");
    const collecting = reduceSyncState(api, { type: "API_COLLECTING", now: 1_000 });
    const fallback = createTabFallbackState(collecting, "SCHEMA_DRIFT", 2_000);
    expect(fallback).toMatchObject({
      runId: "same-run",
      trigger: "manual",
      startedAt: api.startedAt,
      accountId: "24680",
      transport: "tab",
      fallbackUsed: true,
      fallbackReason: "SCHEMA_DRIFT",
      status: "opening",
      ownedTabId: null,
      expectedPage: 1,
      seenFingerprints: [],
      seenWorkIds: [],
    });
  });

  it("allows only conservative API-to-tab fallback errors", () => {
    expect(["UNKNOWN", "PAGE_TIMEOUT", "SCHEMA_DRIFT", "PAGINATION_MUTATED", "REPEATED_PAGE", "AUTH_REQUIRED"]
      .every((code) => shouldFallbackToTab(code as never))).toBe(true);
    expect(["RATE_LIMITED", "CHALLENGE", "ACCOUNT_MISMATCH", "STORAGE_LIMIT", "MAX_PAGES", "TAB_CLOSED"]
      .some((code) => shouldFallbackToTab(code as never))).toBe(false);
  });

  it("protects existing data from an empty snapshot", () => {
    const empty = {
      ...page("empty", 1, false),
      works: [],
      positivelyEmpty: true,
      quality: { totalCards: 0, validCards: 0, missingRequired: 0, missingMetricFields: 0 },
    };
    expect(validateEmptyPage(empty, 0)).toEqual({ ok: true });
    expect(validateEmptyPage(empty, 2)).toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(validateEmptyPage({ ...empty, positivelyEmpty: false }, 0)).toMatchObject({ code: "SCHEMA_DRIFT" });
  });
});
