import {
  ALLOWED_IMAGE_HOST,
  COVER_CACHE_BATCH_SIZE,
  COVER_CACHE_FETCH_TIMEOUT_MS,
  COVER_CACHE_INTER_IMAGE_DELAY_MS,
  COVER_CACHE_MAX_BLOB_BYTES,
  COVER_CACHE_MAX_READY_BYTES,
  COVER_CACHE_MAX_SOURCE_BYTES,
  COVER_CACHE_PIPELINE_VERSION,
} from "./constants";
import type { CoverCacheSummary, CoverRecord, CoverStatus } from "./types";
import { validateUsableCoverRecord } from "./cover-queue";

export {
  isUsableCoverRecord,
  isUsableReadyCover,
  isValidCoverRecord,
  validateCoverRecord,
  validateUsableCoverRecord,
} from "./cover-queue";
export type {
  CoverQueueValidationCode,
  CoverQueueValidationExpectation,
  CoverQueueValidationResult,
} from "./cover-queue";

export interface CoverImageAsset {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
}

export class CoverCacheError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CoverCacheError";
    this.code = code;
  }
}

/** Only the Pixiv image CDN is a valid cache source. Keep this check in the
 * domain layer as well as the repository so callers cannot accidentally turn
 * a dashboard URL or an arbitrary remote URL into a fetch. */
export function isAllowedCoverUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLocaleLowerCase() === ALLOWED_IMAGE_HOST
      && !url.username
      && !url.password
      && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

export const isAllowedCoverSourceUrl = isAllowedCoverUrl;
export const isSafeCoverUrl = isAllowedCoverUrl;

interface CoverResponseBytes {
  blob: Blob;
  bytes: number;
}

function contentLengthOf(response: Response): number | null {
  const raw = response.headers?.get("content-length") ?? null;
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoverCacheError("INVALID_CONTENT_LENGTH", "封面响应的 Content-Length 无效");
  }
  return value;
}

/** Read a response through its stream and cancel it as soon as the source
 * ceiling is crossed. This keeps large CDN responses out of memory even
 * when the server omits Content-Length. */
export async function readCoverResponse(
  response: Response,
  maxBytes = COVER_CACHE_MAX_SOURCE_BYTES,
): Promise<CoverResponseBytes> {
  const declared = contentLengthOf(response);
  if (declared != null && declared > maxBytes) {
    throw new CoverCacheError("CONTENT_LENGTH_EXCEEDED", "封面原图超过 8 MB 上限");
  }
  if (!response.ok) throw new CoverCacheError("HTTP_ERROR", `封面请求失败（${response.status}）`);

  const chunks: BlobPart[] = [];
  let bytes = 0;
  const body = response.body;
  if (body == null) {
    if (typeof response.arrayBuffer !== "function") {
      throw new CoverCacheError("STREAM_UNAVAILABLE", "封面响应不支持可读取的响应流");
    }
    const value = await response.arrayBuffer();
    bytes = value.byteLength;
    if (bytes > maxBytes) throw new CoverCacheError("BODY_TOO_LARGE", "封面原图超过 8 MB 上限");
    chunks.push(value);
  } else {
    const reader = body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const value: unknown = next.value;
        // A stream created by another realm (notably jsdom/undici in tests)
        // may fail an instanceof check even though it is a valid byte view.
        if (!(value instanceof Uint8Array) && !ArrayBuffer.isView(value)) {
          throw new CoverCacheError("INVALID_BODY", "封面响应流包含无效数据");
        }
        const view = value as ArrayBufferView;
        const chunk = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          try {
            await reader.cancel("cover source exceeds maximum size");
          } catch {
            // The stream is already over the safety ceiling; cancellation is
            // best effort when a test double or a browser stream rejects it.
          }
          throw new CoverCacheError("BODY_TOO_LARGE", "封面原图超过 8 MB 上限");
        }
        const ownedChunk = new Uint8Array(chunk.byteLength);
        ownedChunk.set(chunk);
        chunks.push(ownedChunk.buffer);
      }
    } finally {
      reader.releaseLock?.();
    }
  }
  const contentType = response.headers?.get("content-type") ?? "application/octet-stream";
  return { blob: new Blob(chunks, { type: contentType }), bytes };
}

export interface CoverBitmap {
  width: number;
  height: number;
  close?: () => void;
}

export interface CoverCanvasContext {
  drawImage: (...args: unknown[]) => void;
}

export interface CoverCanvas {
  width: number;
  height: number;
  getContext: (contextId: "2d") => CoverCanvasContext | null;
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<Blob>;
  toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

export interface CoverProcessingDependencies {
  createImageBitmap?: (source: Blob) => Promise<CoverBitmap>;
  createCanvas?: (width: number, height: number) => CoverCanvas;
  maxBlobBytes?: number;
}

function defaultCreateImageBitmap(source: Blob): Promise<CoverBitmap> {
  const create = globalThis.createImageBitmap;
  if (typeof create !== "function") {
    return Promise.reject(new CoverCacheError("BITMAP_UNAVAILABLE", "当前环境不支持图像解码"));
  }
  return create(source) as Promise<CoverBitmap>;
}

function defaultCreateCanvas(width: number, height: number): CoverCanvas {
  const Constructor = globalThis.OffscreenCanvas;
  if (typeof Constructor !== "function") {
    throw new CoverCacheError("CANVAS_UNAVAILABLE", "当前环境不支持 OffscreenCanvas");
  }
  return new Constructor(width, height) as unknown as CoverCanvas;
}

function renderedBlob(canvas: CoverCanvas, quality: number): Promise<Blob> {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/webp", quality });
  }
  const toBlob = canvas.toBlob;
  if (typeof toBlob === "function") {
    return new Promise<Blob>((resolve, reject) => {
      toBlob((blob) => blob == null
        ? reject(new CoverCacheError("COMPRESSION_FAILED", "封面压缩没有生成图像"))
        : resolve(blob), "image/webp", quality);
    });
  }
  return Promise.reject(new CoverCacheError("COMPRESSION_UNAVAILABLE", "当前环境不支持图像压缩"));
}

function scaledDimensions(width: number, height: number, ratio: number): { width: number; height: number } {
  const baseScale = Math.min(1, 320 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * baseScale * ratio)),
    height: Math.max(1, Math.round(height * baseScale * ratio)),
  };
}

/** Decode through createImageBitmap and progressively reduce quality/size
 * until the WebP is under the local-cache ceiling. */
export async function encodeCoverBlob(
  source: Blob,
  dependencies: CoverProcessingDependencies = {},
): Promise<CoverImageAsset> {
  const createBitmap = dependencies.createImageBitmap ?? defaultCreateImageBitmap;
  const createCanvas = dependencies.createCanvas ?? defaultCreateCanvas;
  const maxBlobBytes = dependencies.maxBlobBytes ?? COVER_CACHE_MAX_BLOB_BYTES;
  let bitmap: CoverBitmap | undefined;
  try {
    bitmap = await createBitmap(source);
    if (!Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0) {
      throw new CoverCacheError("INVALID_DIMENSIONS", "封面尺寸无效");
    }
    const ratios = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
    const qualities = [0.68, 0.58, 0.48, 0.38, 0.28, 0.18, 0.1];
    for (const ratio of ratios) {
      const dimensions = scaledDimensions(bitmap.width, bitmap.height, ratio);
      const canvas = createCanvas(dimensions.width, dimensions.height);
      const context = canvas.getContext("2d");
      if (!context) throw new CoverCacheError("CANVAS_CONTEXT_UNAVAILABLE", "封面画布不可用");
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
      for (const quality of qualities) {
        let output: Blob;
        try {
          output = await renderedBlob(canvas, quality);
        } catch (error) {
          if (error instanceof CoverCacheError) throw error;
          throw new CoverCacheError("COMPRESSION_FAILED", error instanceof Error ? error.message : "封面压缩失败");
        }
        if (output.size <= maxBlobBytes && output.type.toLocaleLowerCase() === "image/webp") {
          return { blob: output, width: dimensions.width, height: dimensions.height, bytes: output.size };
        }
      }
    }
    throw new CoverCacheError("OUTPUT_TOO_LARGE", "压缩后的封面仍超过 150 KB 上限");
  } catch (error) {
    if (error instanceof CoverCacheError) throw error;
    throw new CoverCacheError("DECODE_FAILED", error instanceof Error ? error.message : "封面解码失败");
  } finally {
    bitmap?.close?.();
  }
}

export interface CoverFetchOptions extends CoverProcessingDependencies {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  maxSourceBytes?: number;
  timeoutMs?: number;
}

/** Fetch and encode one cover. The caller may inject every browser primitive,
 * which keeps the pipeline deterministic in service-worker and unit tests. */
export async function fetchAndEncodeCover(
  sourceUrl: string,
  options: CoverFetchOptions = {},
): Promise<CoverImageAsset> {
  if (!isAllowedCoverUrl(sourceUrl)) throw new CoverCacheError("URL_NOT_ALLOWED", "封面地址不是 i.pximg.net HTTPS 地址");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new CoverCacheError("FETCH_UNAVAILABLE", "当前环境不支持网络请求");
  const timeoutMs = Math.max(1, options.timeoutMs ?? COVER_CACHE_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new CoverCacheError("TIMEOUT", "封面处理超过 8 秒，已停止本次尝试"));
    }, timeoutMs);
  });
  const operation = async (): Promise<CoverImageAsset> => {
    let response: Response;
    try {
      response = await fetchImpl(sourceUrl, { credentials: "omit", cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new CoverCacheError("TIMEOUT", "封面处理超过 8 秒，已停止本次尝试");
      throw new CoverCacheError("NETWORK_ERROR", error instanceof Error ? error.message : "封面网络请求失败");
    }
    const source = await readCoverResponse(response, options.maxSourceBytes ?? COVER_CACHE_MAX_SOURCE_BYTES);
    return encodeCoverBlob(source.blob, options);
  };
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export const downloadAndEncodeCover = fetchAndEncodeCover;
export const fetchCover = fetchAndEncodeCover;
export const processCover = encodeCoverBlob;
export const encodeCover = encodeCoverBlob;

export interface CoverCacheCandidate {
  key: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
}

export interface CoverAttemptInput {
  key: string;
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  lastAttemptRunId: string;
  status: CoverStatus;
  blob?: Blob;
  width: number;
  height: number;
  bytes: number;
  attemptedAt: string;
  errorCode?: string;
}

export interface CoverCacheRepository {
  scanCoverCandidates: (options?: { runId?: string; pipelineVersion?: number; limit?: number }) => Promise<CoverCacheCandidate[]>;
  getCoverCacheSummary: (options?: { pipelineVersion?: number }) => Promise<CoverCacheSummary>;
  writeCoverAttempt: (attempt: CoverAttemptInput) => Promise<boolean>;
}

export interface CoverCacheBatchOptions {
  repository: CoverCacheRepository;
  runId: string;
  pipelineVersion?: number;
  maxBatch?: number;
  delayMs?: number;
  maxReadyBytes?: number;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  processor?: (sourceUrl: string) => Promise<CoverImageAsset>;
  onRevision?: (revision: string) => void | Promise<void>;
}

export interface CoverCacheBatchResult {
  selected: number;
  attempted: number;
  ready: number;
  failed: number;
  skipped: number;
  stale: number;
  revision: string;
}

function attemptErrorCode(error: unknown): string {
  if (error instanceof CoverCacheError) return error.code;
  return error instanceof Error ? "UNKNOWN" : "UNKNOWN";
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uniqueCandidates(candidates: CoverCacheCandidate[]): CoverCacheCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.workKey || candidate.key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Process at most one image at a time. Errors are recorded on the candidate
 * and never abort the rest of the batch; the repository's CAS decides whether
 * a late result still belongs to the current WorkRecord. */
export async function runCoverCacheBatch(options: CoverCacheBatchOptions): Promise<CoverCacheBatchResult> {
  const pipelineVersion = options.pipelineVersion ?? COVER_CACHE_PIPELINE_VERSION;
  const maxBatch = Math.min(COVER_CACHE_BATCH_SIZE, Math.max(0, options.maxBatch ?? COVER_CACHE_BATCH_SIZE));
  const delayMs = Math.max(0, options.delayMs ?? COVER_CACHE_INTER_IMAGE_DELAY_MS);
  const maxReadyBytes = options.maxReadyBytes ?? COVER_CACHE_MAX_READY_BYTES;
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? waitFor;
  const processor = options.processor ?? ((sourceUrl: string) => fetchAndEncodeCover(sourceUrl));
  const candidates = uniqueCandidates(await options.repository.scanCoverCandidates({
    runId: options.runId,
    pipelineVersion,
    limit: maxBatch,
  })).slice(0, maxBatch);
  let readyBytes = (await options.repository.getCoverCacheSummary({ pipelineVersion })).bytes;
  let attempted = 0;
  let ready = 0;
  let failed = 0;
  let skipped = 0;
  let stale = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const attemptedAt = now();
    if (readyBytes >= maxReadyBytes) {
      const accepted = await options.repository.writeCoverAttempt({
        key: candidate.workKey,
        workKey: candidate.workKey,
        sourceUrl: candidate.sourceUrl,
        pipelineVersion,
        lastAttemptRunId: options.runId,
        status: "skipped-capacity",
        width: 0,
        height: 0,
        bytes: 0,
        attemptedAt,
        errorCode: "CAPACITY",
      });
      if (accepted) skipped += 1;
      else stale += 1;
      continue;
    }

    attempted += 1;
    try {
      const asset = await processor(candidate.sourceUrl);
      const outputRecord: CoverRecord = {
        key: candidate.workKey,
        workKey: candidate.workKey,
        sourceUrl: candidate.sourceUrl,
        pipelineVersion,
        lastAttemptRunId: options.runId,
        status: "ready",
        blob: asset.blob,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        attemptedAt,
      };
      const outputValidation = validateUsableCoverRecord(outputRecord, {
        sourceUrl: candidate.sourceUrl,
        pipelineVersion,
        maxBytes: COVER_CACHE_MAX_BLOB_BYTES,
      });
      if (!outputValidation.ok) {
        throw new CoverCacheError(`INVALID_OUTPUT_${outputValidation.code}`, "压缩后的封面数据无效");
      }
      if (asset.bytes > maxReadyBytes - readyBytes) {
        const accepted = await options.repository.writeCoverAttempt({
          key: candidate.workKey,
          workKey: candidate.workKey,
          sourceUrl: candidate.sourceUrl,
          pipelineVersion,
          lastAttemptRunId: options.runId,
          status: "skipped-capacity",
          width: 0,
          height: 0,
          bytes: 0,
          attemptedAt,
          errorCode: "CAPACITY",
        });
        if (accepted) skipped += 1;
        else stale += 1;
        continue;
      }
      const accepted = await options.repository.writeCoverAttempt({
        key: candidate.workKey,
        workKey: candidate.workKey,
        sourceUrl: candidate.sourceUrl,
        pipelineVersion,
        lastAttemptRunId: options.runId,
        status: "ready",
        blob: asset.blob,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        attemptedAt,
      });
      if (accepted) {
        ready += 1;
        readyBytes += asset.bytes;
      } else stale += 1;
    } catch (error) {
      const accepted = await options.repository.writeCoverAttempt({
        key: candidate.workKey,
        workKey: candidate.workKey,
        sourceUrl: candidate.sourceUrl,
        pipelineVersion,
        lastAttemptRunId: options.runId,
        status: "failed",
        width: 0,
        height: 0,
        bytes: 0,
        attemptedAt,
        errorCode: attemptErrorCode(error),
      });
      if (accepted) failed += 1;
      else stale += 1;
    }
  }

  const revision = now();
  await options.onRevision?.(revision);
  return { selected: candidates.length, attempted, ready, failed, skipped, stale, revision };
}

export const runCoverCache = runCoverCacheBatch;

export class CoverCacheService {
  private inFlight: Promise<CoverCacheBatchResult> | null = null;
  private readonly defaults: Omit<CoverCacheBatchOptions, "runId">;

  constructor(options: Omit<CoverCacheBatchOptions, "runId">) {
    this.defaults = options;
  }

  run(runId: string): Promise<CoverCacheBatchResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = runCoverCacheBatch({ ...this.defaults, runId }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  get isRunning(): boolean {
    return this.inFlight !== null;
  }

  async waitForIdle(): Promise<void> {
    await this.inFlight?.then(() => undefined, () => undefined);
  }
}

export const createCoverCacheService = (options: Omit<CoverCacheBatchOptions, "runId">): CoverCacheService => (
  new CoverCacheService(options)
);
