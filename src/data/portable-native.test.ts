import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteDB } from "idb";
import type { SyncRun, WorkRecord } from "../domain/types";
import { createWorkDictionary } from "../domain/metric-frames";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { clearMemoryStateForTests } from "./local-state";
import { canonicalJson, createPortableBackup } from "./portable-backup";
import { parsePortableBackupDocument, portableBackupFromCsv, portableBackupToCsv } from "./portable-backup-csv";
import { decodePublicFrameHistory } from "./frame-storage";
import { createMetricFrame, createMetricKeyframe, encodeWorkDictionary } from "./metric-frame-codec";
import { createNativePortableBackup } from "./portable-native";
import { encodeWorkDocument, encodeWorkState } from "./storage-codec";

const account = { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" };
const settings = { onboardingComplete: true, scheduledSyncEnabled: false, syncIntervalHours: 1, showPixivChips: true, theme: "system" as const };

afterEach(async () => {
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
  clearMemoryStateForTests();
});

async function seedNativeHistory(frameCount = 80): Promise<{ work: WorkRecord; runs: SyncRun[] }> {
  const db = await getDatabase();
  const dictionary = createWorkDictionary([{ ordinal: 0, workKey: "illust-1" }]);
  const runs: SyncRun[] = [];
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const epochMs = Date.parse("2026-09-01T00:00:00.000Z") + index * 3_600_000;
    const runId = `run-${index}`;
    runs.push({
      runId, trigger: "manual", startedAt: new Date(epochMs - 1_000).toISOString(), finishedAt: new Date(epochMs).toISOString(),
      status: "completed", pages: 1, works: 1, changedWorks: 1, errorCode: null, errorMessage: null,
    });
    frames.push(createMetricFrame({
      runId, runSeq: index, epochMs, scope: "complete", parser: 1, quality: 1,
      observedOrdinals: [0],
      changes: [{
        ordinal: 0,
        metrics: index === 0
          ? { likes: 1, bookmarks: 1, views: 10, comments: 0, rank: null, responses: null, illustrations: null }
          : { views: 10 + index },
        ...(index === 0 ? { ranking: { status: "unknown" as const, observedAt: null, source: null } } : {}),
      }],
    }));
  }
  const last = frames.at(-1)!;
  const work: WorkRecord = {
    key: "illust-1", id: "1", type: "illust", title: "One, \"quoted\"\nsecond line", seriesTitle: null, publishedAt: null,
    wordCount: null, pageCount: 1, isAi: null, isR18: null, thumbnailUrl: "https://i.pximg.net/example.jpg",
    workUrl: "https://www.pixiv.net/artworks/1", metrics: { likes: 1, bookmarks: 1, views: 10 + frameCount - 1, comments: 0, rank: null, responses: null, illustrations: null },
    rankingStatus: "unknown", rankingObservedAt: null, rankingSource: null, rawLabels: {}, missingFields: [], parserVersion: 1,
    firstSeenAt: runs[0]!.startedAt, lastSeenAt: runs.at(-1)!.finishedAt!, lastObservedRunId: runs.at(-1)!.runId, absentSince: null,
  };
  const keyframe = createMetricKeyframe({
    runId: `${last.runId}:keyframe`, runSeq: last.runSeq, epochMs: last.epochMs,
    scope: "complete", parser: 1, quality: 1,
  }, [{
    ordinal: 0, metrics: work.metrics, rankingStatus: "unknown", rankingObservedAt: null, rankingSource: null,
    presence: "present", absentSince: null,
    lastObserved: { runId: last.runId, runSeq: last.runSeq, epochMs: last.epochMs, collectedAt: new Date(last.epochMs).toISOString() },
    parser: 1, quality: 1, provenance: null,
  }]);
  const tx = db.transaction(["works", "workStates", "workDictionary", "metricFrames", "metricKeyframes", "analyticsSchemaState", "syncRuns", "accountFollowerRecords"], "readwrite");
  await tx.objectStore("works").put(encodeWorkDocument(work), work.key);
  await tx.objectStore("workStates").put(encodeWorkState(work), work.key);
  await tx.objectStore("workDictionary").put(encodeWorkDictionary(dictionary), "root");
  for (const frame of frames) await tx.objectStore("metricFrames").put(frame);
  await tx.objectStore("metricKeyframes").put(keyframe);
  await tx.objectStore("analyticsSchemaState").put({ key: "root", activeSchema: "frames", nextRunSeq: frameCount, migrationStatus: "ready", migrationCursor: null, migrationSnapshot: null, updatedAt: new Date(last.epochMs).toISOString() });
  for (const run of runs) await tx.objectStore("syncRuns").put(run, run.runId);
  await tx.objectStore("accountFollowerRecords").put({ runId: runs.at(-1)!.runId, accountId: account.id, collectedAt: runs.at(-1)!.finishedAt!, status: "ready", followers: 321, errorCode: null });
  await tx.done;
  return { work, runs };
}

describe("native portable backup", () => {
  it("exports and validates the current frame architecture without expanded legacy arrays", async () => {
    const { work, runs } = await seedNativeHistory();
    const envelope = await createNativePortableBackup({ account, settings }, "2026-09-02T00:00:00.000Z");
    expect(envelope.formatVersion).toBe(6);
    expect(envelope.payload).toMatchObject({ storageSchema: "metric-frames-v1", analytics: { activeSchema: "frames", nextRunSeq: 80 } });
    expect(envelope.payload.metricFrames).toHaveLength(80);
    expect(envelope.payload.metricKeyframes).toHaveLength(1);
    expect(envelope.payload).not.toHaveProperty("samples");
    expect(envelope.payload).not.toHaveProperty("observationBatches");

    const preview = await parsePortableBackupDocument(canonicalJson(envelope), { localAccountId: account.id });
    expect(preview).toMatchObject({ native: true, accountMatch: "same", counts: { works: 1, samples: 80, observationBatches: 80, metricFrames: 80, metricKeyframes: 1 } });

    const history = decodePublicFrameHistory(envelope.payload.workDictionary, envelope.payload.metricFrames);
    const legacy = await createPortableBackup({
      kind: "full", account, settings, works: [work], samples: history.samples,
      observationBatches: history.observationBatches, runs,
      accountFollowerSamples: [{ runId: runs.at(-1)!.runId, accountId: account.id, collectedAt: runs.at(-1)!.finishedAt!, followers: 321 }],
    }, envelope.exportedAt);
    expect(canonicalJson(envelope).length).toBeLessThan(canonicalJson(legacy).length);
    expect(canonicalJson(envelope)).not.toContain("\n");
  });

  it("round-trips the exact native envelope through CSV and rejects tampering", async () => {
    await seedNativeHistory(3);
    const envelope = await createNativePortableBackup({ account, settings }, "2026-09-02T00:00:00.000Z");
    const csv = portableBackupToCsv(envelope);
    expect(csv).toContain("metric_frame");
    expect(csv).not.toContain("observation_batch");
    expect(portableBackupFromCsv(csv)).toEqual(envelope);
    await expect(parsePortableBackupDocument(csv, { localAccountId: account.id })).resolves.toMatchObject({ native: true, counts: { metricFrames: 3 } });
    await expect(parsePortableBackupDocument(csv.replace("second line", "changed"))).rejects.toThrow(/校验失败/);
  });
});
