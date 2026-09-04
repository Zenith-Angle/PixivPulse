import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARSER_VERSION } from "../domain/constants";
import type { ObservationBatch, SyncRun, WorkMetrics, WorkRecord, WorkSample } from "../domain/types";
import { clearMemoryStateForTests, saveSettings } from "./local-state";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { decodeWorkSample, encodeObservationBatch, encodeWorkDocument, encodeWorkSample, encodeWorkState } from "./storage-codec";
import {
  applyRetentionPlan,
  buildRetentionPlan,
  cleanupRetention,
  commitImportedAnalyticalData,
  getDataRevision,
  getImportStaging,
  getStorageStats,
  planRetention,
  retentionBucketKey,
  retentionTierForAge,
  stageImportChunk,
} from "./repository";

const NOW = "2026-09-01T00:00:00.000Z";
const BASE_METRICS: WorkMetrics = {
  likes: 10,
  bookmarks: 5,
  views: 100,
  comments: 1,
  rank: null,
  responses: 0,
  illustrations: 0,
};

function sample(
  collectedAt: string,
  runId: string,
  overrides: Partial<WorkSample> = {},
): WorkSample {
  const { metrics: overrideMetrics, ...otherOverrides } = overrides;
  return {
    workKey: "illust-1",
    runId,
    collectedAt,
    rankingStatus: "unknown",
    rankingObservedAt: null,
    rankingSource: null,
    parserVersion: PARSER_VERSION,
    dataQuality: 1,
    kind: "change",
    ...otherOverrides,
    metrics: { ...BASE_METRICS, ...(overrideMetrics ?? {}) },
  };
}

function run(runId: string, at = "2026-08-01T00:00:00.000Z"): SyncRun {
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

function record(workKey = "illust-1"): WorkRecord {
  const [type, id] = workKey.split("-") as ["illust" | "novel", string];
  return {
    key: workKey,
    id,
    type,
    contentType: type === "novel" ? "novel" : "illustration",
    description: null,
    title: "Fixture",
    seriesTitle: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    wordCount: null,
    pageCount: 1,
    isAi: false,
    isR18: false,
    thumbnailUrl: null,
    workUrl: `https://www.pixiv.net/artworks/${id}`,
    metrics: { ...BASE_METRICS },
    rankingStatus: "unknown",
    rankingObservedAt: null,
    rankingSource: null,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    lastObservedRunId: "metadata",
    absentSince: null,
    rawLabels: {},
    missingFields: [],
    parserVersion: PARSER_VERSION,
  };
}

function batch(runId: string, observedAt: string, workKeys = ["illust-1"]): ObservationBatch {
  return { runId, observedAt, workKeys, changedWorkKeys: workKeys, scope: "complete" };
}

function hoursAgo(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
}

async function clearDatabase(): Promise<void> {
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
}

async function seedRows(samples: readonly WorkSample[], batches: readonly ObservationBatch[] = []): Promise<void> {
  const db = await getDatabase();
  const workKeys = new Set([...samples.map((item) => item.workKey), ...batches.flatMap((item) => item.workKeys)]);
  const runs = new Set([...samples.map((item) => item.runId), ...batches.map((item) => item.runId)]);
  for (const workKey of workKeys) {
    const value = record(workKey);
    await db.put("works", encodeWorkDocument(value), value.key);
    await db.put("workStates", encodeWorkState(value), value.key);
  }
  for (const runId of runs) await db.put("syncRuns", run(runId), runId);
  for (const value of samples) await db.add("samples", value);
  for (const value of batches) await db.put("observationBatches", encodeObservationBatch(value));
}

describe("storage v5 retention and revision", () => {
  beforeEach(async () => {
    clearMemoryStateForTests();
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it("keeps the recent window lossless and uses exact tier boundaries and Beijing buckets", () => {
    expect(retentionTierForAge(72 * 3_600_000 - 1)).toBe("lossless");
    expect(retentionTierForAge(72 * 3_600_000)).toBe("30m");
    expect(retentionTierForAge(7 * 86_400_000 - 1)).toBe("30m");
    expect(retentionTierForAge(7 * 86_400_000)).toBe("1h");
    expect(retentionTierForAge(30 * 86_400_000 - 1)).toBe("1h");
    expect(retentionTierForAge(30 * 86_400_000)).toBe("6h");
    expect(retentionTierForAge(365 * 86_400_000)).toBe("6h");
    expect(retentionBucketKey("2026-08-31T15:59:59.999Z", "30m")).toBe("30m:2026-08-31T23:30");
    expect(retentionBucketKey("2026-08-31T16:00:00.000Z", "30m")).toBe("30m:2026-09-01T00:00");
    expect(retentionBucketKey("2026-08-31T16:00:00.000Z", "6h")).toBe("6h:2026-09-01T00:00");
  });

  it("keeps legacy sample rows non-destructive until they can migrate losslessly", () => {
    const rankedOneAt = hoursAgo(73.75);
    const rankedOne = sample(rankedOneAt, "rank-1", {
      id: 1,
      metrics: { ...BASE_METRICS, rank: 1 },
      rankingStatus: "ranked",
      rankingObservedAt: rankedOneAt,
      rankingSource: "api",
    });
    const rankedTwoAt = hoursAgo(73.5);
    const rankedTwo = sample(rankedTwoAt, "rank-2", {
      id: 2,
      metrics: { ...BASE_METRICS, rank: 2 },
      rankingStatus: "ranked",
      rankingObservedAt: rankedTwoAt,
      rankingSource: "api",
    });
    const rankedTwoLatestAt = hoursAgo(73.25);
    const rankedTwoLatest = sample(rankedTwoLatestAt, "rank-3", {
      id: 3,
      metrics: { ...BASE_METRICS, rank: 2 },
      rankingStatus: "ranked",
      rankingObservedAt: rankedTwoLatestAt,
      rankingSource: "api",
    });
    const incomplete = sample(hoursAgo(75), "quality-low", {
      id: 4,
      workKey: "illust-2",
      metrics: { ...BASE_METRICS, views: null, comments: null, responses: null, illustrations: null },
    });
    const complete = sample(hoursAgo(75.5), "quality-high", {
      id: 5,
      workKey: "illust-2",
      metrics: { ...BASE_METRICS, views: 200 },
    });
    const recentEndpoint = sample(hoursAgo(1), "quality-current", { id: 6, workKey: "illust-2" });
    const plan = buildRetentionPlan({
      now: NOW,
      samples: [rankedOne, rankedTwo, rankedTwoLatest, incomplete, complete, recentEndpoint],
      observationBatches: [],
    });
    expect(plan.sampleDeletes).toEqual([]);
    expect(plan.samplePuts).toEqual([]);
    expect(plan.sourceSamples).toHaveLength(6);
  });

  it("keeps legacy observation batches non-destructive and reports the new tiers", () => {
    const batches = [
      batch("batch-2h-a", hoursAgo(73)),
      batch("batch-2h-b", hoursAgo(73.5)),
      batch("batch-daily-a", "2026-06-02T01:00:00.000Z"),
      batch("batch-daily-b", "2026-06-02T05:00:00.000Z"),
    ];
    const plan = buildRetentionPlan({ now: NOW, samples: [], observationBatches: batches });
    expect(plan.batchDeletes).toEqual([]);
    expect(plan.sourceBatches).toHaveLength(4);
    expect(plan.tierCounts).toMatchObject({ lossless: 0, "30m": 2, "1h": 0, "6h": 2 });
  });

  it("builds a deterministic retention plan without external storage metadata", () => {
    const source = sample("2026-06-02T01:00:00.000Z", "history-a", { id: 1 });
    const duplicate = sample("2026-06-02T02:00:00.000Z", "history-b", { id: 2, metrics: { ...BASE_METRICS, views: 200 } });
    const first = buildRetentionPlan({
      now: NOW,
      accountId: "42",
      samples: [source, duplicate],
      observationBatches: [],
    });
    const second = buildRetentionPlan({
      now: NOW,
      accountId: "42",
      samples: [source, duplicate],
      observationBatches: [],
    });
    expect(first.planId).toBe(second.planId);
    expect(first.sampleDeletes).toEqual(second.sampleDeletes);
    expect(first).toMatchObject({
      version: 2,
      policy: { losslessHours: 72, tiers: { "30m": 7, "1h": 30, "6h": Number.POSITIVE_INFINITY } },
    });
    expect(first).not.toHaveProperty("archive");
  });

  it("applies only the non-destructive compatibility plan", async () => {
    const samples = [
      sample("2026-06-02T01:00:00.000Z", "history-a"),
      sample("2026-06-02T02:00:00.000Z", "history-b", { metrics: { ...BASE_METRICS, views: 200 } }),
    ];
    await seedRows(samples);
    const before = await getStorageStats();
    const plan = await planRetention({ now: NOW });
    expect(plan.sampleDeletes).toHaveLength(0);
    const applied = await applyRetentionPlan(plan);
    expect(applied).toMatchObject({ applied: true, deletedSamples: 0, pendingReason: null });
    expect(await getStorageStats()).toMatchObject({ dataRevision: before.dataRevision, samples: 2 });
  });

  it("rejects a caller-crafted destructive legacy plan", async () => {
    const samples = [
      sample("2026-06-02T01:00:00.000Z", "archive-a"),
      sample("2026-06-02T02:00:00.000Z", "archive-b", { metrics: { ...BASE_METRICS, views: 200 } }),
    ];
    await seedRows(samples);
    const plan = await planRetention({ now: NOW });
    const unsafe = { ...plan, sampleDeletes: [plan.sourceSamples[0]!] };
    const rejected = await applyRetentionPlan(unsafe);
    expect(rejected).toMatchObject({ applied: false, pendingReason: "unsafe-legacy-plan", deletedSamples: 0 });
    expect(await getStorageStats()).toMatchObject({ samples: 2 });
  });

  it("keeps source identities in plans even when unrelated metadata is absent", () => {
    const plan = buildRetentionPlan({
      now: NOW,
      samples: [
        sample("2026-06-02T01:00:00.000Z", "orphan-a", { id: 1 }),
        sample("2026-06-02T02:00:00.000Z", "orphan-b", { id: 2 }),
      ],
      observationBatches: [],
    });
    expect(plan.sampleDeletes).toHaveLength(0);
    expect(plan.sourceSamples).toHaveLength(2);
    expect(plan.sourceSamples.every((source) => source.hash.length > 0 && source.identity.length > 0)).toBe(true);
    expect(plan).not.toHaveProperty("archive");
  });

  it("increments the IndexedDB revision for analytical import and clears staged chunks atomically", async () => {
    const before = await getDataRevision();
    await stageImportChunk({ sessionId: "session-1", chunk: 1, payload: { part: 1 }, createdAt: NOW });
    await stageImportChunk({ sessionId: "session-1", chunk: 0, payload: { part: 0 }, createdAt: NOW });
    expect((await getImportStaging("session-1")).map((item) => item.chunk)).toEqual([0, 1]);
    const revision = await commitImportedAnalyticalData({
      stagingSessionId: "session-1",
      works: [record()],
      runs: [run("import-run")],
      samples: [sample("2026-08-31T00:00:00.000Z", "import-run")],
      observationBatches: [batch("import-run", "2026-08-31T00:00:00.000Z")],
    });
    expect(revision).toBe(before + 1);
    expect(await getDataRevision()).toBe(before + 1);
    expect(await getImportStaging("session-1")).toEqual([]);
    expect(await getStorageStats()).toMatchObject({ samples: 1, observationBatches: 1, importStaging: 0 });
  });

  it("exports v4 analytical data with only the portable settings whitelist", async () => {
    await saveSettings({
      onboardingComplete: true,
      scheduledSyncEnabled: true,
      syncIntervalHours: 2,
      showPixivChips: false,
      theme: "dark",
      lastCompactedAt: "machine-local",
    });
    const { exportRepositoryData } = await import("./repository");
    const exported = await exportRepositoryData();
    expect(exported.formatVersion).toBe(5);
    expect(exported.accountFollowerSamples).toEqual([]);
    expect(exported.settings).toEqual({
      onboardingComplete: true,
      scheduledSyncEnabled: true,
      syncIntervalHours: 2,
      showPixivChips: false,
      theme: "dark",
    });
    expect(exported).not.toHaveProperty("syncState");
    expect(exported).toHaveProperty("account");
  });
});
