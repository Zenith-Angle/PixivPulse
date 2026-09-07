import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { init, use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { describe, expect, it } from "vitest";
import { CHART_REPLACE_OPTIONS } from "./EChartsHost";

use([LineChart, DataZoomComponent, GridComponent, TooltipComponent, SVGRenderer]);

const option = (offset = 0) => ({
  animation: false,
  grid: { left: 30, right: 20, top: 20, bottom: 50 },
  xAxis: { type: "time" as const },
  yAxis: { type: "value" as const },
  dataZoom: [{ type: "inside" as const }, { type: "slider" as const }],
  series: [{
    id: "observations",
    type: "line" as const,
    data: Array.from({ length: 40 }, (_, index) => [
      Date.UTC(2026, 8, 1, index),
      offset + index,
    ]),
  }],
});

describe("chart axis replacement", () => {
  it("keeps a retained zoom proxy usable while replacing axes", () => {
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 800, height: 300 });
    try {
      chart.setOption(option(), { lazyUpdate: false });
      const internal = chart as unknown as {
        getModel: () => {
          getComponent: (type: string, index: number) => {
            findRepresentativeAxisProxy: () => {
              calculateDataWindow: (window: { start: number; end: number }) => unknown;
            };
          };
        };
      };
      const proxy = internal.getModel().getComponent("dataZoom", 0).findRepresentativeAxisProxy();

      chart.setOption(option(100), CHART_REPLACE_OPTIONS);

      expect(() => proxy.calculateDataWindow({ start: 20, end: 70 })).not.toThrow();
    } finally {
      chart.dispose();
    }
  });
});
