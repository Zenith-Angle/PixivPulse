import { describe, expect, it } from "vitest";
import { buildCompareBuckets, compareBucketHours } from "./compareBuckets";
import type { ChartTimeRangePreset } from "./chartTimeRange";

const start = Date.parse("2026-09-07T00:00:00+08:00");
const HOUR = 3_600_000;
const point = (hour: number, value: number | null) => ({ at: new Date(start + hour * HOUR).toISOString(), value });
const buckets = (points: ReturnType<typeof point>[], end = 3) => buildCompareBuckets(points, start, start + end * HOUR, 1);

describe("comparison time buckets", () => {
  it.each<[ChartTimeRangePreset, number]>([["24h", 1], ["3d", 3], ["7d", 6], ["30d", 24], ["3m", 72]])("uses a stable width for %s", (preset, hours) => {
    expect(compareBucketHours({ preset, startMs: start, endMs: start + 10 * HOUR })).toBe(hours);
  });

  it("sums changes, includes right boundaries once, and preserves decreases and observed zero", () => {
    const result = buckets([point(0, 100), point(0.25, 110), point(0.75, 125), point(1, 130), point(2, 125), point(3, 125)]);
    expect(result.map((bucket) => bucket.value)).toEqual([30, -5, 0]);
    expect(result.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0)).toBe(25);
  });

  it("retains a preceding baseline and assigns a later observation to its bucket", () => {
    const result = buckets([point(-2, 100), point(0.5, 120), point(3, 160)]);
    expect(result.map((bucket) => bucket.value)).toEqual([20, null, 40]);
  });

  it("does not invent a zero baseline, fill empty tails, or bridge unknown metrics", () => {
    expect(buckets([point(0.5, 100)]).map((bucket) => bucket.value)).toEqual([null, null, null]);
    expect(buckets([point(0, 100), point(0.5, null), point(1, 130), point(2, 140)]).map((bucket) => bucket.value)).toEqual([null, 10, null]);
  });

  it("clips partial edge buckets and ignores observations after the selected end", () => {
    const result = buildCompareBuckets([point(0, 100), point(0.75, 120), point(1.25, 130), point(2, 500)], start + HOUR / 2, start + 1.5 * HOUR, 1);
    expect(result.map((bucket) => [bucket.start, bucket.end, bucket.value])).toEqual([
      [start + HOUR / 2, start + HOUR, 20], [start + HOUR, start + 1.5 * HOUR, 10],
    ]);
  });

  it("sorts inputs and uses the final duplicate-time value as the next baseline", () => {
    expect(buckets([point(2, 140), point(0, 100), point(1, 120), point(1, 125)]).map((bucket) => bucket.value)).toEqual([25, 15, null]);
  });

  it("adapts custom and all-history ranges and rejects empty bounds", () => {
    expect(compareBucketHours({ preset: "all", startMs: null, endMs: null }, 90 * 24 * HOUR)).toBe(72);
    expect(compareBucketHours({ preset: "custom", startMs: start, endMs: start + 7 * 24 * HOUR })).toBe(6);
    expect(buildCompareBuckets([], start, start, 1)).toEqual([]);
  });
});
