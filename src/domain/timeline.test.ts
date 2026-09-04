import { describe, expect, it } from "vitest";
import { buildPortfolioTimeline, buildWorkTimeline } from "./timeline";
import type { ObservationBatch, WorkMetrics, WorkObservation, WorkSample } from "./types";

const metrics = (views: number): WorkMetrics => ({ views, likes: views, bookmarks: views, comments: views, rank: null, responses: null, illustrations: null });
const sample = (workKey: string, runId: string, collectedAt: string, views: number, kind: WorkSample["kind"] = "change"): WorkSample => ({ workKey, runId, collectedAt, metrics: metrics(views), parserVersion: 1, dataQuality: 1, kind });
const observation = (workKey: string, runId: string, observedAt: string): WorkObservation => ({ workKey, runId, observedAt, metricsChanged: true });

describe("historical chart timelines", () => {
  it("forward-fills unchanged observations from the latest sparse sample", () => {
    const samples = [sample("a", "r1", "2026-08-30T00:00:00Z", 10), sample("a", "r3", "2026-08-30T02:00:00Z", 15)];
    const observations = [observation("a", "r1", "2026-08-30T00:00:00Z"), observation("a", "r2", "2026-08-30T01:00:00Z"), observation("a", "r3", "2026-08-30T02:00:00Z")];
    expect(buildWorkTimeline("a", samples, observations, { startMs: null, endMs: null }).map((point) => point.metrics.views)).toEqual([10, 10, 15]);
  });

  it("keeps unchanged works in portfolio totals", () => {
    const samples = [sample("a", "r1", "2026-08-30T00:00:00Z", 10), sample("a", "r2", "2026-08-30T01:00:00Z", 12), sample("b", "r1", "2026-08-30T00:00:00Z", 20)];
    const observations = [observation("a", "r1", "2026-08-30T00:00:00Z"), observation("b", "r1", "2026-08-30T00:00:00Z"), observation("a", "r2", "2026-08-30T01:00:00Z"), observation("b", "r2", "2026-08-30T01:00:00Z")];
    expect(buildPortfolioTimeline(["a", "b"], samples, observations, { startMs: null, endMs: null }).map((point) => point.metrics.views)).toEqual([30, 32]);
  });

  it("uses compacted samples when old observations are unavailable", () => {
    const samples = [sample("a", "daily-1", "2026-01-01T15:59:59.999Z", 10, "daily-rollup"), sample("a", "daily-2", "2026-01-02T15:59:59.999Z", 12, "daily-rollup")];
    expect(buildWorkTimeline("a", samples, [], { startMs: null, endMs: null })).toHaveLength(2);
  });

  it("keeps old rollups when recent compressed observations share the range", () => {
    const samples = [sample("a", "old", "2026-05-01T15:59:59.999Z", 10, "daily-rollup"), sample("a", "new", "2026-08-30T01:00:00Z", 20)];
    const batches: ObservationBatch[] = [{ runId: "new", observedAt: "2026-08-30T01:00:00Z", workKeys: ["a"], changedWorkKeys: ["a"], scope: "complete" }];
    expect(buildWorkTimeline("a", samples, [], { startMs: null, endMs: null }, batches).map((point) => point.metrics.views)).toEqual([10, 20]);
  });

  it("adds a range-start baseline before computing range growth", () => {
    const samples = [sample("a", "before", "2026-08-30T00:00:00Z", 10), sample("a", "after", "2026-08-30T02:00:00Z", 15)];
    const batches: ObservationBatch[] = [{ runId: "after", observedAt: "2026-08-30T02:00:00Z", workKeys: ["a"], changedWorkKeys: ["a"], scope: "complete" }];
    const startMs = Date.parse("2026-08-30T01:00:00Z");
    expect(buildPortfolioTimeline(["a"], samples, [], { startMs, endMs: null }, batches).map((point) => point.metrics.views)).toEqual([10, 15]);
  });

  it("uses every available fine-grained sample when the requested range predates local history", () => {
    const samples = [
      sample("a", "first", "2026-08-30T10:00:00Z", 10),
      sample("a", "second", "2026-08-30T12:00:00Z", 15),
    ];
    const range = { startMs: Date.parse("2026-08-27T00:00:00Z"), endMs: Date.parse("2026-08-31T00:00:00Z") };

    expect(buildPortfolioTimeline(["a"], samples, [], range).map((point) => point.metrics.views)).toEqual([10, 15]);
  });
});
