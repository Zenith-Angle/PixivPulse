import {
  normalizeRankingFields,
  type NullableMetric,
  type ObservationBatch,
  type ParsedWork,
  type RankingSourceCode,
  type RankingStatusCode,
  type WorkDocument,
  type WorkMetrics,
  type WorkRecord,
  type WorkSample,
  type WorkState,
  type WorkStateValues,
} from "../domain/types";

export const WORK_STATE_VERSION = 1 as const;
export const OBSERVATION_BATCH_CODEC_VERSION = 1 as const;
export const OBSERVATION_BATCH_CODEC = "packed-v1" as const;
export const WORK_SAMPLE_CODEC_VERSION = 1 as const;
export const WORK_SAMPLE_CODEC = "sample-v1" as const;

const METRIC_KEYS = [
  "likes",
  "bookmarks",
  "views",
  "comments",
  "rank",
  "responses",
  "illustrations",
] as const satisfies readonly (keyof WorkMetrics)[];

export class DataIntegrityError extends Error {
  readonly code = "DATA_INTEGRITY" as const;

  constructor(message: string) {
    super(message);
    this.name = "DataIntegrityError";
  }
}

export type StoredSampleKindCode = 0 | 1;

/** Compact v5 representation of a public WorkSample. The primary key remains
 * the legacy inline `id` for an atomic v4 upgrade, while `k` is a stable
 * content identity used by retention plans. Short field names
 * are intentional: these rows are the high-cardinality part of the store. */
export interface StoredWorkSample {
  id?: number;
  k: string;
  w: string;
  r: string;
  t: string;
  m: [NullableMetric, NullableMetric, NullableMetric, NullableMetric, NullableMetric, NullableMetric, NullableMetric];
  s: RankingStatusCode;
  o: string | null;
  p: RankingSourceCode;
  v: number;
  q: number;
  y: StoredSampleKindCode;
  c?: "30m" | "1h" | "2h" | "6h" | "day" | "daily";
  x?: string;
  codec: typeof WORK_SAMPLE_CODEC;
  codecVersion: typeof WORK_SAMPLE_CODEC_VERSION;
}

function fail(message: string): never {
  throw new DataIntegrityError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`Invalid ${field}`);
  return value;
}

function finiteNumberOrNull(value: unknown, field: string): NullableMetric {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`Invalid ${field}`);
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) fail(`Invalid ${field}`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`Invalid ${field}`);
  }
  return [...value] as string[];
}

function validWorkType(value: unknown): value is WorkDocument["type"] {
  return value === "illust" || value === "novel";
}

function validContentType(value: unknown): boolean {
  return value === "novel" || value === "illustration" || value === "manga"
    || value === "ugoira" || value === "unknown";
}

function validateRawLabels(value: unknown): Record<string, string> {
  if (!isRecord(value)) fail("Invalid rawLabels");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") fail("Invalid rawLabels value");
    result[key] = item;
  }
  return result;
}

/** Validate and return a cloned static document so callers cannot mutate the
 * object that is about to be persisted. */
export function decodeWorkDocument(value: unknown): WorkDocument {
  if (!isRecord(value)) fail("Missing or malformed WorkDocument");
  const id = nonEmptyString(value.id, "work document id");
  const type = value.type;
  if (!validWorkType(type)) fail("Invalid work document type");
  const key = nonEmptyString(value.key, "work document key");
  if (key !== `${type}-${id}`) fail("WorkDocument key does not match type and id");
  const contentType = value.contentType;
  if (contentType !== undefined && !validContentType(contentType)) fail("Invalid work document contentType");
  const description = value.description;
  if (description !== undefined && description !== null && typeof description !== "string") fail("Invalid work document description");
  const title = nonEmptyString(value.title, "work document title");
  const seriesTitle = value.seriesTitle;
  if (seriesTitle !== null && typeof seriesTitle !== "string") fail("Invalid work document seriesTitle");
  const publishedAt = nullableTimestamp(value.publishedAt, "work document publishedAt");
  const wordCount = finiteNumberOrNull(value.wordCount, "work document wordCount");
  const pageCount = finiteNumberOrNull(value.pageCount, "work document pageCount");
  const isAi = value.isAi;
  if (isAi !== null && typeof isAi !== "boolean") fail("Invalid work document isAi");
  const isR18 = value.isR18;
  if (isR18 !== null && typeof isR18 !== "boolean") fail("Invalid work document isR18");
  const thumbnailUrl = value.thumbnailUrl;
  if (thumbnailUrl !== null && typeof thumbnailUrl !== "string") fail("Invalid work document thumbnailUrl");
  const workUrl = nonEmptyString(value.workUrl, "work document workUrl");
  const firstSeenAt = nonEmptyString(value.firstSeenAt, "work document firstSeenAt");
  if (!Number.isFinite(Date.parse(firstSeenAt))) fail("Invalid work document firstSeenAt");
  const rawLabels = validateRawLabels(value.rawLabels);
  const missingFields = stringArray(value.missingFields, "work document missingFields");
  const parserVersion = value.parserVersion;
  if (typeof parserVersion !== "number" || !Number.isSafeInteger(parserVersion) || parserVersion < 0) {
    fail("Invalid work document parserVersion");
  }

  const document: WorkDocument = {
    key,
    id,
    type,
    title,
    seriesTitle,
    publishedAt,
    wordCount,
    pageCount,
    isAi,
    isR18,
    thumbnailUrl,
    workUrl,
    firstSeenAt,
    rawLabels,
    missingFields,
    parserVersion,
  };
  if (contentType !== undefined) document.contentType = contentType as NonNullable<WorkDocument["contentType"]>;
  if (description !== undefined) document.description = description;
  return document;
}

export interface WorkDocumentOptions {
  key?: string;
  firstSeenAt?: string;
}

/** Encode only static metadata from either a public WorkRecord or a parsed
 * work. Parsed works need a key and firstSeenAt supplied by the repository. */
export function encodeWorkDocument(source: WorkRecord | ParsedWork, options: WorkDocumentOptions = {}): WorkDocument {
  const sourceRecord = source as Partial<WorkRecord>;
  const key = options.key ?? sourceRecord.key;
  const firstSeenAt = options.firstSeenAt ?? sourceRecord.firstSeenAt;
  if (typeof key !== "string" || !key) fail("Cannot encode WorkDocument without key");
  if (typeof firstSeenAt !== "string" || !firstSeenAt) fail("Cannot encode WorkDocument without firstSeenAt");
  const document: Record<string, unknown> = {
    key,
    id: source.id,
    type: source.type,
    title: source.title,
    seriesTitle: source.seriesTitle,
    publishedAt: source.publishedAt,
    wordCount: source.wordCount,
    pageCount: source.pageCount,
    isAi: source.isAi,
    isR18: source.isR18,
    thumbnailUrl: source.thumbnailUrl,
    workUrl: source.workUrl,
    firstSeenAt,
    rawLabels: source.rawLabels,
    missingFields: source.missingFields,
    parserVersion: source.parserVersion,
  };
  if (source.contentType !== undefined) document.contentType = source.contentType;
  if (source.description !== undefined) document.description = source.description;
  return decodeWorkDocument(document);
}

/** Canonical metadata used for field-wise document comparisons. Object label
 * order and parser-provided missing-field order are intentionally ignored. */
export function canonicalWorkDocument(value: WorkDocument): string {
  const document = decodeWorkDocument(value);
  const canonical: Record<string, unknown> = {
    key: document.key,
    id: document.id,
    type: document.type,
    contentType: document.contentType ?? null,
    description: document.description ?? null,
    title: document.title,
    seriesTitle: document.seriesTitle,
    publishedAt: document.publishedAt,
    wordCount: document.wordCount,
    pageCount: document.pageCount,
    isAi: document.isAi,
    isR18: document.isR18,
    thumbnailUrl: document.thumbnailUrl,
    workUrl: document.workUrl,
    firstSeenAt: document.firstSeenAt,
    rawLabels: Object.fromEntries(Object.keys(document.rawLabels).sort().map((key) => [key, document.rawLabels[key]])),
    missingFields: [...document.missingFields].sort(),
    parserVersion: document.parserVersion,
  };
  return JSON.stringify(canonical);
}

export function canonicalMetadataEqual(left: WorkDocument, right: WorkDocument): boolean {
  return canonicalWorkDocument(left) === canonicalWorkDocument(right);
}

export const workDocumentsEqual = canonicalMetadataEqual;
export const canonicalDocument = canonicalWorkDocument;

function rankingStatusCode(value: unknown): RankingStatusCode {
  if (value === "unknown") return 0;
  if (value === "ranked") return 1;
  if (value === "unranked") return 2;
  fail("Invalid ranking status");
}

function rankingSourceCode(value: unknown): RankingSourceCode {
  if (value === null) return 0;
  if (value === "api") return 1;
  if (value === "page") return 2;
  fail("Invalid ranking source");
}

function rankingStatusFromCode(value: unknown): "unknown" | "ranked" | "unranked" {
  if (value === 0) return "unknown";
  if (value === 1) return "ranked";
  if (value === 2) return "unranked";
  fail("Invalid ranking status code");
}

function rankingSourceFromCode(value: unknown): "api" | "page" | null {
  if (value === 0) return null;
  if (value === 1) return "api";
  if (value === 2) return "page";
  fail("Invalid ranking source code");
}

function validateMetrics(metrics: unknown): WorkMetrics {
  if (!isRecord(metrics)) fail("Missing or malformed metrics");
  const result = {} as WorkMetrics;
  for (const key of METRIC_KEYS) result[key] = finiteNumberOrNull(metrics[key], `metrics.${key}`);
  return result;
}

function kindCode(value: unknown): StoredSampleKindCode {
  if (value === "change") return 0;
  if (value === "daily-rollup") return 1;
  fail("Invalid sample kind");
}

function kindFromCode(value: unknown): WorkSample["kind"] {
  if (value === 0) return "change";
  if (value === 1) return "daily-rollup";
  fail("Invalid sample kind code");
}

function compactLevel(value: unknown): WorkSample["compactionLevel"] {
  if (value === undefined) return undefined;
  if (value === "30m" || value === "1h" || value === "2h" || value === "6h" || value === "day" || value === "daily") return value;
  fail("Invalid sample compaction level");
}

function validateSamplePublic(value: unknown): WorkSample {
  if (!isRecord(value)) fail("Missing or malformed WorkSample");
  const id = value.id;
  if (id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)) fail("Invalid sample id");
  const workKey = nonEmptyString(value.workKey, "sample workKey");
  const runId = nonEmptyString(value.runId, "sample runId");
  const collectedAt = nonEmptyString(value.collectedAt, "sample collectedAt");
  if (!Number.isFinite(Date.parse(collectedAt))) fail("Invalid sample collectedAt");
  const metrics = validateMetrics(value.metrics);
  const parserVersion = value.parserVersion;
  if (typeof parserVersion !== "number" || !Number.isSafeInteger(parserVersion) || parserVersion < 0) fail("Invalid sample parserVersion");
  const dataQuality = value.dataQuality;
  if (typeof dataQuality !== "number" || !Number.isFinite(dataQuality)) fail("Invalid sample dataQuality");
  const kind = value.kind;
  if (kind !== "change" && kind !== "daily-rollup") fail("Invalid sample kind");
  const ranking = normalizeRankingFields({
    rank: metrics.rank,
    rankingStatus: value.rankingStatus,
    rankingObservedAt: value.rankingObservedAt,
    rankingSource: value.rankingSource,
  });
  const normalizedMetrics = { ...metrics, rank: ranking.rank };
  const result: WorkSample = {
    ...(id === undefined ? {} : { id }),
    workKey,
    runId,
    collectedAt,
    metrics: normalizedMetrics,
    rankingStatus: ranking.rankingStatus,
    rankingObservedAt: ranking.rankingStatus === "unknown" ? null : ranking.rankingObservedAt,
    rankingSource: ranking.rankingStatus === "unknown" ? null : ranking.rankingSource,
    parserVersion,
    dataQuality,
    kind,
  };
  const level = compactLevel(value.compactionLevel);
  if (level !== undefined) result.compactionLevel = level;
  const source = value.rollupSourceCollectedAt;
  if (source !== undefined) {
    if (typeof source !== "string" || !source || !Number.isFinite(Date.parse(source))) fail("Invalid sample rollupSourceCollectedAt");
    result.rollupSourceCollectedAt = source;
  }
  return result;
}

function sampleIdentityParts(sample: Pick<WorkSample, "workKey" | "runId" | "collectedAt" | "kind"> & Partial<Pick<WorkSample, "rollupSourceCollectedAt">>): string {
  if (typeof sample.workKey !== "string" || !sample.workKey) fail("Invalid sample identity workKey");
  if (typeof sample.runId !== "string" || !sample.runId) fail("Invalid sample identity runId");
  if (typeof sample.collectedAt !== "string" || !sample.collectedAt) fail("Invalid sample identity collectedAt");
  if (sample.kind !== "change" && sample.kind !== "daily-rollup") fail("Invalid sample identity kind");
  return JSON.stringify([
    sample.workKey,
    sample.runId,
    sample.collectedAt,
    sample.kind,
    sample.rollupSourceCollectedAt ?? null,
  ]);
}

/** Stable identity for a sample. The auto-increment primary key is purposely
 * excluded, so an export/import or v4 migration keeps the same identity. */
export function sampleIdentityFor(sample: Pick<WorkSample, "workKey" | "runId" | "collectedAt" | "kind"> & Partial<Pick<WorkSample, "rollupSourceCollectedAt">>): string {
  return sampleIdentityParts(sample);
}

export const sampleIdentity = sampleIdentityFor;
export const stableSampleIdentity = sampleIdentityFor;
export const sampleKeyFor = sampleIdentityFor;

/** IndexedDB stores a short digest of the stable identity to keep the
 * high-cardinality index compact. The exact identity remains available from
 * the public row and is what import/retention plans carry. */
export function storedSampleIdentityFor(
  sample: Pick<WorkSample, "workKey" | "runId" | "collectedAt" | "kind"> & Partial<Pick<WorkSample, "rollupSourceCollectedAt">>,
): string {
  return fnv64(sampleIdentityFor(sample));
}

export const compactSampleKeyFor = storedSampleIdentityFor;

function canonicalSampleObject(sample: WorkSample): Record<string, unknown> {
  const normalized = validateSamplePublic(sample);
  const result: Record<string, unknown> = {
    workKey: normalized.workKey,
    runId: normalized.runId,
    collectedAt: normalized.collectedAt,
    metrics: Object.fromEntries(METRIC_KEYS.map((key) => [key, normalized.metrics[key]])),
    rankingStatus: normalized.rankingStatus,
    rankingObservedAt: normalized.rankingObservedAt ?? null,
    rankingSource: normalized.rankingSource ?? null,
    parserVersion: normalized.parserVersion,
    dataQuality: normalized.dataQuality,
    kind: normalized.kind,
    compactionLevel: normalized.compactionLevel ?? null,
    rollupSourceCollectedAt: normalized.rollupSourceCollectedAt ?? null,
  };
  return result;
}

/** Canonical, deterministic sample material used by retention revalidation
 * and integrity checks. It is intentionally independent of object key
 * insertion order. */
export function canonicalWorkSample(sample: WorkSample): string {
  return JSON.stringify(canonicalSampleObject(sample));
}

function fnv64(value: string): string {
  // This is an identity/checksum material helper, not a cryptographic digest.
  // Callers can replace it with SHA-256 over the canonical
  // material without changing the source-row contract.
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function sampleCanonicalHash(sample: WorkSample): string {
  return fnv64(canonicalWorkSample(sample));
}

export const canonicalSample = canonicalWorkSample;
export const canonicalSampleHash = sampleCanonicalHash;
export const sampleHash = sampleCanonicalHash;

function decodeStoredSample(value: Record<string, unknown>): WorkSample {
  if (value.codec !== WORK_SAMPLE_CODEC || value.codecVersion !== WORK_SAMPLE_CODEC_VERSION) fail("Unknown sample codec");
  const id = value.id;
  if (id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)) fail("Invalid stored sample id");
  const workKey = nonEmptyString(value.w, "stored sample workKey");
  const runId = nonEmptyString(value.r, "stored sample runId");
  const collectedAt = nonEmptyString(value.t, "stored sample collectedAt");
  if (!Number.isFinite(Date.parse(collectedAt))) fail("Invalid stored sample collectedAt");
  if (!Array.isArray(value.m) || value.m.length !== METRIC_KEYS.length) fail("Malformed stored sample metric tuple");
  const metrics = value.m.map((item, index) => finiteNumberOrNull(item, `stored sample metric ${index}`)) as WorkSample["metrics"] extends infer _ ? [NullableMetric, NullableMetric, NullableMetric, NullableMetric, NullableMetric, NullableMetric, NullableMetric] : never;
  const status = value.s;
  const source = value.p;
  if (status !== 0 && status !== 1 && status !== 2) fail("Invalid stored sample ranking status code");
  if (source !== 0 && source !== 1 && source !== 2) fail("Invalid stored sample ranking source code");
  const rankingStatus = rankingStatusFromCode(status);
  const rankingObservedAt = rankingStatus === "unknown"
    ? value.o === null ? null : fail("Unknown stored sample ranking must have null observedAt")
    : nullableTimestamp(value.o, "stored sample rankingObservedAt");
  const rankingSource = rankingStatus === "unknown" ? null : rankingSourceFromCode(source);
  const parserVersion = value.v;
  if (typeof parserVersion !== "number" || !Number.isSafeInteger(parserVersion) || parserVersion < 0) fail("Invalid stored sample parserVersion");
  const dataQuality = value.q;
  if (typeof dataQuality !== "number" || !Number.isFinite(dataQuality)) fail("Invalid stored sample dataQuality");
  const kind = kindFromCode(value.y);
  const result: WorkSample = {
    ...(id === undefined ? {} : { id }),
    workKey,
    runId,
    collectedAt,
    metrics: {
      likes: metrics[0],
      bookmarks: metrics[1],
      views: metrics[2],
      comments: metrics[3],
      rank: rankingStatus === "ranked" ? metrics[4] : null,
      responses: metrics[5],
      illustrations: metrics[6],
    },
    rankingStatus,
    rankingObservedAt,
    rankingSource,
    parserVersion,
    dataQuality,
    kind,
  };
  const level = compactLevel(value.c);
  if (level !== undefined) result.compactionLevel = level;
  if (value.x !== undefined) {
    if (typeof value.x !== "string" || !value.x || !Number.isFinite(Date.parse(value.x))) fail("Invalid stored sample rollupSourceCollectedAt");
    result.rollupSourceCollectedAt = value.x;
  }
  const expectedIdentity = storedSampleIdentityFor(result);
  if (value.k !== expectedIdentity) fail("Stored sample stable identity mismatch");
  return result;
}

/** Decode either the compact v5 representation or a legacy public v4 row. */
export function decodeWorkSample(value: unknown): WorkSample {
  if (!isRecord(value)) fail("Missing or malformed WorkSample");
  if (value.codec !== undefined || value.codecVersion !== undefined || value.w !== undefined || value.m !== undefined) {
    return decodeStoredSample(value);
  }
  return validateSamplePublic(value);
}

/** Encode a public sample into the compact v5 storage representation. */
export function encodeWorkSample(value: WorkSample): StoredWorkSample {
  const sample = validateSamplePublic(value);
  const ranking = normalizeRankingFields({
    rank: sample.metrics.rank,
    rankingStatus: sample.rankingStatus,
    rankingObservedAt: sample.rankingObservedAt,
    rankingSource: sample.rankingSource,
  });
  const normalized: WorkSample = {
    ...sample,
    metrics: { ...sample.metrics, rank: ranking.rank },
    rankingStatus: ranking.rankingStatus,
    rankingObservedAt: ranking.rankingStatus === "unknown" ? null : ranking.rankingObservedAt,
    rankingSource: ranking.rankingStatus === "unknown" ? null : ranking.rankingSource,
  };
  const stored: StoredWorkSample = {
    ...(normalized.id === undefined ? {} : { id: normalized.id }),
    k: storedSampleIdentityFor(normalized),
    w: normalized.workKey,
    r: normalized.runId,
    t: normalized.collectedAt,
    m: [
      normalized.metrics.likes,
      normalized.metrics.bookmarks,
      normalized.metrics.views,
      normalized.metrics.comments,
      normalized.metrics.rank,
      normalized.metrics.responses,
      normalized.metrics.illustrations,
    ],
    s: rankingStatusCode(ranking.rankingStatus),
    o: ranking.rankingStatus === "unknown" ? null : ranking.rankingObservedAt,
    p: rankingSourceCode(ranking.rankingStatus === "unknown" ? null : ranking.rankingSource),
    v: normalized.parserVersion,
    q: normalized.dataQuality,
    y: kindCode(normalized.kind),
    codec: WORK_SAMPLE_CODEC,
    codecVersion: WORK_SAMPLE_CODEC_VERSION,
  };
  if (normalized.compactionLevel !== undefined) stored.c = normalized.compactionLevel;
  if (normalized.rollupSourceCollectedAt !== undefined) stored.x = normalized.rollupSourceCollectedAt;
  return stored;
}

export const encodeSample = encodeWorkSample;
export const decodeSample = decodeWorkSample;
export const encodeStoredSample = encodeWorkSample;
export const decodeStoredSampleRow = decodeWorkSample;

export function encodeWorkState(record: WorkRecord): WorkState {
  const document = encodeWorkDocument(record);
  const metrics = validateMetrics(record.metrics);
  const ranking = normalizeRankingFields({
    rank: metrics.rank,
    rankingStatus: record.rankingStatus,
    rankingObservedAt: record.rankingObservedAt,
    rankingSource: record.rankingSource,
  });
  const normalizedMetrics = { ...metrics, rank: ranking.rank };
  const values: WorkStateValues = [
    normalizedMetrics.likes,
    normalizedMetrics.bookmarks,
    normalizedMetrics.views,
    normalizedMetrics.comments,
    normalizedMetrics.rank,
    normalizedMetrics.responses,
    normalizedMetrics.illustrations,
    rankingStatusCode(ranking.rankingStatus),
    ranking.rankingStatus === "unknown" ? null : ranking.rankingObservedAt,
    rankingSourceCode(ranking.rankingStatus === "unknown" ? null : ranking.rankingSource),
    nonEmptyString(record.lastSeenAt, "work state lastSeenAt"),
    nonEmptyString(record.lastObservedRunId, "work state lastObservedRunId"),
    nullableTimestamp(record.absentSince, "work state absentSince"),
  ];
  // Keep the document validation in the encode path; this also prevents a
  // malformed record from producing a state that can never be materialized.
  if (document.key !== record.key) fail("WorkDocument key mismatch");
  return { key: document.key, version: WORK_STATE_VERSION, values };
}

export function decodeWorkState(value: unknown, expectedKey?: string): WorkState {
  if (!isRecord(value)) fail("Missing or malformed WorkState");
  const key = nonEmptyString(value.key, "work state key");
  if (expectedKey !== undefined && key !== expectedKey) fail("WorkState key mismatch");
  if (value.version !== WORK_STATE_VERSION) fail("Unknown WorkState version");
  if (!Array.isArray(value.values) || value.values.length !== 13) fail("Malformed WorkState tuple");
  const values = value.values;
  const metrics = values.slice(0, 7).map((item, index) => finiteNumberOrNull(item, `work state metric ${index}`));
  const status = values[7];
  const observedAt = values[8];
  const source = values[9];
  const lastSeenAt = values[10];
  const lastObservedRunId = values[11];
  const absentSince = values[12];
  if (status !== 0 && status !== 1 && status !== 2) fail("Invalid WorkState ranking status code");
  if (source !== 0 && source !== 1 && source !== 2) fail("Invalid WorkState ranking source code");
  const rankingStatus = rankingStatusFromCode(status);
  const rankingObservedAt = rankingStatus === "unknown" ? (observedAt === null ? null : fail("Unknown ranking must have null observedAt")) : nullableTimestamp(observedAt, "work state rankingObservedAt");
  if (typeof lastSeenAt !== "string" || !lastSeenAt || !Number.isFinite(Date.parse(lastSeenAt))) fail("Invalid WorkState lastSeenAt");
  if (typeof lastObservedRunId !== "string" || !lastObservedRunId) fail("Invalid WorkState lastObservedRunId");
  const normalizedAbsentSince = nullableTimestamp(absentSince, "work state absentSince");
  const tuple = [
    ...metrics,
    status,
    rankingObservedAt,
    source,
    lastSeenAt,
    lastObservedRunId,
    normalizedAbsentSince,
  ] as WorkStateValues;
  return { key, version: WORK_STATE_VERSION, values: tuple };
}

export function materializeWorkRecord(documentValue: unknown, stateValue: unknown): WorkRecord {
  const document = decodeWorkDocument(documentValue);
  if (stateValue === undefined || stateValue === null) fail(`Missing WorkState for ${document.key}`);
  const state = decodeWorkState(stateValue, document.key);
  const values = state.values;
  const rankingStatus = rankingStatusFromCode(values[7]);
  const rankingSource = rankingSourceFromCode(values[9]);
  const metrics: WorkMetrics = {
    likes: values[0],
    bookmarks: values[1],
    views: values[2],
    comments: values[3],
    rank: values[4],
    responses: values[5],
    illustrations: values[6],
  };
  return {
    ...document,
    metrics,
    rankingStatus,
    rankingObservedAt: rankingStatus === "unknown" ? null : values[8],
    rankingSource: rankingStatus === "unknown" ? null : rankingSource,
    lastSeenAt: values[10],
    lastObservedRunId: values[11],
    absentSince: values[12],
  };
}

export interface PackedWorkKeys {
  illust: string[];
  novel: string[];
  legacy: string[];
}

export interface StoredObservationBatch {
  runId: string;
  observedAt: string;
  scope: ObservationBatch["scope"];
  codec: typeof OBSERVATION_BATCH_CODEC;
  codecVersion: typeof OBSERVATION_BATCH_CODEC_VERSION;
  workKeys: PackedWorkKeys;
  changedWorkKeys: PackedWorkKeys;
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function packWorkKeys(keys: Iterable<string>): PackedWorkKeys {
  const illust: string[] = [];
  const novel: string[] = [];
  const legacy: string[] = [];
  for (const key of sortUnique(keys)) {
    const illustMatch = /^illust-(\d+)$/.exec(key);
    if (illustMatch) {
      illust.push(illustMatch[1]!);
      continue;
    }
    const novelMatch = /^novel-(\d+)$/.exec(key);
    if (novelMatch) {
      novel.push(novelMatch[1]!);
      continue;
    }
    if (key.length === 0) fail("Invalid empty legacy work key");
    legacy.push(key);
  }
  return { illust, novel, legacy };
}

function unpackWorkKeys(value: unknown, field: string): string[] {
  if (!isRecord(value)) fail(`Invalid packed ${field}`);
  const illust = stringArray(value.illust, `${field}.illust`);
  const novel = stringArray(value.novel, `${field}.novel`);
  const legacy = stringArray(value.legacy, `${field}.legacy`);
  if (illust.some((id) => !/^\d+$/.test(id)) || novel.some((id) => !/^\d+$/.test(id))) {
    fail(`Invalid packed ${field} id`);
  }
  const keys = [
    ...illust.map((id) => `illust-${id}`),
    ...novel.map((id) => `novel-${id}`),
    ...legacy,
  ];
  if (new Set(keys).size !== keys.length) fail(`Duplicate packed ${field} key`);
  return sortUnique(keys);
}

function validateBatchHeader(value: Record<string, unknown>): { runId: string; observedAt: string; scope: ObservationBatch["scope"] } {
  const runId = nonEmptyString(value.runId, "observation batch runId");
  const observedAt = nonEmptyString(value.observedAt, "observation batch observedAt");
  if (value.scope !== "complete" && value.scope !== "partial") fail("Invalid observation batch scope");
  return { runId, observedAt, scope: value.scope };
}

function normalizeBatch(header: { runId: string; observedAt: string; scope: ObservationBatch["scope"] }, workKeys: string[], changedWorkKeys: string[]): ObservationBatch {
  const observed = sortUnique(workKeys);
  const observedSet = new Set(observed);
  const changed = sortUnique(changedWorkKeys);
  if (changed.some((key) => !observedSet.has(key))) fail("Observation batch changed keys are not a subset of work keys");
  return { ...header, workKeys: observed, changedWorkKeys: changed };
}

/** Encode a public batch into the compact v4 representation. Unencodable
 * keys stay in the tagged legacy group instead of being silently discarded. */
export function encodeObservationBatch(batch: ObservationBatch): StoredObservationBatch {
  if (!batch || typeof batch !== "object") fail("Missing observation batch");
  const header = validateBatchHeader(batch as unknown as Record<string, unknown>);
  const workKeys = stringArray(batch.workKeys, "observation batch workKeys");
  const changedWorkKeys = stringArray(batch.changedWorkKeys, "observation batch changedWorkKeys");
  const normalized = normalizeBatch(header, workKeys, changedWorkKeys);
  return {
    ...header,
    codec: OBSERVATION_BATCH_CODEC,
    codecVersion: OBSERVATION_BATCH_CODEC_VERSION,
    workKeys: packWorkKeys(normalized.workKeys),
    changedWorkKeys: packWorkKeys(normalized.changedWorkKeys),
  };
}

/** Decode both the v4 packed shape and v3's plain array shape. */
export function decodeObservationBatch(value: unknown): ObservationBatch {
  if (!isRecord(value)) fail("Missing or malformed observation batch");
  const header = validateBatchHeader(value);
  const hasCodec = "codec" in value || "codecVersion" in value;
  if (!hasCodec) {
    return normalizeBatch(header, stringArray(value.workKeys, "legacy observation batch workKeys"), stringArray(value.changedWorkKeys, "legacy observation batch changedWorkKeys"));
  }
  if (value.codec !== OBSERVATION_BATCH_CODEC || value.codecVersion !== OBSERVATION_BATCH_CODEC_VERSION) {
    fail("Unknown observation batch codec");
  }
  const workKeys = unpackWorkKeys(value.workKeys, "workKeys");
  const changedWorkKeys = unpackWorkKeys(value.changedWorkKeys, "changedWorkKeys");
  return normalizeBatch(header, workKeys, changedWorkKeys);
}

/** Canonical public batch material for import conflict checks and retention
 * compare-and-set validation. Decoding first makes packed and legacy rows
 * compare identically. */
export function canonicalObservationBatch(value: ObservationBatch): string {
  const batch = decodeObservationBatch(value);
  return JSON.stringify({
    runId: batch.runId,
    observedAt: batch.observedAt,
    scope: batch.scope,
    workKeys: batch.workKeys,
    changedWorkKeys: batch.changedWorkKeys,
  });
}

export const canonicalBatch = canonicalObservationBatch;

export function observationBatchCanonicalHash(value: ObservationBatch): string {
  return fnv64(canonicalObservationBatch(value));
}

export const canonicalBatchHash = observationBatchCanonicalHash;

export function encodeStoredObservationBatch(value: unknown): StoredObservationBatch {
  return encodeObservationBatch(decodeObservationBatch(value));
}

export const packObservationBatch = encodeObservationBatch;
export const unpackObservationBatch = decodeObservationBatch;
