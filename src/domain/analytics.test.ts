import { describe, expect, it } from "vitest";
import { analyzeWork, calculateMetricDelta, calculateRatio } from "./analytics";
import type { WorkMetrics, WorkRecord, WorkSample } from "./types";

const metrics = (values: Partial<WorkMetrics>): WorkMetrics => ({
  likes: values.likes ?? null,
  bookmarks: values.bookmarks ?? null,
  views: values.views ?? null,
  comments: values.comments ?? null,
  rank: values.rank ?? null,
  responses: values.responses ?? null,
  illustrations: values.illustrations ?? null,
});
const work: WorkRecord = {
  key: "illust-1",
  id: "1",
  type: "illust",
  title: "Test",
  seriesTitle: null,
  publishedAt: null,
  wordCount: null,
  pageCount: 1,
  isAi: null,
  isR18: null,
  thumbnailUrl: null,
  workUrl: "https://www.pixiv.net/artworks/1",
  metrics: metrics({ views: 100, likes: 10, bookmarks: 4 }),
  rawLabels: {},
  missingFields: [],
  parserVersion: 1,
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-01T02:00:00.000Z",
  lastObservedRunId: "run-2",
  absentSince: null,
};

const sample = (runId: string, collectedAt: string, values: Partial<WorkMetrics>): WorkSample => ({
  workKey: work.key,
  runId,
  collectedAt,
  metrics: metrics(values),
  parserVersion: 1,
  dataQuality: 1,
  kind: "change",
});

describe("work analytics", () => {
  it("uses actual elapsed intervals and guards zero denominators", () => {
    const previous = sample("run-1", "2026-08-01T00:00:00.000Z", { views: 100, likes: 10, bookmarks: 4 });
    const latest = sample("run-2", "2026-08-01T02:00:00.000Z", { views: 160, likes: 16, bookmarks: 8 });
    const delta = calculateMetricDelta(previous, latest, "views");
    expect(delta.value).toBe(60);
    expect(delta.elapsedHours).toBe(2);
    expect(delta.confidence).toBe("exact");
    expect(calculateRatio(8, 0)).toBeNull();
    expect(calculateRatio(null, 10)).toBeNull();
    const analysis = analyzeWork(work, [previous, latest], [
      { workKey: work.key, runId: "run-1", observedAt: previous.collectedAt, metricsChanged: true },
      { workKey: work.key, runId: "run-2", observedAt: latest.collectedAt, metricsChanged: true },
    ]);
    expect(analysis.bookmarkRate).toBe(0.05);
    expect(analysis.likeRate).toBe(0.1);
    expect(analysis.sparkline).toHaveLength(2);
    expect(analysis.confidence).toBe("medium");
  });

  it("does not fabricate a delta or confidence from one sample", () => {
    const only = sample("run-1", "2026-08-01T00:00:00.000Z", { views: 0, likes: 0, bookmarks: 0 });
    const delta = calculateMetricDelta(null, only, "views");
    expect(delta.value).toBeNull();
    expect(delta.elapsedHours).toBeNull();
    expect(delta.confidence).toBe("insufficient");
    const analysis = analyzeWork(work, [only], [{ workKey: work.key, runId: "run-1", observedAt: only.collectedAt, metricsChanged: true }]);
    expect(analysis.confidence).toBe("low");
    expect(analysis.bookmarkRate).toBeNull();
    expect(analysis.likeRate).toBeNull();
  });
});
