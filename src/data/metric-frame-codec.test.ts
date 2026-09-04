import { describe, expect, it } from "vitest";
import type {
  MetricFrame,
  MetricKeyframeState,
  MetricObservationStamp,
  WorkDictionary,
} from "../domain/metric-frames";
import {
  assignWorkOrdinal,
  createWorkDictionary,
  METRIC_FRAME_FULL_MASK,
} from "../domain/metric-frames";
import type { WorkMetrics } from "../domain/types";
import {
  applyMetricFrame,
  applyMetricFrames,
  createMetricFrame,
  createMetricKeyframe,
  decodeMetricFrame,
  decodeMetricKeyframe,
  decodeWorkDictionary,
  encodeMetricFrame,
  encodeMetricKeyframe,
  encodeWorkDictionary,
  packMetricOrdinals,
  reconstructMetricRange,
  unpackMetricOrdinals,
  validateMetricFrame,
  validateMetricFrameSequence,
  validateMetricKeyframe,
} from "./metric-frame-codec";

const allMetrics = (overrides: Partial<WorkMetrics> = {}): WorkMetrics => ({
  likes: 10,
  bookmarks: 20,
  views: 30,
  comments: 4,
  rank: null,
  responses: 2,
  illustrations: 1,
  ...overrides,
});

const header = (epochMs: number, runSeq: number, quality = 1) => ({
  runId: `run-${runSeq}`,
  runSeq,
  epochMs,
  scope: "partial" as const,
  parser: 7,
  quality,
});

function firstFrame(
  ordinal: number,
  epochMs: number,
  runSeq: number,
  metrics: WorkMetrics = allMetrics(),
  extras: Partial<Parameters<typeof createMetricFrame>[0]> = {},
): MetricFrame {
  return createMetricFrame({
    ...header(epochMs, runSeq),
    observedOrdinals: [ordinal],
    changes: [{ ordinal, metrics }],
    ...extras,
  });
}

function state(ordinal: number, epochMs: number, metrics: WorkMetrics = allMetrics()): MetricKeyframeState {
  const lastObserved: MetricObservationStamp = {
    runId: "run-keyframe",
    runSeq: 1,
    epochMs,
    collectedAt: new Date(epochMs).toISOString(),
  };
  return {
    ordinal,
    metrics,
    rankingStatus: metrics.rank === null ? "unknown" : "ranked",
    rankingObservedAt: metrics.rank === null ? null : lastObserved.collectedAt,
    rankingSource: metrics.rank === null ? null : "api",
    presence: "present",
    absentSince: null,
    lastObserved,
    parser: 7,
    quality: 1,
    provenance: null,
  };
}

describe("metric frame codec", () => {
  it("assigns append-only work ordinals and preserves dictionary gaps", () => {
    let dictionary = createWorkDictionary();
    const first = assignWorkOrdinal(dictionary, "illust-1");
    dictionary = first.dictionary;
    const second = assignWorkOrdinal(dictionary, "novel-2");
    dictionary = second.dictionary;

    expect(first.ordinal).toBe(0);
    expect(second.ordinal).toBe(1);
    expect(assignWorkOrdinal(dictionary, "illust-1").ordinal).toBe(0);

    const retired = decodeWorkDictionary({
      codec: "metric-frame-v1",
      codecVersion: 1,
      entries: [[0, "illust-1"]],
      nextOrdinal: 9,
    });
    const retained = assignWorkOrdinal(retired, "illust-1").dictionary;
    expect(retained.nextOrdinal).toBe(9);
    expect(assignWorkOrdinal(retained, "novel-3").ordinal).toBe(9);
    expect(() => decodeWorkDictionary({ entries: [[0, "a"], [0, "b"]] })).toThrow();
  });

  it("delta-packs ascending ordinals and round-trips an absolute sparse frame", () => {
    expect(packMetricOrdinals([8, 2, 5])).toEqual([2, 3, 3]);
    expect(unpackMetricOrdinals([2, 3, 3])).toEqual([2, 5, 8]);

    const frame = createMetricFrame({
      ...header(1000, 1),
      observedOrdinals: [8, 2, 5],
      changes: [
        { ordinal: 8, metrics: { views: 99, comments: null } },
        { ordinal: 2, metrics: { likes: 3, rank: null } },
      ],
    });
    expect(frame.observed).toEqual([2, 3, 3]);
    expect(frame.changes.map((change) => change.slice(0, 4))).toEqual([
      [2, 17, 16, [3]],
      [8, 12, 8, [99]],
    ]);
    expect(decodeMetricFrame(encodeMetricFrame(frame))).toEqual(frame);
  });

  it("represents explicit null values and ranking/quality overrides", () => {
    const frame = createMetricFrame({
      ...header(2000, 1),
      observedOrdinals: [0],
      changes: [{
        ordinal: 0,
        metrics: allMetrics({ rank: 5 }),
        ranking: { status: "ranked", observedAt: "1970-01-01T00:00:02.000Z", source: "api" },
        quality: 0.75,
      }],
    });
    expect(frame.changes[0]![1]).toBe(METRIC_FRAME_FULL_MASK);
    expect(frame.changes[0]![2]).toBe(0);
    expect(frame.changes[0]![4]).toEqual({ status: "ranked", observedAt: "1970-01-01T00:00:02.000Z", source: "api" });
    expect(frame.changes[0]![5]).toBe(0.75);

    const cleared = createMetricFrame({
      ...header(3000, 2),
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { rank: null }, ranking: { status: "unknown", observedAt: null, source: null } }],
    });
    const result = applyMetricFrames([frame, cleared]).get(0);
    expect(result?.metrics.rank).toBeNull();
    expect(result?.rankingStatus).toBe("unknown");
  });

  it("requires a full mask for the first work frame", () => {
    const partial = createMetricFrame({
      ...header(1000, 1),
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { views: 1 } }],
    });
    expect(() => applyMetricFrame(partial)).toThrow(/full metric mask/i);
    expect(() => validateMetricFrameSequence([partial])).toThrow(/full metric mask/i);

    const knownButNeverObserved = {
      ...header(900, 9),
      scope: "complete" as const,
      observedOrdinals: [],
      changes: [],
    };
    const initialEmpty = createMetricFrame(knownButNeverObserved);
    const laterPartial = createMetricFrame({
      ...header(1000, 10),
      observedOrdinals: [4],
      changes: [{ ordinal: 4, metrics: { views: 1 } }],
    });
    const dictionary = createWorkDictionary([{ ordinal: 4, workKey: "illust-4" }]);
    expect(() => applyMetricFrames([initialEmpty, laterPartial], new Map(), dictionary)).toThrow(/full metric mask/i);
  });

  it("applies complete scope as absence and preserves prior last observation", () => {
    const dictionary: WorkDictionary = {
      ...createWorkDictionary([{ ordinal: 0, workKey: "a" }, { ordinal: 1, workKey: "b" }]),
    };
    const first = firstFrame(0, 1000, 1);
    const second = createMetricFrame({
      ...header(2000, 2),
      scope: "complete",
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { views: 31 } }],
    });
    const result = applyMetricFrames([first, second], new Map(), dictionary);
    expect(result.get(0)?.metrics.views).toBe(31);
    expect(result.get(0)?.lastObserved?.epochMs).toBe(2000);
    expect(result.get(1)).toMatchObject({ presence: "absent", absentSince: "1970-01-01T00:00:02.000Z" });
  });

  it("orders same-millisecond frames by runSeq stably", () => {
    const low = firstFrame(0, 5000, 1, allMetrics({ views: 10 }));
    const high = createMetricFrame({
      ...header(5000, 2),
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { views: 20 } }],
    });
    const result = applyMetricFrames([high, low]).get(0);
    expect(result?.metrics.views).toBe(20);
    expect(result?.lastObserved).toMatchObject({ runSeq: 2, epochMs: 5000 });
  });

  it("rejects frames from one run when their shared header drifts", () => {
    const first = firstFrame(0, 1000, 1);
    const drifted = createMetricFrame({
      ...header(1000, 1, 0.5),
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { views: 31 } }],
    });
    expect(() => applyMetricFrames([first, drifted])).toThrow(/inconsistent shared header/i);
  });

  it("round-trips keyframes with complete metrics, ranking, presence and provenance", () => {
    const keyframe = createMetricKeyframe(header(4000, 4), [
      state(0, 4000, allMetrics({ rank: 8 })),
      {
        ...state(1, 4000, allMetrics({ views: null })),
        presence: "absent",
        absentSince: "1970-01-01T00:00:03.000Z",
        lastObserved: null,
        rankingStatus: "unknown",
        rankingObservedAt: null,
        rankingSource: null,
        provenance: { sourceFrameId: "source-1" },
      },
    ], { sourceFrameId: "keyframe-source" });
    expect(keyframe.states[0]).toMatchObject({
      metrics: allMetrics({ rank: 8 }),
      rankingStatus: "ranked",
      presence: "present",
      lastObserved: { epochMs: 4000 },
    });
    expect(decodeMetricKeyframe(encodeMetricKeyframe(keyframe))).toEqual(keyframe);
    expect(validateMetricKeyframe(keyframe)).toEqual(keyframe);
  });

  it("reconstructs from the nearest keyframe and keeps compacted source provenance", () => {
    const initial = firstFrame(0, 1000, 1);
    const compacted = createMetricFrame({
      ...header(3000, 3),
      kind: "compacted",
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { views: 55 }, provenance: { sourceRunId: "run-2", sourceEpochMs: 2000 } }],
      provenance: { sourceFrameId: "frame-2" },
    });
    const keyframe = createMetricKeyframe(header(4000, 4), [state(0, 4000, allMetrics({ views: 55 }))]);
    const latest = createMetricFrame({
      ...header(5000, 5),
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: { views: 60 } }],
    });
    const reconstructed = reconstructMetricRange([latest, keyframe, compacted, initial], { startMs: 4500, endMs: 5000 });
    expect(reconstructed.get(0)?.metrics.views).toBe(60);
    expect(compacted.provenance).toEqual({ sourceFrameId: "frame-2" });
    expect(compacted.changes[0]![6]).toEqual({ sourceRunId: "run-2", sourceEpochMs: 2000 });
  });

  it("rejects malformed masks, deltas, ordering, provenance and keyframe state", () => {
    const frame = firstFrame(0, 1000, 1);
    expect(() => decodeMetricFrame({ ...frame, observed: [1, 0] })).toThrow();
    expect(() => decodeMetricFrame({ ...frame, changes: [[0, 1, 2, []]] })).toThrow();
    expect(() => decodeMetricFrame({ ...frame, changes: [[0, 1, 0, [1]], [0, 1, 0, [2]]] })).toThrow();
    expect(() => decodeMetricFrame({ ...frame, kind: "compacted", provenance: undefined })).toThrow(/source provenance/i);
    expect(() => decodeMetricKeyframe({
      ...createMetricKeyframe(header(1000, 1), [state(0, 1000)]),
      states: [{ ...state(0, 1000), metrics: { likes: 1 } }],
    })).toThrow();
    expect(() => decodeMetricKeyframe({
      ...createMetricKeyframe(header(1000, 1), [state(0, 1000)]),
      states: [{ ...state(0, 1000), presence: "present", lastObserved: null }],
    })).toThrow();
    expect(() => decodeMetricFrame({
      ...frame,
      changes: [[0, 1, 0, [1], null, null, {}]],
    })).toThrow();
  });
});
