import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { init, use, setPlatformAPI } from "echarts/core";
import env from "zrender/lib/core/env.js";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, DataZoomComponent, LegendComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { buildAbsoluteCompareChartOption, buildFollowerChartOption, buildGrowthChartOption, buildPortfolioChartOption } from "./chartOptions";
import { buildTrendSeries } from "./chartTrend";

const optionRecord = (option: unknown): Record<string, any> => option as Record<string, any>;

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, SVGRenderer]);

describe("rendered chart behaviour", () => {
  const wasNode = env.node;
  beforeAll(() => {
    // Enable DOM tooltips in jsdom; SVG tests need only deterministic text widths.
    env.node = false;
    setPlatformAPI({ measureText: (text) => ({ width: text.length * 7 }) });
  });
  afterAll(() => { env.node = wasNode; });
  it("follows the slope through sparse observations without leaving segment bounds", () => {
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 800, height: 300 });
    try {
      chart.setOption({ ...buildGrowthChartOption({ metric: "views", points: [
        { at: "2026-09-01T00:00:00Z", value: 10 },
        { at: "2026-09-01T01:00:00Z", value: 30 },
        { at: "2026-09-01T08:00:00Z", value: 60 },
        { at: "2026-09-02T00:00:00Z", value: 60 },
        { at: "2026-09-02T01:00:00Z", value: 40 },
      ] }), animation: false });
      chart.renderToSVGString();
      const line = optionRecord(chart.getZr().storage.getDisplayList().find((item) => item.type === "ec-polyline"));
      const curves: number[][] = [];
      let previous: number[] = [];
      line.buildPath({
        moveTo: (x: number, y: number) => { previous = [x, y]; },
        bezierCurveTo: (...values: number[]) => {
          const [cx1, cy1, cx2, cy2, x, y] = values;
          for (const [value, start, end] of [[cx1, previous[0], x], [cx2, previous[0], x], [cy1, previous[1], y], [cy2, previous[1], y]]) {
            expect(value).toBeGreaterThanOrEqual(Math.min(start!, end!) - 0.001);
            expect(value).toBeLessThanOrEqual(Math.max(start!, end!) + 0.001);
          }
          curves.push(values);
          previous = [x!, y!];
        },
      }, line.shape);
      expect(curves).toHaveLength(4);
      expect(curves[0]![3]).not.toBe(curves[0]![5]);
    } finally {
      chart.dispose();
    }
  });

  it.each(["total", "delta"] as const)("orders the actual %s tooltip at each observation", async (valueMode) => {
    const host = document.createElement("div");
    document.body.append(host);
    const chart = init(host, undefined, { renderer: "svg", width: 800, height: 300 });
    try {
      const source = buildAbsoluteCompareChartOption({ metric: "views", valueMode, range: { preset: "30d", startMs: Date.parse("2026-09-01T00:00:00Z"), endMs: Date.parse("2026-09-04T00:00:00Z") }, series: [
        { key: "a", name: "Alpha", color: "red", points: [10, 20, 50, 60].map((value, i) => ({ at: `2026-09-0${i + 1}T00:00:00Z`, value })) },
        { key: "b", name: "Beta", color: "green", points: [10, 40, 30, 40].map((value, i) => ({ at: `2026-09-0${i + 1}T00:00:00Z`, value })) },
      ] });
      chart.setOption({ ...source, series: buildTrendSeries(source), animation: false });
      for (const [dataIndex, higher, lower] of [[1, "Beta", "Alpha"], [2, "Alpha", "Beta"]] as const) {
        chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex });
        await vi.waitFor(() => {
          const tooltip = host.textContent ?? "";
          expect(tooltip).toContain(higher);
          expect(tooltip).toContain(valueMode === "delta" ? "分段增量" : "采样值");
          expect(tooltip.match(/Alpha/g)).toHaveLength(1);
          expect(tooltip.match(/Beta/g)).toHaveLength(1);
          expect(tooltip.indexOf(higher), `point ${dataIndex}: ${tooltip}`).toBeLessThan(tooltip.indexOf(lower));
        });
      }
    } finally {
      chart.dispose();
      host.remove();
    }
  });
});

describe("dashboard ECharts option builders", () => {
  it("builds the account follower history on a real time axis with density controls", () => {
    const option = optionRecord(buildFollowerChartOption({
      points: Array.from({ length: 40 }, (_, index) => ({
        at: new Date(Date.parse("2026-08-30T00:00:00.000Z") + index * 60_000).toISOString(),
        value: 1_000 + index,
        runId: `follower-${index}`,
      })),
    }));

    expect(option.xAxis.type).toBe("time");
    expect(option.yAxis.name).toBe("粉丝数");
    expect(option.series[0].name).toBe("粉丝数");
    expect(option.series[0].smooth).toBeCloseTo(0.35);
    expect(option.series[0].sampling).toBe("lttb");
    expect(option.series[0].showSymbol).toBe(false);
    expect(option.series[0].data).toHaveLength(40);
    expect(option.dataZoom.some((zoom: { type: string }) => zoom.type === "slider")).toBe(true);
  });

  it("keeps one follower point available for the caller's baseline empty state", () => {
    const option = optionRecord(buildFollowerChartOption({ points: [{ at: "2026-08-30T00:00:00.000Z", value: 100 }] }));
    expect(option.series[0].data).toEqual([[Date.parse("2026-08-30T00:00:00.000Z"), 100, "", 0]]);
    expect(option.xAxis.type).toBe("time");
  });

  it("builds a compact follower preview without full chart chrome", () => {
    const option = optionRecord(buildFollowerChartOption({
      compact: true,
      points: [
        { at: "2026-08-30T00:00:00.000Z", value: 100 },
        { at: "2026-08-30T01:00:00.000Z", value: 101 },
      ],
    }));
    expect(option.xAxis.show).toBe(false);
    expect(option.yAxis.show).toBe(false);
    expect(option.dataZoom).toBeUndefined();
    expect(option.tooltip).toBeUndefined();
    expect(option.aria.enabled).toBe(false);
  });

  it("builds a smooth portfolio area line for a selected non-rank metric", () => {
    const option = optionRecord(buildPortfolioChartOption({
      metric: "comments",
      points: [
        { at: "2026-08-30T00:00:00.000Z", value: 4 },
        { at: "2026-08-30T01:00:00.000Z", value: 9 },
      ],
    }));
    expect(option.animation).toBe(true);
    expect(option.animationDurationUpdate).toBe(0);
    expect(option.series[0].name).toBe("评论");
    expect(option.series[0].smooth).toBe(0.35);
    expect(option.series[0].smoothMonotone).toBeUndefined();
    expect(option.series[0].step).toBeUndefined();
    expect(option.series[0].areaStyle).toBeTruthy();
    expect(option.series[0].data).toEqual([
      [Date.parse("2026-08-30T00:00:00.000Z"), 4, "", 0],
      [Date.parse("2026-08-30T01:00:00.000Z"), 9, "", 1],
    ]);
    expect(option.series[0].name).not.toContain("排名");
  });

  it("places intraday samples on their real timestamp distance", () => {
    const option = optionRecord(buildPortfolioChartOption({
      metric: "views",
      points: [
        { at: "2026-08-30T00:00:00.000Z", value: 10, runId: "a" },
        { at: "2026-08-30T00:30:00.000Z", value: 12, runId: "b" },
        { at: "2026-08-30T06:00:00.000Z", value: 20, runId: "c" },
      ],
    }));

    expect(option.xAxis.type).toBe("time");
    expect(option.series[0].data).toEqual([
      [Date.parse("2026-08-30T00:00:00.000Z"), 10, "a", 0],
      [Date.parse("2026-08-30T00:30:00.000Z"), 12, "b", 1],
      [Date.parse("2026-08-30T06:00:00.000Z"), 20, "c", 2],
    ]);
    expect(option.series[0].sampling).toBeUndefined();
    expect(option.series[0].smooth).toBe(0.35);
    expect(option.series[0].step).toBeUndefined();
    expect(option.series[0].encode).toEqual({ x: 0, y: 1, tooltip: 1 });
    expect(option.xAxis.axisLabel.formatter(Date.parse("2026-08-30T06:00:00.000Z"))).not.toMatch(/NaN|—/);
  });

  it("renders cumulative metric timelines as smooth curves without discarding raw points", () => {
    const portfolio = optionRecord(buildPortfolioChartOption({ metric: "views", points: [
      { at: "2026-08-31T00:00:00.000Z", value: 10 },
      { at: "2026-08-31T00:05:00.000Z", value: 12 },
      { at: "2026-08-31T03:00:00.000Z", value: 20 },
    ] }));
    const detail = optionRecord(buildGrowthChartOption({ metric: "views", points: [
      { at: "2026-08-30T00:00:00.000Z", value: 0 },
      { at: "2026-08-30T02:00:00.000Z", value: 5 },
    ] }));

    for (const option of [portfolio, detail]) {
      expect(option.series[0].smooth).toBe(0.35);
      expect(option.series[0].smoothMonotone).toBeUndefined();
      expect(option.series[0].step).toBeUndefined();
      expect(option.series[0].sampling).toBeUndefined();
      expect(option.animation).toBe(true);
      expect(option.animationDurationUpdate).toBe(0);
    }
    expect(portfolio.series[0].data).toHaveLength(3);
  });

  it("sorts timestamps, preserves same-time runs and hides dense symbols", () => {
    const points = Array.from({ length: 14 }, (_, index) => ({
      at: new Date(Date.parse("2026-08-30T00:00:00.000Z") + index * 60_000).toISOString(),
      value: index,
    }));
    const duplicateAt = points[2]!.at;
    points.unshift({ at: duplicateAt, value: 99 });
    points.unshift({ at: "invalid", value: 100 });
    const option = optionRecord(buildPortfolioChartOption({ metric: "views", points: points.reverse() }));

    expect(option.series[0].data).toHaveLength(15);
    expect(option.series[0].data.filter((point: unknown[]) => point[0] === Date.parse(duplicateAt))).toHaveLength(2);
    expect(option.series[0].showSymbol).toBe(false);
  });

  it("compares two works as absolute totals on their real timestamps", () => {
    const option = optionRecord(buildAbsoluteCompareChartOption({
      metric: "bookmarks",
      series: [
        { key: "a", name: "甲", color: "#007eaf", points: [
          { at: "2026-08-31T03:00:00.000Z", value: 130, runId: "a-2" },
          { at: "2026-08-31T00:00:00.000Z", value: 100, runId: "a-1" },
        ] },
        { key: "b", name: "乙", color: "#ff6b5e", points: [
          { at: "2026-08-31T01:00:00.000Z", value: 80, runId: "b-1" },
          { at: "2026-08-31T04:00:00.000Z", value: 95, runId: "b-2" },
        ] },
      ],
    }));

    expect(option.xAxis.type).toBe("time");
    expect(option.yAxis.name).toBe("收藏总数");
    expect(option.series).toHaveLength(2);
    expect(option.series[0].data).toEqual([
      [Date.parse("2026-08-31T00:00:00.000Z"), 100, "a-1", 1],
      [Date.parse("2026-08-31T03:00:00.000Z"), 130, "a-2", 0],
    ]);
    expect(option.series[1].data).toEqual([
      [Date.parse("2026-08-31T01:00:00.000Z"), 80, "b-1", 0],
      [Date.parse("2026-08-31T04:00:00.000Z"), 95, "b-2", 1],
    ]);
    expect(option.tooltip.valueFormatter(1_300)).toBe("1,300");
    expect(option.series[0].smooth).toBe(0.35);
    expect(option.tooltip.order).toBe("valueDesc");
    expect(option.series[0].sampling).toBeUndefined();
  });

  it("compares bucket increments instead of cumulative growth since the first point", () => {
    const option = optionRecord(buildAbsoluteCompareChartOption({
      metric: "views",
      valueMode: "delta",
      series: [
        { key: "a", name: "甲", color: "#007eaf", points: [
          { at: "2026-08-31T00:00:00.000Z", value: 100 },
          { at: "2026-08-31T01:00:00.000Z", value: 130 },
          { at: "2026-08-31T02:00:00.000Z", value: 125 },
        ] },
        { key: "b", name: "乙", color: "#ff6b5e", points: [
          { at: "2026-08-31T00:30:00.000Z", value: 200 },
          { at: "2026-08-31T02:30:00.000Z", value: 180 },
        ] },
      ],
    }));

    expect(option.xAxis.type).toBe("time");
    expect(option.yAxis.name).toBe("浏览增量 / 1 小时");
    expect(option.series[0].data.map((point: unknown[]) => point[1])).toEqual([30, -5, null]);
    expect(option.series[1].data.map((point: unknown[]) => point[1])).toEqual([null, null, -20]);
    expect(option.series[0].smooth).toBe(false);
    expect(buildTrendSeries(option)).toHaveLength(2);
    expect(option.tooltip.formatter).toBeUndefined();
    expect(option.tooltip.extraCssText).toBeUndefined();
    expect(option.series[1].tooltip).toBeUndefined();
    expect(option.tooltip.axisPointer.label.formatter({ value: option.series[0].data[0][0] })).toBe("8/31 08:00 至 8/31 09:00 · 分段增量");
    expect(option.tooltip.valueFormatter(30)).toBe("+30");
    expect(option.tooltip.valueFormatter(-20)).toBe("-20");
    expect(option.tooltip.order).toBe("valueDesc");
    expect(option.yAxis.min({ min: -20 })).toBe(-20);
    expect(option.yAxis.min({ min: 5 })).toBe(0);
  });

  it("builds one work's absolute totals instead of percentages", () => {
    const option = optionRecord(buildGrowthChartOption({ metric: "likes", points: [
      { at: "2026-08-30T00:00:00.000Z", value: 1_250 },
      { at: "2026-08-30T02:00:00.000Z", value: 1_300 },
    ] }));
    expect(option.series[0].name).toBe("获赞总数");
    expect(option.yAxis.name).toBe("获赞总数");
    expect(option.xAxis.type).toBe("time");
    expect(option.series[0].data).toEqual([
      [Date.parse("2026-08-30T00:00:00.000Z"), 1_250, "", 0],
      [Date.parse("2026-08-30T02:00:00.000Z"), 1_300, "", 1],
    ]);
    expect(option.tooltip.valueFormatter(1_300)).toBe("1,300");
    expect(option.yAxis.axisLabel.formatter(1_300)).toBe("1,300");
    expect(option.series[0].sampling).toBeUndefined();
    expect(option.aria.enabled).toBe(true);
  });

  it("keeps growth history on an absolute Beijing time axis", () => {
    const option = optionRecord(buildGrowthChartOption({
      metric: "views",
      points: [
        { at: "2026-09-03T00:00:00.000Z", value: 30 },
        { at: "2026-08-31T01:00:00.000Z", value: 2 },
        { at: "2026-08-31T01:00:00.000Z", value: 3 },
        { at: "invalid", value: 8 },
      ],
    }));

    expect(option.xAxis.type).toBe("time");
    expect(option.xAxis.name).toBeUndefined();
    expect(option.series[0].data).toEqual([
      [Date.parse("2026-08-31T01:00:00.000Z"), 2, "", 1],
      [Date.parse("2026-08-31T01:00:00.000Z"), 3, "", 2],
      [Date.parse("2026-09-03T00:00:00.000Z"), 30, "", 0],
    ]);
    expect(option.xAxis.axisLabel.formatter(Date.parse("2026-08-31T01:00:00.000Z"))).not.toMatch(/NaN|—/);
  });

  it("keeps every dense point available and adds native zoom controls", () => {
    const points = Array.from({ length: 40 }, (_, index) => ({
      at: new Date(Date.parse("2026-08-30T16:00:00.000Z") + index * 60_000).toISOString(),
      value: index,
      runId: `run-${index}`,
      sequence: index,
    }));
    const option = optionRecord(buildPortfolioChartOption({ metric: "views", points }));
    expect(option.series[0].data).toHaveLength(40);
    const slider = option.dataZoom.find((zoom: { type: string }) => zoom.type === "slider");
    expect(slider).toBeTruthy();
    expect(slider.height).toBeGreaterThanOrEqual(24);
    expect(slider.handleSize).toBe("100%");
    expect(slider.handleStyle).toMatchObject({ color: "#007eaf", borderColor: "#005f83" });
    expect(slider.brushSelect).toBe(false);
    expect(slider.realtime).toBe(true);
    expect(slider.throttle).toBe(20);
    expect(option.dataZoom.every((zoom: { filterMode: string }) => zoom.filterMode === "none")).toBe(true);
  });

  it.each([
    ["today", 20, 1],
    ["3d", 72, 3],
  ] as const)("keeps a visible comparison slider for the %s range", (preset, durationHours, bucketHours) => {
    const start = Date.parse("2026-09-07T00:00:00+08:00");
    const end = start + durationHours * 60 * 60_000;
    const option = optionRecord(buildAbsoluteCompareChartOption({
      metric: "views",
      valueMode: "delta",
      range: { preset, startMs: start, endMs: end },
      series: [{
        key: "a",
        name: "甲",
        color: "#007eaf",
        points: [
          { at: new Date(start).toISOString(), value: 100 },
          { at: new Date(end).toISOString(), value: 120 },
        ],
      }],
    }));

    expect(option.series[0].data).toHaveLength(durationHours / bucketHours);
    expect(option.dataZoom.some((zoom: { type: string }) => zoom.type === "slider")).toBe(true);
    expect(option.grid.bottom).toBe(64);
  });
});
