import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core";
import { LineChart } from "echarts/charts";
import { CanvasRenderer } from "echarts/renderers";
import { buildTrendSeries, getChartTimeExtent } from "./chartTrend";
import { resolveChartViewport, type ChartViewport, type ChartZoomEvent } from "./chartViewport";

// Register only the pieces used by the dashboard. Keeping this at module scope
// also makes React StrictMode's development double-mount safe.
use([LineChart, CanvasRenderer, GridComponent, TooltipComponent, LegendComponent, AriaComponent, DataZoomComponent]);

export const CHART_REPLACE_OPTIONS = {
  lazyUpdate: false,
  replaceMerge: ["series", "dataZoom", "xAxis", "yAxis"],
};

export interface EChartsHostProps {
  option: EChartsCoreOption;
  ariaLabel: string;
  summary: ReactNode;
  hasData?: boolean;
  emptyMessage?: ReactNode;
  className?: string;
  height?: number | string;
  compact?: boolean;
  presentation?: "trend" | "buckets";
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
  compact = false,
  presentation = "trend",
}: EChartsHostProps) {
  const chartElementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const reducedMotion = useReducedMotion();
  const summaryId = useId();
  const [rendered, setRendered] = useState(false);
  const sourceOptionRef = useRef(option);
  sourceOptionRef.current = option;
  const domainRef = useRef<ChartViewport | undefined>(undefined);
  const viewportRef = useRef<ChartViewport | undefined>(undefined);
  const zoomFrameRef = useRef<number | null>(null);

  const chartAria = {
    enabled: !compact,
    label: { description: `${ariaLabel}。${presentation === "buckets" ? "按所选时间范围合并的分段净增量。" : "平滑趋势；提示数值为原始采样。"}` },
  };

  useEffect(() => {
    const element = chartElementRef.current;
    // The visible summary and empty-state copy remain useful in SSR and in
    // DOMs without a canvas implementation; initialization below is guarded
    // so those environments never break the dashboard render.
    if (!element || typeof window === "undefined" || typeof document === "undefined" || !canvasAvailable(element)) return undefined;

    let chart: ECharts | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const handleResize = () => chart?.resize();
    const handleZoom = (event: unknown) => {
      if (!event || typeof event !== "object") return;
      viewportRef.current = resolveChartViewport(domainRef.current, event as ChartZoomEvent);
      if (zoomFrameRef.current !== null) return;
      zoomFrameRef.current = requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        chart?.setOption(
          { series: buildTrendSeries(sourceOptionRef.current, viewportRef.current) },
          { replaceMerge: ["series"], lazyUpdate: false, silent: true },
        );
      });
    };
    try {
      chart = init(element, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      domainRef.current = getChartTimeExtent(option);
      viewportRef.current = domainRef.current;
      chart.setOption({ ...option, series: buildTrendSeries(option), aria: chartAria, animation: !reducedMotion }, { lazyUpdate: false });
      chart.on("datazoom", handleZoom);
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
      if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = null;
      chart?.off("datazoom", handleZoom);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      if (chartRef.current === chart) chartRef.current = null;
      disposeChart(chart);
      setRendered(false);
    };
  }, [hasData]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = null;
    const domain = getChartTimeExtent(option);
    const domainChanged = domain?.[0] !== domainRef.current?.[0] || domain?.[1] !== domainRef.current?.[1];
    if (domainChanged) viewportRef.current = domain;
    domainRef.current = domain;
    // Preserve the user's zoom on same-domain refreshes; a new date range starts in full view.
    const currentZoom = (chartRef.current.getOption().dataZoom as Array<{ start?: number; end?: number }> | undefined)?.[0];
    const dataZoom = Array.isArray(option.dataZoom)
      ? option.dataZoom.map((zoom) => ({
        ...zoom,
        start: domainChanged ? 0 : currentZoom?.start ?? 0,
        end: domainChanged ? 100 : currentZoom?.end ?? 100,
        startValue: null,
        endValue: null,
        rangeMode: ["percent", "percent"],
      }))
      : option.dataZoom;
    try {
      chartRef.current.setOption(
        { ...option, dataZoom, series: buildTrendSeries(option, viewportRef.current), aria: chartAria, animation: !reducedMotion },
        CHART_REPLACE_OPTIONS,
      );
    } catch {
      // A disposed chart can race an option update during StrictMode cleanup.
    }
  }, [option, reducedMotion, ariaLabel, compact, presentation]);

  const style = { height: typeof height === "number" ? `${height}px` : height };
  return (
    <div className={cn("echarts-host", className)} style={style}>
      {hasData && !compact && <span className="chart-trend-label">{presentation === "buckets" ? "分段净增量" : "平滑趋势"}</span>}
      {hasData ? <div ref={chartElementRef} className={cn("echarts-canvas", rendered && "echarts-rendered")} role="img" aria-label={ariaLabel} aria-describedby={summaryId} /> : <div className="chart-empty" role="img" aria-label={ariaLabel} aria-describedby={summaryId}><span aria-hidden="true">∿</span><span>{emptyMessage}</span></div>}
      <p id={summaryId} className="chart-summary">{summary}</p>
    </div>
  );
}
