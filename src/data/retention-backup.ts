import type { IDBPDatabase } from "idb";
import type { MetricFrame } from "../domain/metric-frames";
import type { AccountFollowerSample, SyncRun, WorkRecord } from "../domain/types";
import {
  buildMetricFrameCompactionPlan,
  metricFrameDigest,
  metricFrameIdentity,
  type FrameCompactionResult,
} from "./frame-storage";
import { getDatabase, type PixivPulseSchema } from "./database";
import { decodeWorkDictionary, type StoredWorkDictionary } from "./metric-frame-codec";
import { decodeWorkDocument, decodeWorkState, materializeWorkRecord } from "./storage-codec";
import { getSettings } from "./local-state";
import { parsePortableBackupDocument } from "./portable-backup-csv";
import {
  createPreCompactionBackup,
  writeAndVerifyPreCompactionBackup,
  type PreCompactionFrameSource,
} from "./pre-compaction-backup";
import {
  readBackupDirectoryConfig,
  recordBackupError,
  recordBackupSuccess,
  requireGrantedBackupDirectory,
} from "./backup-directory";
import type { BackupDirectoryHandleLike, BackupReceipt } from "./backup-types";

export type PreCompactionPendingReason = "backup-directory-required" | "backup-verification-failed" | null;

export interface GuardedFrameCompactionResult extends FrameCompactionResult {
  backedUpFrames: number;
  backupFileName: string | null;
  pendingReason: PreCompactionPendingReason;
}

interface BackupSnapshot {
  frames: MetricFrame[];
  dictionary: StoredWorkDictionary;
  works: WorkRecord[];
  runs: SyncRun[];
  followerSamples: AccountFollowerSample[];
}

function receiptKey(identity: string, digest: string): string {
  return `${identity}\u0000${digest}`;
}

function sourceFor(frame: MetricFrame): PreCompactionFrameSource {
  return { identity: metricFrameIdentity(frame), digest: metricFrameDigest(frame), frame };
}

function backupFileName(now: string | number | Date, checksum: string): string {
  const timestamp = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  const safeTimestamp = new Date(Number.isFinite(timestamp) ? timestamp : Date.now())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `pixivpulse-pre-thinning-${safeTimestamp}-${checksum.slice(0, 12)}.json`;
}

async function readSnapshot(db: IDBPDatabase<PixivPulseSchema>): Promise<BackupSnapshot> {
  const tx = db.transaction([
    "metricFrames", "workDictionary", "works", "workStates", "syncRuns", "accountFollowerRecords",
  ], "readonly");
  const [frames, dictionary, documents, states, runs, followerRecords] = await Promise.all([
    tx.objectStore("metricFrames").getAll(),
    tx.objectStore("workDictionary").get("root"),
    tx.objectStore("works").getAll(),
    tx.objectStore("workStates").getAll(),
    tx.objectStore("syncRuns").getAll(),
    tx.objectStore("accountFollowerRecords").getAll(),
  ]);
  await tx.done;
  if (!dictionary) throw new Error("本地作品字典缺失，无法生成抽稀前备份");
  decodeWorkDictionary(dictionary);
  const stateByKey = new Map(states.map((state) => [state.key, decodeWorkState(state)]));
  const works = documents.map((document) => {
    const decoded = decodeWorkDocument(document);
    return materializeWorkRecord(decoded, stateByKey.get(decoded.key));
  });
  const completedRunIds = new Set(runs.filter((run) => run.status === "completed").map((run) => run.runId));
  const followerSamples = followerRecords
    .filter((record) => record.status === "ready" && record.followers != null && completedRunIds.has(record.runId))
    .map((record): AccountFollowerSample => ({
      runId: record.runId,
      accountId: record.accountId,
      collectedAt: record.collectedAt,
      followers: record.followers as number,
    }));
  return { frames, dictionary, works, runs, followerSamples };
}

async function receiptsForSources(
  db: IDBPDatabase<PixivPulseSchema>,
  sources: readonly PreCompactionFrameSource[],
): Promise<Map<string, BackupReceipt>> {
  const result = new Map<string, BackupReceipt>();
  const tx = db.transaction("backupReceipts", "readonly");
  for (const source of sources) {
    const key = receiptKey(source.identity, source.digest);
    const receipt = await tx.store.get(key);
    if (receipt) result.set(key, receipt);
  }
  await tx.done;
  return result;
}

async function validateReceiptFiles(
  directory: BackupDirectoryHandleLike,
  receipts: readonly BackupReceipt[],
): Promise<Set<string>> {
  const byFile = new Map<string, BackupReceipt[]>();
  for (const receipt of receipts) {
    const rows = byFile.get(receipt.fileName) ?? [];
    rows.push(receipt);
    byFile.set(receipt.fileName, rows);
  }
  const verified = new Set<string>();
  for (const [fileName, rows] of byFile) {
    const handle = await directory.getFileHandle(fileName, { create: false });
    const text = await (await handle.getFile()).text();
    const preview = await parsePortableBackupDocument(text);
    if (preview.native || preview.envelope.formatVersion !== 5) throw new Error(`备份文件格式不匹配：${fileName}`);
    const checksum = preview.envelope.checksum.value;
    if (rows.some((row) => row.fileChecksum !== checksum)) throw new Error(`备份文件校验和不匹配：${fileName}`);
    const actualRunIds = new Set(preview.logicalPayload.runs.map((run) => run.runId));
    const expectedRunIds = new Set(rows.map((row) => row.runId));
    if (actualRunIds.size !== expectedRunIds.size || [...expectedRunIds].some((runId) => !actualRunIds.has(runId))) {
      throw new Error(`备份文件来源清单不匹配：${fileName}`);
    }
    for (const row of rows) verified.add(row.key);
  }
  return verified;
}

async function writeMissingBackup(
  db: IDBPDatabase<PixivPulseSchema>,
  snapshot: BackupSnapshot,
  sources: readonly PreCompactionFrameSource[],
  now: string | number | Date,
  directory?: BackupDirectoryHandleLike,
): Promise<{ fileName: string; receipts: BackupReceipt[] }> {
  const settings = await getSettings();
  const target = directory ?? (await requireGrantedBackupDirectory()).directoryHandle;
  const exportedAt = new Date(now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now).toISOString();
  const generated = await createPreCompactionBackup({
    account: settings.boundAccount ?? null,
    settings,
    works: snapshot.works,
    runs: snapshot.runs,
    accountFollowerSamples: snapshot.followerSamples,
    storedDictionary: snapshot.dictionary,
    allFrames: snapshot.frames,
    sources,
  }, exportedAt);
  const fileName = backupFileName(now, generated.checksum);
  await writeAndVerifyPreCompactionBackup(target, fileName, generated);
  const backedAt = new Date().toISOString();
  const receipts: BackupReceipt[] = generated.manifest.sources.map((source) => ({
    key: receiptKey(source.identity, source.digest),
    frameIdentity: source.identity,
    frameDigest: source.digest,
    runId: source.runId,
    fileName,
    fileChecksum: generated.checksum,
    backedAt,
  }));
  const tx = db.transaction("backupReceipts", "readwrite");
  for (const receipt of receipts) await tx.store.put(receipt);
  await tx.done;
  await recordBackupSuccess(fileName, backedAt);
  return { fileName, receipts };
}

async function applyVerifiedPlan(
  db: IDBPDatabase<PixivPulseSchema>,
  now: string | number | Date,
  verifiedReceiptKeys: ReadonlySet<string>,
): Promise<FrameCompactionResult> {
  const tx = db.transaction(["metricFrames", "backupReceipts", "storageMeta"], "readwrite");
  try {
    const frames = await tx.objectStore("metricFrames").getAll();
    const plan = buildMetricFrameCompactionPlan(frames, now);
    for (const frame of plan.lossySources) {
      const identity = metricFrameIdentity(frame);
      const digest = metricFrameDigest(frame);
      const key = receiptKey(identity, digest);
      const receipt = await tx.objectStore("backupReceipts").get(key);
      if (!receipt || receipt.frameIdentity !== identity || receipt.frameDigest !== digest || !verifiedReceiptKeys.has(key)) {
        throw new Error("抽稀事务发现尚未复验的新数据，已保留全部原始记录");
      }
    }
    for (const entry of plan.deletes) await tx.objectStore("metricFrames").delete(entry.key);
    for (const rewrite of plan.rewrites) await tx.objectStore("metricFrames").put(rewrite.frame);
    if (plan.deletes.length > 0 || plan.rewrites.length > 0) {
      const meta = await tx.objectStore("storageMeta").get("root");
      await tx.objectStore("storageMeta").put({ key: "root", dataRevision: (meta?.dataRevision ?? 0) + 1 });
    }
    await tx.done;
    return { considered: plan.considered, rewritten: plan.rewrites.length, deleted: plan.deletes.length };
  } catch (error) {
    try { tx.abort(); } catch { /* already completed or aborting */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export async function getPendingPreCompactionCount(now: string | number | Date = Date.now()): Promise<number> {
  const frames = await (await getDatabase()).getAll("metricFrames");
  return buildMetricFrameCompactionPlan(frames, now).lossySources.length;
}

export async function runGuardedFrameCompaction(
  now: string | number | Date = Date.now(),
  options: { directory?: BackupDirectoryHandleLike } = {},
): Promise<GuardedFrameCompactionResult> {
  const db = await getDatabase();
  const snapshot = await readSnapshot(db);
  const initialPlan = buildMetricFrameCompactionPlan(snapshot.frames, now);
  if (initialPlan.considered === 0) {
    return { considered: 0, rewritten: 0, deleted: 0, backedUpFrames: 0, backupFileName: null, pendingReason: null };
  }
  const sources = initialPlan.lossySources.map(sourceFor);
  if (sources.length === 0) {
    const applied = await applyVerifiedPlan(db, now, new Set());
    return { ...applied, backedUpFrames: 0, backupFileName: null, pendingReason: null };
  }

  const config = await readBackupDirectoryConfig();
  if (!config && !options.directory) {
    return { considered: initialPlan.considered, rewritten: 0, deleted: 0, backedUpFrames: 0, backupFileName: null, pendingReason: "backup-directory-required" };
  }

  try {
    const existing = await receiptsForSources(db, sources);
    const missing = sources.filter((source) => !existing.has(receiptKey(source.identity, source.digest)));
    let backupFile: string | null = null;
    let backedUpFrames = 0;
    if (missing.length > 0) {
      const written = await writeMissingBackup(db, snapshot, missing, now, options.directory);
      backupFile = written.fileName;
      backedUpFrames = written.receipts.length;
      for (const receipt of written.receipts) existing.set(receipt.key, receipt);
    }
    const directory = options.directory ?? (await requireGrantedBackupDirectory()).directoryHandle;
    const reliedUpon = sources.map((source) => existing.get(receiptKey(source.identity, source.digest)))
      .filter((receipt): receipt is BackupReceipt => receipt != null);
    if (reliedUpon.length !== sources.length) throw new Error("抽稀前备份收据不完整");
    const verified = await validateReceiptFiles(directory, reliedUpon);
    const applied = await applyVerifiedPlan(db, now, verified);
    return { ...applied, backedUpFrames, backupFileName: backupFile, pendingReason: null };
  } catch (error) {
    await recordBackupError(error).catch(() => undefined);
    return {
      considered: initialPlan.considered,
      rewritten: 0,
      deleted: 0,
      backedUpFrames: 0,
      backupFileName: null,
      pendingReason: "backup-verification-failed",
    };
  }
}
