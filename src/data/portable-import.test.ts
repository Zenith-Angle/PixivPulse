import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteDB } from "idb";
import type { SyncRun, WorkRecord, WorkSample } from "../domain/types";
import { createWorkDictionary } from "../domain/metric-frames";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { clearMemoryStateForTests } from "./local-state";
import { createPortableBackup } from "./portable-backup";
import { parsePortableBackupDocument, portableBackupToCsv } from "./portable-backup-csv";
import { createNativePortableBackup } from "./portable-native";
import { commitStagedPortableImport, stagePortableImport } from "./portable-import";
import { getDashboardData, saveSettings } from "./repository";
import { createMetricFrame, decodeWorkDictionary, encodeWorkDictionary } from "./metric-frame-codec";
import { encodeWorkDocument, encodeWorkState } from "./storage-codec";

const run: SyncRun = { runId: "import-run", trigger: "manual", startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:01.000Z", status: "completed", pages: 1, works: 1, changedWorks: 1, errorCode: null, errorMessage: null };
const work: WorkRecord = { key: "illust-77", id: "77", type: "illust", title: "Imported", seriesTitle: null, publishedAt: null, wordCount: null, pageCount: 1, isAi: null, isR18: null, thumbnailUrl: "https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/01/00/00/00/77_p0_square1200.jpg", workUrl: "https://www.pixiv.net/artworks/77", metrics: { likes: 4, bookmarks: 3, views: 20, comments: 1, rank: null, responses: null, illustrations: null }, rawLabels: {}, missingFields: [], parserVersion: 1, firstSeenAt: run.startedAt, lastSeenAt: run.finishedAt!, lastObservedRunId: run.runId, absentSince: null };
const sample: WorkSample = { workKey: work.key, runId: run.runId, collectedAt: run.finishedAt!, metrics: work.metrics, parserVersion: 1, dataQuality: 1, kind: "change" };

afterEach(async () => {
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
  clearMemoryStateForTests();
});

describe("portable import", () => {
  it("stages, revalidates and atomically restores CSV directly into native frame stores", async () => {
    const source = await getDatabase();
    const frame = createMetricFrame({
      runId: run.runId, runSeq: 0, epochMs: Date.parse(run.finishedAt!), scope: "complete", parser: 1, quality: 1,
      observedOrdinals: [0], changes: [{ ordinal: 0, metrics: work.metrics, ranking: { status: "unknown", observedAt: null, source: null } }],
    });
    const tx = source.transaction(["works", "workStates", "workDictionary", "metricFrames", "analyticsSchemaState", "syncRuns", "accountFollowerRecords"], "readwrite");
    await tx.objectStore("works").put(encodeWorkDocument(work), work.key);
    await tx.objectStore("workStates").put(encodeWorkState(work), work.key);
    await tx.objectStore("workDictionary").put(encodeWorkDictionary(createWorkDictionary([{ ordinal: 0, workKey: work.key }])), "root");
    await tx.objectStore("metricFrames").put(frame);
    await tx.objectStore("analyticsSchemaState").put({ key: "root", activeSchema: "frames", nextRunSeq: 1, migrationStatus: "ready", migrationCursor: null, migrationSnapshot: null, updatedAt: run.finishedAt! });
    await tx.objectStore("syncRuns").put(run, run.runId);
    await tx.objectStore("accountFollowerRecords").put({ runId: run.runId, accountId: "42", collectedAt: run.finishedAt!, status: "ready", followers: 321, errorCode: null });
    await tx.done;
    const envelope = await createNativePortableBackup({ account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" }, settings: { onboardingComplete: true, scheduledSyncEnabled: false, syncIntervalHours: 1, showPixivChips: true, theme: "system" } });
    resetDatabaseConnection();
    await deleteDB(DATABASE_NAME);
    clearMemoryStateForTests();
    const preview = await parsePortableBackupDocument(portableBackupToCsv(envelope), { localIsEmpty: true });
    const staged = await stagePortableImport(preview);
    const result = await commitStagedPortableImport(staged.sessionId, staged.checksum);
    expect(result).toMatchObject({ works: 1, samples: 1, accountFollowerSamples: 1, observationBatches: 1, runs: 1, duplicates: 0 });
    const data = await getDashboardData();
    expect(data.works.map((item) => item.key)).toEqual([work.key]);
    expect(data.samples).toHaveLength(1);
    expect(data.accountFollowerSamples).toEqual([{ runId: run.runId, accountId: "42", collectedAt: run.finishedAt!, followers: 321 }]);
    const restored = await getDatabase();
    expect(await restored.count("metricFrames")).toBe(1);
    expect(await restored.count("samples")).toBe(0);
    expect(await restored.count("observationBatches")).toBe(0);
    expect(await restored.get("analyticsSchemaState", "root")).toMatchObject({ activeSchema: "frames", migrationStatus: "ready", nextRunSeq: 1 });
  });

  it("fails atomically when a hidden pending follower reservation conflicts", async () => {
    const incomingRun: SyncRun = { ...run, runId: "pending-conflict" };
    const incomingWork: WorkRecord = { ...work, key: "illust-78", id: "78", lastObservedRunId: incomingRun.runId, workUrl: "https://www.pixiv.net/artworks/78" };
    const envelope = await createPortableBackup({
      kind: "full",
      account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: { onboardingComplete: true, scheduledSyncEnabled: false, syncIntervalHours: 1, showPixivChips: true, theme: "system" },
      works: [incomingWork],
      samples: [{ ...sample, workKey: incomingWork.key, runId: incomingRun.runId }],
      accountFollowerSamples: [{ runId: incomingRun.runId, accountId: "42", collectedAt: incomingRun.finishedAt!, followers: 999 }],
      observationBatches: [{ runId: incomingRun.runId, observedAt: incomingRun.finishedAt!, workKeys: [incomingWork.key], changedWorkKeys: [incomingWork.key], scope: "complete" }],
      runs: [incomingRun],
    });
    const preview = await parsePortableBackupDocument(JSON.stringify(envelope), { localIsEmpty: true });
    const staged = await stagePortableImport(preview);
    const db = await getDatabase();
    await db.put("accountFollowerRecords", { runId: incomingRun.runId, accountId: "42", collectedAt: incomingRun.finishedAt!, status: "pending", followers: null, errorCode: null });

    await expect(commitStagedPortableImport(staged.sessionId, staged.checksum)).rejects.toThrow(/粉丝样本/);
    expect(await db.get("works", incomingWork.key)).toBeUndefined();
    expect(await db.getAll("samples")).toEqual([]);
    expect(await db.get("syncRuns", incomingRun.runId)).toBeUndefined();
    expect(await db.get("accountFollowerRecords", incomingRun.runId)).toMatchObject({ status: "pending" });
  });

  it("merges native frames by work key and remaps colliding ordinals and run sequences", async () => {
    const sourceWork = { ...work, key: "illust-88", id: "88", workUrl: "https://www.pixiv.net/artworks/88" };
    const sourceRun = { ...run, runId: "source-run" };
    sourceWork.lastObservedRunId = sourceRun.runId;
    const sourceDb = await getDatabase();
    const sourceTx = sourceDb.transaction(["works", "workStates", "workDictionary", "metricFrames", "analyticsSchemaState", "syncRuns"], "readwrite");
    await sourceTx.objectStore("works").put(encodeWorkDocument(sourceWork), sourceWork.key);
    await sourceTx.objectStore("workStates").put(encodeWorkState(sourceWork), sourceWork.key);
    await sourceTx.objectStore("workDictionary").put(encodeWorkDictionary(createWorkDictionary([{ ordinal: 0, workKey: sourceWork.key }])), "root");
    await sourceTx.objectStore("metricFrames").put(createMetricFrame({ runId: sourceRun.runId, runSeq: 0, epochMs: Date.parse(sourceRun.finishedAt!), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0], changes: [{ ordinal: 0, metrics: sourceWork.metrics, ranking: { status: "unknown", observedAt: null, source: null } }] }));
    await sourceTx.objectStore("analyticsSchemaState").put({ key: "root", activeSchema: "frames", nextRunSeq: 1, migrationStatus: "ready", migrationCursor: null, migrationSnapshot: null, updatedAt: sourceRun.finishedAt! });
    await sourceTx.objectStore("syncRuns").put(sourceRun, sourceRun.runId);
    await sourceTx.done;
    const envelope = await createNativePortableBackup({ account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" }, settings: {} });

    resetDatabaseConnection();
    await deleteDB(DATABASE_NAME);
    clearMemoryStateForTests();
    const localRun = { ...run, runId: "local-run" };
    const localWork = { ...work, key: "illust-77", id: "77", lastObservedRunId: localRun.runId };
    const localDb = await getDatabase();
    const localTx = localDb.transaction(["works", "workStates", "workDictionary", "metricFrames", "analyticsSchemaState", "syncRuns"], "readwrite");
    await localTx.objectStore("works").put(encodeWorkDocument(localWork), localWork.key);
    await localTx.objectStore("workStates").put(encodeWorkState(localWork), localWork.key);
    await localTx.objectStore("workDictionary").put(encodeWorkDictionary(createWorkDictionary([{ ordinal: 0, workKey: localWork.key }])), "root");
    await localTx.objectStore("metricFrames").put(createMetricFrame({ runId: localRun.runId, runSeq: 0, epochMs: Date.parse(localRun.finishedAt!) - 1_000, scope: "complete", parser: 1, quality: 1, observedOrdinals: [0], changes: [{ ordinal: 0, metrics: localWork.metrics, ranking: { status: "unknown", observedAt: null, source: null } }] }));
    await localTx.objectStore("analyticsSchemaState").put({ key: "root", activeSchema: "frames", nextRunSeq: 1, migrationStatus: "ready", migrationCursor: null, migrationSnapshot: null, updatedAt: localRun.finishedAt! });
    await localTx.objectStore("syncRuns").put(localRun, localRun.runId);
    await localTx.done;
    await saveSettings({ boundAccount: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" } });

    const preview = await parsePortableBackupDocument(JSON.stringify(envelope), { localAccountId: "42" });
    const staged = await stagePortableImport(preview);
    await expect(commitStagedPortableImport(staged.sessionId, staged.checksum)).resolves.toMatchObject({ works: 1, observationBatches: 1 });
    const dictionary = decodeWorkDictionary(await localDb.get("workDictionary", "root"));
    expect(dictionary.entries).toEqual([{ ordinal: 0, workKey: localWork.key }, { ordinal: 1, workKey: sourceWork.key }]);
    const sourceFrame = await localDb.getFromIndex("metricFrames", "by-run-id", sourceRun.runId);
    expect(sourceFrame).toMatchObject({ runSeq: 1, observed: [1] });
    expect(sourceFrame?.changes[0]?.[0]).toBe(1);
    expect(await localDb.get("analyticsSchemaState", "root")).toMatchObject({ activeSchema: "frames", nextRunSeq: 2, migrationStatus: "ready" });
    expect(await localDb.count("samples")).toBe(0);
    expect(await localDb.count("observationBatches")).toBe(0);
  });
});
