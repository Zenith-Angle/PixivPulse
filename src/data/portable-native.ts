import type { IDBPDatabase } from "idb";
import type { MetricFrame, MetricKeyframe } from "../domain/metric-frames";
import type {
  AccountFollowerRecord,
  AccountFollowerSample,
  AppSettings,
  PixivAccount,
  SyncRun,
  WorkDocument,
  WorkRecord,
  WorkState,
} from "../domain/types";
import type { PixivPulseSchema } from "./database";
import { getDatabase } from "./database";
import { decodePublicFrameHistory } from "./frame-storage";
import {
  decodeMetricFrame,
  decodeMetricKeyframe,
  decodeWorkDictionary,
  encodeMetricFrame,
  encodeMetricKeyframe,
  encodeWorkDictionary,
  unpackMetricOrdinals,
  type StoredWorkDictionary,
} from "./metric-frame-codec";
import {
  MAX_PORTABLE_BACKUP_BYTES,
  MAX_PORTABLE_FOLLOWER_SAMPLES,
  MAX_PORTABLE_RUNS,
  MAX_PORTABLE_WORKS,
  canonicalJson,
  portableSettings,
  sha256Hex,
  type PortableBackupPayload,
  type PortableSettings,
} from "./portable-backup";
import { decodeWorkDocument, decodeWorkState, materializeWorkRecord } from "./storage-codec";

export const NATIVE_PORTABLE_BACKUP_FORMAT_VERSION = 6 as const;
export const NATIVE_PORTABLE_STORAGE_SCHEMA = "metric-frames-v1" as const;
export const MAX_PORTABLE_FRAMES = 500_000;
export const MAX_PORTABLE_KEYFRAMES = 50_000;

export interface NativePortableAnalyticsState {
  activeSchema: "frames";
  nextRunSeq: number;
}

export interface NativePortableBackupPayload {
  kind: "full";
  account: PixivAccount | null;
  settings: PortableSettings;
  storageSchema: typeof NATIVE_PORTABLE_STORAGE_SCHEMA;
  workDocuments: WorkDocument[];
  workStates: WorkState[];
  workDictionary: StoredWorkDictionary;
  metricFrames: MetricFrame[];
  metricKeyframes: MetricKeyframe[];
  analytics: NativePortableAnalyticsState;
  runs: SyncRun[];
  accountFollowerRecords: AccountFollowerRecord[];
  cachePolicy: "regenerate-covers";
}

export interface NativePortableBackupEnvelope {
  product: "PixivPulse";
  formatVersion: typeof NATIVE_PORTABLE_BACKUP_FORMAT_VERSION;
  exportedAt: string;
  timeZone: "Asia/Shanghai";
  payload: NativePortableBackupPayload;
  checksum: { algorithm: "SHA-256"; value: string };
}

export interface PortableDocumentPreview {
  envelope: NativePortableBackupEnvelope | import("./portable-backup").PortableBackupEnvelope;
  logicalPayload: PortableBackupPayload;
  warnings: string[];
  accountMatch: "empty-local" | "same" | "mismatch";
  counts: {
    works: number;
    samples: number;
    observationBatches: number;
    runs: number;
    accountFollowerSamples: number;
    metricFrames: number;
    metricKeyframes: number;
  };
  native: boolean;
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkedArray<T>(value: unknown, label: string, maximum: number): T[] {
  if (!Array.isArray(value)) throw new Error(`备份缺少${label}`);
  if (value.length > maximum) throw new Error(`${label}数量超过安全上限`);
  return value as T[];
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
  return value;
}

function validAccount(value: unknown): PixivAccount | null {
  if (value == null) return null;
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string") {
    throw new Error("备份账号信息无效");
  }
  const profileUrl = typeof value.profileUrl === "string" ? value.profileUrl : `https://www.pixiv.net/users/${value.id}`;
  if (profileUrl !== `https://www.pixiv.net/users/${value.id}`) throw new Error("备份账号主页无效");
  return { id: value.id, name: value.name, profileUrl };
}

function accountMatch(account: PixivAccount | null, options: { localAccountId?: string | null; localIsEmpty?: boolean }): PortableDocumentPreview["accountMatch"] {
  return options.localIsEmpty === true || !options.localAccountId
    ? "empty-local"
    : account?.id === options.localAccountId ? "same" : "mismatch";
}

function validateRuns(value: unknown): SyncRun[] {
  const runs = checkedArray<SyncRun>(value, "同步记录", MAX_PORTABLE_RUNS);
  const ids = new Set<string>();
  for (const run of runs) {
    if (!isRecord(run) || typeof run.runId !== "string" || !run.runId || ids.has(run.runId)) {
      throw new Error("备份同步记录标识缺失或重复");
    }
    ids.add(run.runId);
  }
  return runs.map((run) => ({ ...run }));
}

function validateFollowerRecords(value: unknown, account: PixivAccount | null, runs: readonly SyncRun[]): AccountFollowerRecord[] {
  const records = checkedArray<AccountFollowerRecord>(value, "粉丝记录", MAX_PORTABLE_FOLLOWER_SAMPLES);
  const completedRuns = new Set(runs.filter((run) => run.status === "completed").map((run) => run.runId));
  const ids = new Set<string>();
  for (const record of records) {
    if (!isRecord(record) || typeof record.runId !== "string" || !record.runId || ids.has(record.runId)
      || record.status !== "ready" || typeof record.accountId !== "string" || !record.accountId
      || !Number.isSafeInteger(record.followers) || (record.followers ?? -1) < 0
      || typeof record.collectedAt !== "string" || !Number.isFinite(Date.parse(record.collectedAt))) {
      throw new Error("备份粉丝记录字段无效");
    }
    if (!account || record.accountId !== account.id) throw new Error("备份粉丝记录账号不一致");
    if (!completedRuns.has(record.runId)) throw new Error("备份粉丝记录引用了未完成的同步记录");
    ids.add(record.runId);
  }
  return records.map((record) => ({ ...record, followers: record.followers as number, errorCode: null }));
}

function validateNativePayload(value: unknown): { payload: NativePortableBackupPayload; logicalPayload: PortableBackupPayload } {
  if (!isRecord(value) || value.kind !== "full" || value.storageSchema !== NATIVE_PORTABLE_STORAGE_SCHEMA
    || value.cachePolicy !== "regenerate-covers") {
    throw new Error("备份数据结构无效");
  }
  const account = validAccount(value.account);
  const settings = portableSettings(isRecord(value.settings) ? value.settings as Partial<AppSettings> : {});
  const rawDocuments = checkedArray<unknown>(value.workDocuments, "作品文档", MAX_PORTABLE_WORKS);
  const rawStates = checkedArray<unknown>(value.workStates, "作品状态", MAX_PORTABLE_WORKS);
  const documents = rawDocuments.map(decodeWorkDocument);
  const states = rawStates.map((state) => decodeWorkState(state));
  const documentByKey = new Map(documents.map((document) => [document.key, document]));
  const stateByKey = new Map(states.map((state) => [state.key, state]));
  if (documentByKey.size !== documents.length || stateByKey.size !== states.length || documents.length !== states.length) {
    throw new Error("备份作品文档或状态缺失、重复");
  }
  const works: WorkRecord[] = documents.map((document) => {
    const state = stateByKey.get(document.key);
    if (!state) throw new Error(`备份缺少作品状态：${document.key}`);
    return materializeWorkRecord(document, state);
  });
  for (const key of stateByKey.keys()) if (!documentByKey.has(key)) throw new Error(`备份缺少作品文档：${key}`);

  const dictionary = decodeWorkDictionary(value.workDictionary);
  const storedDictionary = encodeWorkDictionary(dictionary);
  const ordinalSet = new Set(dictionary.entries.map((entry) => entry.ordinal));
  const frames = checkedArray<unknown>(value.metricFrames, "指标帧", MAX_PORTABLE_FRAMES).map(decodeMetricFrame);
  const keyframes = checkedArray<unknown>(value.metricKeyframes, "指标关键帧", MAX_PORTABLE_KEYFRAMES).map(decodeMetricKeyframe);
  const frameIds = new Set<string>();
  for (const frame of frames) {
    if (frameIds.has(frame.runId)) throw new Error("备份指标帧同步标识重复");
    frameIds.add(frame.runId);
    for (const ordinal of unpackMetricOrdinals(frame.observed)) if (!ordinalSet.has(ordinal)) throw new Error("备份指标帧引用了不存在的作品序号");
    for (const change of frame.changes) if (!ordinalSet.has(change[0])) throw new Error("备份指标帧引用了不存在的作品序号");
  }
  for (const keyframe of keyframes) {
    for (const state of keyframe.states) if (!ordinalSet.has(state.ordinal)) throw new Error("备份关键帧引用了不存在的作品序号");
  }
  if (!isRecord(value.analytics) || value.analytics.activeSchema !== "frames") throw new Error("备份分析架构状态无效");
  const nextRunSeq = safeInteger(value.analytics.nextRunSeq, "备份帧序列");
  const largestRunSeq = Math.max(-1, ...frames.map((frame) => frame.runSeq), ...keyframes.map((frame) => frame.runSeq));
  if (nextRunSeq <= largestRunSeq) throw new Error("备份帧序列会复用已有编号");
  const runs = validateRuns(value.runs);
  const followers = validateFollowerRecords(value.accountFollowerRecords, account, runs);
  const history = decodePublicFrameHistory(storedDictionary, frames);
  const accountFollowerSamples: AccountFollowerSample[] = followers.map((record) => ({
    runId: record.runId,
    accountId: record.accountId,
    collectedAt: record.collectedAt,
    followers: record.followers as number,
  }));
  const logicalPayload: PortableBackupPayload = {
    kind: "full",
    account,
    settings,
    works,
    samples: history.samples,
    observationBatches: history.observationBatches,
    runs,
    accountFollowerSamples,
    cachePolicy: "regenerate-covers",
  };
  return {
    payload: {
      kind: "full",
      account,
      settings,
      storageSchema: NATIVE_PORTABLE_STORAGE_SCHEMA,
      workDocuments: documents,
      workStates: states,
      workDictionary: storedDictionary,
      metricFrames: frames.map(encodeMetricFrame),
      metricKeyframes: keyframes.map(encodeMetricKeyframe),
      analytics: { activeSchema: "frames", nextRunSeq },
      runs,
      accountFollowerRecords: followers,
      cachePolicy: "regenerate-covers",
    },
    logicalPayload,
  };
}

async function checksumFor(unsigned: Omit<NativePortableBackupEnvelope, "checksum">): Promise<string> {
  return sha256Hex(canonicalJson(unsigned));
}

export async function createNativePortableBackup(
  input: { account: PixivAccount | null; settings: Partial<AppSettings> },
  exportedAt = new Date().toISOString(),
  database?: IDBPDatabase<PixivPulseSchema>,
): Promise<NativePortableBackupEnvelope> {
  const db = database ?? await getDatabase();
  const tx = db.transaction([
    "works", "workStates", "workDictionary", "metricFrames", "metricKeyframes", "analyticsSchemaState", "syncRuns", "accountFollowerRecords",
    "samples", "observationBatches",
  ], "readonly");
  const [workDocuments, workStates, storedDictionary, metricFrames, metricKeyframes, schema, runs, followerRecords, legacySamples, legacyBatches] = await Promise.all([
    tx.objectStore("works").getAll(),
    tx.objectStore("workStates").getAll(),
    tx.objectStore("workDictionary").get("root"),
    tx.objectStore("metricFrames").getAll(),
    tx.objectStore("metricKeyframes").getAll(),
    tx.objectStore("analyticsSchemaState").get("root"),
    tx.objectStore("syncRuns").getAll(),
    tx.objectStore("accountFollowerRecords").getAll(),
    tx.objectStore("samples").count(),
    tx.objectStore("observationBatches").count(),
  ]);
  await tx.done;
  if (!storedDictionary || schema?.activeSchema !== "frames" || schema.migrationStatus === "running"
    || schema.migrationStatus === "failed" || legacySamples !== 0 || legacyBatches !== 0) {
    throw new Error("本地历史尚未完全统一到最新版帧结构，已停止导出");
  }
  const unsigned: Omit<NativePortableBackupEnvelope, "checksum"> = {
    product: "PixivPulse",
    formatVersion: NATIVE_PORTABLE_BACKUP_FORMAT_VERSION,
    exportedAt: isoTimestamp(exportedAt, "导出时间"),
    timeZone: "Asia/Shanghai",
    payload: {
      kind: "full",
      account: validAccount(input.account),
      settings: portableSettings(input.settings),
      storageSchema: NATIVE_PORTABLE_STORAGE_SCHEMA,
      workDocuments: workDocuments.map(decodeWorkDocument),
      workStates: workStates.map((state) => decodeWorkState(state)),
      workDictionary: encodeWorkDictionary(decodeWorkDictionary(storedDictionary)),
      metricFrames: metricFrames.map(encodeMetricFrame),
      metricKeyframes: metricKeyframes.map(encodeMetricKeyframe),
      analytics: { activeSchema: "frames", nextRunSeq: schema.nextRunSeq },
      runs: runs.map((run) => ({ ...run })),
      accountFollowerRecords: followerRecords.filter((record) => record.status === "ready").map((record) => ({ ...record })),
      cachePolicy: "regenerate-covers",
    },
  };
  // Run the same integrity checks used on import before publishing a file.
  validateNativePayload(unsigned.payload);
  return { ...unsigned, checksum: { algorithm: "SHA-256", value: await checksumFor(unsigned) } };
}

export async function parseNativePortableBackupText(
  text: string,
  options: { localAccountId?: string | null; localIsEmpty?: boolean } = {},
): Promise<PortableDocumentPreview> {
  if (encoder.encode(text).byteLength > MAX_PORTABLE_BACKUP_BYTES) throw new Error("备份文件超过 50 MiB 安全上限");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("备份不是有效的 JSON 文件"); }
  if (!isRecord(raw) || raw.product !== "PixivPulse" || raw.formatVersion !== NATIVE_PORTABLE_BACKUP_FORMAT_VERSION
    || raw.timeZone !== "Asia/Shanghai") throw new Error("不支持这个原生备份版本");
  const exportedAt = isoTimestamp(raw.exportedAt, "备份导出时间");
  if (!isRecord(raw.checksum) || raw.checksum.algorithm !== "SHA-256" || typeof raw.checksum.value !== "string"
    || !/^[0-9a-f]{64}$/i.test(raw.checksum.value)) throw new Error("备份缺少 SHA-256 校验和");
  const { checksum: _checksum, ...unsignedRaw } = raw;
  const actual = await sha256Hex(canonicalJson(unsignedRaw));
  if (actual !== raw.checksum.value.toLowerCase()) throw new Error("备份校验失败，文件可能损坏或被修改");
  const validated = validateNativePayload(raw.payload);
  const envelope: NativePortableBackupEnvelope = {
    product: "PixivPulse",
    formatVersion: NATIVE_PORTABLE_BACKUP_FORMAT_VERSION,
    exportedAt,
    timeZone: "Asia/Shanghai",
    payload: validated.payload,
    checksum: { algorithm: "SHA-256", value: actual },
  };
  return {
    envelope,
    logicalPayload: validated.logicalPayload,
    warnings: ["缩略图缓存不随备份迁移，将按作品封面地址长期缓存"],
    accountMatch: accountMatch(validated.payload.account, options),
    counts: {
      works: validated.payload.workDocuments.length,
      samples: validated.logicalPayload.samples.length,
      observationBatches: validated.payload.metricFrames.length,
      runs: validated.payload.runs.length,
      accountFollowerSamples: validated.payload.accountFollowerRecords.length,
      metricFrames: validated.payload.metricFrames.length,
      metricKeyframes: validated.payload.metricKeyframes.length,
    },
    native: true,
  };
}

export function isNativePortableEnvelope(value: NativePortableBackupEnvelope | import("./portable-backup").PortableBackupEnvelope): value is NativePortableBackupEnvelope {
  return value.formatVersion === NATIVE_PORTABLE_BACKUP_FORMAT_VERSION;
}
