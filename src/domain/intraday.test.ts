import { describe, expect, it } from "vitest";
import { buildIntradayAnalytics, type IntradayAnalyticsInput } from "./intraday";
import { beijingDayRange, parseInstant } from "./time";
import type { WorkMetrics, WorkObservation, WorkSample } from "./types";

const metrics = (views: number): WorkMetrics => ({
  likes: 1,
  bookmarks: 2,
  views,
  comments: 0,
  rank: null,
  responses: 0,
  illustrations: 0,
});

const localAt = (hour: number, minute = 0, day = 30): string =>
  new Date(`2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`).toISOString();

function sample(workKey: string, at: string, views: number, runId = `sample-${at}`): WorkSample {
  return {
    workKey,
    runId,
    collectedAt: at,
    metrics: metrics(views),
    parserVersion: 1,
    dataQuality: 1,
    kind: "change",
  };
}

function observation(workKey: string, at: string, runId: string, metricsChanged: boolean): WorkObservation {
  return { workKey, observedAt: at, runId, metricsChanged };
}

const referenceMetricKeys = ["likes", "bookmarks", "views", "comments", "rank", "responses", "illustrations"] as const;
const referenceAdditiveMetricKeys = ["likes", "bookmarks", "views", "comments", "responses", "illustrations"] as const;

function referenceEmptyMetrics(): WorkMetrics {
  return { likes: null, bookmarks: null, views: null, comments: null, rank: null, responses: null, illustrations: null };
}

function referenceSubtractMetrics(current: WorkMetrics, baseline: WorkMetrics): WorkMetrics {
  const result = referenceEmptyMetrics();
  for (const key of referenceMetricKeys) result[key] = current[key] == null || baseline[key] == null ? null : current[key] - baseline[key];
  return result;
}

function referenceAddNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return left + right;
}

// Intentionally straightforward oracle for differential coverage. It keeps
// the old scan-based lookup shape so the production implementation can change
// independently while retaining the same observable result.
function buildReferenceIntradayAnalytics(input: IntradayAnalyticsInput): ReturnType<typeof buildIntradayAnalytics> {
  const now = input.now == null ? Date.now() : parseInstant(input.now);
  const day = now == null ? null : beijingDayRange(now);
  if (now == null || day == null) {
    return { date: "", baselineLabel: "partial", sampleCount: 0, points: [], works: [], delta: referenceEmptyMetrics() };
  }

  const workKeys = new Set<string>();
  for (const work of input.works ?? []) if (work.key) workKeys.add(work.key);
  for (const item of input.observations) if (item.workKey) workKeys.add(item.workKey);
  for (const batch of input.observationBatches ?? []) for (const workKey of batch.workKeys) if (workKey) workKeys.add(workKey);
  const orderedWorkKeys = [...workKeys];
  const normalized = input.observations.slice();
  const seen = new Set(normalized.map((item) => `${item.runId}\u0000${item.workKey}`));
  for (const batch of input.observationBatches ?? []) {
    const changed = new Set(batch.changedWorkKeys);
    for (const workKey of batch.workKeys) {
      const key = `${batch.runId}\u0000${workKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ workKey, runId: batch.runId, observedAt: batch.observedAt, metricsChanged: changed.has(workKey) });
    }
  }

  const observationCeiling = Math.min(now, day.endMs - 1);
  const observationsByWork = new Map<string, WorkObservation[]>();
  for (const item of normalized) {
    const timestamp = parseInstant(item.observedAt);
    if (timestamp == null || timestamp < day.startMs || timestamp >= day.endMs || timestamp > observationCeiling) continue;
    const list = observationsByWork.get(item.workKey) ?? [];
    list.push(item);
    observationsByWork.set(item.workKey, list);
  }

  const works: ReturnType<typeof buildIntradayAnalytics>["works"] = [];
  for (const workKey of orderedWorkKeys) {
    const observations = (observationsByWork.get(workKey) ?? []).slice().sort((left, right) => parseInstant(left.observedAt)! - parseInstant(right.observedAt)!
      || (left.id ?? 0) - (right.id ?? 0));
    if (observations.length === 0) continue;
    const samples = input.samples.filter((item) => item.workKey === workKey && parseInstant(item.collectedAt) != null).slice().sort((left, right) => parseInstant(left.collectedAt)! - parseInstant(right.collectedAt)!
      || (left.id ?? 0) - (right.id ?? 0));
    const latestSample = (at: number): WorkSample | null => {
      let latest: WorkSample | null = null;
      for (const item of samples) {
        const timestamp = parseInstant(item.collectedAt);
        if (timestamp == null || timestamp > at) break;
        latest = item;
      }
      return latest;
    };
    const points = observations.map((item) => {
      const itemAt = parseInstant(item.observedAt)!;
      const sampleAt = latestSample(itemAt);
      return {
        observedAt: item.observedAt,
        runId: item.runId,
        metricsChanged: item.metricsChanged,
        metrics: sampleAt ? { ...sampleAt.metrics } : referenceEmptyMetrics(),
      };
    });
    const baselineAt = parseInstant(points[0]!.observedAt)!;
    const baselineMetrics = { ...points[0]!.metrics };
    const latestMetrics = points.at(-1)?.metrics ?? referenceEmptyMetrics();
    const changeSampleCount = samples.filter((item) => {
      const timestamp = parseInstant(item.collectedAt);
      return item.kind === "change" && timestamp != null && timestamp >= day.startMs && timestamp < day.endMs && timestamp <= observationCeiling;
    }).length;
    const baselineLabel: "estimated" | "partial" = baselineAt - day.startMs <= Math.max(2 * 60 * 60_000, Math.max(0, input.configuredIntervalHours ?? input.syncIntervalHours ?? 1) * 2 * 60 * 60_000)
      ? "estimated"
      : "partial";
    works.push({
      workKey,
      date: day.date,
      baselineAt: points[0]?.observedAt ?? null,
      baselineLabel,
      sampleCount: observations.length,
      changeSampleCount,
      points,
      delta: referenceSubtractMetrics(latestMetrics, baselineMetrics),
    });
  }

  const byRun = new Map<string, { observedAt: string; timestamp: number }>();
  for (const work of works) {
    for (const point of work.points) {
      const timestamp = parseInstant(point.observedAt);
      if (timestamp == null) continue;
      const current = byRun.get(point.runId);
      if (!current || timestamp > current.timestamp) byRun.set(point.runId, { observedAt: point.observedAt, timestamp });
    }
  }
  const orderedSamplesByWork = new Map<string, WorkSample[]>();
  for (const item of input.samples) {
    if (parseInstant(item.collectedAt) == null) continue;
    const list = orderedSamplesByWork.get(item.workKey) ?? [];
    list.push(item);
    orderedSamplesByWork.set(item.workKey, list);
  }
  for (const list of orderedSamplesByWork.values()) list.sort((left, right) => parseInstant(left.collectedAt)! - parseInstant(right.collectedAt)!
    || (left.id ?? 0) - (right.id ?? 0));
  const orderedRuns = [...byRun.entries()].sort((left, right) => left[1].timestamp - right[1].timestamp);
  const portfolioPoints = orderedRuns.map(([runId, run]) => {
      const metrics = referenceEmptyMetrics();
    for (const workKey of orderedWorkKeys) {
      const work = works.find((item) => item.workKey === workKey);
      let latestPoint: ReturnType<typeof buildIntradayAnalytics>["works"][number]["points"][number] | null = null;
      if (work) {
        for (const point of work.points) {
          const timestamp = parseInstant(point.observedAt);
          if (timestamp == null || timestamp > run.timestamp) break;
          latestPoint = point;
        }
      }
      let fallback: WorkSample | null = null;
      if (!latestPoint) {
        for (const item of orderedSamplesByWork.get(workKey) ?? []) {
          const timestamp = parseInstant(item.collectedAt);
          if (timestamp == null || timestamp > run.timestamp) break;
          fallback = item;
        }
      }
      const currentMetrics = latestPoint?.metrics ?? fallback?.metrics;
      if (!currentMetrics) continue;
      for (const key of referenceAdditiveMetricKeys) metrics[key] = referenceAddNullable(metrics[key], currentMetrics[key]);
    }
    return { observedAt: run.observedAt, runId, metrics };
  });
  const delta = referenceEmptyMetrics();
  for (const work of works) for (const key of referenceAdditiveMetricKeys) delta[key] = referenceAddNullable(delta[key], work.delta[key]);
  return {
    date: day.date,
    baselineLabel: works.length === 0 || works.some((work) => work.baselineLabel === "partial") ? "partial" : "estimated",
    sampleCount: portfolioPoints.length,
    points: portfolioPoints,
    works,
    delta,
  };
}

describe("intraday analytics", () => {
  it("forward-fills a flat work from its first in-day observation", () => {
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [sample("illust-1", localAt(23, 30, 29), 100)],
      observations: [
        observation("illust-1", localAt(23, 30, 29), "run-baseline", true),
        observation("illust-1", localAt(10), "run-1", true),
        observation("illust-1", localAt(12), "run-2", false),
      ],
      now: "2026-08-30T18:00:00+08:00",
      configuredIntervalHours: 1,
    });
    expect(result.works[0]).toMatchObject({ baselineLabel: "partial", sampleCount: 2, changeSampleCount: 0 });
    expect(result.works[0]?.points.map((point) => point.metrics.views)).toEqual([100, 100]);
    expect(result.works[0]?.delta.views).toBe(0);
  });

  it("does not invent today's growth before a second in-day observation", () => {
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }, { key: "novel-2" }],
      samples: [
        sample("illust-1", localAt(23, 30, 29), 100),
        sample("illust-1", localAt(10), 130, "run-1"),
        sample("novel-2", localAt(23, 45, 29), 50),
      ],
      observations: [
        observation("illust-1", localAt(23, 30, 29), "run-baseline-a", true),
        observation("novel-2", localAt(23, 45, 29), "run-baseline-b", true),
        observation("illust-1", localAt(10), "run-1", true),
        observation("novel-2", localAt(11), "run-2", false),
      ],
      now: "2026-08-30T18:00:00+08:00",
      configuredIntervalHours: 1,
    });
    expect(result.works[0]?.delta.views).toBe(0);
    expect(result.works[0]?.changeSampleCount).toBe(1);
    expect(result.delta.views).toBe(0);
  });

  it("counts portfolio sampling rounds by run instead of by work", () => {
    const at = localAt(10);
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }, { key: "novel-2" }],
      samples: [sample("illust-1", at, 100, "run-1"), sample("novel-2", at, 50, "run-1")],
      observations: [
        observation("illust-1", at, "run-1", true),
        observation("novel-2", at, "run-1", true),
      ],
      now: "2026-08-30T18:00:00+08:00",
      configuredIntervalHours: 1,
    });
    expect(result.sampleCount).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.metrics.views).toBe(150);
  });

  it("reconstructs intraday rounds from compact observation batches", () => {
    const firstAt = localAt(10);
    const secondAt = localAt(12);
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }, { key: "novel-2" }],
      samples: [sample("illust-1", firstAt, 100, "run-1"), sample("novel-2", firstAt, 50, "run-1"), sample("illust-1", secondAt, 125, "run-2")],
      observations: [],
      observationBatches: [
        { runId: "run-1", observedAt: firstAt, workKeys: ["illust-1", "novel-2"], changedWorkKeys: ["illust-1", "novel-2"], scope: "complete" },
        { runId: "run-2", observedAt: secondAt, workKeys: ["illust-1", "novel-2"], changedWorkKeys: ["illust-1"], scope: "complete" },
      ],
      now: "2026-08-30T18:00:00+08:00",
    });
    expect(result.sampleCount).toBe(2);
    expect(result.points.map((point) => point.metrics.views)).toEqual([150, 175]);
    expect(result.works.find((work) => work.workKey === "novel-2")?.points[1]?.metricsChanged).toBe(false);
  });

  it("marks the first observation partial when the previous sample is too old", () => {
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [
        sample("illust-1", localAt(20, 0, 29), 75),
        sample("illust-1", localAt(10), 100, "run-1"),
        sample("illust-1", localAt(12), 115, "run-2"),
      ],
      observations: [
        observation("illust-1", localAt(10), "run-1", true),
        observation("illust-1", localAt(12), "run-2", true),
      ],
      now: "2026-08-30T18:00:00+08:00",
      configuredIntervalHours: 1,
    });
    expect(result.works[0]?.baselineLabel).toBe("partial");
    expect(result.works[0]?.delta.views).toBe(15);
    expect(result.works[0]?.baselineAt).toBe(localAt(10));
  });

  it("carries each work forward through a partial run and never sums rank", () => {
    const firstAt = localAt(10);
    const secondAt = localAt(12);
    const firstA = sample("illust-1", firstAt, 100, "run-1");
    const firstB = sample("novel-2", firstAt, 50, "run-1");
    const secondA = sample("illust-1", secondAt, 130, "run-2");
    firstA.metrics.rank = 5;
    firstB.metrics.rank = 8;
    secondA.metrics.rank = 3;
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }, { key: "novel-2" }],
      samples: [firstA, firstB, secondA],
      observations: [
        observation("illust-1", firstAt, "run-1", true),
        observation("novel-2", firstAt, "run-1", true),
        observation("illust-1", secondAt, "run-2", true),
      ],
      now: "2026-08-30T18:00:00+08:00",
      configuredIntervalHours: 1,
    });
    expect(result.points.map((point) => point.metrics.views)).toEqual([150, 180]);
    expect(result.points.every((point) => point.metrics.rank === null)).toBe(true);
  });

  it("uses the UTC+8 natural-day boundary regardless of the host timezone", () => {
    const beforeMidnight = "2026-08-30T15:59:59.999Z";
    const atMidnight = "2026-08-30T16:00:00.000Z";
    const later = "2026-08-30T16:30:00.000Z";
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [
        sample("illust-1", beforeMidnight, 100, "baseline"),
        sample("illust-1", atMidnight, 105, "midnight"),
        sample("illust-1", later, 110, "later"),
      ],
      observations: [
        observation("illust-1", beforeMidnight, "baseline", true),
        observation("illust-1", atMidnight, "midnight", true),
        observation("illust-1", later, "later", true),
      ],
      now: later,
      configuredIntervalHours: 1,
    });

    expect(result.date).toBe("2026-08-31");
    expect(result.sampleCount).toBe(2);
    expect(result.works[0]?.points.map((point) => point.runId)).toEqual(["midnight", "later"]);
    expect(result.works[0]?.baselineAt).toBe(atMidnight);
    expect(result.delta.views).toBe(5);
  });

  it("marks a first observation close to Beijing midnight as a near-day-start baseline", () => {
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [
        sample("illust-1", "2026-08-30T14:00:00.000Z", 100, "old-change"),
        sample("illust-1", "2026-08-30T17:00:00.000Z", 130, "today-change"),
      ],
      observations: [
        observation("illust-1", "2026-08-30T15:30:00.000Z", "near-midnight", false),
        observation("illust-1", "2026-08-30T17:00:00.000Z", "today-change", true),
      ],
      now: "2026-08-30T18:00:00.000Z",
      configuredIntervalHours: 1,
    });

    expect(result.works[0]).toMatchObject({ baselineLabel: "estimated", baselineAt: "2026-08-30T17:00:00.000Z" });
    expect(result.delta.views).toBe(0);
  });

  it("uses today's first observation as the displayed daily-change baseline", () => {
    const beforeMidnight = sample("illust-1", localAt(23, 30, 29), 100, "before-midnight");
    const firstToday = sample("illust-1", localAt(0, 5), 100, "today-first");
    const rebound = sample("illust-1", localAt(1, 30), 100, "today-rebound");
    const latest = sample("illust-1", localAt(2, 50), 100, "today-latest");
    beforeMidnight.metrics.bookmarks = 428;
    firstToday.metrics.bookmarks = 427;
    rebound.metrics.bookmarks = 428;
    latest.metrics.bookmarks = 427;

    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [beforeMidnight, firstToday, rebound, latest],
      observations: [
        observation("illust-1", beforeMidnight.collectedAt, beforeMidnight.runId, true),
        observation("illust-1", firstToday.collectedAt, firstToday.runId, true),
        observation("illust-1", rebound.collectedAt, rebound.runId, true),
        observation("illust-1", latest.collectedAt, latest.runId, true),
      ],
      now: localAt(3),
      configuredIntervalHours: 1,
    });

    expect(result.works[0]?.points.map((point) => point.metrics.bookmarks)).toEqual([427, 428, 427]);
    expect(result.works[0]?.baselineAt).toBe(firstToday.collectedAt);
    expect(result.works[0]?.delta.bookmarks).toBe(0);
    expect(result.delta.bookmarks).toBe(0);
  });

  it("preserves a real net decrease from today's first observation", () => {
    const firstToday = sample("illust-1", localAt(0, 5), 100, "today-first");
    const latest = sample("illust-1", localAt(2, 50), 100, "today-latest");
    firstToday.metrics.bookmarks = 427;
    latest.metrics.bookmarks = 426;

    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [firstToday, latest],
      observations: [
        observation("illust-1", firstToday.collectedAt, firstToday.runId, true),
        observation("illust-1", latest.collectedAt, latest.runId, true),
      ],
      now: localAt(3),
    });

    expect(result.works[0]?.delta.bookmarks).toBe(-1);
    expect(result.delta.bookmarks).toBe(-1);
  });

  it("returns an empty partial result for an invalid explicit now value", () => {
    const result = buildIntradayAnalytics({ samples: [], observations: [], now: "not-a-time" });
    expect(result).toMatchObject({ date: "", baselineLabel: "partial", sampleCount: 0, works: [] });
  });

  it("matches the scan-based oracle for mixed ties, nulls, invalid times, and batches", () => {
    const firstAt = localAt(8);
    const secondAt = localAt(10);
    const thirdAt = localAt(11);
    const firstSample = sample("illust-1", firstAt, 80, "sample-first");
    const tieSample = sample("illust-1", firstAt, 81, "sample-tie");
    firstSample.id = 9;
    tieSample.id = 3;
    const nullSample = sample("novel-2", thirdAt, 120, "sample-null");
    nullSample.metrics.views = null;
    const input: IntradayAnalyticsInput = {
      works: [{ key: "illust-1" }, { key: "novel-2" }, { key: "missing-3" }],
      samples: [
        sample("illust-1", "not-a-time", 999, "sample-invalid"),
        tieSample,
        firstSample,
        sample("illust-1", "2026-08-29T23:59:00.000Z", 1, "sample-before-day"),
        nullSample,
      ],
      observations: [
        { ...observation("illust-1", secondAt, "run-second", true), id: 9 },
        { ...observation("illust-1", firstAt, "run-first", true), id: 5 },
        { ...observation("novel-2", thirdAt, "run-null", true), id: 1 },
        observation("missing-3", "not-a-time", "run-invalid", true),
      ],
      observationBatches: [
        { runId: "run-first", observedAt: firstAt, workKeys: ["illust-1", "novel-2", "novel-2"], changedWorkKeys: ["illust-1"], scope: "partial" },
        { runId: "run-batch", observedAt: thirdAt, workKeys: ["illust-1", "novel-2"], changedWorkKeys: ["novel-2"], scope: "complete" },
      ],
      now: localAt(12),
      configuredIntervalHours: 1,
    };

    expect(buildIntradayAnalytics(input)).toEqual(buildReferenceIntradayAnalytics(input));
  });

  it("preserves tie ordering, invalid and missing records, and batch deduplication", () => {
    const sameAt = localAt(10);
    const missingAt = localAt(9);
    const lowerIdSample = sample("illust-1", sameAt, 10, "sample-low");
    const higherIdSample = sample("illust-1", sameAt, 20, "sample-high");
    lowerIdSample.id = 2;
    higherIdSample.id = 9;
    const invalidSample = sample("illust-1", "not-a-time", 999, "sample-invalid");
    const earlierObservation = observation("illust-1", sameAt, "run-2", false);
    const laterObservation = observation("illust-1", sameAt, "run-1", true);
    earlierObservation.id = 10;
    laterObservation.id = 20;
    const missingObservation = observation("novel-2", missingAt, "run-missing", true);

    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }, { key: "novel-2" }],
      samples: [invalidSample, higherIdSample, lowerIdSample],
      observations: [laterObservation, missingObservation, earlierObservation],
      observationBatches: [
        { runId: "run-1", observedAt: sameAt, workKeys: ["illust-1", "novel-2", "novel-2"], changedWorkKeys: ["illust-1", "novel-2"], scope: "complete" },
      ],
      now: localAt(12),
      configuredIntervalHours: 1,
    });

    expect(result.works.map((work) => work.workKey)).toEqual(["illust-1", "novel-2"]);
    expect(result.works[0]?.points.map((point) => point.runId)).toEqual(["run-2", "run-1"]);
    expect(result.works[0]?.points.map((point) => point.metrics.views)).toEqual([20, 20]);
    expect(result.works[1]?.points.map((point) => point.runId)).toEqual(["run-missing", "run-1"]);
    expect(result.works[1]?.points.map((point) => point.metrics.views)).toEqual([null, null]);
    expect(result.sampleCount).toBe(3);
    expect(result.points.map((point) => point.runId)).toEqual(["run-missing", "run-2", "run-1"]);
    expect(result.points.map((point) => point.metrics.views)).toEqual([null, 20, 20]);
    expect(result.works[1]?.sampleCount).toBe(2);
  });

  it("keeps first-seen order when a run's representative timestamp is updated", () => {
    const firstAt = localAt(9);
    const finalAt = localAt(10);
    const result = buildIntradayAnalytics({
      works: [{ key: "illust-1" }],
      samples: [sample("illust-1", firstAt, 10), sample("illust-1", finalAt, 20)],
      observations: [
        { ...observation("illust-1", firstAt, "run-a", true), id: 1 },
        { ...observation("illust-1", finalAt, "run-b", true), id: 2 },
        { ...observation("illust-1", finalAt, "run-a", true), id: 3 },
      ],
      now: localAt(12),
    });

    expect(result.points.map((point) => point.runId)).toEqual(["run-a", "run-b"]);
    expect(result.points.map((point) => point.observedAt)).toEqual([finalAt, finalAt]);
  });

  it("keeps time lookups bounded by indexed input size on a larger fixture", () => {
    const workCount = 34;
    const observationCount = 1_000;
    let sampleTimeReads = 0;
    let observationTimeReads = 0;
    const samples: WorkSample[] = [];
    const observations: WorkObservation[] = [];
    const works = Array.from({ length: workCount }, (_, workIndex) => ({ key: `work-${workIndex}` }));

    for (let workIndex = 0; workIndex < workCount; workIndex += 1) {
      const workKey = `work-${workIndex}`;
      for (let pointIndex = 0; pointIndex < observationCount; pointIndex += 1) {
        const at = localAt(Math.floor(pointIndex / 60), pointIndex % 60, 30);
        const workSample = sample(workKey, at, workIndex * observationCount + pointIndex, `sample-${workIndex}-${pointIndex}`);
        const originalSampleTime = workSample.collectedAt;
        Object.defineProperty(workSample, "collectedAt", {
          configurable: true,
          get: () => {
            sampleTimeReads += 1;
            return originalSampleTime;
          },
        });
        samples.push(workSample);

        const workObservation = observation(workKey, at, `run-${pointIndex}`, pointIndex > 0);
        const originalObservationTime = workObservation.observedAt;
        Object.defineProperty(workObservation, "observedAt", {
          configurable: true,
          get: () => {
            observationTimeReads += 1;
            return originalObservationTime;
          },
        });
        observations.push(workObservation);
      }
    }

    const result = buildIntradayAnalytics({ works, samples, observations, now: localAt(23, 59) });

    expect(result.works).toHaveLength(workCount);
    expect(result.works.every((work) => work.points.length === observationCount)).toBe(true);
    expect(result.sampleCount).toBe(observationCount);
    expect(sampleTimeReads).toBeLessThanOrEqual(samples.length * 2);
    expect(observationTimeReads).toBeLessThanOrEqual(observations.length * 3);
  });
});
