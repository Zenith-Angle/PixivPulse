import {
  MAX_PORTABLE_BACKUP_BYTES,
  canonicalJson,
  parsePortableBackupText,
  type PortableBackupEnvelope,
  type PortableBackupPayload,
} from "./portable-backup";
import {
  NATIVE_PORTABLE_BACKUP_FORMAT_VERSION,
  parseNativePortableBackupText,
  type NativePortableBackupEnvelope,
  type NativePortableBackupPayload,
  type PortableDocumentPreview,
} from "./portable-native";

export const PORTABLE_CSV_FORMAT_VERSION = "2" as const;
const LEGACY_CSV_FORMAT_VERSION = "1" as const;

type NativeCsvRecordType = "metadata" | "work_document" | "work_state" | "work_dictionary" | "metric_frame" | "metric_keyframe" | "analytics" | "run" | "account_follower_record";
type LegacyCsvRecordType = "metadata" | "work" | "sample" | "observation_batch" | "run" | "account_follower_sample";

interface NativeCsvMetadata {
  product: NativePortableBackupEnvelope["product"];
  formatVersion: NativePortableBackupEnvelope["formatVersion"];
  exportedAt: string;
  timeZone: NativePortableBackupEnvelope["timeZone"];
  checksum: NativePortableBackupEnvelope["checksum"];
  payload: Pick<NativePortableBackupPayload, "kind" | "account" | "settings" | "storageSchema" | "cachePolicy">;
}

interface LegacyCsvMetadata {
  product: PortableBackupEnvelope["product"];
  formatVersion: PortableBackupEnvelope["formatVersion"];
  exportedAt: string;
  timeZone: PortableBackupEnvelope["timeZone"];
  checksum: PortableBackupEnvelope["checksum"];
  payload: Pick<PortableBackupPayload, "kind" | "account" | "settings" | "cachePolicy">;
}

const CSV_HEADER = ["pixivpulse_csv_version", "record_type", "index", "payload_json"] as const;
const encoder = new TextEncoder();

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function csvRow(version: string, type: string, index: number, value: unknown): string {
  return [version, type, String(index), canonicalJson(value)].map(csvCell).join(",");
}

/** CSV remains plaintext, but carries the same native frames as JSON. */
export function portableBackupToCsv(envelope: NativePortableBackupEnvelope): string {
  const {
    workDocuments, workStates, workDictionary, metricFrames, metricKeyframes, analytics,
    runs, accountFollowerRecords, ...payloadMetadata
  } = envelope.payload;
  const metadata: NativeCsvMetadata = {
    product: envelope.product,
    formatVersion: envelope.formatVersion,
    exportedAt: envelope.exportedAt,
    timeZone: envelope.timeZone,
    checksum: envelope.checksum,
    payload: payloadMetadata,
  };
  const rows = [
    CSV_HEADER.map(csvCell).join(","),
    csvRow(PORTABLE_CSV_FORMAT_VERSION, "metadata", 0, metadata),
    csvRow(PORTABLE_CSV_FORMAT_VERSION, "work_dictionary", 0, workDictionary),
    csvRow(PORTABLE_CSV_FORMAT_VERSION, "analytics", 0, analytics),
    ...workDocuments.map((value, index) => csvRow(PORTABLE_CSV_FORMAT_VERSION, "work_document", index, value)),
    ...workStates.map((value, index) => csvRow(PORTABLE_CSV_FORMAT_VERSION, "work_state", index, value)),
    ...metricFrames.map((value, index) => csvRow(PORTABLE_CSV_FORMAT_VERSION, "metric_frame", index, value)),
    ...metricKeyframes.map((value, index) => csvRow(PORTABLE_CSV_FORMAT_VERSION, "metric_keyframe", index, value)),
    ...runs.map((value, index) => csvRow(PORTABLE_CSV_FORMAT_VERSION, "run", index, value)),
    ...accountFollowerRecords.map((value, index) => csvRow(PORTABLE_CSV_FORMAT_VERSION, "account_follower_record", index, value)),
  ];
  return `\ufeff${rows.join("\r\n")}\r\n`;
}

function parseCsvRows(text: string): string[][] {
  const normalized = text.startsWith("\ufeff") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === '"') {
      if (quoted && normalized[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
      continue;
    }
    if (!quoted && character === ",") { row.push(field); field = ""; continue; }
    if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && normalized[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = ""; continue;
    }
    field += character;
  }
  if (quoted) throw new Error("CSV 备份包含未闭合的引号");
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  while (rows.length > 0 && rows.at(-1)?.every((value) => value === "")) rows.pop();
  return rows;
}

function parseJsonCell(value: string, rowNumber: number): unknown {
  try { return JSON.parse(value); } catch { throw new Error(`CSV 备份第 ${rowNumber} 行的数据不是有效 JSON`); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRows(text: string): string[][] {
  if (encoder.encode(text).byteLength > MAX_PORTABLE_BACKUP_BYTES) throw new Error("备份文件超过 50 MiB 安全上限");
  const rows = parseCsvRows(text);
  if (rows.length < 2 || CSV_HEADER.some((value, index) => rows[0]?.[index] !== value) || rows[0]?.length !== CSV_HEADER.length) {
    throw new Error("CSV 备份表头无效");
  }
  return rows;
}

function parseNativeCsv(rows: string[][]): NativePortableBackupEnvelope {
  let metadata: NativeCsvMetadata | null = null;
  let workDictionary: unknown;
  let analytics: unknown;
  const collections: Record<Exclude<NativeCsvRecordType, "metadata" | "work_dictionary" | "analytics">, unknown[]> = {
    work_document: [], work_state: [], metric_frame: [], metric_keyframe: [], run: [], account_follower_record: [],
  };
  const singletons = new Set<NativeCsvRecordType>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const rowNumber = rowIndex + 1;
    if (row.length !== CSV_HEADER.length) throw new Error(`CSV 备份第 ${rowNumber} 行列数无效`);
    const [version, typeValue, indexValue, json] = row;
    if (version !== PORTABLE_CSV_FORMAT_VERSION || !/^(metadata|work_document|work_state|work_dictionary|metric_frame|metric_keyframe|analytics|run|account_follower_record)$/.test(typeValue!)) {
      throw new Error(`CSV 备份第 ${rowNumber} 行记录类型无效`);
    }
    const type = typeValue as NativeCsvRecordType;
    const parsedIndex = Number(indexValue);
    const value = parseJsonCell(json!, rowNumber);
    if (type === "metadata" || type === "work_dictionary" || type === "analytics") {
      if (parsedIndex !== 0 || singletons.has(type)) throw new Error("CSV 备份单例记录无效或重复");
      singletons.add(type);
      if (type === "metadata") {
        if (!isRecord(value)) throw new Error("CSV 备份元数据无效");
        metadata = value as unknown as NativeCsvMetadata;
      } else if (type === "work_dictionary") workDictionary = value;
      else analytics = value;
      continue;
    }
    const collection = collections[type];
    if (!Number.isSafeInteger(parsedIndex) || parsedIndex !== collection.length) throw new Error(`CSV 备份第 ${rowNumber} 行索引不连续`);
    collection.push(value);
  }
  if (!metadata || !isRecord(metadata.payload) || workDictionary === undefined || analytics === undefined) throw new Error("CSV 备份缺少原生元数据");
  return {
    product: metadata.product,
    formatVersion: metadata.formatVersion,
    exportedAt: metadata.exportedAt,
    timeZone: metadata.timeZone,
    checksum: metadata.checksum,
    payload: {
      ...metadata.payload,
      workDocuments: collections.work_document as NativePortableBackupPayload["workDocuments"],
      workStates: collections.work_state as NativePortableBackupPayload["workStates"],
      workDictionary: workDictionary as NativePortableBackupPayload["workDictionary"],
      metricFrames: collections.metric_frame as NativePortableBackupPayload["metricFrames"],
      metricKeyframes: collections.metric_keyframe as NativePortableBackupPayload["metricKeyframes"],
      analytics: analytics as NativePortableBackupPayload["analytics"],
      runs: collections.run as NativePortableBackupPayload["runs"],
      accountFollowerRecords: collections.account_follower_record as NativePortableBackupPayload["accountFollowerRecords"],
    },
  };
}

function parseLegacyCsv(rows: string[][]): PortableBackupEnvelope {
  let metadata: LegacyCsvMetadata | null = null;
  const collections: Record<Exclude<LegacyCsvRecordType, "metadata">, unknown[]> = {
    work: [], sample: [], observation_batch: [], run: [], account_follower_sample: [],
  };
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const rowNumber = rowIndex + 1;
    if (row.length !== CSV_HEADER.length) throw new Error(`CSV 备份第 ${rowNumber} 行列数无效`);
    const [version, typeValue, indexValue, json] = row;
    if (version !== LEGACY_CSV_FORMAT_VERSION || !/^(metadata|work|sample|observation_batch|run|account_follower_sample)$/.test(typeValue!)) {
      throw new Error(`CSV 备份第 ${rowNumber} 行记录类型无效`);
    }
    const type = typeValue as LegacyCsvRecordType;
    const parsedIndex = Number(indexValue);
    const value = parseJsonCell(json!, rowNumber);
    if (type === "metadata") {
      if (metadata || parsedIndex !== 0 || !isRecord(value)) throw new Error("CSV 备份元数据无效或重复");
      metadata = value as unknown as LegacyCsvMetadata;
      continue;
    }
    const collection = collections[type];
    if (!Number.isSafeInteger(parsedIndex) || parsedIndex !== collection.length) throw new Error(`CSV 备份第 ${rowNumber} 行索引不连续`);
    collection.push(value);
  }
  if (!metadata || !isRecord(metadata.payload)) throw new Error("CSV 备份缺少元数据");
  return {
    product: metadata.product,
    formatVersion: metadata.formatVersion,
    exportedAt: metadata.exportedAt,
    timeZone: metadata.timeZone,
    checksum: metadata.checksum,
    payload: {
      ...metadata.payload,
      works: collections.work as PortableBackupPayload["works"],
      samples: collections.sample as PortableBackupPayload["samples"],
      observationBatches: collections.observation_batch as PortableBackupPayload["observationBatches"],
      runs: collections.run as PortableBackupPayload["runs"],
      accountFollowerSamples: collections.account_follower_sample as NonNullable<PortableBackupPayload["accountFollowerSamples"]>,
    },
  };
}

export function portableBackupFromCsv(text: string): NativePortableBackupEnvelope | PortableBackupEnvelope {
  const rows = validateRows(text);
  const version = rows[1]?.[0];
  if (version === PORTABLE_CSV_FORMAT_VERSION) return parseNativeCsv(rows);
  if (version === LEGACY_CSV_FORMAT_VERSION) return parseLegacyCsv(rows);
  throw new Error("不支持这个 CSV 备份版本");
}

export async function parsePortableBackupDocument(
  text: string,
  options: { localAccountId?: string | null; localIsEmpty?: boolean } = {},
): Promise<PortableDocumentPreview> {
  const normalized = text.startsWith("\ufeff") ? text.slice(1) : text;
  const json = normalized.trimStart().startsWith("{") ? normalized : JSON.stringify(portableBackupFromCsv(text));
  let formatVersion: unknown;
  try { formatVersion = (JSON.parse(json) as { formatVersion?: unknown }).formatVersion; } catch { /* detailed parser error follows */ }
  if (formatVersion === NATIVE_PORTABLE_BACKUP_FORMAT_VERSION) return parseNativePortableBackupText(json, options);
  const legacy = await parsePortableBackupText(json, options);
  return {
    envelope: legacy.envelope,
    logicalPayload: legacy.envelope.payload,
    warnings: legacy.warnings,
    accountMatch: legacy.accountMatch,
    counts: { ...legacy.counts, metricFrames: 0, metricKeyframes: 0 },
    native: false,
  };
}
