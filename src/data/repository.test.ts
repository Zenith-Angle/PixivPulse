import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARSER_VERSION } from "../domain/constants";
import { createWorkDictionary } from "../domain/metric-frames";
import type { PagePayload, ParsedWork, SyncRun, WorkRecord, WorkSample } from "../domain/types";
import { clearMemoryStateForTests } from "./local-state";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { encodeWorkDictionary } from "./metric-frame-codec";
import { canonicalWorkSample, decodeWorkSample, encodeObservationBatch, encodeWorkDocument, encodeWorkSample, encodeWorkState } from "./storage-codec";
import {
  clearLocalData,
  cleanupRetention,
  compactTemporalSamples,
  completeSync,
  failSyncRun,
  getDashboardData,
  getCombinedRetentionTierCounts,
  getTrustedStagedAccount,
  mergePassivePageSnapshot,
  migrateLegacyAnalyticsToFrames,
  observationBatchForRun,
  reserveAccountFollowerCollection,
  settleAccountFollowerCollection,
  stagePage,
  StaleObservationError,
  validateAccountConsistency,
  validatePassivePagePayload,
} from "./repository";
import { buildMetricFrame } from "./frame-storage";

function work(id = "101", views = 100): ParsedWork {
  return {
    id,
    type: "illust",
    contentType: "illustration",
    description: `Description for ${id}`,
    title: `Work ${id}`,
    seriesTitle: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    wordCount: null,
    pageCount: 1,
    isAi: null,
    isR18: false,
    thumbnailUrl: null,
    workUrl: `https://www.pixiv.net/artworks/${id}`,
    metrics: { likes: 10, bookmarks: 5, views, comments: 1, rank: null, responses: 0, illustrations: 0 },
    rawLabels: {},
    missingFields: ["rank"],
    parserVersion: PARSER_VERSION,
  };
}

function page(runId: string, works: ParsedWork[], options: Partial<PagePayload> = {}): PagePayload {
  const pageNumber = options.page ?? 1;
  const pageCount = options.pageCount ?? 1;
  const hasNext = options.hasNext ?? pageNumber < pageCount;
  return {
    runId,
    page: pageNumber,
    pageCount,
    hasNext,
    positivelyEmpty: works.length === 0,
    fingerprint: JSON.stringify({ page: pageNumber, pageCount, hasNext, workIds: works.map((item) => `${item.type}:${item.id}`) }),
    works,
    account: { id: "24680", name: "Test account", profileUrl: "https://www.pixiv.net/users/24680" },
    parserVersion: PARSER_VERSION,
    collectedAt: options.collectedAt ?? "2026-08-30T10:00:00.000Z",
    quality: { totalCards: works.length, validCards: works.length, missingRequired: 0, missingMetricFields: 0 },
    ...options,
  };
}

async function clearDatabase(): Promise<void> {
  const db = await getDatabase();
  db.close();
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
}

function syncRunFixture(runId: string, at: string): SyncRun {
  return {
    runId,
    trigger: "manual",
    startedAt: at,
    finishedAt: at,
    status: "completed",
    pages: 1,
    works: 1,
    changedWorks: 1,
    errorCode: null,
    errorMessage: null,
  };
}

async function seedHistoryMetadata(runIds: string[]): Promise<void> {
  const db = await getDatabase();
  const firstSeenAt = "2020-01-01T00:00:00.000Z";
  const source = work();
  const record: WorkRecord = {
    ...source,
    key: "illust-101",
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    lastObservedRunId: runIds.at(-1) ?? "metadata",
    absentSince: null,
  };
  await db.put("works", encodeWorkDocument(record), record.key);
  await db.put("workStates", encodeWorkState(record), record.key);
  for (const runId of runIds) await db.put("syncRuns", syncRunFixture(runId, firstSeenAt), runId);
}

describe("repository atomic snapshots", () => {
  beforeEach(async () => {
    clearMemoryStateForTests();
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it("keeps changed batch keys unique and inside the observed work set", () => {
    expect(observationBatchForRun("run", "2026-08-30T10:00:00.000Z", ["b", "a", "a"], ["c", "b", "b"], "complete")).toEqual({
      runId: "run",
      observedAt: "2026-08-30T10:00:00.000Z",
      workKeys: ["a", "b"],
      changedWorkKeys: ["b"],
      scope: "complete",
    });
  });

  it("does not publish an incomplete multi-page run", async () => {
    await stagePage(page("partial", [work()], { page: 1, pageCount: 2, hasNext: true }));
    await expect(completeSync({ runId: "partial", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z", expectedPageCount: 2 }))
      .rejects.toThrow("Not all pages");
    const data = await getDashboardData();
    expect(data.works).toHaveLength(0);
    expect(data.samples).toHaveLength(0);
    expect(data.runs).toHaveLength(0);
  });

  it("records one compact batch per synchronization without duplicating change samples", async () => {
    await stagePage(page("first", [work()]));
    await completeSync({ runId: "first", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });

    await stagePage(page("second", [work()], { collectedAt: "2026-08-30T12:00:00.000Z" }));
    await completeSync({ runId: "second", trigger: "manual", startedAt: "2026-08-30T11:59:00.000Z" });

    const data = await getDashboardData();
    expect(data.works).toHaveLength(1);
    expect(data.samples).toHaveLength(1);
    expect(data.observations).toHaveLength(0);
    expect(data.observationBatches).toHaveLength(2);
    expect(data.observationBatches?.[0]).toMatchObject({
      runId: "second",
      observedAt: "2026-08-30T12:00:00.000Z",
      workKeys: ["illust-101"],
      changedWorkKeys: [],
      scope: "complete",
    });
    expect(data.runs).toHaveLength(2);
    const db = await getDatabase();
    expect(await db.count("samples")).toBe(0);
    expect(await db.count("observationBatches")).toBe(0);
    expect(await db.count("metricFrames")).toBe(2);
    expect(await db.count("metricKeyframes")).toBe(1);
  });

  it("counts active frame history in every data-center retention tier", async () => {
    const db = await getDatabase();
    const now = Date.parse("2026-09-02T00:00:00.000Z");
    const ages = [1, 4, 8, 31];
    for (const [runSeq, ageDays] of ages.entries()) {
      await db.put("metricFrames", buildMetricFrame({
        runId: `tier-${ageDays}`,
        runSeq,
        collectedAt: new Date(now - ageDays * 86_400_000).toISOString(),
        scope: "complete",
        parser: 1,
        quality: 1,
        observedOrdinals: [0],
        changes: [{ ordinal: 0, metrics: { views: ageDays } }],
      }));
    }
    await db.add("samples", encodeWorkSample({
      workKey: "illust-legacy",
      runId: "tier-100",
      collectedAt: new Date(now - 100 * 86_400_000).toISOString(),
      metrics: { likes: 1, bookmarks: 1, views: 1, comments: 0, rank: null, responses: null, illustrations: null },
      parserVersion: 1,
      dataQuality: 1,
      kind: "change",
    }));

    await expect(getCombinedRetentionTierCounts(now)).resolves.toEqual({
      lossless: 1,
      "30m": 1,
      "1h": 1,
      "6h": 2,
    });
  });

  it("routes the legacy compaction API through the guarded frame path", async () => {
    const db = await getDatabase();
    const now = Date.parse("2026-09-02T00:00:00.000Z");
    await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([{ ordinal: 0, workKey: "illust-101" }])), "root");
    for (const [runSeq, minute] of [0, 10, 20].entries()) {
      await db.put("metricFrames", buildMetricFrame({
        runId: `guarded-${minute}`,
        runSeq,
        collectedAt: new Date(now - 4 * 86_400_000 + minute * 60_000).toISOString(),
        scope: "complete",
        parser: 1,
        quality: 1,
        observedOrdinals: [0],
        changes: [{ ordinal: 0, metrics: runSeq === 0 ? work().metrics : { views: minute } }],
      }));
    }
    const before = await db.getAll("metricFrames");
    const result = await compactTemporalSamples({ enabled: true, now });
    expect(result).toMatchObject({ pendingReason: "backup-directory-required", updatedSamples: 0, deletedSamples: 0 });
    expect(await db.getAll("metricFrames")).toEqual(before);
  });

  it("migrates legacy history transactionally with canonical values unchanged", async () => {
    await seedHistoryMetadata(["legacy-frame"]);
    const db = await getDatabase();
    const legacy: WorkSample = {
      workKey: "illust-101", runId: "legacy-frame", collectedAt: "2020-01-01T00:00:00.000Z",
      metrics: { likes: 10, bookmarks: 5, views: 100, comments: 1, rank: null, responses: 0, illustrations: 0 },
      rankingStatus: "unknown", rankingObservedAt: null, rankingSource: null,
      parserVersion: PARSER_VERSION, dataQuality: 1, kind: "change",
    };
    await db.put("samples", encodeWorkSample(legacy));
    await db.put("observationBatches", encodeObservationBatch({
      runId: "legacy-frame", observedAt: legacy.collectedAt, workKeys: [legacy.workKey], changedWorkKeys: [legacy.workKey], scope: "complete",
    }));
    const result = await migrateLegacyAnalyticsToFrames({ chunkSize: 1 });
    expect(result).toMatchObject({ status: "ready", migratedRuns: 1, migratedSamples: 1, remainingRuns: 0 });
    expect(await db.count("samples")).toBe(0);
    expect(await db.count("observationBatches")).toBe(0);
    expect(await db.count("metricFrames")).toBe(1);
    const after = (await getDashboardData()).samples.find((sample) => sample.runId === "legacy-frame");
    expect(after && canonicalWorkSample(after)).toBe(canonicalWorkSample(legacy));
  });

  it("keeps legacy rollups untouched even when the same run already has a frame", async () => {
    await seedHistoryMetadata(["legacy-rollup"]);
    const db = await getDatabase();
    const rollup: WorkSample = {
      workKey: "illust-101", runId: "legacy-rollup", collectedAt: "2020-01-01T00:00:00.000Z",
      metrics: { likes: 10, bookmarks: 5, views: 100, comments: 1, rank: null, responses: 0, illustrations: 0 },
      rankingStatus: "unknown", rankingObservedAt: null, rankingSource: null,
      parserVersion: PARSER_VERSION, dataQuality: 1, kind: "daily-rollup",
      rollupSourceCollectedAt: "2019-12-31T23:00:00.000Z",
    };
    await db.put("samples", encodeWorkSample(rollup));
    await db.put("observationBatches", encodeObservationBatch({
      runId: rollup.runId, observedAt: rollup.collectedAt, workKeys: [rollup.workKey], changedWorkKeys: [rollup.workKey], scope: "complete",
    }));
    await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([{ ordinal: 0, workKey: rollup.workKey }])), "root");
    await db.put("metricFrames", buildMetricFrame({
      runId: rollup.runId,
      runSeq: 0,
      collectedAt: rollup.collectedAt,
      scope: "complete",
      parser: PARSER_VERSION,
      quality: 1,
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: rollup.metrics }],
    }));
    const result = await migrateLegacyAnalyticsToFrames();
    expect(result).toMatchObject({ status: "pending", migratedRuns: 0, remainingRuns: 1 });
    expect(await db.count("samples")).toBe(1);
    expect(await db.count("observationBatches")).toBe(1);
    expect(await db.count("metricFrames")).toBe(1);
  });

  it("stores sorted unique work keys and changed work keys in each batch", async () => {
    await stagePage(page("unchanged-1", [work("101", 100)]));
    await completeSync({ runId: "unchanged-1", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });
    await stagePage(page("unchanged-2", [work("101", 100)], { collectedAt: "2026-08-30T10:30:00.000Z" }));
    await completeSync({ runId: "unchanged-2", trigger: "manual", startedAt: "2026-08-30T10:29:00.000Z" });
    const data = await getDashboardData();
    expect(data.observationBatches).toHaveLength(2);
    expect(data.observationBatches?.map((batch) => batch.workKeys)).toEqual([["illust-101"], ["illust-101"]]);
    expect(data.observationBatches?.map((batch) => batch.changedWorkKeys)).toEqual([[], ["illust-101"]]);
    expect(data.samples.filter((item) => item.workKey === "illust-101")).toHaveLength(1);
  });

  it("binds an account, updates only mutable account fields, and rejects a mismatch", async () => {
    await stagePage(page("account-1", [work()], {
      account: { id: "24680", name: "Original name", profileUrl: "https://www.pixiv.net/users/24680" },
    }));
    await completeSync({ runId: "account-1", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });
    expect((await getDashboardData()).settings.boundAccount).toEqual({
      id: "24680", name: "Original name", profileUrl: "https://www.pixiv.net/users/24680",
    });
    expect((await getDashboardData()).works[0]).toMatchObject({
      contentType: "illustration",
      description: "Description for 101",
    });

    await stagePage(page("account-2", [work()], {
      account: { id: "24680", name: "Updated name", profileUrl: "https://www.pixiv.net/users/24680" },
      collectedAt: "2026-08-30T10:30:00.000Z",
    }));
    await completeSync({ runId: "account-2", trigger: "manual", startedAt: "2026-08-30T10:29:00.000Z", accountId: "24680" });
    expect((await getDashboardData()).settings.boundAccount?.name).toBe("Updated name");

    const mismatch = page("account-3", [work()], {
      account: { id: "97531", name: "Other account", profileUrl: "https://www.pixiv.net/users/97531" },
      collectedAt: "2026-08-30T11:30:00.000Z",
    });
    expect(() => validateAccountConsistency([mismatch], "24680")).toThrow("账号");
    await stagePage(mismatch);
    await expect(completeSync({ runId: "account-3", trigger: "manual", startedAt: "2026-08-30T11:29:00.000Z", accountId: "24680" }))
      .rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });

  it("resolves a complete staged account and makes follower reservation/settlement idempotent", async () => {
    await stagePage(page("followers", [work()]));
    await expect(getTrustedStagedAccount("followers")).resolves.toEqual({
      id: "24680", name: "Test account", profileUrl: "https://www.pixiv.net/users/24680",
    });
    await expect(getTrustedStagedAccount("followers", "97531")).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });

    const collectedAt = "2026-08-30T10:00:00.000Z";
    expect(await reserveAccountFollowerCollection({ runId: "followers", accountId: "24680", collectedAt })).toBe(true);
    expect(await reserveAccountFollowerCollection({ runId: "followers", accountId: "24680", collectedAt })).toBe(false);
    await settleAccountFollowerCollection({ runId: "followers", accountId: "24680", collectedAt, followers: 123, errorCode: null });
    // A second worker completion loses the pending CAS and cannot overwrite
    // the first observed count.
    await settleAccountFollowerCollection({ runId: "followers", accountId: "24680", collectedAt, followers: 456, errorCode: null });
    await completeSync({ runId: "followers", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });
    expect((await getDashboardData()).accountFollowerSamples).toEqual([{
      runId: "followers", accountId: "24680", collectedAt, followers: 123,
    }]);
  });

  it("hides failed and cross-account follower rows from dashboard reads", async () => {
    await stagePage(page("seed-account", [work()]));
    await completeSync({ runId: "seed-account", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });
    const db = await getDatabase();

    const failedAt = "2026-08-30T11:00:00.000Z";
    expect(await reserveAccountFollowerCollection({ runId: "failed-followers", accountId: "24680", collectedAt: failedAt })).toBe(true);
    await settleAccountFollowerCollection({ runId: "failed-followers", accountId: "24680", collectedAt: failedAt, followers: 9, errorCode: null });
    await failSyncRun({ runId: "failed-followers", trigger: "manual", startedAt: "2026-08-30T10:59:00.000Z" }, "UNKNOWN", "failed");

    const crossAt = "2026-08-30T12:00:00.000Z";
    expect(await reserveAccountFollowerCollection({ runId: "cross-followers", accountId: "97531", collectedAt: crossAt })).toBe(true);
    await settleAccountFollowerCollection({ runId: "cross-followers", accountId: "97531", collectedAt: crossAt, followers: 10, errorCode: null });
    await db.put("syncRuns", syncRunFixture("cross-followers", crossAt), "cross-followers");

    const data = await getDashboardData();
    expect(data.accountFollowerSamples).toEqual([]);
    expect(await db.count("accountFollowerRecords")).toBe(2);
  });

  it("marks disappeared works absent while preserving their history", async () => {
    await stagePage(page("present", [work()]));
    await completeSync({ runId: "present", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });

    await stagePage(page("absent", [], { collectedAt: "2026-08-31T10:00:00.000Z", positivelyEmpty: true }));
    await completeSync({ runId: "absent", trigger: "manual", startedAt: "2026-08-31T09:59:00.000Z" });

    const data = await getDashboardData();
    expect(data.works).toHaveLength(1);
    expect(data.works[0]?.absentSince).toBe("2026-08-31T10:00:00.000Z");
    expect(data.samples).toHaveLength(1);
  });

  it("clears the local database and state before an explicit rebind", async () => {
    await stagePage(page("before-clear", [work()]));
    await completeSync({ runId: "before-clear", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });
    const rebound = { id: "97531", name: "Rebound", profileUrl: "https://www.pixiv.net/users/97531" };
    await clearLocalData(rebound);
    const data = await getDashboardData();
    expect(data.works).toHaveLength(0);
    expect(data.samples).toHaveLength(0);
    expect(data.observations).toHaveLength(0);
    expect(data.settings.boundAccount).toEqual(rebound);
    expect(data.settings.scheduledSyncEnabled).toBe(false);
    expect(data.syncState).toBeNull();
  });

  it("normalizes legacy ranking and keeps unknown passive observations from overwriting it", async () => {
    const ranked = work("101");
    ranked.metrics.rank = 7;
    await stagePage(page("rank-seed", [ranked], { collectedAt: "2026-08-30T10:00:00.000Z" }));
    await completeSync({ runId: "rank-seed", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });

    const partial = work("101", 120);
    partial.metrics = { ...partial.metrics, likes: null, rank: null };
    partial.rankingStatus = "unknown";
    partial.rankingObservedAt = null;
    partial.rankingSource = null;
    const newWork = work("999", 999);
    const passive = page("passive-unknown", [partial, newWork], { collectedAt: "2026-08-30T10:30:00.000Z" });
    const run = await mergePassivePageSnapshot(passive, { now: Date.parse("2026-08-30T10:31:00.000Z") });
    expect(run).toMatchObject({ trigger: "passive", pages: 1, works: 1, changedWorks: 1 });
    const data = await getDashboardData();
    expect(data.works).toHaveLength(1);
    expect(data.works[0]).toMatchObject({
      key: "illust-101",
      rankingStatus: "ranked",
      metrics: { views: 120, likes: 10, rank: 7 },
    });
    expect(data.samples).toHaveLength(2);
    expect(data.samples[0]).toMatchObject({ rankingStatus: "unknown", rankingObservedAt: null, rankingSource: null, metrics: { rank: null } });
    expect(data.observations).toHaveLength(0);
    expect(data.observationBatches).toHaveLength(2);
    expect(data.observationBatches?.find((batch) => batch.runId === "passive-unknown")).toMatchObject({
      scope: "partial",
      workKeys: ["illust-101"],
      changedWorkKeys: ["illust-101"],
    });
  });

  it("applies explicit unranked state, rejects stale/account-invalid snapshots, and preserves non-null metrics", async () => {
    await stagePage(page("seed-passive", [work("101", 100)], { collectedAt: "2026-08-30T10:00:00.000Z" }));
    await completeSync({ runId: "seed-passive", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z" });

    const badAccount = page("bad-account", [work("101", 110)], {
      account: { id: "97531", name: "Other", profileUrl: "https://www.pixiv.net/users/97531" },
      collectedAt: "2026-08-30T10:10:00.000Z",
    });
    expect(validatePassivePagePayload(badAccount, "24680", Date.parse("2026-08-30T10:11:00.000Z"))).toMatchObject({ ok: false, code: "ACCOUNT_MISMATCH" });
    await expect(mergePassivePageSnapshot(badAccount, { now: Date.parse("2026-08-30T10:11:00.000Z") })).rejects.toThrow();

    const stale = page("stale-passive", [work("101", 111)], { collectedAt: "2026-08-30T09:59:00.000Z" });
    await expect(mergePassivePageSnapshot(stale, { now: Date.parse("2026-08-30T10:00:30.000Z") })).rejects.toBeInstanceOf(StaleObservationError);

    const unranked = work("101", 110);
    unranked.metrics = { ...unranked.metrics, likes: null, bookmarks: null, views: 110, comments: null, rank: null, responses: null, illustrations: null };
    unranked.rankingStatus = "unranked";
    unranked.rankingObservedAt = "2026-08-30T10:20:00.000Z";
    unranked.rankingSource = "page";
    const run = await mergePassivePageSnapshot(page("passive-unranked", [unranked], { collectedAt: "2026-08-30T10:20:00.000Z" }), {
      now: Date.parse("2026-08-30T10:21:00.000Z"),
    });
    expect(run.changedWorks).toBe(1);
    const data = await getDashboardData();
    expect(data.works[0]).toMatchObject({ rankingStatus: "unranked", metrics: { views: 110, likes: 10, rank: null } });
    expect(data.samples[0]).toMatchObject({ rankingStatus: "unranked", rankingSource: "page", metrics: { rank: null } });
  });

  it("preserves legacy fine-grained samples instead of bypassing the frame backup gate", async () => {
    const db = await getDatabase();
    const base = {
      workKey: "illust-101",
      metrics: work().metrics,
      parserVersion: PARSER_VERSION,
      dataQuality: 1,
      kind: "change" as const,
    };
    await seedHistoryMetadata(["before", "after"]);
    await db.add("samples", { ...base, runId: "before", collectedAt: "2020-01-01T15:59:59.999Z" });
    await db.add("samples", { ...base, runId: "after", collectedAt: "2020-01-01T16:00:00.000Z", metrics: { ...base.metrics, views: 110 } });

    const result = await cleanupRetention({ now: "2026-09-01T00:00:00.000Z" });
    const samples = (await db.getAll("samples")).map((sample) => decodeWorkSample(sample));
    expect(result).toMatchObject({ deletedSamples: 0, createdRollups: 0, pendingReason: null });
    expect(samples.map((sample) => sample.collectedAt).sort()).toEqual([
      "2020-01-01T15:59:59.999Z",
      "2020-01-01T16:00:00.000Z",
    ]);
    expect(samples.every((sample) => sample.kind === "change")).toBe(true);
  });

  it("preserves an existing daily rollup and a later same-day change", async () => {
    const db = await getDatabase();
    const base = {
      workKey: "illust-101",
      runId: "before",
      metrics: work().metrics,
      parserVersion: PARSER_VERSION,
      dataQuality: 1,
      kind: "daily-rollup" as const,
      compactionLevel: "daily" as const,
      rollupSourceCollectedAt: "2020-01-01T01:00:00.000Z",
      collectedAt: "2020-01-01T01:00:00.000Z",
    };
    await seedHistoryMetadata(["before", "after"]);
    await db.add("samples", base);
    await db.add("samples", {
      ...base,
      runId: "before-2",
      collectedAt: "2020-01-01T01:30:00.000Z",
      rollupSourceCollectedAt: "2020-01-01T01:30:00.000Z",
    });
    await cleanupRetention({ now: "2026-09-01T00:00:00.000Z" });
    const first = (await db.getAll("samples")).map((sample) => decodeWorkSample(sample)).find((sample) => sample.kind === "daily-rollup");
    expect(first).toMatchObject({ rollupSourceCollectedAt: "2020-01-01T01:00:00.000Z", metrics: { views: 100 } });

    await db.add("samples", {
      ...base,
      runId: "after",
      kind: "change",
      compactionLevel: undefined,
      rollupSourceCollectedAt: undefined,
      collectedAt: "2020-01-01T02:00:00.000Z",
      metrics: { ...base.metrics, views: 120 },
    });
    const result = await cleanupRetention({ now: "2026-09-01T00:00:00.000Z" });
    const samples = (await db.getAll("samples")).map((sample) => decodeWorkSample(sample));
    expect(result.updatedRollups).toBe(0);
    expect(samples).toHaveLength(3);
    expect(samples.filter((sample) => sample.kind === "daily-rollup").map((sample) => sample.runId).sort()).toEqual(["before", "before-2"]);
    expect(samples.find((sample) => sample.kind === "change")).toMatchObject({ runId: "after", metrics: { views: 120 } });
  });

  it("keeps a legacy UTC day-end rollup byte-for-byte across repeated cleanup", async () => {
    const db = await getDatabase();
    await seedHistoryMetadata(["legacy"]);
    await db.add("samples", {
      workKey: "illust-101",
      runId: "legacy",
      collectedAt: "2020-01-03T23:59:59.999Z",
      metrics: work().metrics,
      parserVersion: PARSER_VERSION,
      dataQuality: 1,
      kind: "daily-rollup",
    });

    await cleanupRetention({ now: "2026-09-01T00:00:00.000Z" });
    await cleanupRetention({ now: "2026-09-01T00:00:00.000Z" });
    const samples = (await db.getAll("samples")).map((sample) => decodeWorkSample(sample));
    expect(samples).toHaveLength(1);
    expect(samples[0]?.collectedAt).toBe("2020-01-03T23:59:59.999Z");
  });
});
