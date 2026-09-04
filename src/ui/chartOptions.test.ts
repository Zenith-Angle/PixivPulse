import { describe, expect, it } from "vitest";
import { buildAbsoluteCompareChartOption, buildCompareChartOption, buildFollowerChartOption, buildGrowthChartOption, buildPortfolioChartOption } from "./chartOptions";

const optionRecord = (option: unknown): Record<string, any> => option as Record<string, any>;

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
    expect(option.series[0].smooth).toBeCloseTo(0.3);
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
    expect(option.series[0].smooth).toBe(true);
    expect(option.series[0].smoothMonotone).toBe("x");
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
    expect(option.series[0].smooth).toBe(true);
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
    const comparison = optionRecord(buildCompareChartOption([{ key: "a", name: "A", color: "#000", points: [{ x: 0, y: 0 }, { x: 2, y: 5 }] }]));
    const detail = optionRecord(buildGrowthChartOption({ metric: "views", points: [
      { at: "2026-08-30T00:00:00.000Z", value: 0 },
      { at: "2026-08-30T02:00:00.000Z", value: 5 },
    ] }));

    for (const option of [portfolio, comparison, detail]) {
      expect(option.series[0].smooth).toBe(true);
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

  it("keeps normalized comparison as multiple line series with tooltips", () => {
    const option = optionRecord(buildCompareChartOption([
      { key: "a", name: "甲", color: "#00a7e9", points: [{ x: 0, y: 0 }, { x: 1, y: 12 }] },
      { key: "b", name: "乙", color: "#ff6b5e", points: [{ x: 0, y: 0 }, { x: 1, y: -4 }] },
    ]));
    expect(option.tooltip.trigger).toBe("axis");
    expect(option.series).toHaveLength(2);
    expect(option.xAxis.type).toBe("value");
    expect(option.series[0].sampling).toBeUndefined();
    expect(option.xAxis.name).toContain("小时");
    expect(option.series[0].data).toEqual([[0, 0, "", 0], [24, 12, "", 1]]);
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
    expect(option.series[0].smooth).toBe(true);
    expect(option.series[0].sampling).toBeUndefined();
  });

  it("compares absolute increments from each work's first point in the selected range", () => {
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
    expect(option.yAxis.name).toBe("浏览增量");
    expect(option.series[0].data.map((point: unknown[]) => point[1])).toEqual([0, 30, 25]);
    expect(option.series[1].data.map((point: unknown[]) => point[1])).toEqual([0, -20]);
    expect(option.tooltip.valueFormatter(30)).toBe("+30");
    expect(option.tooltip.valueFormatter(-20)).toBe("-20");
    expect(option.yAxis.min({ min: -20 })).toBe(-20);
    expect(option.yAxis.min({ min: 5 })).toBe(0);
  });

  it("normalizes irregular compare points and keeps one axis unit", () => {
    const option = optionRecord(buildCompareChartOption([{
      key: "a",
      name: "甲",
      color: "#00a7e9",
      points: [
        { x: 6, y: 60 },
        { x: Number.NaN, y: 90 },
        { x: 0.5, y: 5 },
        { x: 0.5, y: 7 },
      ],
    }]));

    expect(option.xAxis.name).toBe("距首次观察（天）");
    expect(option.series[0].data).toEqual([[0.5, 5, "", 2], [0.5, 7, "", 3], [6, 60, "", 0]]);
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
});
