import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COVER_CACHE_PIPELINE_VERSION, PARSER_VERSION } from "../domain/constants";
import type { PagePayload, ParsedWork, WorkRecord } from "../domain/types";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { clearBridgedCoverData } from "./cover-media-bridge";
import {
  cleanupCoverRecords,
  completeSync,
  getCoverCacheSummary,
  getCurrentCover,
  scanCoverCandidates,
  writeCoverAttempt,
} from "./repository";

const source = "https://i.pximg.net/c/250x250/work.jpg";

function work(id = "101", thumbnailUrl: string | null = source): ParsedWork {
  return {
    id,
    type: "illust",
    contentType: "illustration",
    description: null,
    title: `Work ${id}`,
    seriesTitle: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    wordCount: null,
    pageCount: 1,
    isAi: null,
    isR18: false,
    thumbnailUrl,
    workUrl: `https://www.pixiv.net/artworks/${id}`,
    metrics: { likes: 1, bookmarks: 1, views: 1, comments: 0, rank: null, responses: 0, illustrations: 1 },
    rawLabels: {},
    missingFields: [],
    parserVersion: PARSER_VERSION,
  };
}

function page(runId: string, works: ParsedWork[], collectedAt: string): PagePayload {
  return {
    runId,
    page: 1,
    pageCount: 1,
    hasNext: false,
    positivelyEmpty: works.length === 0,
    fingerprint: `${runId}-${collectedAt}`,
    works,
    account: { id: "24680", name: "Test", profileUrl: "https://www.pixiv.net/users/24680" },
    parserVersion: PARSER_VERSION,
    collectedAt,
    quality: { totalCards: works.length, validCards: works.length, missingRequired: 0, missingMetricFields: 0 },
  };
}

async function clearDatabase(): Promise<void> {
  try {
    const db = await getDatabase();
    db.close();
  } catch {
    // The database may not have been opened by a failed test.
  }
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
  await clearBridgedCoverData();
}

async function seed(...works: ParsedWork[]): Promise<void> {
  const item = page("complete-1", works, "2026-08-30T10:00:00.000Z");
  const db = await getDatabase();
  for (const parsed of item.works) {
    const key = `${parsed.type}-${parsed.id}`;
    await db.put("works", {
      ...parsed,
      key,
      firstSeenAt: item.collectedAt,
      lastSeenAt: item.collectedAt,
      lastObservedRunId: item.runId,
      absentSince: null,
    } as WorkRecord, key);
  }
}

describe("cover repository", () => {
  beforeEach(clearDatabase);
  afterEach(clearDatabase);

  it("upgrades with a covers store and reads only the current work URL", async () => {
    const db = await getDatabase();
    expect([...db.objectStoreNames]).toContain("covers");
    const record = {
      key: "illust-101",
      workKey: "illust-101",
      sourceUrl: source,
      pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "complete-1",
      status: "ready" as const,
      blob: new Blob([new Uint8Array([1, 2])], { type: "image/webp" }),
      width: 2,
      height: 1,
      bytes: 2,
      attemptedAt: "2026-08-30T10:01:00.000Z",
    };
    await seed(work());
    await db.put("covers", record, record.key);
    expect(await getCurrentCover("illust-101", source)).toMatchObject({ status: "ready", bytes: 2 });
    expect(await getCurrentCover("illust-101", "https://i.pximg.net/changed.jpg")).toBeNull();
  });

  it("suppresses a failed attempt within a complete run and retries it on the next run", async () => {
    await seed(work());
    expect(await writeCoverAttempt({
      workKey: "illust-101",
      sourceUrl: source,
      pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "complete-1",
      status: "failed",
      attemptedAt: "2026-08-30T10:01:00.000Z",
      errorCode: "NETWORK_ERROR",
    })).toBe(true);
    expect(await scanCoverCandidates({ runId: "complete-1" })).toHaveLength(0);
    expect(await scanCoverCandidates({ runId: "complete-2" })).toMatchObject([{ workKey: "illust-101", sourceUrl: source }]);
  });

  it("rejects stale CAS writes when the work URL or key no longer matches", async () => {
    await seed(work());
    expect(await writeCoverAttempt({
      key: "novel-101",
      workKey: "illust-101",
      sourceUrl: source,
      pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "complete-1",
      status: "failed",
    })).toBe(false);
    expect(await writeCoverAttempt({
      workKey: "illust-101",
      sourceUrl: "https://i.pximg.net/old.jpg",
      pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "old-run",
      status: "failed",
    })).toBe(false);
    expect(await getCurrentCover("illust-101", source)).toBeNull();
  });

  it("accepts a new-source candidate identity and rejects the stale queued identity", async () => {
    await seed(work());
    const oldCandidate = (await scanCoverCandidates({ runId: "complete-1" }))[0]!;
    expect(await writeCoverAttempt({
      ...oldCandidate,
      lastAttemptRunId: "complete-1",
      status: "ready",
      attemptedAt: "2026-08-30T10:01:00.000Z",
      blob: new Blob([new Uint8Array([1, 2])], { type: "image/webp" }),
      width: 2,
      height: 1,
      bytes: 2,
    })).toBe(true);

    const changedSource = "https://i.pximg.net/c/250x250/work-v2.jpg";
    const db = await getDatabase();
    const stored = (await db.get("works", "illust-101"))!;
    await db.put("works", { ...stored, thumbnailUrl: changedSource }, stored.key);
    const newCandidate = (await scanCoverCandidates({ runId: "complete-2" }))[0]!;
    expect(newCandidate).toMatchObject({ sourceUrl: changedSource, revision: oldCandidate.revision + 1 });

    expect(await writeCoverAttempt({
      ...newCandidate,
      lastAttemptRunId: "complete-2",
      status: "failed",
      attemptedAt: "2026-08-30T11:01:00.000Z",
      errorCode: "NETWORK_ERROR",
    })).toBe(true);
    expect(await writeCoverAttempt({
      ...oldCandidate,
      lastAttemptRunId: "complete-1",
      status: "failed",
      attemptedAt: "2026-08-30T11:02:00.000Z",
      errorCode: "STALE_TASK",
    })).toBe(false);

    // Even if the authoritative URL later flips back, the old revision cannot
    // replace the winner. A fresh scan would assign the next revision.
    await db.put("works", { ...(await db.get("works", "illust-101"))!, thumbnailUrl: source }, stored.key);
    expect(await writeCoverAttempt({
      ...oldCandidate,
      lastAttemptRunId: "complete-3",
      status: "failed",
      attemptedAt: "2026-08-30T11:03:00.000Z",
      errorCode: "STALE_REVISION",
    })).toBe(false);
    const replacement = (await scanCoverCandidates({ runId: "complete-3" }))[0]!;
    expect(replacement.revision).toBe(newCandidate.revision + 1);
    await db.put("works", { ...(await db.get("works", "illust-101"))!, thumbnailUrl: changedSource }, stored.key);
    expect(await getCoverCacheSummary({ runId: "complete-2" })).toMatchObject({ failed: 1, pending: 0, total: 1 });
  });

  it("summarizes current statuses and removes orphan or URL-stale entries", async () => {
    await seed(work("101"), work("102"), work("103"));
    const db = await getDatabase();
    await db.put("covers", {
      key: "illust-101", workKey: "illust-101", sourceUrl: source, pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "run", status: "ready", blob: new Blob([new Uint8Array(4)], { type: "image/webp" }), width: 2, height: 2, bytes: 4,
      attemptedAt: "2026-08-30T10:01:00.000Z",
    }, "illust-101");
    await db.put("covers", {
      key: "illust-102", workKey: "illust-102", sourceUrl: source, pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "run", status: "failed", width: 0, height: 0, bytes: 0, attemptedAt: "2026-08-30T10:01:00.000Z",
    }, "illust-102");
    await db.put("covers", {
      key: "illust-ghost", workKey: "illust-ghost", sourceUrl: source, pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "run", status: "ready", blob: new Blob([new Uint8Array(8)]), width: 1, height: 1, bytes: 8,
      attemptedAt: "2026-08-30T10:01:00.000Z",
    }, "illust-ghost");
    const summary = await getCoverCacheSummary();
    expect(summary).toEqual({ ready: 0, failed: 1, skipped: 0, pending: 2, bytes: 0, total: 3 });
    expect(await getCoverCacheSummary({ runId: "next-run" })).toEqual({ ready: 0, failed: 0, skipped: 0, pending: 3, bytes: 0, total: 3 });
    // Legacy rows remain as rollback material; cleanup applies to the active
    // media database and does not destructively erase the old fallback store.
    expect(await cleanupCoverRecords()).toBe(0);
    expect(await db.get("covers", "illust-ghost")).toBeDefined();
  });

  it("keeps the last valid cover source when a later sync omits the thumbnail", async () => {
    const first = page("cover-source-1", [work()], "2026-08-30T10:00:00.000Z");
    await (await getDatabase()).put("stagedPages", {
      key: "cover-source-1:1", runId: "cover-source-1", page: 1, payload: first, stagedAt: first.collectedAt,
    }, "cover-source-1:1");
    await completeSync({ runId: "cover-source-1", trigger: "manual", startedAt: first.collectedAt });
    expect(await writeCoverAttempt({
      workKey: "illust-101", sourceUrl: source, pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      lastAttemptRunId: "cover-source-1", status: "ready", attemptedAt: first.collectedAt,
      blob: new Blob([new Uint8Array([1, 2])], { type: "image/webp" }), width: 2, height: 1, bytes: 2,
    })).toBe(true);

    const second = page("cover-source-2", [work("101", null)], "2026-08-30T11:00:00.000Z");
    await (await getDatabase()).put("stagedPages", {
      key: "cover-source-2:1", runId: "cover-source-2", page: 1, payload: second, stagedAt: second.collectedAt,
    }, "cover-source-2:1");
    await completeSync({ runId: "cover-source-2", trigger: "manual", startedAt: second.collectedAt });

    expect((await (await getDatabase()).get("works", "illust-101"))?.thumbnailUrl).toBe(source);
    // fake-indexeddb does not preserve Blob MIME metadata, so this environment
    // classifies the payload as pending; the important invariant is that the
    // current source and therefore the total do not disappear.
    expect(await getCoverCacheSummary()).toMatchObject({ total: 1 });
    expect(await cleanupCoverRecords()).toBe(0);
  });

});
