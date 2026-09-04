import { COVER_CACHE_MAX_BLOB_BYTES, COVER_CACHE_PIPELINE_VERSION } from "../domain/constants";
import type { CoverCacheSummary, CoverRecord, CoverStatus } from "../domain/types";
import { getDatabase } from "./database";
import {
  commitCover,
  coverAttemptKey,
  deleteCover,
  getCurrentCover as getMediaCover,
  getCurrentCoverMetadata,
  getMigrationJournal,
  listCoverAttempts,
  recoverMigration,
  listCoverMetadata,
  reconcileMedia,
  scanCoverCandidates as scanMediaCandidates,
  writeCoverAttemptMetadata as writeMediaCoverAttempt,
  writeCoverManifest,
  writeMigrationCheckpoint,
  writeMigrationJournal,
  type CoverIdentity,
  type CoverSourceSnapshot,
} from "../media/media-repository";
import { deleteMediaDatabase } from "../media/media-database";

const MIGRATION_ID = "legacy-covers-v1";
let migrationPromise: Promise<void> | null = null;

function sourceFingerprint(sourceUrl: string, pipelineVersion: number): string {
  return `${sourceUrl}|${pipelineVersion}|1`;
}

function identityOf(workKey: string, sourceUrl: string, pipelineVersion: number, revision = 1): CoverIdentity {
  return { workKey, sourceUrl, pipelineVersion, revision, fingerprint: `${sourceUrl}|${pipelineVersion}|${revision}` };
}

function isValidSource(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLocaleLowerCase() === "i.pximg.net";
  } catch {
    return false;
  }
}

async function migrateLegacyCovers(): Promise<void> {
  const completed = await getMigrationJournal(MIGRATION_ID);
  if (completed?.status === "completed") return;
  const startedAt = new Date().toISOString();
  await writeMigrationJournal({ migrationId: MIGRATION_ID, migrationVersion: 1, status: "running", startedAt });
  try {
    const db = await getDatabase();
    const records = (await db.getAll("covers")).sort((left, right) => left.workKey.localeCompare(right.workKey));
    const recovery = await recoverMigration(MIGRATION_ID);
    const startIndex = recovery.resumeCursor == null
      ? 0
      : Math.max(0, records.findIndex((record) => record.workKey === recovery.resumeCursor) + 1);
    let sequence = recovery.checkpoint?.sequence ?? 0;
    for (const record of records.slice(startIndex)) {
      sequence += 1;
      if (!record || record.key !== record.workKey || !isValidSource(record.sourceUrl)) continue;
      const existing = await getCurrentCoverMetadata(record.workKey);
      const revision = existing && existing.sourceUrl !== record.sourceUrl ? existing.revision + 1 : existing?.revision ?? 1;
      const identity = identityOf(record.workKey, record.sourceUrl, record.pipelineVersion || COVER_CACHE_PIPELINE_VERSION, revision);
      const expectedIdentity = existing ?? null;
      if (record.status === "ready" && record.blob instanceof Blob && record.width > 0 && record.height > 0 && record.bytes > 0) {
        await commitCover({
          ...identity,
          blob: record.blob,
          width: record.width,
          height: record.height,
          bytes: record.bytes,
          attemptedAt: record.attemptedAt,
          lastAttemptRunId: record.lastAttemptRunId,
          maxBytes: COVER_CACHE_MAX_BLOB_BYTES,
          expectedIdentity,
        });
      } else if (record.status !== "ready") {
        await writeCoverManifest({
          ...identity,
          status: record.status,
          attemptedAt: record.attemptedAt,
          lastAttemptRunId: record.lastAttemptRunId,
          errorCode: record.errorCode ?? null,
          expectedIdentity,
        });
      }
      await writeMigrationCheckpoint({
        migrationId: MIGRATION_ID,
        migrationVersion: 1,
        sequence,
        cursor: record.workKey,
        state: { migrated: sequence },
      });
    }
    await writeMigrationJournal({
      migrationId: MIGRATION_ID,
      migrationVersion: 1,
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      details: { records: records.length },
    });
  } catch (error) {
    await writeMigrationJournal({
      migrationId: MIGRATION_ID,
      migrationVersion: 1,
      status: "failed",
      startedAt,
      errorCode: error instanceof Error ? error.name : "MIGRATION_FAILED",
    }).catch(() => false);
    throw error;
  }
}

export function ensureCoverMediaMigration(): Promise<void> {
  if (!migrationPromise) migrationPromise = migrateLegacyCovers().catch((error) => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
}

export async function readBridgedCover(workKey: string, sourceUrl?: string | null): Promise<CoverRecord | null> {
  await ensureCoverMediaMigration();
  const current = await getMediaCover(workKey, { sourceUrl, pipelineVersion: COVER_CACHE_PIPELINE_VERSION });
  if (current) return asCoverRecord(current);
  // A changed source may be refreshing while the previous ready value remains
  // authoritative for display. The lookup intentionally omits sourceUrl.
  const fallback = await getMediaCover(workKey, { pipelineVersion: COVER_CACHE_PIPELINE_VERSION });
  if (fallback) return asCoverRecord(fallback);
  const legacy = await (await getDatabase()).get("covers", workKey);
  if (!legacy) return null;
  if (sourceUrl === undefined || legacy.sourceUrl === sourceUrl) return legacy;
  return legacy.status === "ready" ? legacy : null;
}

export interface BridgedCoverWrite {
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  revision?: number;
  fingerprint?: string;
  lastAttemptRunId: string;
  status: CoverStatus;
  blob?: Blob;
  width?: number;
  height?: number;
  bytes?: number;
  attemptedAt?: string;
  errorCode?: string;
}

function asCoverRecord(current: Awaited<ReturnType<typeof getMediaCover>>): CoverRecord | null {
  if (!current) return null;
  return {
    key: current.workKey,
    workKey: current.workKey,
    sourceUrl: current.sourceUrl,
    pipelineVersion: current.pipelineVersion,
    lastAttemptRunId: current.lastAttemptRunId ?? "media",
    status: current.status as CoverStatus,
    blob: current.blob,
    width: current.width,
    height: current.height,
    bytes: current.bytes,
    attemptedAt: current.attemptedAt,
    ...(current.errorCode ? { errorCode: current.errorCode } : {}),
  };
}

export async function writeBridgedCover(input: BridgedCoverWrite): Promise<boolean> {
  await ensureCoverMediaMigration();
  const existing = await getCurrentCoverMetadata(input.workKey);
  const sourceChanged = existing != null
    && (existing.sourceUrl !== input.sourceUrl || existing.pipelineVersion !== input.pipelineVersion);
  // A replacement must carry the identity assigned by the candidate scan.
  // Old queue rows have no identity and may only update the same source.
  if (sourceChanged && (input.revision === undefined || input.fingerprint === undefined)) {
    return false;
  }
  // Two different sources can be scanned from the same predecessor revision.
  // Once either wins, the other identity is stale even if the work URL later
  // flips back. A legitimate replacement will be scanned at the next revision.
  if (sourceChanged && existing != null && input.revision! <= existing.revision) {
    return false;
  }
  const revision = input.revision ?? existing?.revision ?? 1;
  const identity: CoverIdentity = {
    ...identityOf(input.workKey, input.sourceUrl, input.pipelineVersion, revision),
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
  };
  const expectedIdentity = existing ?? null;
  if (input.status === "ready") {
    if (!(input.blob instanceof Blob)) return false;
    return commitCover({
      ...identity,
      blob: input.blob,
      width: input.width ?? 0,
      height: input.height ?? 0,
      bytes: input.bytes,
      attemptedAt: input.attemptedAt,
      lastAttemptRunId: input.lastAttemptRunId,
      maxBytes: COVER_CACHE_MAX_BLOB_BYTES,
      expectedIdentity,
    });
  }
  // Failed and capacity-limited refreshes are attempts for the new identity;
  // they must not replace the last durable ready manifest or Blob.
  if (existing?.status === "ready"
    && existing.sourceUrl === identity.sourceUrl
    && existing.pipelineVersion === identity.pipelineVersion
    && existing.revision === identity.revision
    && existing.fingerprint === identity.fingerprint) {
    return false;
  }
  return writeMediaCoverAttempt({
    ...identity,
    status: input.status,
    runId: input.lastAttemptRunId,
    attemptedAt: input.attemptedAt,
    errorCode: input.errorCode ?? null,
  });
}

interface CurrentCoverSources {
  sources: CoverSourceSnapshot[];
  byWorkKey: Map<string, CoverIdentity | null>;
}

async function currentCoverSources(): Promise<CurrentCoverSources> {
  const works = await (await getDatabase()).getAll("works");
  const [manifestRows, attemptRows] = await Promise.all([listCoverMetadata(), listCoverAttempts()]);
  const manifests = new Map(manifestRows.map((manifest) => [manifest.workKey, manifest]));
  const latestIdentity = new Map<string, CoverIdentity>();
  for (const manifest of manifestRows) latestIdentity.set(manifest.workKey, manifest);
  for (const attempt of attemptRows) {
    const current = latestIdentity.get(attempt.workKey);
    if (!current || attempt.revision >= current.revision) latestIdentity.set(attempt.workKey, attempt);
  }
  const sources: CoverSourceSnapshot[] = [];
  const byWorkKey = new Map<string, CoverIdentity | null>();
  for (const work of works) {
    if (!isValidSource(work.thumbnailUrl)) {
      byWorkKey.set(work.key, null);
      continue;
    }
    const latest = latestIdentity.get(work.key);
    const sameAsLatest = latest?.sourceUrl === work.thumbnailUrl
      && latest.pipelineVersion === COVER_CACHE_PIPELINE_VERSION;
    const revision = sameAsLatest ? latest.revision : (latest?.revision ?? 0) + 1;
    const source = {
      workKey: work.key,
      sourceUrl: work.thumbnailUrl!,
      pipelineVersion: COVER_CACHE_PIPELINE_VERSION,
      revision,
      fingerprint: sameAsLatest ? latest.fingerprint : `${work.thumbnailUrl}|${COVER_CACHE_PIPELINE_VERSION}|${revision}`,
    };
    sources.push(source);
    byWorkKey.set(work.key, source);
  }
  return { sources, byWorkKey };
}

async function currentSources(): Promise<CoverSourceSnapshot[]> {
  return (await currentCoverSources()).sources;
}

export async function scanBridgedCoverCandidates(runId: string | null, limit?: number): Promise<Array<{
  key: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  revision: number;
  fingerprint: string;
}>> {
  await ensureCoverMediaMigration();
  return scanMediaCandidates(await currentSources(), { runId, pipelineVersion: COVER_CACHE_PIPELINE_VERSION, limit });
}

export async function summarizeBridgedCovers(runId?: string | null): Promise<CoverCacheSummary> {
  await ensureCoverMediaMigration();
  const sources = await currentSources();
  const manifests = new Map((await listCoverMetadata()).map((manifest) => [manifest.workKey, manifest]));
  const attempts = new Map((await listCoverAttempts()).map((attempt) => [attempt.key, attempt]));
  const summary: CoverCacheSummary = { ready: 0, failed: 0, skipped: 0, pending: 0, bytes: 0, total: sources.length };
  for (const source of sources) {
    const manifest = manifests.get(source.workKey);
    const sameIdentity = manifest?.sourceUrl === source.sourceUrl
      && manifest.pipelineVersion === source.pipelineVersion
      && manifest.revision === source.revision
      && manifest.fingerprint === source.fingerprint;
    if (!sameIdentity) {
      const attempt = attempts.get(coverAttemptKey(source));
      if (attempt && (runId == null || attempt.runId === runId)) {
        if (attempt.status === "failed") summary.failed += 1;
        else summary.skipped += 1;
      } else {
        summary.pending += 1;
      }
    } else if (manifest.status === "ready") {
      summary.ready += 1;
      summary.bytes += manifest.bytes;
    } else if (runId != null && manifest.lastAttemptRunId !== runId) {
      summary.pending += 1;
    } else if (manifest.status === "failed") summary.failed += 1;
    else if (manifest.status === "skipped-capacity") summary.skipped += 1;
    else summary.pending += 1;
  }
  return summary;
}

export async function cleanupBridgedCovers(): Promise<number> {
  await ensureCoverMediaMigration();
  const current = await currentCoverSources();
  const result = await reconcileMedia({ current: current.sources, currentByWorkKey: current.byWorkKey });
  return result.removedManifestCount + result.removedBlobCount;
}

export async function clearBridgedCoverData(): Promise<void> {
  migrationPromise = null;
  await deleteMediaDatabase();
}
