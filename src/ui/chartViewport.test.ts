import { describe, expect, it } from "vitest";
import { resolveChartViewport } from "./chartViewport";

describe("chart zoom viewport", () => {
  it("resolves slider and batched wheel zoom against the full observation domain", () => {
    expect(resolveChartViewport([100, 1100], { start: 20, end: 60 })).toEqual([300, 700]);
    expect(resolveChartViewport([100, 1100], { batch: [{ start: 20, end: 60 }] })).toEqual([300, 700]);
  });
  it("honours value zooms, including real timestamp strings", () => {
    const start = Date.parse("2026-09-01T00:00:00Z");
    const end = Date.parse("2026-09-03T00:00:00Z");
    const middle = Date.parse("2026-09-02T00:00:00Z");
    expect(resolveChartViewport([start, end], { startValue: "2026-09-02T00:00:00Z", endValue: end })).toEqual([middle, end]);
    expect(resolveChartViewport([0, 10], { startValue: 3, endValue: 7 })).toEqual([3, 7]);
  });
  it("clamps to observations and keeps degenerate zooms finite", () => {
    expect(resolveChartViewport([0, 10], { start: -10, end: 120 })).toEqual([0, 10]);
    expect(resolveChartViewport([0, 10], { start: 50, end: 50 })).toEqual([0, 10]);
    expect(resolveChartViewport([0, 10], { start: NaN, end: Infinity })).toEqual([0, 10]);
    expect(resolveChartViewport([4, 4], { start: 50, end: 50 })).toEqual([4, 4]);
    expect(resolveChartViewport(undefined, {})).toBeUndefined();
  });
});
