import type { EChartsCoreOption } from "echarts/core";
import { formatBeijingTimestamp } from "../domain/time";

export type DashboardChartMetric = "views" | "bookmarks" | "likes" | "comments";
export type CompareValueMode = "total" | "delta";

export interface ChartTimePoint {
  at: string;
  value: number | null;
  runId?: string;
  sequence?: number;
}

export interface NormalizedChartPoint {
  x: number;
  y: number;
  runId?: string;
  sequence?: number;
}

export interface ChartSeriesInput {
  key: string;
  name: string;
  color: string;
  points: NormalizedChartPoint[];
}

export interface AbsoluteChartSeriesInput {
  key: string;
  name: string;
  color: string;
  points: ChartTimePoint[];
}

export const DASHBOARD_CHART_METRICS: readonly DashboardChartMetric[] = [
  "views",
  "bookmarks",
  "likes",
  "comments",
];

export const DASHBOARD_CHART_METRIC_LABELS: Record<DashboardChartMetric, string> = {
  views: "浏览",
  bookmarks: "收藏",
  likes: "获赞",
  comments: "评论",
};

const formatAxisTime = (value: string | number): string => {
  return formatBeijingTimestamp(value, { includeYear: false }) ?? String(value);
};

const formatRelativeValue = (value: number, unit: "小时" | "天"): string => {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const digits = absolute < 1 ? 2 : absolute < 10 && !Number.isInteger(value) ? 1 : 0;
  return `${value.toFixed(digits)} ${unit}`;
};

const formatAxisNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
};

const baseGrid = {
  left: 48,
  right: 20,
  top: 24,
  bottom: 34,
  containLabel: true,
};

const baseTextStyle = {
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  color: "#53616b",
};

const lineDensityOptions = (pointCount: number) => ({
  // Follow neighbouring slopes; monotone-x flattens every observation into a step.
  smooth: 0.35,
  showSymbol: pointCount <= 12,
  symbol: "circle" as const,
  symbolSize: 7,
});

// Keep the first render animated while making setOption updates immediate.
// EChartsHost still owns the runtime reduced-motion switch in the browser.
const chartAnimationOptions = {
  animation: true,
  animationDurationUpdate: 0,
};

const chartZoom = (pointCount: number) => [
  {
    type: "inside" as const,
    filterMode: "none" as const,
    zoomOnMouseWheel: "shift" as const,
    moveOnMouseWheel: true,
    realtime: true,
    throttle: 20,
  },
  ...(pointCount > 24 ? [{
    type: "slider" as const,
    filterMode: "none" as const,
    height: 24,
    bottom: 5,
    realtime: true,
    throttle: 20,
    brushSelect: false,
    showDetail: false,
    showDataShadow: false,
    handleSize: "100%",
    handleStyle: {
      color: "#007eaf",
      borderColor: "#005f83",
      borderWidth: 1,
      shadowBlur: 2,
      shadowColor: "rgba(20, 24, 28, 0.2)",
    },
    moveHandleSize: 8,
    moveHandleStyle: {
      color: "#007eaf",
      opacity: 0.55,
    },
    backgroundColor: "#eef3f5",
    borderColor: "#c4d0d5",
    fillerColor: "rgba(0, 167, 233, 0.12)",
    dataBackground: {
      lineStyle: { color: "#c4d0d5", width: 1 },
      areaStyle: { color: "#dbe3e7", opacity: 0.4 },
    },
    selectedDataBackground: {
      lineStyle: { color: "#00a7e9", width: 1 },
      areaStyle: { color: "rgba(0, 167, 233, 0.16)", opacity: 0.7 },
    },
  }] : []),
];

const chartGrid = (pointCount: number) => ({ ...baseGrid, bottom: pointCount > 24 ? 64 : baseGrid.bottom });

const normalizeTimePoints = (points: ChartTimePoint[]): Array<[number, number, string, number]> => {
  const normalized: Array<[number, number, string, number, number]> = [];
  points.forEach((point, index) => {
    const timestamp = Date.parse(point.at);
    if (!Number.isFinite(timestamp) || point.value === null || !Number.isFinite(point.value)) return;
    normalized.push([timestamp, point.value, point.runId ?? "", point.sequence ?? index, index]);
  });
  return normalized
    .sort((left, right) => left[0] - right[0] || left[3] - right[3] || left[4] - right[4])
    .map(([timestamp, value, runId, sequence]) => [timestamp, value, runId, sequence]);
};

const normalizeNumericPoints = (points: NormalizedChartPoint[]): NormalizedChartPoint[] => {
  const normalized: Array<NormalizedChartPoint & { inputIndex: number }> = [];
  points.forEach((point, inputIndex) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0) return;
    normalized.push({ ...point, sequence: point.sequence ?? inputIndex, inputIndex });
  });
  return normalized
    .sort((left, right) => left.x - right.x || (left.sequence ?? left.inputIndex) - (right.sequence ?? right.inputIndex) || left.inputIndex - right.inputIndex)
    .map(({ inputIndex: _inputIndex, ...point }) => point);
};

/**
 * Build the portfolio chart option from the already-aggregated intraday
 * points. Rank is intentionally not part of this metric union: a rank is a
 * position, not a portfolio total and must never be plotted as one.
 */
export const buildPortfolioChartOption = ({
  points,
  metric,
  color = "#ff6b5e",
}: {
  points: ChartTimePoint[];
  metric: DashboardChartMetric;
  color?: string;
}): EChartsCoreOption => {
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  const validPoints = normalizeTimePoints(points);
  return {
    ...chartAnimationOptions,
    aria: { enabled: true },
    textStyle: baseTextStyle,
    grid: chartGrid(validPoints.length),
    dataZoom: chartZoom(validPoints.length),
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line",
        label: { formatter: (params: { value: string | number }) => `${formatAxisTime(params.value)} · 采样值` },
      },
      valueFormatter: (value: unknown) => formatAxisNumber(Number(value)),
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLabel: {
        hideOverlap: true,
        formatter: (value: number) => formatAxisTime(value),
      },
      axisLine: { lineStyle: { color: "#dbe3e7" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      min: "dataMin",
      axisLabel: { formatter: (value: number) => formatAxisNumber(value) },
      splitLine: { lineStyle: { color: "#dbe3e7", type: "dashed" } },
    },
    series: [{
      id: "portfolio",
      name: label,
      type: "line",
      data: validPoints,
      dimensions: [{ name: "时间", type: "time" }, { name: label, type: "float" }, { name: "同步", type: "ordinal" }, { name: "顺序", type: "int" }],
      encode: { x: 0, y: 1, tooltip: 1 },
      ...lineDensityOptions(validPoints.length),
      lineStyle: { color, width: 3 },
      itemStyle: { color, borderColor: "#ffffff", borderWidth: 2 },
      areaStyle: { color, opacity: 0.12 },
      emphasis: { focus: "series" },
    }],
  };
};

/** Build the account-level follower history. This remains a separate builder
 * so follower observations can never be mistaken for portfolio work metrics. */
export const buildFollowerChartOption = ({
  points,
  color = "#007eaf",
  compact = false,
}: {
  points: ChartTimePoint[];
  color?: string;
  compact?: boolean;
}): EChartsCoreOption => {
  const validPoints = normalizeTimePoints(points);
  return {
    ...chartAnimationOptions,
    aria: { enabled: !compact },
    textStyle: baseTextStyle,
    grid: compact ? { left: 2, right: 2, top: 5, bottom: 5, containLabel: false } : chartGrid(validPoints.length),
    dataZoom: compact ? undefined : chartZoom(validPoints.length),
    tooltip: compact ? undefined : {
      trigger: "axis",
      axisPointer: {
        type: "line",
        label: { formatter: (params: { value: string | number }) => `${formatAxisTime(params.value)} · 采样值` },
      },
      valueFormatter: (value: unknown) => formatAxisNumber(Number(value)),
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      show: !compact,
      axisLabel: {
        hideOverlap: true,
        formatter: (value: number) => formatAxisTime(value),
      },
      axisLine: { lineStyle: { color: "#dbe3e7" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: "粉丝数",
      show: !compact,
      nameLocation: "end",
      nameGap: 10,
      nameRotate: 0,
      scale: true,
      min: "dataMin",
      axisLabel: { formatter: (value: number) => formatAxisNumber(value) },
      splitLine: { lineStyle: { color: "#dbe3e7", type: "dashed" } },
    },
    series: [{
      id: "followers",
      name: "粉丝数",
      type: "line",
      data: validPoints,
      dimensions: [{ name: "时间", type: "time" }, { name: "粉丝数", type: "float" }, { name: "同步", type: "ordinal" }, { name: "顺序", type: "int" }],
      encode: { x: 0, y: 1, tooltip: 1 },
      ...lineDensityOptions(validPoints.length),
      sampling: validPoints.length > 24 ? "lttb" : undefined,
      lineStyle: { color, width: 3 },
      itemStyle: { color, borderColor: "#ffffff", borderWidth: 2 },
      areaStyle: { color, opacity: 0.12 },
      emphasis: { focus: "series" },
    }],
  };
};

/** Build a multi-series option for the normalized comparison timeline. */
export const buildCompareChartOption = (series: ChartSeriesInput[]): EChartsCoreOption => {
  const normalized = series.map((item) => ({ ...item, points: normalizeNumericPoints(item.points) }));
  const maxDays = Math.max(0, ...normalized.flatMap((item) => item.points.map((point) => point.x)));
  const useHours = maxDays < 2;
  const axisUnit = useHours ? "小时" : "天";
  const xMultiplier = useHours ? 24 : 1;
  const maxPointCount = Math.max(0, ...normalized.map((item) => item.points.length));
  return {
    ...chartAnimationOptions,
    aria: { enabled: true },
    textStyle: baseTextStyle,
    grid: chartGrid(maxPointCount),
    dataZoom: chartZoom(maxPointCount),
    legend: {
      show: false,
      data: normalized.map((item) => item.name),
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", label: { formatter: (params: { value: number }) => `${formatRelativeValue(params.value, axisUnit)} · 采样值` } },
      order: "valueDesc",
      valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}%`,
    },
    xAxis: {
      type: "value",
      name: `距首次观察（${axisUnit}）`,
      nameLocation: "middle",
      nameGap: 25,
      min: 0,
      axisLabel: { hideOverlap: true, formatter: (value: number) => formatRelativeValue(value, axisUnit) },
      axisLine: { lineStyle: { color: "#dbe3e7" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: "相对变化",
      nameLocation: "middle",
      nameGap: 38,
      axisLabel: { formatter: (value: number) => `${value}%` },
      splitLine: { lineStyle: { color: "#dbe3e7", type: "dashed" } },
    },
    series: normalized.map((item) => ({
      id: `relative:${item.key}`,
      name: item.name,
      type: "line",
      data: item.points.map((point, index) => [point.x * xMultiplier, point.y, point.runId ?? "", point.sequence ?? index]),
      dimensions: [{ name: axisUnit, type: "float" }, { name: "相对变化", type: "float" }, { name: "同步", type: "ordinal" }, { name: "顺序", type: "int" }],
      encode: { x: 0, y: 1, tooltip: 1 },
      ...lineDensityOptions(item.points.length),
      lineStyle: { color: item.color, width: 3 },
      itemStyle: { color: item.color, borderColor: "#ffffff", borderWidth: 2 },
      emphasis: { focus: "series" },
    })),
  };
};

/** Compare multiple works on their actual timestamps as totals or range-relative deltas. */
export const buildAbsoluteCompareChartOption = ({
  series,
  metric,
  valueMode = "total",
}: {
  series: AbsoluteChartSeriesInput[];
  metric: DashboardChartMetric;
  valueMode?: CompareValueMode;
}): EChartsCoreOption => {
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  const valueLabel = valueMode === "delta" ? `${label}增量` : `${label}总数`;
  const normalized = series.map((item) => {
    const points = normalizeTimePoints(item.points);
    const baseline = points[0]?.[1] ?? 0;
    return {
      ...item,
      points: valueMode === "delta"
        ? points.map(([timestamp, value, runId, sequence]) => [timestamp, value - baseline, runId, sequence] as [number, number, string, number])
        : points,
    };
  });
  const maxPointCount = Math.max(0, ...normalized.map((item) => item.points.length));
  const formatValue = (value: unknown): string => {
    const numeric = Number(value);
    const formatted = formatAxisNumber(numeric);
    return valueMode === "delta" && numeric > 0 ? `+${formatted}` : formatted;
  };
  return {
    ...chartAnimationOptions,
    aria: { enabled: true },
    textStyle: baseTextStyle,
    grid: chartGrid(maxPointCount),
    dataZoom: chartZoom(maxPointCount),
    legend: {
      show: false,
      data: normalized.map((item) => item.name),
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line",
        label: { formatter: (params: { value: string | number }) => `${formatAxisTime(params.value)} · 采样值` },
      },
      valueFormatter: formatValue,
      order: "valueDesc",
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLabel: {
        hideOverlap: true,
        formatter: (value: number) => formatAxisTime(value),
      },
      axisLine: { lineStyle: { color: "#dbe3e7" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: valueLabel,
      nameLocation: "end",
      nameGap: 10,
      nameRotate: 0,
      scale: true,
      min: valueMode === "delta" ? (extent: { min: number }) => Math.min(0, extent.min) : undefined,
      axisLabel: { formatter: (value: number) => formatValue(value) },
      splitLine: { lineStyle: { color: "#dbe3e7", type: "dashed" } },
    },
    series: normalized.map((item) => ({
      id: `absolute:${item.key}`,
      name: item.name,
      type: "line",
      data: item.points,
      dimensions: [{ name: "时间", type: "time" }, { name: valueLabel, type: "float" }, { name: "同步", type: "ordinal" }, { name: "顺序", type: "int" }],
      encode: { x: 0, y: 1, tooltip: 1 },
      ...lineDensityOptions(item.points.length),
      connectNulls: false,
      lineStyle: { color: item.color, width: 3 },
      itemStyle: { color: item.color, borderColor: "#ffffff", borderWidth: 2 },
      emphasis: { focus: "series" },
    })),
  };
};

/** Build one work's selected metric using absolute totals on its real timeline. */
export const buildGrowthChartOption = ({
  points,
  metric,
  color = "#ff6b5e",
}: {
  points: ChartTimePoint[];
  metric: DashboardChartMetric;
  color?: string;
}): EChartsCoreOption => {
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  const normalized = normalizeTimePoints(points);
  return {
    ...chartAnimationOptions,
    aria: { enabled: true },
    textStyle: baseTextStyle,
    grid: chartGrid(normalized.length),
    dataZoom: chartZoom(normalized.length),
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line",
        label: { formatter: (params: { value: string | number }) => `${formatAxisTime(params.value)} · 采样值` },
      },
      valueFormatter: (value: unknown) => formatAxisNumber(Number(value)),
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLabel: { hideOverlap: true, formatter: (value: number) => formatAxisTime(value) },
      axisLine: { lineStyle: { color: "#dbe3e7" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: `${label}总数`,
      nameLocation: "end",
      nameGap: 10,
      nameRotate: 0,
      scale: true,
      axisLabel: { formatter: (value: number) => formatAxisNumber(value) },
      splitLine: { lineStyle: { color: "#dbe3e7", type: "dashed" } },
    },
    series: [{
      id: "growth",
      name: `${label}总数`,
      type: "line",
      data: normalized,
      dimensions: [{ name: "时间", type: "time" }, { name: `${label}总数`, type: "float" }, { name: "同步", type: "ordinal" }, { name: "顺序", type: "int" }],
      encode: { x: 0, y: 1, tooltip: 1 },
      ...lineDensityOptions(normalized.length),
      lineStyle: { color, width: 3 },
      itemStyle: { color, borderColor: "#ffffff", borderWidth: 2 },
      areaStyle: { color, opacity: 0.1 },
      emphasis: { focus: "series" },
    }],
  };
};

// Short aliases keep the builders convenient for focused tests and other UI
// surfaces without duplicating option construction logic.
export const buildPortfolioOption = buildPortfolioChartOption;
export const buildCompareOption = buildCompareChartOption;
export const buildAbsoluteCompareOption = buildAbsoluteCompareChartOption;
export const buildGrowthOption = buildGrowthChartOption;
