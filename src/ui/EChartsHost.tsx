import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core";
import { LineChart } from "echarts/charts";
import { CanvasRenderer } from "echarts/renderers";

// Register only the pieces used by the dashboard. Keeping this at module scope
// also makes React StrictMode's development double-mount safe.
use([LineChart, CanvasRenderer, GridComponent, TooltipComponent, LegendComponent, AriaComponent, DataZoomComponent]);

export interface EChartsHostProps {
  option: EChartsCoreOption;
  ariaLabel: string;
  summary: ReactNode;
  hasData?: boolean;
  emptyMessage?: ReactNode;
  className?: string;
  height?: number | string;
}

const cn = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

const readReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function disposeChart(chart: ECharts | null): void {
  if (!chart) return;
  try { chart.dispose(); } catch {
    // jsdom may expose a canvas element without a 2D context; cleanup must remain best-effort.
  }
}

function canvasAvailable(element: HTMLElement): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  return context != null && element.isConnected;
}

/**
 * A small lifecycle wrapper around ECharts. It owns one instance per DOM
 * element, updates options without replacing the instance, listens for size
 * changes, and always disconnects/disposes on unmount.
 */
export function EChartsHost({
  option,
  ariaLabel,
  summary,
  hasData = true,
  emptyMessage = "暂无足够样本",
  className,
  height = 238,
}: EChartsHostProps) {
  const chartElementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const reducedMotion = useReducedMotion();
  const summaryId = useId();
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const element = chartElementRef.current;
    // The visible summary and empty-state copy remain useful in SSR and in
    // DOMs without a canvas implementation; initialization below is guarded
    // so those environments never break the dashboard render.
    if (!element || typeof window === "undefined" || typeof document === "undefined" || !canvasAvailable(element)) return undefined;

    let chart: ECharts | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const handleResize = () => chart?.resize();
    try {
      chart = init(element, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      chart.setOption({ ...option, animation: !reducedMotion }, { lazyUpdate: true });
      setRendered(true);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(element);
      } else {
        window.addEventListener("resize", handleResize);
      }
    } catch {
      // Canvas can be unavailable in embedded documents. Keep the chart's
      // accessible summary rather than allowing a dashboard render to fail.
      chartRef.current = null;
      disposeChart(chart);
      chart = null;
      setRendered(false);
    }
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      if (chartRef.current === chart) chartRef.current = null;
      disposeChart(chart);
      setRendered(false);
    };
  }, [hasData]);

  useEffect(() => {
    if (!chartRef.current) return;
    try {
      chartRef.current.setOption(
        { ...option, animation: !reducedMotion },
        { lazyUpdate: true, replaceMerge: ["series", "dataZoom", "xAxis", "yAxis"] },
      );
    } catch {
      // A disposed chart can race an option update during StrictMode cleanup.
    }
  }, [option, reducedMotion]);

  const style = { height: typeof height === "number" ? `${height}px` : height };
  return (
    <div className={cn("echarts-host", className)} style={style}>
      {hasData ? <div ref={chartElementRef} className={cn("echarts-canvas", rendered && "echarts-rendered")} role="img" aria-label={ariaLabel} aria-describedby={summaryId} /> : <div className="chart-empty" role="img" aria-label={ariaLabel} aria-describedby={summaryId}><span aria-hidden="true">∿</span><span>{emptyMessage}</span></div>}
      <p id={summaryId} className="chart-summary">{summary}</p>
    </div>
  );
}

export const ChartHost = EChartsHost;
export default EChartsHost;
