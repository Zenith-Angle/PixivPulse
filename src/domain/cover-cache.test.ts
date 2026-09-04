import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoverCacheError,
  encodeCoverBlob,
  fetchAndEncodeCover,
  isAllowedCoverUrl,
  readCoverResponse,
  runCoverCacheBatch,
  type CoverCacheRepository,
  type CoverImageAsset,
} from "./cover-cache";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cover cache safety and encoding", () => {
  it("accepts only HTTPS i.pximg.net source URLs", () => {
    expect(isAllowedCoverUrl("https://i.pximg.net/img-master/work.jpg")).toBe(true);
    expect(isAllowedCoverUrl("http://i.pximg.net/work.jpg")).toBe(false);
    expect(isAllowedCoverUrl("https://evil.example/i.pximg.net/work.jpg")).toBe(false);
    expect(isAllowedCoverUrl("https://cdn.i.pximg.net/work.jpg")).toBe(false);
    expect(isAllowedCoverUrl("https://i.pximg.net:444/work.jpg")).toBe(false);
  });

  it("rejects a declared response larger than 8 MB before reading the body", async () => {
    const getReader = vi.fn();
    const response = new Response(null, {
      status: 200,
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    });
    Object.defineProperty(response, "body", { value: { getReader } });
    await expect(readCoverResponse(response)).rejects.toMatchObject({ code: "CONTENT_LENGTH_EXCEEDED" });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("cancels a stream as soon as cumulative bytes exceed the source ceiling", async () => {
    const cancel = vi.fn(async () => undefined);
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(8 * 1024 * 1024) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1) });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    } as unknown as Response;
    await expect(readCoverResponse(response)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("sends credentials omit and progressively encodes a 320px WebP", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" },
      });
    });
    const createImageBitmap = vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }));
    const convertToBlob = vi.fn(async (options?: { type?: string; quality?: number }) => {
      expect(options?.type).toBe("image/webp");
      expect(options?.quality).toBeCloseTo(0.68);
      return new Blob([new Uint8Array(32)], { type: "image/webp" });
    });
    const drawImage = vi.fn();
    const asset = await fetchAndEncodeCover("https://i.pximg.net/work.jpg", {
      fetch: fetchImpl,
      createImageBitmap,
      createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage }), convertToBlob }),
    });
    expect(asset).toMatchObject({ width: 320, height: 240, bytes: 32, blob: expect.any(Blob) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when every compressed candidate is over 150 KB", async () => {
    const createImageBitmap = vi.fn(async () => ({ width: 100, height: 100 }));
    const convertToBlob = vi.fn(async () => new Blob([new Uint8Array(150 * 1024 + 1)], { type: "image/webp" }));
    await expect(encodeCoverBlob(new Blob([new Uint8Array([1])]), {
      createImageBitmap,
      createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage: vi.fn() }), convertToBlob }),
    })).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    expect(convertToBlob).toHaveBeenCalled();
  });

  it("aborts a cover attempt that does not resolve within its timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const pending = fetchAndEncodeCover("https://i.pximg.net/work.jpg", { fetch: fetchImpl, timeoutMs: 8_000 });

    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

function repositoryFor(candidates: Array<{ key: string; workKey: string; sourceUrl: string; pipelineVersion: number }>, bytes = 0): CoverCacheRepository & { writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    scanCoverCandidates: vi.fn(async () => candidates),
    getCoverCacheSummary: vi.fn(async () => ({ ready: 0, failed: 0, skipped: 0, pending: candidates.length, bytes, total: candidates.length })),
    writeCoverAttempt: vi.fn(async (attempt) => {
      writes.push(attempt as unknown as Record<string, unknown>);
      return true;
    }),
  };
}

describe("cover cache batch service", () => {
  it("processes no more than eight candidates, serializes work, records failures, and emits a revision", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      key: `illust-${index}`,
      workKey: `illust-${index}`,
      sourceUrl: `https://i.pximg.net/${index}.jpg`,
      pipelineVersion: 1,
    }));
    const repository = repositoryFor(candidates);
    const active: number[] = [];
    let maxActive = 0;
    const processor = vi.fn(async (sourceUrl: string): Promise<CoverImageAsset> => {
      active.push(1);
      maxActive = Math.max(maxActive, active.length);
      active.pop();
      if (sourceUrl.endsWith("/2.jpg")) throw new CoverCacheError("NETWORK_ERROR");
      return { blob: new Blob([new Uint8Array([1])], { type: "image/webp" }), width: 1, height: 1, bytes: 1 };
    });
    const onRevision = vi.fn();
    const result = await runCoverCacheBatch({
      repository,
      runId: "complete-1",
      delayMs: 0,
      processor,
      onRevision,
      now: vi.fn(() => "2026-08-31T00:00:00.000Z"),
    });
    expect(result.selected).toBe(8);
    expect(result.ready).toBe(7);
    expect(result.failed).toBe(1);
    expect(processor).toHaveBeenCalledTimes(8);
    expect(maxActive).toBe(1);
    expect(repository.writes).toHaveLength(8);
    expect(onRevision).toHaveBeenCalledWith("2026-08-31T00:00:00.000Z");
  });

  it("marks candidates as skipped without fetching once the ready-byte ceiling is full", async () => {
    const repository = repositoryFor([{
      key: "illust-1",
      workKey: "illust-1",
      sourceUrl: "https://i.pximg.net/1.jpg",
      pipelineVersion: 1,
    }], 128);
    const processor = vi.fn();
    const result = await runCoverCacheBatch({
      repository,
      runId: "complete-1",
      maxReadyBytes: 128,
      delayMs: 0,
      processor,
    });
    expect(result.skipped).toBe(1);
    expect(processor).not.toHaveBeenCalled();
    expect(repository.writes[0]).toMatchObject({ status: "skipped-capacity", errorCode: "CAPACITY" });
  });

  it("does not persist an invalid processor result as ready", async () => {
    const repository = repositoryFor([{
      key: "illust-invalid",
      workKey: "illust-invalid",
      sourceUrl: "https://i.pximg.net/invalid.jpg",
      pipelineVersion: 1,
    }]);
    const result = await runCoverCacheBatch({
      repository,
      runId: "complete-invalid",
      delayMs: 0,
      processor: async () => ({
        blob: new Blob([new Uint8Array([1, 2])], { type: "image/jpeg" }),
        width: 0,
        height: 10,
        bytes: 2,
      }),
    });
    expect(result.ready).toBe(0);
    expect(result.failed).toBe(1);
    expect(repository.writes[0]).toMatchObject({
      status: "failed",
      errorCode: "INVALID_OUTPUT_INVALID_DIMENSIONS",
    });
    expect(repository.writes[0]?.status).not.toBe("ready");
  });
});
