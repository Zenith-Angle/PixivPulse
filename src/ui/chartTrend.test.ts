import { describe, expect, it } from "vitest";
import type { EChartsCoreOption } from "echarts/core";
import { buildSmoothedTrend, buildTrendSeries, getChartTimeExtent } from "./chartTrend";

type NumericPoint = readonly [number, number, ...unknown[]];

const asRecord = (value: unknown): Record<string, any> => value as Record<string, any>;

const interpolate = (points: readonly NumericPoint[], x: number): number => {
  if (points.length === 0) return Number.NaN;
  if (x <= points[0]![0]) return points[0]![1];
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    const left = points[index - 1]!;
    if (x <= right[0]) {
      const fraction = (x - left[0]) / (right[0] - left[0]);
      return left[1] + (right[1] - left[1]) * fraction;
    }
  }
  return points[points.length - 1]![1];
};

const secondDifferenceRoughness = (values: readonly number[]): number => {
  let total = 0;
  for (let index = 1; index < values.length - 1; index += 1) {
    total += Math.abs(values[index - 1]! - 2 * values[index]! + values[index + 1]!);
  }
  return total;
};

describe("chart trend smoothing", () => {
  it("leaves fixed-window growth unchanged across viewports", () => {
    const series = [{ id: "growth", type: "line" as const, smooth: false, data: [[0, 10], [1, 30], [2, -5]] }];
    expect(buildTrendSeries({ series }, [0, 2])).toEqual(series);
    expect(buildTrendSeries({ series }, [1, 2])).toEqual(series);
  });
  it("reduces a high-frequency staircase while keeping a fixed output grid", () => {
    const points: NumericPoint[] = Array.from({ length: 460 }, (_, index) => [
      index,
      20 + Math.floor(index / 16) * 17 + (index >= 41 ? 32 : 0) + Math.floor(index / 43) * 7,
    ]);
    const trend = buildSmoothedTrend(points);
    const rawAtGrid = trend.map(([x]) => interpolate(points, x));

    expect(trend).toHaveLength(512);
    expect(secondDifferenceRoughness(trend.map(([, y]) => y)) / secondDifferenceRoughness(rawAtGrid)).toBeLessThan(0.3);
  });

  it("keeps increasing negative data monotonic, bounded, and exact at full-domain endpoints", () => {
    const points: NumericPoint[] = [[-4, -12], [-1, -7], [3, -1], [11, 9]];
    const trend = buildSmoothedTrend(points);
    const values = trend.map(([, y]) => y);

    expect(trend[0]).toEqual([-4, -12]);
    expect(trend[trend.length - 1]).toEqual([11, 9]);
    expect(values.every((value) => value >= -12 && value <= 9)).toBe(true);
    expect(values.every((value, index) => index === 0 || value >= values[index - 1]! - 1e-10)).toBe(true);
  });

  it("keeps decreasing plateaus monotonic without losing negative values", () => {
    const points: NumericPoint[] = [[0, 10], [1, 10], [2, 5], [5, 5], [6, -2]];
    const trend = buildSmoothedTrend(points);
    const values = trend.map(([, y]) => y);

    expect(trend[0]).toEqual([0, 10]);
    expect(trend[trend.length - 1]).toEqual([6, -2]);
    expect(values.every((value) => value >= -2 && value <= 10)).toBe(true);
    expect(values.every((value, index) => index === 0 || value <= values[index - 1]! + 1e-10)).toBe(true);
  });

  it("leaves an affine function unchanged even with irregular input density", () => {
    const points: NumericPoint[] = [[0, 3], [0.1, 3.2], [1, 5], [4, 11], [9, 21]];
    const trend = buildSmoothedTrend(points);

    for (const [x, y] of trend) expect(y).toBeCloseTo(2 * x + 3, 8);
  });

  it("uses the last duplicate for the trend but leaves raw tuple metadata untouched", () => {
    const data: NumericPoint[] = [[0, 1, "first"], [0, 4, "last"], [2, 8, "end"]];
    const dimensions = [{ name: "时间", type: "time" }, { name: "浏览", type: "float" }, { name: "同步", type: "ordinal" }];
    const encode = { x: 0, y: 1, tooltip: [1, 2] };
    const source = {
      id: "work-a",
      name: "作品 A",
      type: "line" as const,
      data,
      dimensions,
      encode,
      lineStyle: { color: "#f00", width: 3 },
      areaStyle: { color: "#f00", opacity: 0.12 },
      itemStyle: { color: "#f00", borderWidth: 2 },
    };
    const output = buildTrendSeries({ series: [source] }, undefined);
    const raw = asRecord(output[0]);
    const trend = asRecord(output[1]);

    expect(raw.data).toBe(data);
    expect(raw.data).toEqual(data);
    expect(raw.dimensions).toBe(dimensions);
    expect(raw.encode).toBe(encode);
    expect(trend.id).toBe("work-a:trend");
    expect(trend.data[0]).toEqual([0, 4]);
    expect(trend.data[trend.data.length - 1]).toEqual([2, 8]);
    expect(trend.data.every((point: unknown) => (point as unknown[]).length === 2)).toBe(true);
  });

  it("keeps raw series first and hides only its display while disabling companion tooltips", () => {
    const first = { id: "first", name: "First", type: "line" as const, data: [[0, 0], [2, 2]], lineStyle: { color: "red", width: 4 }, areaStyle: { color: "red", opacity: 0.2 }, itemStyle: { color: "red" } };
    const second = { id: "second", name: "Second", type: "line" as const, data: [[1, 10], [3, 12]], lineStyle: { color: "blue", width: 2 } };
    const output = buildTrendSeries({ series: [first, second] });
    const rawFirst = asRecord(output[0]);
    const rawSecond = asRecord(output[1]);
    const trendFirst = asRecord(output[2]);
    const trendSecond = asRecord(output[3]);

    expect(output).toHaveLength(4);
    expect(rawFirst.id).toBe("first:raw");
    expect(rawSecond.id).toBe("second:raw");
    expect(rawFirst.data).toBe(first.data);
    expect(rawSecond.data).toBe(second.data);
    expect(rawFirst.lineStyle).toMatchObject({ color: "red", width: 0, opacity: 0 });
    expect(rawFirst.areaStyle).toMatchObject({ color: "red", opacity: 0 });
    expect(rawFirst.itemStyle).toMatchObject({ color: "red", opacity: 0 });
    expect(rawFirst.sampling).toBeUndefined();
    expect(rawFirst.emphasis).toMatchObject({ disabled: true });
    expect(rawFirst.selectedMode).toBe(false);
    expect(trendFirst.id).toBe("first:trend");
    expect(trendSecond.id).toBe("second:trend");
    expect(trendFirst.name).toBe(first.name);
    expect(trendFirst.lineStyle).toEqual(first.lineStyle);
    expect(trendFirst.areaStyle).toEqual(first.areaStyle);
    expect(trendFirst.tooltip).toEqual({ show: false, trigger: "none" });
    expect(trendFirst.smooth).toBe(0.35);
    expect(trendFirst.smoothMonotone).toBe("none");
    expect(trendFirst.showSymbol).toBe(false);
    expect(trendFirst.symbol).toBe("none");
    expect(trendFirst.sampling).toBeUndefined();
    expect(trendFirst.animation).toBe(false);
    expect(trendFirst.emphasis).toMatchObject({ disabled: true });
    expect(trendFirst.selectedMode).toBe(false);
  });

  it("clips trend output to the visible window plus three bandwidths", () => {
    const points: NumericPoint[] = [[0, 0], [100, 100]];
    const trend = buildSmoothedTrend(points, [40, 60]);

    expect(trend[0]![0]).toBeCloseTo(38.5, 12);
    expect(trend[trend.length - 1]![0]).toBeCloseTo(61.5, 12);
    expect(trend.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 100)).toBe(true);
    expect(buildSmoothedTrend(points, [200, 300])).toEqual([]);
  });

  it("uses one shared viewport bandwidth for different work domains", () => {
    const viewport = [20, 80] as const;
    const narrow: NumericPoint[] = [[0, 0], [100, 100]];
    const wide: NumericPoint[] = [[0, 0], [1000, 1000]];
    const narrowTrend = buildSmoothedTrend(narrow, viewport);
    const wideTrend = buildSmoothedTrend(wide, viewport);

    expect(narrowTrend[0]![0]).toBeCloseTo(15.5, 12);
    expect(narrowTrend[narrowTrend.length - 1]![0]).toBeCloseTo(84.5, 12);
    expect(wideTrend[0]![0]).toBeCloseTo(15.5, 12);
    expect(wideTrend[wideTrend.length - 1]![0]).toBeCloseTo(84.5, 12);
  });

  it("does not manufacture trend companions for empty, singleton, or duplicate-only data", () => {
    const empty = { id: "empty", type: "line" as const, data: [] as NumericPoint[] };
    const singleton = { id: "singleton", type: "line" as const, data: [[1, 2, "meta"]] as NumericPoint[] };
    const duplicateOnly = { id: "duplicate", type: "line" as const, data: [[2, 3, "a"], [2, 4, "b"]] as NumericPoint[] };
    const option = { series: [empty, singleton, duplicateOnly] } satisfies EChartsCoreOption;
    const output = buildTrendSeries(option);

    expect(output).toEqual([empty, singleton, duplicateOnly]);
    expect(output[1]).toBe(singleton);
    expect(output[2]).toBe(duplicateOnly);
  });

  it("ignores unsupported series shapes and reports only supported tuple-line extents", () => {
    const line = { id: "line", type: "line" as const, data: [[8, 1], [12, 3]] };
    const objectData = { id: "objects", type: "line" as const, data: [{ value: [0, 1] }, { value: [100, 2] }] };
    const polar = { id: "polar", type: "line" as const, coordinateSystem: "polar" as const, data: [[-20, 4], [-10, 5]] };
    const scatter = { id: "scatter", type: "scatter", data: [[-100, 0], [100, 1]] };
    const incompatibleEncode = { id: "encoded", type: "line" as const, encode: { x: 2, y: 1 }, data: [[-50, 0], [-40, 1]] };
    const option = { series: [line, objectData, polar, scatter, incompatibleEncode] } satisfies EChartsCoreOption;
    const output = buildTrendSeries(option);

    expect(output[1]).toBe(objectData);
    expect(output[2]).toBe(polar);
    expect(output[3]).toBe(scatter);
    expect(output[4]).toBe(incompatibleEncode);
    expect(getChartTimeExtent(option)).toEqual([8, 12]);
    expect(getChartTimeExtent({ series: [objectData, polar, scatter, incompatibleEncode] })).toBeUndefined();
  });

  it("returns raw display points for fewer than two distinct x values", () => {
    const points: NumericPoint[] = [[5, -1, "a"], [5, 4, "b"]];
    expect(buildSmoothedTrend(points)).toEqual([[5, -1], [5, 4]]);
  });

  it("filters nonfinite numeric points without mutating the input", () => {
    const points: NumericPoint[] = [[0, 0], [1, Number.NaN], [2, 2], [3, Number.POSITIVE_INFINITY]];
    const snapshot = points.map((point) => [...point]);

    expect(buildSmoothedTrend(points)).toHaveLength(512);
    expect(points).toEqual(snapshot);
    expect(buildSmoothedTrend([[0, Number.NaN], [1, Number.POSITIVE_INFINITY]])).toEqual([]);
  });
});
