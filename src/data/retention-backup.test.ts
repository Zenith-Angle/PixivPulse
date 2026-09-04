import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedWork, SyncRun, WorkRecord } from "../domain/types";
import { createWorkDictionary } from "../domain/metric-frames";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { buildMetricFrame } from "./frame-storage";
import { encodeWorkDictionary } from "./metric-frame-codec";
import { encodeWorkDocument, encodeWorkState } from "./storage-codec";
import { saveSettings, clearMemoryStateForTests } from "./local-state";
import { runGuardedFrameCompaction } from "./retention-backup";
import type { BackupDirectoryHandleLike, BackupFileHandleLike } from "./backup-types";

const NOW = Date.parse("2026-09-02T00:00:00.000Z");

async function reset(): Promise<void> {
  clearMemoryStateForTests();
  try { (await getDatabase()).close(); } catch { /* unopened */ }
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
}

function fakeDirectory(): { handle: BackupDirectoryHandleLike; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fileHandle = (name: string): BackupFileHandleLike => ({
    kind: "file",
    name,
    getFile: async () => ({ size: (files.get(name) ?? "").length, text: async () => files.get(name) ?? "" }),
    createWritable: async () => {
      let pending = "";
      return {
        write: async (data) => { pending = typeof data === "string" ? data : String(data); },
        close: async () => { files.set(name, pending); },
      };
    },
  });
  return {
    files,
    handle: {
      kind: "directory",
      name: "PixivPulseBackups",
      queryPermission: async () => "granted",
      getFileHandle: async (name, options) => {
        if (!files.has(name) && options?.create !== true) throw new Error("not found");
        if (!files.has(name)) files.set(name, "");
        return fileHandle(name);
      },
    },
  };
}

async function seedLossyHistory(): Promise<void> {
  const db = await getDatabase();
  const account = { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" };
  await saveSettings({ boundAccount: account });
  const parsed: ParsedWork = {
    id: "1", type: "illust", contentType: "illustration", description: "", title: "One", seriesTitle: null,
    publishedAt: "2026-01-01T00:00:00.000Z", wordCount: null, pageCount: 1, isAi: false, isR18: false,
    thumbnailUrl: null, workUrl: "https://www.pixiv.net/artworks/1",
    metrics: { likes: 1, bookmarks: 1, views: 30, comments: 0, rank: null, responses: 0, illustrations: 1 },
    rawLabels: {}, missingFields: [], parserVersion: 1,
  };
  const work: WorkRecord = {
    ...parsed, key: "illust-1", firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-29T00:20:00.000Z", lastObservedRunId: "latest", absentSince: null,
  };
  await db.put("works", encodeWorkDocument(work), work.key);
  await db.put("workStates", encodeWorkState(work), work.key);
  await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([{ ordinal: 0, workKey: work.key }])), "root");
  const base = Date.parse("2026-08-29T00:00:00.000Z");
  const definitions = [
    { runId: "base", at: base, metrics: { likes: 1, bookmarks: 1, views: 10, comments: 0, rank: null, responses: 0, illustrations: 1 } },
    { runId: "middle", at: base + 10 * 60_000, metrics: { views: 20 } },
    { runId: "latest", at: base + 20 * 60_000, metrics: { views: 30 } },
  ];
  for (const [runSeq, definition] of definitions.entries()) {
    await db.put("metricFrames", buildMetricFrame({
      runId: definition.runId,
      runSeq,
      collectedAt: new Date(definition.at).toISOString(),
      scope: "complete",
      parser: 1,
      quality: 1,
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: definition.metrics }],
    }));
    const run: SyncRun = {
      runId: definition.runId, trigger: "manual", startedAt: new Date(definition.at).toISOString(),
      finishedAt: new Date(definition.at).toISOString(), status: "completed", pages: 1, works: 1,
      changedWorks: 1, errorCode: null, errorMessage: null,
    };
    await db.put("syncRuns", run, run.runId);
  }
}

describe("guarded pre-compaction backup", () => {
  beforeEach(reset);
  afterEach(reset);

  it("blocks lossy thinning when no directory has been authorized", async () => {
    await seedLossyHistory();
    const before = await (await getDatabase()).getAll("metricFrames");
    const result = await runGuardedFrameCompaction(NOW);
    expect(result).toMatchObject({ pendingReason: "backup-directory-required", rewritten: 0, deleted: 0 });
    expect(await (await getDatabase()).getAll("metricFrames")).toEqual(before);
    expect(await (await getDatabase()).count("backupReceipts")).toBe(0);
  });

  it("writes and revalidates an importable JSON before applying the exact plan", async () => {
    await seedLossyHistory();
    const directory = fakeDirectory();
    const first = await runGuardedFrameCompaction(NOW, { directory: directory.handle });
    expect(first).toMatchObject({ pendingReason: null, backedUpFrames: 1 });
    expect([...directory.files.keys()]).toHaveLength(1);
    expect([...directory.files.keys()][0]).toMatch(/\.json$/);
    expect(JSON.parse([...directory.files.values()][0] ?? "{}")).toMatchObject({ product: "PixivPulse", formatVersion: 5 });
    expect(await (await getDatabase()).count("backupReceipts")).toBe(1);
    const frames = await (await getDatabase()).getAll("metricFrames");
    expect(frames.find((frame) => frame.runId === "middle")).toMatchObject({ kind: "compacted", changes: [] });

    const second = await runGuardedFrameCompaction(NOW, { directory: directory.handle });
    expect(second).toMatchObject({ pendingReason: null, backedUpFrames: 0, rewritten: 0, deleted: 0 });
    expect(directory.files.size).toBe(1);
  });
});
