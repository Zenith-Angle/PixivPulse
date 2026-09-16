import { describe, expect, it } from "vitest";
import { createDemoData } from "../ui/demoData";
import { createKnowledge } from "./knowledge";
import type { DashboardData, WorkMetrics } from "../domain/types";

const metrics = (views: number | null, bookmarks: number | null = views, likes: number | null = views): WorkMetrics => ({ views, bookmarks, likes, comments: 0, rank: null, responses: null, illustrations: null });
const args = { dimension: "hour_of_day", metrics: ["views", "bookmarks", "likes"], workKeys: [], from: null, to: null, bucketHours: 1, offset: 0, limit: 24 };
function fixture(points: [string, string, WorkMetrics][]): DashboardData {
  const data = createDemoData(), base = data.works[0]!;
  data.works = [...new Set(points.map(([key]) => key))].map(key => {
    const last = points.filter(([workKey]) => key === workKey).at(-1)!;
    return { ...base, key, title: `作品${key}`, lastSeenAt: last[1], metrics: last[2] };
  });
  data.samples = points.map(([workKey, collectedAt, values], index) => ({ workKey, collectedAt, metrics: values, runId: `r${index}`, kind: "change", parserVersion: 1, dataQuality: 1 }));
  data.observations = []; data.observationBatches = []; data.runs = [];
  return data;
}
const time = (hour: number, minute = 0, day = 1) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`;
type Result = { rows: { slot: string; values: (number | null)[][] }[]; summary: { metric: string; observedNetChange: number | null; peak: string | null; low: string | null; excludedCoarseNetChange: number }[]; selectedWorks: number; total: number; nextOffset: number | null; coverage: { accepted: number; excludedCoarse: number; excludedBoundary: number; suggestedBucketHours: number } };
const query = (data: DashboardData, overrides: Record<string, unknown> = {}) => createKnowledge(data).execute("analyze_time_patterns", { ...args, ...overrides }) as Result;

describe("local temporal aggregates", () => {
  it("aggregates every work and metric, excludes lifetime totals of newly observed works, and preserves negative changes", () => {
    const data = fixture([
      ["a", time(0), metrics(100, 10, 5)], ["a", time(1), metrics(120, 12, 4)], ["a", time(2), metrics(125, 12, 5)],
      ["b", time(0), metrics(200, 20, 10)], ["b", time(1), metrics(230, 23, 12)], ["b", time(2), metrics(240, 24, 12)],
      ["new", time(1), metrics(10000, 1000, 100)], ["new", time(2), metrics(10005, 1001, 101)],
    ]);
    const before = JSON.stringify(data), result = query(data);
    expect(result.selectedWorks).toBe(3);
    expect(result.summary[0]).toMatchObject({ observedNetChange: 70, peak: "00:00–01:00", low: "01:00–02:00" });
    expect(result.rows[0]!.values[0]).toEqual([50, 50, 0, 25, 50 / 70, 2, 1, 2]);
    expect(result.rows[0]!.values[2]!.slice(0, 3)).toEqual([1, 2, -1]);
    expect(result.rows[2]!.values[0]![0]).toBeNull();
    expect(JSON.stringify(data)).toBe(before);
  });
  it("does not mistake denser sampling or unchanged records for higher activity", () => {
    const result = query(fixture([
      ["a", time(0), metrics(0)], ["a", time(0, 15), metrics(3)], ["a", time(0, 30), metrics(6)], ["a", time(0, 45), metrics(9)], ["a", time(1), metrics(12)], ["a", time(2), metrics(24)],
    ]));
    expect(result.rows[0]!.values[0]![3]).toBe(12);
    expect(result.rows[1]!.values[0]![3]).toBe(12);
    expect(result.summary[0]!.peak).toBeNull();
    const zero = query(fixture([["a", time(0), metrics(12)], ["a", time(1), metrics(12)]]));
    expect(zero.rows[0]!.values[0]![0]).toBe(0);
    expect(zero.rows[1]!.values[0]![0]).toBeNull();
  });
  it("keeps coarse gaps out of hourly peaks but allows an explicit coarser comparison", () => {
    const data = fixture([["a", time(0), metrics(100)], ["a", time(6), metrics(700)]]);
    const hourly = query(data);
    expect(hourly.coverage).toMatchObject({ accepted: 0, excludedCoarse: 1, suggestedBucketHours: 6 });
    expect(hourly.summary[0]).toMatchObject({ observedNetChange: null, peak: null, excludedCoarseNetChange: 600 });
    const coarse = query(data, { bucketHours: 6 });
    expect(coarse.rows[0]!.values[0]![0]).toBe(600);
    expect(coarse.total).toBe(4);
  });
  it("respects explicit ranges, metric nulls and selected work scope", () => {
    const data = fixture([["a", time(0), metrics(10, null)], ["a", time(1), metrics(20, 5)], ["a", time(2), metrics(30, 6)], ["b", time(0), metrics(100)], ["b", time(1), metrics(999)]]);
    const result = query(data, { workKeys: ["a"], from: time(0, 30), to: time(2) });
    expect(result.coverage.excludedBoundary).toBe(1);
    expect(result.summary[0]!.observedNetChange).toBe(10);
    expect(result.summary[1]!.observedNetChange).toBe(1);
    expect(query(data).rows[0]!.values[1]![7]).toBe(1); // Only b has two known endpoints.
    expect(() => query(data, { from: "2026-09-01" })).toThrow(/timezone/);
    expect(() => query(data, { workKeys: ["missing"] })).toThrow();
  });
  it("does not recover fake hourly precision from a compacted sample or its observation batch", () => {
    const data = fixture([["a", time(0), metrics(100)], ["a", time(1), metrics(500)]]);
    data.samples[1]!.compactionLevel = "6h";
    data.works[0]!.lastSeenAt = time(1, 2);
    data.observationBatches = [{ runId: "r1", observedAt: time(1, 1), workKeys: ["a"], changedWorkKeys: ["a"], scope: "complete" }];
    const result = query(data);
    expect(result.rows[0]!.values[0]![0]).toBeNull();
    expect(result.coverage).toMatchObject({ excludedCoarse: 2, suggestedBucketHours: 6 });
    data.samples[1]!.compactionLevel = "daily";
    expect(query(data).coverage).toMatchObject({ suggestedBucketHours: 24, suggestedDimension: "date" });
  });
  it("uses confirmed zero-change observations but breaks continuity across a missing changed sample", () => {
    const data = fixture([["a", time(0), metrics(100)], ["a", time(3), metrics(130)], ["a", time(4), metrics(140)]]);
    data.observations = [{ workKey: "a", runId: "unchanged", observedAt: time(1), metricsChanged: false }, { workKey: "a", runId: "lost-change", observedAt: time(2), metricsChanged: true }];
    const result = query(data);
    expect(result.rows[0]!.values[0]![0]).toBe(0);
    expect(result.rows[1]!.values[0]![0]).toBeNull();
    expect(result.rows[2]!.values[0]![0]).toBeNull();
    expect(result.rows[3]!.values[0]![0]).toBe(10);
  });
  it("supports Beijing calendar dates and weekdays, with full-range summary even on a partial page", () => {
    const data = fixture([["a", time(23, 0, 1), metrics(0)], ["a", time(0, 0, 2), metrics(10)], ["a", time(1, 0, 2), metrics(30)]]);
    const daily = query(data, { dimension: "date", limit: 1 });
    expect(daily.rows[0]!.slot).toBe("2026-09-01");
    expect(daily.rows[0]!.values[0]![0]).toBe(10);
    expect(daily.nextOffset).toBe(1);
    expect(daily.summary[0]!.observedNetChange).toBe(30);
    const weekly = query(data, { dimension: "weekday" });
    expect(weekly.rows.find(row => row.slot === "周二")!.values[0]![0]).toBe(10);
    expect(weekly.rows.find(row => row.slot === "周三")!.values[0]![0]).toBe(20);
  });
  it("returns a fixed 24-slot answer from a large portfolio without transmitting raw histories", () => {
    const points: [string, string, WorkMetrics][] = [];
    for (let work = 0; work < 38; work++) for (let index = 0; index < 400; index++) points.push([`w${work}`, new Date(Date.parse(time(0)) + index * 900000).toISOString(), metrics(index * (work + 1))]);
    const result = query(fixture(points));
    expect(result.rows).toHaveLength(24); expect(result.selectedWorks).toBe(38);
    expect(result.summary[0]!.observedNetChange).toBe(399 * 38 * 39 / 2);
    expect(JSON.stringify(result)).not.toContain("workKey");
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(20000);
  });
  it("assigns a slightly delayed midnight reading to the preceding day without double counting", () => {
    const data = fixture([["a", time(23, 30, 1), metrics(100)], ["a", time(0, 2, 2), metrics(110)], ["a", time(0, 30, 2), metrics(115)]]);
    const daily = query(data, { dimension: "date" });
    expect(daily.rows.map(row => row.values[0]![0])).toEqual([10, 5]);
    expect(daily.summary[0]!.observedNetChange).toBe(15);
  });

});
