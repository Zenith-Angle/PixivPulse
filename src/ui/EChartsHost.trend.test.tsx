import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EChartsHost } from "./EChartsHost";
import { buildGrowthChartOption } from "./chartOptions";

const chart = vi.hoisted(() => ({ setOption: vi.fn(), getOption: () => ({ dataZoom: [{ start: 40, end: 60 }] }), on: vi.fn(), off: vi.fn(), resize: vi.fn(), dispose: vi.fn() }));
vi.mock("echarts/core", () => ({ init: () => chart, use: () => {} }));

const option = (offset = 0) => buildGrowthChartOption({ metric: "views", points: Array.from({ length: 50 }, (_, i) => ({
  at: new Date(1_700_000_000_000 + i * 60_000).toISOString(), value: offset + Math.floor(i / 10) * 5,
})) });

describe("trend chart lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("coalesces zoom changes and regenerates from the latest raw option", () => {
    const view = render(<EChartsHost option={option()} ariaLabel="Growth" summary="50 samples" />);
    const zoom = chart.on.mock.calls.find(([event]) => event === "datazoom")![1];
    const before = chart.setOption.mock.calls.length;
    act(() => {
      zoom({ start: 20, end: 70 });
      zoom({ batch: [{ start: 40, end: 60 }] });
      vi.advanceTimersByTime(20);
    });
    expect(chart.setOption.mock.calls).toHaveLength(before + 1);
    const [update, settings] = chart.setOption.mock.lastCall!;
    expect(Object.keys(update)).toEqual(["series"]);
    expect(settings.replaceMerge).toEqual(["series"]);
    expect(settings.lazyUpdate).toBe(false);
    expect(update.series).toHaveLength(2);
    expect(update.series[0].data).toHaveLength(50);
    expect(update.series[1].data[0][0]).toBeGreaterThan(1_700_000_000_000);

    view.rerender(<EChartsHost option={option(100)} ariaLabel="Updated growth" summary="50 samples" />);
    act(() => { zoom({ start: 40, end: 60 }); vi.advanceTimersByTime(20); });
    const series = chart.setOption.mock.lastCall![0].series;
    expect(series).toHaveLength(2);
    expect(series[0].data[0][1]).toBe(100);
    expect(series[1].data.every((point: number[]) => point[1]! >= 100)).toBe(true);
  });

  it("pins the accessible description and cancels pending updates on unmount", () => {
    const view = render(<EChartsHost option={option()} ariaLabel="Growth" summary="50 samples" />);
    expect(chart.setOption.mock.lastCall![0].aria.label.description).toContain("Growth");
    expect(chart.setOption.mock.lastCall![0].aria.label.description).toContain("原始采样");
    const zoom = chart.on.mock.calls.find(([event]) => event === "datazoom")![1];
    act(() => { zoom({ start: 20, end: 70 }); });
    view.unmount();
    const before = chart.setOption.mock.calls.length;
    act(() => { vi.advanceTimersByTime(20); });
    expect(chart.setOption.mock.calls).toHaveLength(before);
    expect(chart.off).toHaveBeenCalledWith("datazoom", zoom);
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });
});
