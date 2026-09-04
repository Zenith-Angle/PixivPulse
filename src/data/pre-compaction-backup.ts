import type {
  AccountFollowerSample,
  AppSettings,
  ObservationBatch,
  PixivAccount,
  SyncRun,
  WorkRecord,
  WorkSample,
} from "../domain/types";
import type { MetricFrame } from "../domain/metric-frames";
import { decodePublicFrameHistory, metricFrameDigest } from "./frame-storage";
import {
  decodeWorkDictionary,
  encodeWorkDictionary,
  type StoredWorkDictionary,
} from "./metric-frame-codec";
import {
  canonicalJson,
  createPortableBackup,
  type PortableBackupEnvelope,
  type PortableBackupPayload,
} from "./portable-backup";
import {
  parsePortableBackupDocument,
} from "./portable-backup-csv";
import type { PortableDocumentPreview } from "./portable-native";

/** A frame pointer produced by a compaction dry-run. The frame is kept in the
 * descriptor so the caller can prove that the selected preimage is the one it
 * intended to export, rather than merely selecting by a mutable run id. */
export interface PreCompactionFrameSource {
  identity: string;
  digest: string;
  frame: MetricFrame;
}

export interface PreCompactionFrameManifestEntry {
  identity: string;
  digest: string;
  runId: string;
}

/**
 * The array names (`works`, `runs`, `accountFollowerSamples`) are the public
 * spelling. The `all*` and `workDictionary` aliases keep this boundary usable
 * by callers that already name their source collections that way; if both
 * spellings are supplied they must describe the same data.
 */
export interface PreCompactionBackupInput {
  account: PixivAccount | null;
  settings: Partial<AppSettings>;
  works?: readonly WorkRecord[];
  allWorks?: readonly WorkRecord[];
  runs?: readonly SyncRun[];
  allRuns?: readonly SyncRun[];
  accountFollowerSamples?: readonly AccountFollowerSample[];
  followerSamples?: readonly AccountFollowerSample[];
  storedDictionary?: StoredWorkDictionary;
  workDictionary?: StoredWorkDictionary;
  allFrames: readonly MetricFrame[];
  sources: readonly PreCompactionFrameSource[];
}

/** The exact logical records expected after parsing the partial backup. */
export interface PreCompactionBackupExpected {
  account: PixivAccount | null;
  works: WorkRecord[];
  samples: WorkSample[];
  observationBatches: ObservationBatch[];
  runs: SyncRun[];
  accountFollowerSamples: AccountFollowerSample[];
  canonicalWorks: string;
  canonicalSamples: string;
  canonicalObservationBatches: string;
  canonicalRuns: string;
  canonicalAccountFollowerSamples: string;
}

/** In-memory evidence returned with the importable envelope. */
export interface PreCompactionBackupManifest extends PreCompactionBackupExpected {
  sources: PreCompactionFrameManifestEntry[];
}

export interface PreCompactionBackupGenerated {
  envelope: PortableBackupEnvelope;
  text: string;
  checksum: string;
  expected: PreCompactionBackupExpected;
  manifest: PreCompactionBackupManifest;
}

export interface PreCompactionBackupVerification {
  envelope: PortableBackupEnvelope;
  preview: PortableDocumentPreview;
  logicalPayload: PortableBackupPayload;
  checksum: string;
  text: string;
  byteLength: number;
  bytes: number;
  counts: PortableDocumentPreview["counts"];
  accountMatch: PortableDocumentPreview["accountMatch"];
  native: false;
}

export interface PreCompactionWritable {
  write(data: string): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface PreCompactionFile {
  readonly size?: number;
  text(): Promise<string>;
}

export interface PreCompactionFileHandle {
  getFile(): Promise<PreCompactionFile>;
  createWritable(): Promise<PreCompactionWritable>;
}

export interface PreCompactionDirectoryHandle {
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<PreCompactionFileHandle>;
}

/** Descriptive aliases for consumers that prefer the File System Access names. */
export type FileSystemDirectoryHandleLike = PreCompactionDirectoryHandle;
export type FileSystemFileHandleLike = PreCompactionFileHandle;
export type FileSystemWritableLike = PreCompactionWritable;

const encoder = new TextEncoder();

function frameIdentity(frame: Pick<MetricFrame, "epochMs" | "runSeq" | "runId">): string {
  return `${frame.epochMs}:${frame.runSeq}:${frame.runId}`;
}

/** Exported for dry-run callers and tests that need to build a descriptor. */
export function preCompactionFrameIdentity(frame: Pick<MetricFrame, "epochMs" | "runSeq" | "runId">): string {
  return frameIdentity(frame);
}

/** Compute the digest used by source descriptors. */
export function preCompactionFrameDigest(frame: MetricFrame): Promise<string> {
  return Promise.resolve(metricFrameDigest(frame));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function resolveArray<T>(
  primary: readonly T[] | undefined,
  alias: readonly T[] | undefined,
  label: string,
): T[] {
  if (primary !== undefined && alias !== undefined && !sameCanonical(primary, alias)) {
    throw new Error(`${label}的两个输入别名内容不一致`);
  }
  const value = primary ?? alias;
  if (value === undefined) throw new Error(`缺少${label}`);
  return [...value];
}

function resolveOptionalArray<T>(
  primary: readonly T[] | undefined,
  alias: readonly T[] | undefined,
  label: string,
): T[] {
  if (primary !== undefined && alias !== undefined && !sameCanonical(primary, alias)) {
    throw new Error(`${label}的两个输入别名内容不一致`);
  }
  return [...(primary ?? alias ?? [])];
}

function resolveDictionary(input: PreCompactionBackupInput): StoredWorkDictionary {
  if (input.storedDictionary !== undefined && input.workDictionary !== undefined
    && !sameCanonical(input.storedDictionary, input.workDictionary)) {
    throw new Error("存储作品字典的两个输入别名内容不一致");
  }
  const value = input.storedDictionary ?? input.workDictionary;
  if (value === undefined) throw new Error("缺少存储作品字典");
  return encodeWorkDictionary(decodeWorkDictionary(value));
}

function validateRunRecords(runs: readonly SyncRun[]): Map<string, SyncRun> {
  const byId = new Map<string, SyncRun>();
  for (const run of runs) {
    if (typeof run.runId !== "string" || run.runId.length === 0 || byId.has(run.runId)) {
      throw new Error("同步记录标识缺失或重复");
    }
    byId.set(run.runId, run);
  }
  return byId;
}

function validateWorks(works: readonly WorkRecord[]): Map<string, WorkRecord> {
  const byKey = new Map<string, WorkRecord>();
  for (const work of works) {
    if (typeof work.key !== "string" || work.key.length === 0 || byKey.has(work.key)) {
      throw new Error("作品标识缺失或重复");
    }
    byKey.set(work.key, work);
  }
  return byKey;
}

function validateDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("帧摘要格式无效");
  }
  return value.toLowerCase();
}

interface ValidatedSource {
  source: PreCompactionFrameSource;
  frame: MetricFrame;
  identity: string;
  digest: string;
}

async function validateSources(
  sources: readonly PreCompactionFrameSource[],
  allFrames: readonly MetricFrame[],
): Promise<ValidatedSource[]> {
  const frameByIdentity = new Map<string, MetricFrame>();
  for (const frame of allFrames) {
    const identity = frameIdentity(frame);
    if (frameByIdentity.has(identity)) throw new Error("当前指标帧标识重复");
    frameByIdentity.set(identity, frame);
  }

  const sourceIdentities = new Set<string>();
  const sourceRunIds = new Set<string>();
  const validated: ValidatedSource[] = [];
  for (const source of sources) {
    if (typeof source.identity !== "string" || source.identity.length === 0 || sourceIdentities.has(source.identity)) {
      throw new Error("压缩来源标识缺失或重复");
    }
    const digest = validateDigest(source.digest);
    if (!source.frame || typeof source.frame.runId !== "string" || source.frame.runId.length === 0) {
      throw new Error("压缩来源帧无效");
    }
    const sourceIdentity = frameIdentity(source.frame);
    if (sourceIdentity !== source.identity) throw new Error("压缩来源帧标识不匹配");
    if (sourceRunIds.has(source.frame.runId)) throw new Error("压缩来源同步标识重复");
    const frame = frameByIdentity.get(source.identity);
    if (frame === undefined) throw new Error("压缩来源帧不存在于当前帧集合");
    const actualDigest = (await preCompactionFrameDigest(frame)).toLowerCase();
    const sourceDigest = (await preCompactionFrameDigest(source.frame)).toLowerCase();
    if (actualDigest !== digest || sourceDigest !== digest) {
      throw new Error("压缩来源帧摘要与当前帧集合不匹配");
    }
    sourceIdentities.add(source.identity);
    sourceRunIds.add(source.frame.runId);
    validated.push({ source, frame, identity: source.identity, digest });
  }
  return validated;
}

function canonicalExpected(expected: PreCompactionBackupExpected): PreCompactionBackupExpected {
  return {
    ...expected,
    works: [...expected.works],
    samples: [...expected.samples],
    observationBatches: [...expected.observationBatches],
    runs: [...expected.runs],
    accountFollowerSamples: [...expected.accountFollowerSamples],
  };
}

function createExpected(
  account: PixivAccount | null,
  works: WorkRecord[],
  samples: WorkSample[],
  observationBatches: ObservationBatch[],
  runs: SyncRun[],
  accountFollowerSamples: AccountFollowerSample[],
): PreCompactionBackupExpected {
  return {
    account,
    works,
    samples,
    observationBatches,
    runs,
    accountFollowerSamples,
    canonicalWorks: canonicalJson(works),
    canonicalSamples: canonicalJson(samples),
    canonicalObservationBatches: canonicalJson(observationBatches),
    canonicalRuns: canonicalJson(runs),
    canonicalAccountFollowerSamples: canonicalJson(accountFollowerSamples),
  };
}

/**
 * Build a legacy portable-v5 backup containing only the logical records
 * represented by the selected frame preimages. All frames are decoded first so
 * sparse changes retain the complete metric state at each selected run.
 */
export async function createPreCompactionBackup(
  input: PreCompactionBackupInput,
  exportedAt = new Date().toISOString(),
): Promise<PreCompactionBackupGenerated> {
  const allWorks = resolveArray(input.works, input.allWorks, "全部作品");
  const allRuns = resolveArray(input.runs, input.allRuns, "全部同步记录");
  const allFollowerSamples = resolveOptionalArray(
    input.accountFollowerSamples,
    input.followerSamples,
    "全部粉丝样本",
  );
  const storedDictionary = resolveDictionary(input);
  const allFrames = [...input.allFrames];
  const validatedSources = await validateSources(input.sources, allFrames);
  const selectedRunIds = new Set(validatedSources.map(({ frame }) => frame.runId));
  const runsById = validateRunRecords(allRuns);
  const selectedRuns: SyncRun[] = [];
  for (const run of allRuns) {
    if (!selectedRunIds.has(run.runId)) continue;
    if (run.status !== "completed") throw new Error(`选中的同步记录未完成：${run.runId}`);
    selectedRuns.push({ ...run });
  }
  for (const runId of selectedRunIds) {
    if (!runsById.has(runId)) throw new Error(`选中的同步记录不存在：${runId}`);
  }
  if (selectedRuns.length !== selectedRunIds.size) throw new Error("选中的同步记录缺少已完成记录");

  // This applies every frame, including unselected predecessors, before the
  // run-id filter. Without that baseline, a sparse selected frame would export
  // an incomplete metric object.
  const history = decodePublicFrameHistory(storedDictionary, allFrames);
  const samples = history.samples.filter((sample) => selectedRunIds.has(sample.runId));
  const observationBatches = history.observationBatches.filter((batch) => selectedRunIds.has(batch.runId));
  const workKeys = new Set<string>();
  for (const sample of samples) workKeys.add(sample.workKey);
  for (const batch of observationBatches) {
    for (const key of batch.workKeys) workKeys.add(key);
    for (const key of batch.changedWorkKeys) workKeys.add(key);
  }

  const worksByKey = validateWorks(allWorks);
  const selectedWorks: WorkRecord[] = [];
  for (const work of allWorks) {
    if (workKeys.has(work.key)) selectedWorks.push({ ...work });
  }
  for (const key of workKeys) {
    if (!worksByKey.has(key)) throw new Error(`选中的历史引用了不存在的作品：${key}`);
  }

  const accountFollowerSamples = allFollowerSamples
    .filter((sample) => selectedRunIds.has(sample.runId))
    .map((sample) => ({ ...sample }));
  for (const sample of accountFollowerSamples) {
    if (!Number.isSafeInteger(sample.followers) || sample.followers < 0) {
      throw new Error("选中的粉丝样本无效");
    }
    if (input.account === null || sample.accountId !== input.account.id) {
      throw new Error("选中的粉丝样本账号不一致");
    }
  }

  const envelope = await createPortableBackup({
    kind: "full",
    account: input.account,
    settings: input.settings,
    works: selectedWorks,
    samples,
    observationBatches,
    runs: selectedRuns,
    accountFollowerSamples,
  }, exportedAt);
  const text = canonicalJson(envelope);
  const expected = canonicalExpected(createExpected(
    input.account,
    selectedWorks,
    samples,
    observationBatches,
    selectedRuns,
    accountFollowerSamples,
  ));
  const manifest: PreCompactionBackupManifest = {
    ...expected,
    sources: validatedSources.map(({ identity, digest, frame }) => ({ identity, digest, runId: frame.runId })),
  };
  return {
    envelope,
    text,
    checksum: envelope.checksum.value,
    expected,
    manifest,
  };
}

interface VerificationExpectation {
  expected: PreCompactionBackupExpected;
  sources?: readonly PreCompactionFrameManifestEntry[];
  checksum?: string;
}

function normalizeVerificationExpectation(
  value: PreCompactionBackupExpected | PreCompactionBackupManifest | PreCompactionBackupGenerated,
): VerificationExpectation {
  if ("envelope" in value && "manifest" in value && "expected" in value) {
    return { expected: value.expected, sources: value.manifest.sources, checksum: value.checksum };
  }
  if ("sources" in value) return { expected: value, sources: value.sources };
  return { expected: value };
}

function canonicalField(
  expected: PreCompactionBackupExpected,
  field: "works" | "samples" | "observationBatches" | "runs" | "accountFollowerSamples",
): string {
  const canonicalName = {
    works: "canonicalWorks",
    samples: "canonicalSamples",
    observationBatches: "canonicalObservationBatches",
    runs: "canonicalRuns",
    accountFollowerSamples: "canonicalAccountFollowerSamples",
  } as const;
  const value = expected[canonicalName[field]];
  const records = expected[field];
  if (typeof value !== "string" || value !== canonicalJson(records)) {
    throw new Error(`预期${field}清单的规范表示无效`);
  }
  return value;
}

function ensureJsonObject(text: string): Record<string, unknown> {
  const normalized = text.startsWith("\ufeff") ? text.slice(1) : text;
  if (!normalized.trimStart().startsWith("{")) throw new Error("预补偿备份必须是 legacy JSON，而不是 CSV");
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new Error("预补偿备份不是有效的 JSON");
  }
  if (!isRecord(value)) throw new Error("预补偿备份 JSON 根结构无效");
  return value;
}

/** Parse and prove that a file is exactly the selected portable-v5 subset. */
export async function verifyPreCompactionBackupText(
  text: string,
  expected: PreCompactionBackupExpected | PreCompactionBackupManifest | PreCompactionBackupGenerated,
): Promise<PreCompactionBackupVerification> {
  // Keep this call explicit: it performs the v5 checksum and reference checks
  // used by the normal import path.
  const preview = await parsePortableBackupDocument(text);
  const raw = ensureJsonObject(text);
  if (raw.formatVersion !== 5 || preview.native !== false || preview.envelope.formatVersion !== 5) {
    throw new Error("预补偿备份必须是 legacy portable-v5 JSON");
  }
  const normalizedExpected = normalizeVerificationExpectation(expected);
  const expectedPayload = normalizedExpected.expected;
  const actualPayload = preview.logicalPayload;
  if (!sameCanonical(actualPayload.account, expectedPayload.account)) {
    throw new Error("预补偿备份账号不匹配");
  }
  const expectedCanonicalWorks = canonicalField(expectedPayload, "works");
  const expectedCanonicalSamples = canonicalField(expectedPayload, "samples");
  const expectedCanonicalBatches = canonicalField(expectedPayload, "observationBatches");
  const expectedCanonicalRuns = canonicalField(expectedPayload, "runs");
  const expectedCanonicalFollowers = canonicalField(expectedPayload, "accountFollowerSamples");
  if (canonicalJson(actualPayload.works) !== expectedCanonicalWorks) throw new Error("预补偿备份包含未选择的作品或作品不一致");
  if (canonicalJson(actualPayload.samples) !== expectedCanonicalSamples) throw new Error("预补偿备份样本子集不一致");
  if (canonicalJson(actualPayload.observationBatches) !== expectedCanonicalBatches) throw new Error("预补偿备份观察批次子集不一致");
  if (canonicalJson(actualPayload.runs) !== expectedCanonicalRuns) throw new Error("预补偿备份同步记录子集不一致");
  if (canonicalJson(actualPayload.accountFollowerSamples ?? []) !== expectedCanonicalFollowers) {
    throw new Error("预补偿备份粉丝样本子集不一致");
  }
  if (actualPayload.runs.some((run) => run.status !== "completed")) {
    throw new Error("预补偿备份包含未完成的同步记录");
  }
  if (normalizedExpected.sources !== undefined) {
    const expectedRunIds = new Set(normalizedExpected.sources.map((source) => source.runId));
    const actualRunIds = new Set(actualPayload.runs.map((run) => run.runId));
    if (expectedRunIds.size !== normalizedExpected.sources.length || expectedRunIds.size !== actualRunIds.size
      || [...expectedRunIds].some((runId) => !actualRunIds.has(runId))) {
      throw new Error("预补偿备份同步记录与来源清单不一致");
    }
  }
  const checksum = preview.envelope.checksum.value;
  if (normalizedExpected.checksum !== undefined && checksum !== normalizedExpected.checksum.toLowerCase()) {
    throw new Error("预补偿备份校验和与生成结果不一致");
  }
  const byteLength = encoder.encode(text).byteLength;
  return {
    envelope: preview.envelope,
    preview,
    logicalPayload: actualPayload,
    checksum,
    text,
    byteLength,
    bytes: byteLength,
    counts: preview.counts,
    accountMatch: preview.accountMatch,
    native: false,
  };
}

function validateFileName(fileName: string): void {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 255
    || fileName === "." || fileName === ".." || fileName.endsWith(".")
    || /[\\/\0]/.test(fileName) || fileName.trim() !== fileName
    || !/\.json$/i.test(fileName) || fileName.slice(0, -5).length === 0) {
    throw new Error("备份文件名必须是安全的 .json 文件名");
  }
}

export interface PreCompactionBackupWriteResult extends PreCompactionBackupVerification {
  fileName: string;
}

/** Write once, refuse accidental replacement, reopen, and verify the bytes. */
export async function writeAndVerifyPreCompactionBackup(
  directory: PreCompactionDirectoryHandle,
  fileName: string,
  generated: PreCompactionBackupGenerated,
): Promise<PreCompactionBackupWriteResult> {
  validateFileName(fileName);
  // Validate the generated object before creating or touching a target file.
  await verifyPreCompactionBackupText(generated.text, generated);

  const handle = await directory.getFileHandle(fileName, { create: true });
  const existingText = await (await handle.getFile()).text();
  if (existingText.length > 0 && existingText !== generated.text) {
    throw new Error("已有备份文件内容不同，拒绝覆盖");
  }
  if (existingText !== generated.text) {
    const writable = await handle.createWritable();
    try {
      await writable.write(generated.text);
    } finally {
      await writable.close();
    }
  }

  const reopened = await directory.getFileHandle(fileName, { create: false });
  const text = await (await reopened.getFile()).text();
  const verification = await verifyPreCompactionBackupText(text, generated);
  return { ...verification, fileName };
}
