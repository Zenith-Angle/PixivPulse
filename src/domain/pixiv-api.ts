import { getPageFingerprint } from "./parser";
import { PARSER_VERSION } from "./constants";
import { normalizePixivDateTime } from "./time";
import { normalizeRankingFields, normalizeWorkContentType } from "./types";
import type { PagePayload, ParsedWork, PixivAccount, WorkMetrics, WorkType } from "./types";
import type { SyncErrorCode } from "./types";

export const PIXIV_API_ORIGIN = "https://www.pixiv.net";
export const PIXIV_SELF_PATH = "/ajax/user/self";
export const PIXIV_WORK_TYPES = ["illust", "novel"] as const;
export const API_TIMEOUT_MS = 20_000;
export const API_JITTER_MIN_MS = 400;
export const API_JITTER_MAX_MS = 900;
export const API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const API_MAX_RANGES = 200;
export const API_MAX_RANGE_LIMIT = 200;
export const API_MAX_REQUESTS = 1 + PIXIV_WORK_TYPES.length + API_MAX_RANGES;
export const API_MAX_WORKS = 10_000;

const METRIC_KEYS = ["viewCount", "ratingCount", "bookmarkCount", "commentCount"] as const;
type ApiMetricKey = (typeof METRIC_KEYS)[number];
const RANKING_KEYS = ["rank", "ranking", "rankingPosition"] as const;

export type PixivApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PixivApiCollectorOptions {
  fetch?: PixivApiFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRanges?: number;
  maxRangeLimit?: number;
  maxRequests?: number;
  maxWorks?: number;
  signal?: AbortSignal;
}

export interface PixivFollowerCount {
  accountId: string;
  followers: number;
  collectedAt: string;
}

export class PixivApiError extends Error {
  readonly code: SyncErrorCode;
  readonly status?: number;

  constructor(code: SyncErrorCode, message: string, status?: number) {
    super(message);
    this.name = "PixivApiError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

interface ApiWork {
  id: string;
  type: WorkType;
  values: Record<string, unknown>;
}

interface ApiRange {
  offset: number;
  limit: number;
}

interface StrategyData {
  type: WorkType;
  works: ApiWork[];
  ranges: ApiRange[];
  thumbnails: unknown;
}

interface RequestContext {
  fetch: PixivApiFetch;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  now: () => number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRanges: number;
  maxRangeLimit: number;
  maxRequests: number;
  maxWorks: number;
  signal: AbortSignal;
  deadline: number;
  requests: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

function fail(code: SyncErrorCode, message: string, status?: number): never {
  throw new PixivApiError(code, message, status);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function createAbortSignal(options: PixivApiCollectorOptions, timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail("SCHEMA_DRIFT", `${field} is not a valid Pixiv id`);
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  fail("SCHEMA_DRIFT", `${field} is not a valid Pixiv id`);
}

function readId(record: Record<string, unknown>): string {
  const workId = record.workId;
  const id = record.id;
  if (workId !== undefined && id !== undefined && normalizeId(workId, "workId") !== normalizeId(id, "id")) {
    fail("SCHEMA_DRIFT", "Pixiv work id fields disagree");
  }
  if (workId !== undefined) return normalizeId(workId, "workId");
  if (id !== undefined) return normalizeId(id, "id");
  fail("SCHEMA_DRIFT", "Pixiv work id is missing");
}

function readWorkType(record: Record<string, unknown>, expected: WorkType): WorkType {
  const values = [record.workType, record.type].filter((value) => value !== undefined);
  for (const value of values) {
    if (typeof value !== "string" || (value !== "illust" && value !== "novel")) {
      fail("SCHEMA_DRIFT", "Pixiv work type is invalid");
    }
    if (value !== expected) fail("SCHEMA_DRIFT", "Pixiv work type does not match its endpoint");
  }
  return expected;
}

function readNonNegativeInteger(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail("SCHEMA_DRIFT", `${field} is not a valid count`);
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  fail("SCHEMA_DRIFT", `${field} is not a valid count`);
}

function readOptionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value == null) return null;
  if (typeof value !== "string") fail("SCHEMA_DRIFT", `${field} is not text`);
  return value;
}

function readOptionalBoolean(value: unknown, field: string): boolean | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  const count = readNonNegativeInteger(value, field);
  return count == null ? null : count > 0;
}

function parseApiWork(value: unknown, expectedType: WorkType): ApiWork {
  if (!isRecord(value)) fail("SCHEMA_DRIFT", "Pixiv work entry is not an object");
  const id = readId(value);
  const type = readWorkType(value, expectedType);
  for (const key of METRIC_KEYS) {
    if (key in value) readNonNegativeInteger(value[key], key);
  }
  for (const key of ["title", "seriesTitle", "createDate", "url", "description", "caption"] as const) {
    if (key in value) readOptionalString(value, key);
  }
  if ("pageCount" in value) readNonNegativeInteger(value.pageCount, "pageCount");
  if ("wordCount" in value) readNonNegativeInteger(value.wordCount, "wordCount");
  if ("textCount" in value) readNonNegativeInteger(value.textCount, "textCount");
  if ("illustType" in value) readNonNegativeInteger(value.illustType, "illustType");
  if ("aiType" in value) readOptionalBoolean(value.aiType, "aiType");
  if ("xRestrict" in value) readOptionalBoolean(value.xRestrict, "xRestrict");
  return { id, type, values: { ...value, workId: id, workType: type } };
}

function parseRange(value: unknown, maxRangeLimit: number): ApiRange {
  let offsetValue: unknown;
  let limitValue: unknown;
  if (Array.isArray(value) && value.length === 2) {
    [offsetValue, limitValue] = value;
  } else if (isRecord(value)) {
    offsetValue = value.offset;
    limitValue = value.limit;
  } else {
    fail("SCHEMA_DRIFT", "Pixiv fetch range is invalid");
  }
  const offset = readNonNegativeInteger(offsetValue, "range offset");
  const limit = readNonNegativeInteger(limitValue, "range limit");
  if (offset == null || limit == null || limit < 1 || limit > maxRangeLimit) {
    fail("SCHEMA_DRIFT", "Pixiv fetch range is outside the safety bounds");
  }
  return { offset, limit };
}

export function validatePixivFetchRanges(
  value: unknown,
  options: { maxRanges?: number; maxRangeLimit?: number } = {},
): ApiRange[] {
  if (!Array.isArray(value)) fail("SCHEMA_DRIFT", "Pixiv fetchRanges is not an array");
  const maxRanges = boundedInteger(options.maxRanges, API_MAX_RANGES, API_MAX_RANGES);
  const maxRangeLimit = boundedInteger(options.maxRangeLimit, API_MAX_RANGE_LIMIT, API_MAX_RANGE_LIMIT);
  if (value.length > maxRanges) fail("MAX_PAGES", "Pixiv returned too many API fetch ranges");
  const ranges = value.map((item) => parseRange(item, maxRangeLimit));
  const ordered = [...ranges].sort((left, right) => left.offset - right.offset);
  let expectedOffset = 0;
  for (const range of ordered) {
    if (range.offset !== expectedOffset) fail("SCHEMA_DRIFT", "Pixiv fetch ranges overlap or contain a gap");
    expectedOffset += range.limit;
  }
  return ordered;
}

function envelopeData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("SCHEMA_DRIFT", "Pixiv API envelope is not an object");
  const body = isRecord(value.body) ? value.body : null;
  const data = body && isRecord(body.data) ? body.data : isRecord(value.data) ? value.data : null;
  if (!data) fail("SCHEMA_DRIFT", "Pixiv API data envelope is missing");
  return data;
}

function envelopeThumbnails(value: unknown, data: Record<string, unknown>): unknown {
  if (data.thumbnails !== undefined) return data.thumbnails;
  if (isRecord(value) && isRecord(value.body) && value.body.thumbnails !== undefined) return value.body.thumbnails;
  if (isRecord(value) && value.thumbnails !== undefined) return value.thumbnails;
  return undefined;
}

function ensureNoErrorEnvelope(value: unknown): void {
  if (!isRecord(value)) return;
  if (value.error && value.error !== false) fail("SCHEMA_DRIFT", "Pixiv API returned an error envelope");
  if (isRecord(value.body) && value.body.error && value.body.error !== false) {
    fail("SCHEMA_DRIFT", "Pixiv API returned an error envelope");
  }
}

/** Parse only the follower total. The endpoint also returns user records, but
 * those records are intentionally outside this collector's data contract. */
export function parsePixivFollowerCount(value: unknown): number {
  ensureNoErrorEnvelope(value);
  if (!isRecord(value) || !isRecord(value.body) || !("total" in value.body)) {
    fail("SCHEMA_DRIFT", "Pixiv follower count is missing from the API envelope");
  }
  const followers = readNonNegativeInteger(value.body.total, "body.total");
  if (followers == null) fail("SCHEMA_DRIFT", "Pixiv follower count is invalid");
  return followers;
}

export function parsePixivSelfAccount(value: unknown): PixivAccount {
  ensureNoErrorEnvelope(value);
  if (!isRecord(value) || !isRecord(value.userData)) fail("SCHEMA_DRIFT", "Pixiv self account data is missing");
  const id = normalizeId(value.userData.id, "userData.id");
  const nameValue = value.userData.name;
  if (nameValue != null && typeof nameValue !== "string") fail("SCHEMA_DRIFT", "Pixiv account name is invalid");
  return {
    id,
    name: nameValue ?? "",
    profileUrl: `${PIXIV_API_ORIGIN}/users/${id}`,
  };
}

function parseStrategy(value: unknown, type: WorkType, options: RequestContext): StrategyData {
  ensureNoErrorEnvelope(value);
  const data = envelopeData(value);
  if (!Array.isArray(data.works)) fail("SCHEMA_DRIFT", "Pixiv strategy works is not an array");
  const works = data.works.map((item) => parseApiWork(item, type));
  const ranges = validatePixivFetchRanges(data.fetchRanges, options);
  return { type, works, ranges, thumbnails: envelopeThumbnails(value, data) };
}

function isChallengeBody(text: string, contentType: string): boolean {
  if (contentType.toLocaleLowerCase().includes("text/html")) return true;
  return /captcha|challenge|verify you are human|unusual traffic|robot check/i.test(text);
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === "AbortError";
}

function byteLength(text: string): number {
  return typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).byteLength;
}

function assertBudget(context: RequestContext): void {
  if (context.signal.aborted || context.now() >= context.deadline) fail("PAGE_TIMEOUT", "Pixiv API synchronization exceeded its time budget");
}

function sleepWithSignal(context: RequestContext, milliseconds: number): Promise<void> {
  assertBudget(context);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(new PixivApiError("PAGE_TIMEOUT", "Pixiv API synchronization exceeded its time budget"));
    context.signal.addEventListener("abort", onAbort, { once: true });
    void context.sleep(milliseconds).then(() => finish()).catch((error: unknown) => finish(error));
  });
}

async function waitBetweenRequests(context: RequestContext): Promise<void> {
  const random = Math.max(0, Math.min(0.999999, context.random()));
  const delay = API_JITTER_MIN_MS + Math.floor(random * (API_JITTER_MAX_MS - API_JITTER_MIN_MS + 1));
  await sleepWithSignal(context, delay);
}

function isAllowedFollowerPath(path: string): boolean {
  let url: URL;
  try {
    url = new URL(path, PIXIV_API_ORIGIN);
  } catch {
    return false;
  }
  if (url.origin !== PIXIV_API_ORIGIN || !/^\/ajax\/user\/\d+\/followers$/.test(url.pathname)) return false;
  const entries = [...url.searchParams.entries()];
  if (entries.length < 2 || entries.length > 3) return false;
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "offset" && value === "0") continue;
    if (key === "limit" && value === "24") continue;
    if (key === "lang" && value === "zh") continue;
    return false;
  }
  return seen.has("offset") && seen.has("limit") && (seen.size === 2 || seen.has("lang"));
}

function isAllowedPath(path: string): boolean {
  if (isAllowedFollowerPath(path)) return true;
  const pathname = path.split("?", 1)[0];
  if (pathname === PIXIV_SELF_PATH) return true;
  return PIXIV_WORK_TYPES.some((type) => pathname === `/ajax/dashboard/works/${type}/request_strategy` || pathname === `/ajax/dashboard/works/${type}`);
}

async function requestJson(context: RequestContext, path: string): Promise<unknown> {
  if (!isAllowedPath(path)) fail("SCHEMA_DRIFT", "Pixiv API endpoint is outside the allowlist");
  if (context.requests >= context.maxRequests) fail("MAX_PAGES", "Pixiv API request safety ceiling was reached");
  assertBudget(context);
  context.requests += 1;
  const url = new URL(path, PIXIV_API_ORIGIN);
  let response: Response;
  try {
    response = await context.fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof PixivApiError) throw error;
    if (context.signal.aborted || isAbortError(error)) {
      fail("PAGE_TIMEOUT", "Pixiv API request timed out");
    }
    fail("UNKNOWN", "Pixiv API request failed");
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    fail("SCHEMA_DRIFT", "Pixiv API redirected unexpectedly", response.status);
  }
  if (response.status === 429) fail("RATE_LIMITED", "Pixiv API rate limit was reached", response.status);
  if (response.status === 401) fail("AUTH_REQUIRED", "Pixiv API authentication is required", response.status);
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > context.maxResponseBytes) {
    fail("STORAGE_LIMIT", "Pixiv API response exceeded the safety byte limit", response.status);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (context.signal.aborted || isAbortError(error)) {
      fail("PAGE_TIMEOUT", "Pixiv API response timed out");
    }
    fail("UNKNOWN", "Pixiv API response could not be read");
  }
  if (byteLength(text) > context.maxResponseBytes) fail("STORAGE_LIMIT", "Pixiv API response exceeded the safety byte limit", response.status);
  assertBudget(context);
  if (response.status === 403 && isChallengeBody(text, contentType)) fail("CHALLENGE", "Pixiv requires a challenge check", response.status);
  if (response.status === 403) fail("SCHEMA_DRIFT", "Pixiv API access was forbidden", response.status);
  if (!response.ok) fail("UNKNOWN", `Pixiv API returned HTTP ${response.status}`, response.status);
  if (!contentType.toLocaleLowerCase().includes("application/json")) fail("SCHEMA_DRIFT", "Pixiv API returned a non-JSON response", response.status);
  try {
    const value: unknown = JSON.parse(text);
    ensureNoErrorEnvelope(value);
    return value;
  } catch (error) {
    if (error instanceof PixivApiError) throw error;
    fail("SCHEMA_DRIFT", "Pixiv API returned invalid JSON", response.status);
  }
}

function mergeWork(left: ApiWork, right: ApiWork): ApiWork {
  const values = { ...left.values };
  for (const [key, value] of Object.entries(right.values)) {
    if (value != null || values[key] == null) values[key] = value;
  }
  return { ...left, values };
}

function thumbnailId(value: Record<string, unknown>, keyHint: string | undefined): string | null {
  if (value.workId !== undefined || value.id !== undefined) return readId(value);
  if (keyHint && /^\d+$/.test(keyHint)) return keyHint;
  return null;
}

function flattenThumbnails(
  value: unknown,
  fallbackType: WorkType,
  keyHint: string | undefined,
  output: Array<{ type: WorkType; id: string; value: Record<string, unknown> }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenThumbnails(item, fallbackType, undefined, output);
    return;
  }
  if (!isRecord(value)) return;
  const keyType = keyHint === "illust" || keyHint === "novel" ? keyHint : fallbackType;
  const id = thumbnailId(value, keyHint);
  if (id != null) {
    const type = readWorkType(value, keyType);
    output.push({ type, id, value });
    return;
  }
  for (const [key, child] of Object.entries(value)) flattenThumbnails(child, keyType, key, output);
}

function addThumbnails(target: Map<string, Record<string, unknown>>, value: unknown, type: WorkType): void {
  const flattened: Array<{ type: WorkType; id: string; value: Record<string, unknown> }> = [];
  flattenThumbnails(value, type, undefined, flattened);
  for (const thumbnail of flattened) {
    const key = `${thumbnail.type}:${thumbnail.id}`;
    if (!target.has(key)) target.set(key, thumbnail.value);
  }
}

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function cleanDescription(...values: Array<unknown>): string | null {
  const value = firstString(...values);
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000) || null;
}

function firstCount(...values: Array<unknown>): number | null {
  for (const value of values) {
    const parsed = readNonNegativeInteger(value, "work count");
    if (parsed != null) return parsed;
  }
  return null;
}

function firstPositiveRanking(...values: Array<unknown>): number | null {
  for (const value of values) {
    if (typeof value === "number") {
      if (Number.isSafeInteger(value) && value > 0) return value;
      continue;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function dateValue(...values: Array<unknown>): string | null {
  const value = firstString(...values);
  return value ? normalizePixivDateTime(value) : null;
}

function buildMetrics(values: Record<string, unknown>, thumbnail: Record<string, unknown> | undefined): WorkMetrics {
  const source = (key: ApiMetricKey): unknown => values[key] ?? thumbnail?.[key];
  const ranking = firstPositiveRanking(
    ...RANKING_KEYS.map((key) => values[key]),
    ...RANKING_KEYS.map((key) => thumbnail?.[key]),
  );
  return {
    views: firstCount(source("viewCount")),
    likes: firstCount(source("ratingCount")),
    bookmarks: firstCount(source("bookmarkCount")),
    comments: firstCount(source("commentCount")),
    rank: ranking,
    responses: null,
    illustrations: null,
  };
}

function toParsedWork(work: ApiWork, thumbnails: Map<string, Record<string, unknown>>, collectedAt: string): ParsedWork {
  const thumbnail = thumbnails.get(`${work.type}:${work.id}`);
  const values = work.values;
  const title = firstString(thumbnail?.title, values.title) ?? "";
  const publishedAt = dateValue(thumbnail?.createDate, values.createDate);
  const wordCount = firstCount(thumbnail?.wordCount, thumbnail?.textCount, values.wordCount, values.textCount);
  const pageCount = firstCount(thumbnail?.pageCount, values.pageCount);
  const isAi = readOptionalBoolean(thumbnail?.aiType ?? values.aiType, "aiType");
  const isR18 = readOptionalBoolean(thumbnail?.xRestrict ?? values.xRestrict, "xRestrict");
  const thumbnailUrl = firstString(thumbnail?.url, values.url);
  const contentType = normalizeWorkContentType(thumbnail?.illustType ?? values.illustType, work.type);
  const description = cleanDescription(thumbnail?.description, thumbnail?.caption, values.description, values.caption);
  const metrics = buildMetrics(values, thumbnail);
  const ranking = normalizeRankingFields({
    rank: metrics.rank,
    rankingStatus: metrics.rank == null ? "unknown" : "ranked",
    rankingObservedAt: metrics.rank == null ? null : collectedAt,
    rankingSource: metrics.rank == null ? null : "api",
  });
  const missingFields = Object.entries(metrics).filter(([, value]) => value == null).map(([key]) => key);
  if (!title) missingFields.push("title");
  return {
    id: work.id,
    type: work.type,
    contentType,
    description,
    title,
    seriesTitle: firstString(thumbnail?.seriesTitle, values.seriesTitle),
    publishedAt,
    wordCount,
    pageCount,
    isAi,
    isR18,
    thumbnailUrl,
    workUrl: work.type === "illust"
      ? `${PIXIV_API_ORIGIN}/artworks/${work.id}`
      : `${PIXIV_API_ORIGIN}/novel/show.php?id=${work.id}`,
    metrics,
    rankingStatus: ranking.rankingStatus,
    rankingObservedAt: ranking.rankingObservedAt,
    rankingSource: ranking.rankingSource,
    rawLabels: {},
    missingFields,
    parserVersion: PARSER_VERSION,
  };
}

function makeContext(options: PixivApiCollectorOptions): { context: RequestContext; cleanup: () => void } {
  const timeoutMs = boundedInteger(options.timeoutMs, API_TIMEOUT_MS, API_TIMEOUT_MS);
  const { controller, cleanup } = createAbortSignal(options, timeoutMs);
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetcher) fail("UNKNOWN", "Fetch is unavailable in the Pixiv service worker");
  const now = options.now ?? Date.now;
  const context: RequestContext = {
    fetch: fetcher,
    sleep: options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    random: options.random ?? Math.random,
    now,
    timeoutMs,
    maxResponseBytes: boundedInteger(options.maxResponseBytes, API_MAX_RESPONSE_BYTES, API_MAX_RESPONSE_BYTES),
    maxRanges: boundedInteger(options.maxRanges, API_MAX_RANGES, API_MAX_RANGES),
    maxRangeLimit: boundedInteger(options.maxRangeLimit, API_MAX_RANGE_LIMIT, API_MAX_RANGE_LIMIT),
    maxRequests: boundedInteger(options.maxRequests, API_MAX_REQUESTS, API_MAX_REQUESTS),
    maxWorks: boundedInteger(options.maxWorks, API_MAX_WORKS, API_MAX_WORKS),
    signal: controller.signal,
    deadline: now() + timeoutMs,
    requests: 0,
  };
  return { context, cleanup };
}

/** Collect the account and all dashboard works through Pixiv's read-only API. */
export async function collectPixivDashboardPage(
  runId: string,
  options: PixivApiCollectorOptions = {},
): Promise<PagePayload> {
  const { context, cleanup } = makeContext(options);
  try {
    const account = parsePixivSelfAccount(await requestJson(context, PIXIV_SELF_PATH));
    const strategies: StrategyData[] = [];
    for (const type of PIXIV_WORK_TYPES) {
      await waitBetweenRequests(context);
      strategies.push(parseStrategy(await requestJson(context, `/ajax/dashboard/works/${type}/request_strategy`), type, context));
    }

    const works = new Map<string, ApiWork>();
    const rangeWorkIds = new Set<string>();
    const thumbnails = new Map<string, Record<string, unknown>>();
    let rangeCount = 0;
    let sourceWorkCount = 0;
    for (const strategy of strategies) {
      addThumbnails(thumbnails, strategy.thumbnails, strategy.type);
      for (const work of strategy.works) {
        sourceWorkCount += 1;
        if (sourceWorkCount > context.maxWorks) fail("STORAGE_LIMIT", "Pixiv returned too many works");
        const key = `${work.type}:${work.id}`;
        if (works.has(key)) fail("SCHEMA_DRIFT", "Pixiv strategy returned a duplicate work");
        works.set(key, work);
      }
      rangeCount += strategy.ranges.length;
      if (rangeCount > context.maxRanges) fail("MAX_PAGES", "Pixiv returned too many API fetch ranges");
    }

    for (const strategy of strategies) {
      for (const range of strategy.ranges) {
        await waitBetweenRequests(context);
        const query = new URLSearchParams({ offset: String(range.offset), limit: String(range.limit) });
        const value = await requestJson(context, `/ajax/dashboard/works/${strategy.type}?${query.toString()}`);
        const data = envelopeData(value);
        if (!Array.isArray(data.works)) fail("SCHEMA_DRIFT", "Pixiv range works is not an array");
        for (const item of data.works) {
          sourceWorkCount += 1;
          if (sourceWorkCount > context.maxWorks) fail("STORAGE_LIMIT", "Pixiv returned too many works");
          const work = parseApiWork(item, strategy.type);
          const key = `${work.type}:${work.id}`;
          if (rangeWorkIds.has(key)) fail("SCHEMA_DRIFT", "Pixiv ranges returned a duplicate work");
          rangeWorkIds.add(key);
          const previous = works.get(key);
          works.set(key, previous ? mergeWork(previous, work) : work);
        }
        addThumbnails(thumbnails, envelopeThumbnails(value, data), strategy.type);
      }
    }

    const collectedAt = new Date(context.now()).toISOString();
    const parsedWorks = [...works.values()].map((work) => toParsedWork(work, thumbnails, collectedAt));
    const quality = {
      totalCards: parsedWorks.length,
      validCards: parsedWorks.length,
      missingRequired: parsedWorks.filter((work) => !work.title || !work.workUrl).length,
      missingMetricFields: parsedWorks.reduce((sum, work) => sum + Object.values(work.metrics).filter((value) => value == null).length, 0),
    };
    const payload: PagePayload = {
      runId,
      page: 1,
      pageCount: 1,
      hasNext: false,
      positivelyEmpty: parsedWorks.length === 0,
      fingerprint: "",
      works: parsedWorks,
      account,
      parserVersion: PARSER_VERSION,
      collectedAt,
      quality,
    };
    payload.fingerprint = getPageFingerprint(payload);
    return payload;
  } finally {
    cleanup();
  }
}

/** Collect one account follower total through Pixiv's read-only endpoint. */
export async function collectPixivFollowerCount(
  accountId: string,
  options: PixivApiCollectorOptions = {},
): Promise<PixivFollowerCount> {
  if (typeof accountId !== "string" || !/^\d+$/.test(accountId)) {
    fail("SCHEMA_DRIFT", "Pixiv account id is not a numeric id");
  }
  const { context, cleanup } = makeContext({ ...options, maxRequests: 1 });
  try {
    await waitBetweenRequests(context);
    const value = await requestJson(
      context,
      `/ajax/user/${accountId}/followers?offset=0&limit=24&lang=zh`,
    );
    return {
      accountId,
      followers: parsePixivFollowerCount(value),
      collectedAt: new Date(context.now()).toISOString(),
    };
  } finally {
    cleanup();
  }
}

export const collectPixivApiPage = collectPixivDashboardPage;
export const collectPixivPage = collectPixivDashboardPage;
export const collectPixivApi = collectPixivDashboardPage;
export const collectPixivDashboard = collectPixivDashboardPage;
export const parseSelfAccount = parsePixivSelfAccount;
