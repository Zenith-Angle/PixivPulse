import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import { DB_VERSION } from "../domain/constants";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { decodeObservationBatch, decodeWorkSample, materializeWorkRecord, storedSampleIdentityFor } from "./storage-codec";
import type { WorkSample } from "../domain/types";

afterEach(async () => {
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
});

describe("database lifecycle", () => {
  it("creates the v6 follower store without rewriting existing v5 records", async () => {
    const legacy = await openDB(DATABASE_NAME, 5, {
      upgrade(database) {
        const samples = database.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        samples.createIndex("by-work-key", "workKey");
        samples.createIndex("by-collected-at", "collectedAt");
        samples.createIndex("by-run-id", "runId");
        samples.createIndex("by-work-key-collected-at", ["workKey", "collectedAt"]);
        samples.createIndex("by-kind-collected-at", ["kind", "collectedAt"]);
        database.createObjectStore("storageMeta", { keyPath: "key" });
      },
    });
    const source = { id: 1, untouched: true, k: "identity", w: "illust-1", r: "run-1", t: "2026-08-30T10:00:00.000Z", m: [], s: 0, o: null, p: 0, v: 1, q: 1, y: 0, codec: "sample-v1", codecVersion: 1 };
    await legacy.put("samples", source);
    legacy.close();

    const db = await getDatabase();
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get("samples", 1)).toEqual(source);
    expect(db.objectStoreNames.contains("accountFollowerRecords")).toBe(true);
    expect(db.objectStoreNames.contains("backupConfig")).toBe(true);
    expect(db.objectStoreNames.contains("backupReceipts")).toBe(true);
    expect([...db.transaction("accountFollowerRecords").objectStore("accountFollowerRecords").indexNames]).toEqual([
      "by-account-collected-at", "by-collected-at", "by-status",
    ]);
  });

  it("releases its connection when another context deletes the database", async () => {
    await getDatabase();

    await expect(Promise.race([
      deleteDB(DATABASE_NAME),
      new Promise((_, reject) => setTimeout(() => reject(new Error("database deletion stayed blocked")), 250)),
    ])).resolves.toBeUndefined();
  });

  it("migrates v2 observations into compact batches and clears the legacy store", async () => {
    const legacy = await openDB(DATABASE_NAME, 2, {
      upgrade(database) {
        const samples = database.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        const observations = database.createObjectStore("observations", { keyPath: "id", autoIncrement: true });
        const syncRuns = database.createObjectStore("syncRuns");
        samples.createIndex("by-work-key", "workKey");
        samples.createIndex("by-collected-at", "collectedAt");
        samples.createIndex("by-run-id", "runId");
        observations.createIndex("by-work-key", "workKey");
        observations.createIndex("by-observed-at", "observedAt");
        observations.createIndex("by-run-id", "runId");
        syncRuns.createIndex("by-started-at", "startedAt");
        syncRuns.createIndex("by-status", "status");
      },
    });
    await legacy.add("observations", { runId: "complete-run", workKey: "illust-2", observedAt: "2026-08-30T10:00:00.000Z", metricsChanged: false });
    await legacy.add("observations", { runId: "complete-run", workKey: "illust-1", observedAt: "2026-08-30T10:00:00.000Z", metricsChanged: true });
    await legacy.add("observations", { runId: "passive-run", workKey: "illust-3", observedAt: "2026-08-30T11:00:00.000Z", metricsChanged: true });
    await legacy.put("syncRuns", { runId: "complete-run", trigger: "manual", startedAt: "2026-08-30T09:59:00.000Z", finishedAt: "2026-08-30T10:01:00.000Z", status: "completed", pages: 1, works: 2, changedWorks: 1, errorCode: null, errorMessage: null }, "complete-run");
    await legacy.put("syncRuns", { runId: "passive-run", trigger: "passive", startedAt: "2026-08-30T10:59:00.000Z", finishedAt: "2026-08-30T11:01:00.000Z", status: "completed", pages: 1, works: 1, changedWorks: 1, errorCode: null, errorMessage: null }, "passive-run");
    legacy.close();

    const db = await getDatabase();
    const batches = await db.getAll("observationBatches");
    expect(db.version).toBe(DB_VERSION);
    expect(batches).toEqual([
      { runId: "complete-run", observedAt: "2026-08-30T10:00:00.000Z", scope: "complete", codec: "packed-v1", codecVersion: 1, workKeys: { illust: ["1", "2"], novel: [], legacy: [] }, changedWorkKeys: { illust: ["1"], novel: [], legacy: [] } },
      { runId: "passive-run", observedAt: "2026-08-30T11:00:00.000Z", scope: "partial", codec: "packed-v1", codecVersion: 1, workKeys: { illust: ["3"], novel: [], legacy: [] }, changedWorkKeys: { illust: ["3"], novel: [], legacy: [] } },
    ]);
    expect(await db.getAll("observations")).toEqual([]);
    expect([...db.transaction("samples").objectStore("samples").indexNames]).toEqual(expect.arrayContaining([
      "by-work-key-collected-at",
      "by-kind-collected-at",
    ]));
  });

  it("migrates a v3 full work record and plain batch without changing its public data", async () => {
    const legacy = await openDB(DATABASE_NAME, 3, {
      upgrade(database) {
        const works = database.createObjectStore("works");
        works.createIndex("by-type", "type");
        works.createIndex("by-last-seen", "lastSeenAt");
        works.createIndex("by-absent", "absentSince");
        database.createObjectStore("workStates");
        const covers = database.createObjectStore("covers");
        covers.createIndex("by-work-key", "workKey");
        covers.createIndex("by-source-url", "sourceUrl");
        covers.createIndex("by-status", "status");
        covers.createIndex("by-last-attempt-run-id", "lastAttemptRunId");
        const samples = database.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        samples.createIndex("by-work-key", "workKey");
        samples.createIndex("by-collected-at", "collectedAt");
        samples.createIndex("by-run-id", "runId");
        samples.createIndex("by-work-key-collected-at", ["workKey", "collectedAt"]);
        samples.createIndex("by-kind-collected-at", ["kind", "collectedAt"]);
        const observations = database.createObjectStore("observations", { keyPath: "id", autoIncrement: true });
        observations.createIndex("by-work-key", "workKey");
        observations.createIndex("by-observed-at", "observedAt");
        observations.createIndex("by-run-id", "runId");
        database.createObjectStore("observationBatches", { keyPath: "runId" }).createIndex("by-observed-at", "observedAt");
        database.createObjectStore("stagedPages").createIndex("by-run-id", "runId");
        const runs = database.createObjectStore("syncRuns");
        runs.createIndex("by-started-at", "startedAt");
        runs.createIndex("by-status", "status");
      },
    });
    const legacyWork = {
      key: "illust-101",
      id: "101",
      type: "illust",
      contentType: "illustration",
      description: "legacy description",
      title: "Legacy work",
      seriesTitle: null,
      publishedAt: "2026-08-01T00:00:00.000Z",
      wordCount: null,
      pageCount: 1,
      isAi: false,
      isR18: false,
      thumbnailUrl: null,
      workUrl: "https://www.pixiv.net/artworks/101",
      metrics: { likes: 10, bookmarks: 5, views: 100, comments: 1, rank: null, responses: 0, illustrations: 1 },
      rankingStatus: "unknown",
      rankingObservedAt: null,
      rankingSource: null,
      rawLabels: {},
      missingFields: ["rank"],
      parserVersion: 1,
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-30T10:00:00.000Z",
      lastObservedRunId: "legacy-run",
      absentSince: null,
    };
    await legacy.put("works", legacyWork, legacyWork.key);
    await legacy.put("observationBatches", {
      runId: "legacy-run",
      observedAt: "2026-08-30T10:00:00.000Z",
      workKeys: ["illust-101"],
      changedWorkKeys: ["illust-101"],
      scope: "complete",
    });
    legacy.close();

    const db = await getDatabase();
    expect(db.version).toBe(DB_VERSION);
    const document = await db.get("works", "illust-101");
    const state = await db.get("workStates", "illust-101");
    expect(document).not.toHaveProperty("metrics");
    expect(state).toBeDefined();
    expect(materializeWorkRecord(document, state)).toEqual(legacyWork);
    expect(decodeObservationBatch(await db.get("observationBatches", "legacy-run"))).toEqual({
      runId: "legacy-run",
      observedAt: "2026-08-30T10:00:00.000Z",
      workKeys: ["illust-101"],
      changedWorkKeys: ["illust-101"],
      scope: "complete",
    });
    expect([...db.transaction("works").objectStore("works").indexNames]).toEqual(["by-type"]);
  });

  it("atomically upgrades v4 samples to compact rows while preserving their public value and identity", async () => {
    const legacy = await openDB(DATABASE_NAME, 4, {
      upgrade(database) {
        const samples = database.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        samples.createIndex("by-work-key", "workKey");
        samples.createIndex("by-collected-at", "collectedAt");
        samples.createIndex("by-run-id", "runId");
        samples.createIndex("by-work-key-collected-at", ["workKey", "collectedAt"]);
        samples.createIndex("by-kind-collected-at", ["kind", "collectedAt"]);
        database.createObjectStore("observationBatches", { keyPath: "runId" }).createIndex("by-observed-at", "observedAt");
      },
    });
    const source: WorkSample = {
      workKey: "illust-42",
      runId: "v4-run",
      collectedAt: "2026-08-30T10:00:00.000Z",
      metrics: { likes: 10, bookmarks: 20, views: 30, comments: 2, rank: 7, responses: 1, illustrations: 1 },
      rankingStatus: "ranked",
      rankingObservedAt: "2026-08-30T10:00:00.000Z",
      rankingSource: "api",
      parserVersion: 1,
      dataQuality: 1,
      kind: "change",
    };
    const key = await legacy.add("samples", source) as number;
    legacy.close();

    const db = await getDatabase();
    expect(db.version).toBe(DB_VERSION);
    const raw = await db.get("samples", key);
    expect(raw).toMatchObject({ id: key, codec: "sample-v1", codecVersion: 1, w: source.workKey, r: source.runId });
    expect(raw).not.toHaveProperty("workKey");
    expect(decodeWorkSample(raw)).toEqual({ ...source, id: key });
    expect(raw.k).toBe(storedSampleIdentityFor(source));
    expect(await db.get("storageMeta", "root")).toEqual({ key: "root", dataRevision: 0 });
  });

  it("fails closed on a corrupt v4 sample and can retry after the source is repaired", async () => {
    const legacy = await openDB(DATABASE_NAME, 4, {
      upgrade(database) {
        const samples = database.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        samples.createIndex("by-work-key", "workKey");
        samples.createIndex("by-collected-at", "collectedAt");
        samples.createIndex("by-run-id", "runId");
        samples.createIndex("by-work-key-collected-at", ["workKey", "collectedAt"]);
        samples.createIndex("by-kind-collected-at", ["kind", "collectedAt"]);
        database.createObjectStore("observationBatches", { keyPath: "runId" }).createIndex("by-observed-at", "observedAt");
      },
    });
    const source: WorkSample = {
      workKey: "illust-corrupt",
      runId: "corrupt-run",
      collectedAt: "2026-08-30T10:00:00.000Z",
      metrics: { likes: NaN, bookmarks: 20, views: 30, comments: 2, rank: null, responses: 1, illustrations: 1 },
      rankingStatus: "unknown",
      rankingObservedAt: null,
      rankingSource: null,
      parserVersion: 1,
      dataQuality: 1,
      kind: "change",
    };
    await legacy.add("samples", source);
    legacy.close();
    await expect(getDatabase()).rejects.toThrow();

    const check = await openDB(DATABASE_NAME, 4);
    const raw = await check.getAll("samples");
    expect(raw[0]).toHaveProperty("metrics");
    const repaired = { ...raw[0], metrics: { ...raw[0].metrics, likes: 0 } };
    await check.put("samples", repaired);
    check.close();
    resetDatabaseConnection();
    const upgraded = await getDatabase();
    expect(upgraded.version).toBe(DB_VERSION);
    expect(decodeWorkSample((await upgraded.getAll("samples"))[0])).toMatchObject({ workKey: source.workKey, metrics: { likes: 0 } });
  });
});
