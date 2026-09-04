import { describe, expect, it } from "vitest";
import {
  beginCoverQueueItem,
  completeCoverQueueItem,
  deserializeCoverQueueState,
  emptyCoverQueueState,
  enqueueCoverGeneration,
  failCoverQueueItem,
  isUsableCoverRecord,
  serializeCoverQueueState,
  type CoverQueueState,
  type CoverQueueWorkInput,
  validateUsableCoverRecord,
} from "./cover-queue";

const firstWork: CoverQueueWorkInput = {
  workKey: "illust-1",
  sourceUrl: "https://i.pximg.net/1.jpg",
  pipelineVersion: 1,
  revision: 3,
  fingerprint: "cover-v3",
};

function add(
  state: CoverQueueState,
  generationId: string,
  works: readonly CoverQueueWorkInput[] = [firstWork],
  enqueuedAt = `${generationId}-at`,
  limits: Parameters<typeof enqueueCoverGeneration>[2] = {},
): CoverQueueState {
  const result = enqueueCoverGeneration(state, { generationId, works, enqueuedAt }, limits);
  expect(result.error).toBeNull();
  return result.state;
}

describe("durable cover queue", () => {
  it("keeps obligations distinct per generation and never overwrites an older pending source", () => {
    let state = add(emptyCoverQueueState(), "run-1", [firstWork], "2026-09-01T00:00:00.000Z");
    state = add(state, "run-2", [{ ...firstWork, sourceUrl: "https://i.pximg.net/2.jpg" }], "2026-09-01T00:01:00.000Z");
    state = add(state, "run-1", [{ ...firstWork, sourceUrl: "https://i.pximg.net/new.jpg" }], "2026-09-01T00:02:00.000Z");

    expect(state.pending).toHaveLength(2);
    expect(state.pending.map((item) => item.key)).toEqual(["run-1|illust-1", "run-2|illust-1"]);
    expect(state.pending[0]?.sourceUrl).toBe(firstWork.sourceUrl);
    expect(state.pending[0]?.attempts).toBe(0);
  });

  it("serializes an in-flight claim and resumes it oldest-first after restart", () => {
    let state = add(emptyCoverQueueState(), "run-old", [firstWork], "2026-09-01T00:00:00.000Z");
    state = add(state, "run-new", [{ ...firstWork, workKey: "illust-2" }], "2026-09-01T00:01:00.000Z");
    const started = beginCoverQueueItem(state, { now: "2026-09-01T00:02:00.000Z" });
    expect(started.claim).toMatchObject({ key: "run-old|illust-1", attempt: 1 });

    const restored = deserializeCoverQueueState(serializeCoverQueueState(started.state));
    expect(restored.pending[0]).toMatchObject({
      key: "run-old|illust-1",
      status: "pending",
      attempts: 1,
      revision: 3,
      fingerprint: "cover-v3",
    });
    const resumed = beginCoverQueueItem(restored, { now: "2026-09-01T00:03:00.000Z" });
    expect(resumed.claim?.key).toBe("run-old|illust-1");
    expect(resumed.claim?.attempt).toBe(2);
  });

  it("allows a newer generation to append while an older item is in flight", () => {
    const initial = add(emptyCoverQueueState(), "run-1", [firstWork], "2026-09-01T00:00:00.000Z");
    const started = beginCoverQueueItem(initial, { now: "2026-09-01T00:00:01.000Z" });
    const state = add(started.state, "run-2", [{ ...firstWork, sourceUrl: "https://i.pximg.net/2.jpg" }], "2026-09-01T00:01:00.000Z");

    expect(state.pending).toHaveLength(2);
    expect(state.pending.find((item) => item.key === "run-1|illust-1")).toMatchObject({ status: "in-flight" });
    expect(state.pending.find((item) => item.key === "run-2|illust-1")).toMatchObject({ status: "pending" });
    expect(beginCoverQueueItem(state).claim?.key).toBe("run-2|illust-1");
  });

  it("removes a completed obligation only after persistence is acknowledged", () => {
    const state = add(emptyCoverQueueState(), "run-1");
    const started = beginCoverQueueItem(state);
    expect(() => completeCoverQueueItem(started.state, started.claim!, false)).toThrowError(
      expect.objectContaining({ code: "PERSISTENCE_NOT_ACKNOWLEDGED" }),
    );
    expect(started.state.pending).toHaveLength(1);

    const completed = completeCoverQueueItem(started.state, started.claim!, {
      persisted: true,
      workKey: firstWork.workKey,
      sourceUrl: firstWork.sourceUrl,
      pipelineVersion: firstWork.pipelineVersion,
    }, { completedAt: "2026-09-01T00:02:00.000Z" });
    expect(completed.pending).toHaveLength(0);
    expect(completed.workOutcomes).toEqual([{
      workKey: firstWork.workKey,
      generationId: "run-1",
      status: "ready",
      completedAt: "2026-09-01T00:02:00.000Z",
      errorCode: null,
    }]);
    expect(completed.generationSummaries[0]).toMatchObject({ enqueued: 1, pending: 0, completed: 1, status: "completed" });
  });

  it("finishes failures for the current generation and re-enqueues on the next one", () => {
    const initial = add(emptyCoverQueueState(), "run-1");
    const started = beginCoverQueueItem(initial);
    const failed = failCoverQueueItem(started.state, started.claim!, "NETWORK_ERROR", { completedAt: "2026-09-01T00:01:00.000Z" });
    expect(failed.pending).toHaveLength(0);
    expect(failed.generationSummaries.find((summary) => summary.generationId === "run-1")).toMatchObject({
      failed: 1,
      pending: 0,
      status: "failed",
      errorCounts: [{ code: "NETWORK_ERROR", count: 1 }],
    });
    expect(failed.workOutcomes[0]).toMatchObject({ workKey: firstWork.workKey, generationId: "run-1", status: "failed" });

    const next = enqueueCoverGeneration(failed, {
      generationId: "run-2",
      enqueuedAt: "2026-09-01T00:02:00.000Z",
      works: [firstWork],
    });
    expect(next.error).toBeNull();
    expect(next.state.pending).toHaveLength(1);
    expect(next.state.pending[0]).toMatchObject({ generationId: "run-2", attempts: 0 });
  });

  it("keeps generation summaries and outcomes bounded while preserving pending entries", () => {
    let state = emptyCoverQueueState();
    for (let index = 0; index < 25; index += 1) {
      const generationId = `run-${String(index).padStart(2, "0")}`;
      state = add(state, generationId, [{ ...firstWork, workKey: `illust-${index}` }], `2026-09-01T00:${String(index).padStart(2, "0")}:00.000Z`);
      const started = beginCoverQueueItem(state, { now: `2026-09-01T00:${String(index).padStart(2, "0")}:01.000Z` });
      state = completeCoverQueueItem(started.state, started.claim!, true, { completedAt: `2026-09-01T00:${String(index).padStart(2, "0")}:02.000Z` });
    }
    expect(state.pending).toHaveLength(0);
    expect(state.generationSummaries).toHaveLength(20);
    expect(state.generationSummaries[0]?.generationId).toBe("run-24");
    expect(state.workOutcomes).toHaveLength(25);

    state = add(state, "run-pending", [firstWork], "2026-09-01T01:00:00.000Z");
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.key).toBe("run-pending|illust-1");
  });

  it("returns explicit capacity errors without dropping existing pending obligations", () => {
    let state = add(emptyCoverQueueState(), "run-1", [firstWork], "2026-09-01T00:00:00.000Z", { maxPendingEntries: 1 });
    const entriesFull = enqueueCoverGeneration(state, {
      generationId: "run-2",
      works: [{ ...firstWork, workKey: "illust-2" }],
      enqueuedAt: "2026-09-01T00:01:00.000Z",
    }, { maxPendingEntries: 1 });
    expect(entriesFull.ok).toBe(false);
    expect(entriesFull.error).toMatchObject({ code: "CAPACITY", limit: "entries" });
    expect(entriesFull.state.pending.map((item) => item.key)).toEqual(["run-1|illust-1"]);

    const bytesFull = enqueueCoverGeneration(state, {
      generationId: "run-2",
      works: [{ ...firstWork, workKey: "illust-2" }],
      enqueuedAt: "2026-09-01T00:01:00.000Z",
    }, { maxSerializedBytes: 10 });
    expect(bytesFull.ok).toBe(false);
    expect(bytesFull.error).toMatchObject({ code: "CAPACITY", limit: "bytes" });
    expect(bytesFull.state.pending).toHaveLength(1);
  });

  it("compacts error aggregates and refuses to serialize over the entry limit", () => {
    let state = emptyCoverQueueState();
    for (let index = 0; index < 12; index += 1) {
      state = add(state, "run-error", [{ ...firstWork, workKey: `illust-error-${index}` }], `2026-09-01T02:00:${String(index).padStart(2, "0")}.000Z`);
      const started = beginCoverQueueItem(state);
      state = failCoverQueueItem(started.state, started.claim!, `ERROR_${index}`, { completedAt: `2026-09-01T02:00:${String(index).padStart(2, "0")}.000Z` });
    }
    const summary = state.generationSummaries.find((item) => item.generationId === "run-error");
    expect(summary?.errorCounts.length).toBeLessThanOrEqual(8);

    let pending = emptyCoverQueueState();
    pending = add(pending, "run-1", [{ ...firstWork, workKey: "illust-1" }]);
    pending = add(pending, "run-2", [{ ...firstWork, workKey: "illust-2" }]);
    expect(() => serializeCoverQueueState(pending, { maxPendingEntries: 1 })).toThrowError(
      expect.objectContaining({ code: "CAPACITY", limit: "entries" }),
    );
  });

  it("rejects corrupt ready records and accepts only a usable current WebP", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    const record = {
      key: firstWork.workKey,
      workKey: firstWork.workKey,
      sourceUrl: firstWork.sourceUrl,
      pipelineVersion: firstWork.pipelineVersion,
      lastAttemptRunId: "run-1",
      status: "ready" as const,
      blob,
      width: 2,
      height: 2,
      bytes: blob.size,
      attemptedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(validateUsableCoverRecord(record, { sourceUrl: firstWork.sourceUrl, pipelineVersion: 1 })).toEqual({ ok: true, code: null });
    const { blob: _blob, ...withoutBlob } = record;
    expect(isUsableCoverRecord(withoutBlob, { sourceUrl: firstWork.sourceUrl, pipelineVersion: 1 })).toBe(false);
    expect(validateUsableCoverRecord({ ...record, bytes: blob.size + 1 }, { sourceUrl: firstWork.sourceUrl, pipelineVersion: 1 }).code).toBe("BLOB_SIZE_MISMATCH");
    expect(validateUsableCoverRecord({ ...record, blob: new Blob([new Uint8Array([1])], { type: "image/jpeg" }), bytes: 1 }, { sourceUrl: firstWork.sourceUrl, pipelineVersion: 1 }).code).toBe("MIME_NOT_ALLOWED");
    expect(validateUsableCoverRecord({ ...record, width: 0 }, { sourceUrl: firstWork.sourceUrl, pipelineVersion: 1 }).code).toBe("INVALID_DIMENSIONS");
    expect(validateUsableCoverRecord({ ...record, sourceUrl: "https://i.pximg.net/other.jpg" }, { sourceUrl: firstWork.sourceUrl, pipelineVersion: 1 }).code).toBe("SOURCE_MISMATCH");
    expect(validateUsableCoverRecord({ ...record, bytes: 151 * 1024, blob: new Blob([new Uint8Array(151 * 1024)], { type: "image/webp" }) }).code).toBe("MAX_BYTES_EXCEEDED");
  });
});
