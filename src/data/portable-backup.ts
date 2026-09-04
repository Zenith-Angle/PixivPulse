import type {
  AccountFollowerSample,
  AppSettings,
  ObservationBatch,
  PixivAccount,
  SyncRun,
  WorkRecord,
  WorkSample,
} from "../domain/types";

export const PORTABLE_BACKUP_FORMAT_VERSION = 5 as const;
export const MAX_PORTABLE_BACKUP_BYTES = 50 * 1024 * 1024;
export const MAX_PORTABLE_WORKS = 100_000;
export const MAX_PORTABLE_SAMPLES = 2_000_000;
export const MAX_PORTABLE_BATCHES = 500_000;
export const MAX_PORTABLE_RUNS = 500_000;
export const MAX_PORTABLE_FOLLOWER_SAMPLES = 500_000;
/** Descriptive alias for callers that use the full domain name. */
export const MAX_PORTABLE_ACCOUNT_FOLLOWER_SAMPLES = MAX_PORTABLE_FOLLOWER_SAMPLES;

export interface PortableSettings {
  onboardingComplete: boolean;
  scheduledSyncEnabled: boolean;
  syncIntervalHours: number;
  showPixivChips: boolean;
  theme: AppSettings["theme"];
}

export interface PortableBackupPayload {
  kind: "full";
  account: PixivAccount | null;
  settings: PortableSettings;
  works: WorkRecord[];
  samples: WorkSample[];
  observationBatches: ObservationBatch[];
  runs: SyncRun[];
  /** Optional on the input type so v3/v4 fixtures and callers remain
   * assignable. Current v5 envelopes always materialize this as an array. */
  accountFollowerSamples?: AccountFollowerSample[];
  cachePolicy: "regenerate-covers";
}

export interface PortableBackupEnvelope {
  product: "PixivPulse";
  formatVersion: typeof PORTABLE_BACKUP_FORMAT_VERSION;
  exportedAt: string;
  timeZone: "Asia/Shanghai";
  payload: PortableBackupPayload;
  checksum: { algorithm: "SHA-256"; value: string };
}

export interface PortableBackupPreview {
  envelope: PortableBackupEnvelope;
  warnings: string[];
  accountMatch: "empty-local" | "same" | "mismatch";
  counts: { works: number; samples: number; observationBatches: number; runs: number; accountFollowerSamples: number };
}

const encoder = new TextEncoder();

export async function decodePortableBytes(bytes: Uint8Array): Promise<string> {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzip) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === "undefined" || typeof Blob.prototype.stream !== "function") {
    throw new Error("当前浏览器无法读取压缩备份");
  }
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("备份包含无效数字");
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) result[key] = stableValue(child);
    }
    return result;
  }
  throw new Error("备份包含不可序列化的数据");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checksumTarget(envelope: Omit<PortableBackupEnvelope, "checksum">): string {
  return canonicalJson(envelope);
}

export function portableSettings(settings: Partial<AppSettings> | null | undefined): PortableSettings {
  return {
    onboardingComplete: settings?.onboardingComplete === true,
    scheduledSyncEnabled: settings?.scheduledSyncEnabled === true,
    syncIntervalHours: typeof settings?.syncIntervalHours === "number" && Number.isFinite(settings.syncIntervalHours)
      ? settings.syncIntervalHours
      : 1,
    showPixivChips: settings?.showPixivChips !== false,
    theme: settings?.theme === "dark" || settings?.theme === "light" ? settings.theme : "system",
  };
}

export async function createPortableBackup(
  payload: Omit<PortableBackupPayload, "settings" | "cachePolicy" | "accountFollowerSamples"> & {
    settings: Partial<AppSettings> | PortableSettings;
    accountFollowerSamples?: AccountFollowerSample[];
    cachePolicy?: "regenerate-covers";
  },
  exportedAt = new Date().toISOString(),
): Promise<PortableBackupEnvelope> {
  const unsigned: Omit<PortableBackupEnvelope, "checksum"> = {
    product: "PixivPulse",
    formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
    exportedAt,
    timeZone: "Asia/Shanghai",
    payload: {
      ...payload,
      settings: portableSettings(payload.settings),
      accountFollowerSamples: payload.accountFollowerSamples ?? [],
      cachePolicy: "regenerate-covers",
    },
  };
  return { ...unsigned, checksum: { algorithm: "SHA-256", value: await sha256Hex(checksumTarget(unsigned)) } };
}

function validAccount(value: unknown): PixivAccount | null {
  if (value == null) return null;
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string") {
    throw new Error("备份账号信息无效");
  }
  return {
    id: value.id,
    name: value.name,
    profileUrl: typeof value.profileUrl === "string" ? value.profileUrl : `https://www.pixiv.net/users/${value.id}`,
  };
}

function checkedArray<T>(value: unknown, label: string, maximum: number): T[] {
  if (!Array.isArray(value)) throw new Error(`备份缺少${label}`);
  if (value.length > maximum) throw new Error(`${label}数量超过安全上限`);
  return value as T[];
}

function countsOf(payload: PortableBackupPayload): PortableBackupPreview["counts"] {
  return {
    works: payload.works.length,
    samples: payload.samples.length,
    observationBatches: payload.observationBatches.length,
    runs: payload.runs.length,
    accountFollowerSamples: payload.accountFollowerSamples?.length ?? 0,
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) return false;
  // Require an actual ISO date-time rather than accepting locale-dependent
  // Date.parse inputs. Both UTC and explicit numeric offsets are valid ISO.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function validateAccountFollowerSamples(
  payload: PortableBackupPayload,
  options: { requireArray?: boolean } = {},
): void {
  const samples = payload.accountFollowerSamples ?? [];
  if (options.requireArray === true && !Array.isArray(payload.accountFollowerSamples)) {
    throw new Error("备份缺少粉丝样本");
  }
  const completedRuns = new Set(
    payload.runs
      .filter((run) => run?.status === "completed" && typeof run.runId === "string")
      .map((run) => run.runId),
  );
  if (samples.length > MAX_PORTABLE_FOLLOWER_SAMPLES) throw new Error("粉丝样本数量超过安全上限");
  if (samples.length > 0 && (!payload.account || !/^\d+$/.test(payload.account.id)
    || payload.account.profileUrl !== `https://www.pixiv.net/users/${payload.account.id}`)) {
    throw new Error("备份粉丝样本缺少一致的账号信息");
  }
  for (const sample of samples) {
    if (!isRecord(sample)
      || typeof sample.runId !== "string" || !sample.runId
      || typeof sample.accountId !== "string" || !sample.accountId
      || !isIsoTimestamp(sample.collectedAt)
      || !Number.isSafeInteger(sample.followers) || sample.followers < 0) {
      throw new Error("备份粉丝样本字段无效");
    }
    if (payload.account && sample.accountId !== payload.account.id) {
      throw new Error("备份粉丝样本账号不一致");
    }
    if (!completedRuns.has(sample.runId)) {
      throw new Error("备份粉丝样本引用了未完成的同步记录");
    }
  }
}

function validateReferences(payload: PortableBackupPayload): void {
  const works = new Set(payload.works.map((work) => work?.key).filter((key): key is string => typeof key === "string" && key.length > 0));
  const runs = new Set(payload.runs.map((run) => run?.runId).filter((runId): runId is string => typeof runId === "string" && runId.length > 0));
  if (works.size !== payload.works.length) throw new Error("备份作品标识缺失或重复");
  if (runs.size !== payload.runs.length) throw new Error("备份同步记录标识缺失或重复");
  for (const sample of payload.samples) {
    if (!sample || !works.has(sample.workKey)) throw new Error("备份样本引用了不存在的作品");
    if (typeof sample.runId !== "string" || !runs.has(sample.runId)) throw new Error("备份样本引用了不存在的同步记录");
  }
  for (const batch of payload.observationBatches) {
    if (!batch || typeof batch.runId !== "string" || !runs.has(batch.runId)) {
      throw new Error("备份观察批次引用了不存在的同步记录");
    }
    if (batch.workKeys.some((key) => !works.has(key)) || batch.changedWorkKeys.some((key) => !works.has(key))) {
      throw new Error("备份观察批次引用了不存在的作品");
    }
  }
  validateAccountFollowerSamples(payload);
}

function payloadFromRecord(value: Record<string, unknown>): PortableBackupPayload {
  const payloadValue = isRecord(value.payload) ? value.payload : value;
  const legacySettings = isRecord(payloadValue.settings) ? payloadValue.settings as Partial<AppSettings> : {};
  const account = validAccount(payloadValue.account ?? legacySettings.boundAccount ?? null);
  return {
    kind: "full",
    account,
    settings: portableSettings(legacySettings),
    works: checkedArray<WorkRecord>(payloadValue.works, "作品", MAX_PORTABLE_WORKS),
    samples: checkedArray<WorkSample>(payloadValue.samples, "样本", MAX_PORTABLE_SAMPLES),
    observationBatches: checkedArray<ObservationBatch>(payloadValue.observationBatches ?? [], "观察批次", MAX_PORTABLE_BATCHES),
    runs: checkedArray<SyncRun>(payloadValue.runs, "同步记录", MAX_PORTABLE_RUNS),
    accountFollowerSamples: checkedArray<AccountFollowerSample>(payloadValue.accountFollowerSamples ?? [], "粉丝样本", MAX_PORTABLE_FOLLOWER_SAMPLES),
    cachePolicy: "regenerate-covers",
  };
}

/** Verify the checksum against the original envelope bytes represented by
 * the parsed JSON object. This is intentionally done before normalizing a
 * legacy payload (for example by adding the v5 follower array), otherwise a
 * valid v3/v4 backup would fail checksum verification during upgrade. */
async function verifyOriginalChecksum(
  unsigned: Record<string, unknown>,
  checksum: unknown,
): Promise<string> {
  if (!isRecord(checksum) || checksum.algorithm !== "SHA-256" || typeof checksum.value !== "string") {
    throw new Error("备份缺少 SHA-256 校验和");
  }
  const expected = checksum.value.toLocaleLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("备份校验和格式无效");
  const actual = await sha256Hex(canonicalJson(unsigned));
  if (actual !== expected) throw new Error("备份校验失败，文件可能损坏或被修改");
  return actual;
}

export async function parsePortableBackupText(
  text: string,
  options: { localAccountId?: string | null; localIsEmpty?: boolean } = {},
): Promise<PortableBackupPreview> {
  if (encoder.encode(text).byteLength > MAX_PORTABLE_BACKUP_BYTES) throw new Error("备份文件超过 50 MiB 安全上限");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("备份不是有效的 JSON 文件");
  }
  if (!isRecord(raw)) throw new Error("备份根结构无效");
  const formatVersion = raw.formatVersion;
  if (formatVersion !== 3 && formatVersion !== 4 && formatVersion !== PORTABLE_BACKUP_FORMAT_VERSION) throw new Error("不支持这个备份版本");

  const rawPayload = isRecord(raw.payload) ? raw.payload : raw;
  if (formatVersion === PORTABLE_BACKUP_FORMAT_VERSION && !Array.isArray(rawPayload.accountFollowerSamples)) {
    throw new Error("备份缺少粉丝样本");
  }

  const payload = payloadFromRecord(raw);
  validateReferences(payload);
  if (formatVersion === PORTABLE_BACKUP_FORMAT_VERSION) validateAccountFollowerSamples(payload, { requireArray: true });
  const warnings: string[] = [];
  if (formatVersion === 3 || formatVersion === 4) warnings.push("旧版备份会在导入时升级为当前格式");
  if (payload.cachePolicy === "regenerate-covers") warnings.push("缩略图不随备份迁移，将在下次同步时重新生成");

  let envelope: PortableBackupEnvelope;
  if (formatVersion === PORTABLE_BACKUP_FORMAT_VERSION) {
    if (raw.product !== "PixivPulse" || raw.timeZone !== "Asia/Shanghai" || !isIsoTimestamp(raw.exportedAt)) {
      throw new Error("备份元数据无效");
    }
    const { checksum: _checksum, ...unsignedRaw } = raw;
    const actual = await verifyOriginalChecksum(unsignedRaw, raw.checksum);
    const unsigned = { ...unsignedRaw, payload } as Omit<PortableBackupEnvelope, "checksum">;
    envelope = { ...unsigned, checksum: { algorithm: "SHA-256", value: actual } };
  } else {
    const { checksum: _checksum, ...unsignedRaw } = raw;
    await verifyOriginalChecksum(unsignedRaw, raw.checksum);
    envelope = await createPortableBackup(payload, typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString());
  }

  const accountMatch = options.localIsEmpty === true || !options.localAccountId
    ? "empty-local"
    : payload.account?.id === options.localAccountId ? "same" : "mismatch";
  return { envelope, warnings, accountMatch, counts: countsOf(payload) };
}
