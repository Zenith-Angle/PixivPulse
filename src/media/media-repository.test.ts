import "fake-indexeddb/auto";
import { deleteMediaDatabase, getMediaDatabase, MEDIA_DATABASE_NAME } from "./media-database";
import { Blob as NodeBlob } from "node:buffer";
import {
  claimCoverJob,
  commitCoverDetailed,
  coverBlobKey,
  coverJobKey,
  getCoverAttempt,
  getCoverJob,
  getCoverSummary,
  getCurrentCover,
  getCurrentCoverMetadata,
  getMigrationCheckpoint,
  getMigrationJournal,
  listCoverMetadata,
  putCoverJob,
  recoverCoverJobs,
  recoverMigration,
  reconcileMedia,
  scanCoverCandidates,
  validateCoverBlob,
  writeMigrationCheckpoint,
  writeMigrationJournal,
  writeCoverAttemptMetadata,
  writeCoverManifest,
  type CoverIdentity,
} from "./media-repository";

const oldIdentity: CoverIdentity = {
  workKey: "illust-101",
  sourceUrl: "https://i.pximg.net/c/250x250/old.webp",
  pipelineVersion: 1,
  revision: 1,
  fingerprint: "old-fingerprint",
};

const newIdentity: CoverIdentity = {
  ...oldIdentity,
  sourceUrl: "https://i.pximg.net/c/250x250/new.webp",
  revision: 2,
  fingerprint: "new-fingerprint",
};

function blob(bytes: number, type = "image/webp"): Blob {
  return new NodeBlob([new Uint8Array(bytes)], { type }) as unknown as Blob;
}

async function resetMedia(): Promise<void> {
  await deleteMediaDatabase();
}

describe("media repository", () => {
  beforeEach(resetMedia);
  afterEach(resetMedia);

  it("creates an independent database and commits manifest, blob, job, and metadata as one media transaction", async () => {
    const db = await getMediaDatabase();
    expect([...db.objectStoreNames]).toEqual(["coverBlobs", "coverJobs", "coverManifest", "mediaMeta"]);
    expect(db.name).toBe(MEDIA_DATABASE_NAME);

    const result = await commitCoverDetailed({
      ...oldIdentity,
      blob: blob(4),
      width: 2,
      height: 2,
      now: "2026-09-02T00:00:00.000Z",
      lastAttemptRunId: "run-1",
      job: { ...oldIdentity, key: coverJobKey(oldIdentity), status: "completed" },
      meta: {
        kind: "migration-checkpoint",
        migrationId: "media-v1",
        migrationVersion: 1,
        sequence: 2,
        cursor: "illust-101",
        state: { imported: 1 },
      },
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.manifest).not.toHaveProperty("blob");
    expect(result.manifest.blobKey).toBe(coverBlobKey(oldIdentity));
    expect(await db.get("coverManifest", oldIdentity.workKey)).toMatchObject({
      sourceUrl: oldIdentity.sourceUrl,
      status: "ready",
      bytes: 4,
    });
    const storedBlob = await db.get("coverBlobs", result.manifest.blobKey!);
    expect(storedBlob).toBeInstanceOf(NodeBlob);
    expect(await getCoverJob(oldIdentity)).toMatchObject({ status: "completed" });
    expect(await getMigrationCheckpoint("media-v1")).toMatchObject({ sequence: 2, cursor: "illust-101" });

    const current = await getCurrentCover(oldIdentity.workKey, oldIdentity.sourceUrl);
    expect(current?.blob).toBeInstanceOf(NodeBlob);
    expect(current?.blob.size).toBe(4);
    expect(current?.bytes).toBe(4);
  });

  it("keeps summary, metadata list, and candidate scans Blob-free", async () => {
    await commitCoverDetailed({ ...oldIdentity, blob: blob(3), width: 3, height: 1 });
    const db = await getMediaDatabase();
    const originalGetAll = db.getAll.bind(db);
    const getAll = vi.spyOn(db, "getAll").mockImplementation((...args) => originalGetAll(...args));

    expect(await getCoverSummary()).toEqual({ ready: 1, failed: 0, skipped: 0, pending: 0, bytes: 3, total: 1 });
    expect(await listCoverMetadata()).toHaveLength(1);
    expect(await scanCoverCandidates([{ ...oldIdentity }])).toEqual([]);
    expect(getAll.mock.calls.every(([storeName]) => storeName === "coverManifest" || storeName === "mediaMeta")).toBe(true);
    expect(getAll.mock.calls.some(([storeName]) => storeName === "coverBlobs")).toBe(false);
    expect(await getCurrentCoverMetadata(oldIdentity.workKey)).not.toHaveProperty("blob");
  });

  it("rejects stale workers and requires an explicit observed identity to replace a source", async () => {
    await commitCoverDetailed({ ...oldIdentity, blob: blob(2), width: 1, height: 2 });

    const unguardedReplacement = await commitCoverDetailed({ ...newIdentity, blob: blob(5), width: 5, height: 1 });
    expect(unguardedReplacement).toMatchObject({ committed: false, reason: "CAS_MISMATCH" });

    const replacement = await commitCoverDetailed({
      ...newIdentity,
      expectedIdentity: oldIdentity,
      blob: blob(5),
      width: 5,
      height: 1,
    });
    expect(replacement.committed).toBe(true);
    const db = await getMediaDatabase();
    expect(await db.get("coverManifest", oldIdentity.workKey)).toMatchObject({ sourceUrl: newIdentity.sourceUrl, status: "ready" });

    const stale = await commitCoverDetailed({
      ...oldIdentity,
      expectedIdentity: oldIdentity,
      blob: blob(9),
      width: 3,
      height: 3,
    });
    expect(stale).toMatchObject({ committed: false, reason: "CAS_MISMATCH" });
    const current = await getCurrentCover(oldIdentity.workKey);
    expect(current?.sourceUrl).toBe(newIdentity.sourceUrl);
    expect(current?.blob.size).toBe(5);
  });

  it("keeps the old ready identity when a newer source attempt fails", async () => {
    await commitCoverDetailed({ ...oldIdentity, blob: blob(2), width: 1, height: 2 });
    expect(await writeCoverAttemptMetadata({
      ...newIdentity,
      status: "failed",
      runId: "run-2",
      errorCode: "NETWORK",
    })).toBe(true);
    expect(await getCurrentCoverMetadata(oldIdentity.workKey)).toMatchObject({
      sourceUrl: oldIdentity.sourceUrl,
      revision: oldIdentity.revision,
      status: "ready",
    });
    expect(await getCoverAttempt(newIdentity)).toMatchObject({ status: "failed", runId: "run-2" });
  });

  it("validates MIME, dimensions, size, and pipeline payloads before writing", async () => {
    expect(validateCoverBlob({ blob: blob(4), width: 2, height: 2 })).toMatchObject({ ok: true, mime: "image/webp" });
    expect(validateCoverBlob({ blob: blob(4, "text/plain"), width: 2, height: 2 }).ok).toBe(false);
    expect(validateCoverBlob({ blob: blob(4), width: 0, height: 2 }).ok).toBe(false);
    expect(validateCoverBlob({ blob: blob(4), width: 2, height: 2, bytes: 5 }).ok).toBe(false);
    expect(validateCoverBlob({ blob: blob(4), width: 2, height: 2, maxBytes: 3 }).ok).toBe(false);

    const failed = await commitCoverDetailed({
      ...oldIdentity,
      pipelineVersion: 0,
      blob: blob(4),
      width: 2,
      height: 2,
    });
    expect(failed).toMatchObject({ committed: false, reason: "INVALID_PIPELINE_VERSION" });
    const db = await getMediaDatabase();
    expect(await db.count("coverManifest")).toBe(0);
    expect(await db.count("coverBlobs")).toBe(0);
  });

  it("recovers expired durable jobs and resumes migration from its latest checkpoint", async () => {
    expect(await putCoverJob({ ...oldIdentity, key: coverJobKey(oldIdentity), status: "pending" })).toBe(true);
    const claimed = await claimCoverJob(coverJobKey(oldIdentity), {
      workerId: "worker-a",
      now: "2026-09-02T00:00:00.000Z",
      leaseMs: 1000,
    });
    expect(claimed).toMatchObject({ status: "claimed", attempts: 1 });
    expect(await recoverCoverJobs("2026-09-02T00:00:00.500Z")).toMatchObject({ recovered: 0 });
    const recovered = await recoverCoverJobs("2026-09-02T00:00:02.000Z");
    expect(recovered).toMatchObject({ recovered: 1, jobs: [{ status: "pending", lastErrorCode: "WORKER_RECOVERY" }] });
    expect(await getCoverJob(oldIdentity)).toMatchObject({ status: "pending", leaseToken: null });

    expect(await writeMigrationJournal({ migrationId: "migration-a", migrationVersion: 1, status: "running" })).toBe(true);
    expect(await writeMigrationCheckpoint({
      migrationId: "migration-a",
      migrationVersion: 1,
      sequence: 4,
      cursor: "work-4",
      state: { copied: 4 },
    })).toBe(true);
    expect(await writeMigrationCheckpoint({
      migrationId: "migration-a",
      migrationVersion: 1,
      sequence: 3,
      cursor: "work-3",
    })).toBe(false);
    const recovery = await recoverMigration("migration-a");
    expect(recovery).toMatchObject({ recoverable: true, resumeCursor: "work-4" });
    expect(await getMigrationJournal("migration-a")).toMatchObject({ status: "running" });
  });

  it("preserves a ready manifest when the authoritative source changes", async () => {
    const committed = await commitCoverDetailed({ ...oldIdentity, blob: blob(2), width: 1, height: 2 });
    expect(committed.committed).toBe(true);
    const db = await getMediaDatabase();
    await db.put("coverBlobs", blob(7), "orphan-blob");

    const result = await reconcileMedia({ current: [{ ...newIdentity }] });
    expect(result.crossDatabaseAtomic).toBe(false);
    expect(result.removedManifestCount).toBe(0);
    expect(result.removedBlobCount).toBe(1);
    expect(result.staleWorkKeys).toEqual([]);
    expect(result.orphanBlobKeys).toEqual(["orphan-blob"]);
    expect(await db.get("coverManifest", oldIdentity.workKey)).toMatchObject({ status: "ready", sourceUrl: oldIdentity.sourceUrl });
    expect(await db.get("coverBlobs", coverBlobKey(oldIdentity))).toBeInstanceOf(NodeBlob);
  });
});
