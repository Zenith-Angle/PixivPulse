export type ChartViewport = readonly [number, number];

export interface ChartZoomEvent {
  start?: number;
  end?: number;
  startValue?: number | string;
  endValue?: number | string;
  batch?: ChartZoomEvent[];
}

const numericValue = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const result = typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
};

/** ECharts emits percentages for dragging, and values for programmatic zoom. */
export const resolveChartViewport = (domain: ChartViewport | undefined, event: ChartZoomEvent): ChartViewport | undefined => {
  if (!domain) return undefined;
  const zoom = event.batch?.[0] ?? event;
  const [min, max] = domain;
  const from = numericValue(zoom.startValue) ?? min + (max - min) * (zoom.start ?? 0) / 100;
  const to = numericValue(zoom.endValue) ?? min + (max - min) * (zoom.end ?? 100) / 100;
  const start = Math.max(min, Math.min(max, from));
  const end = Math.max(min, Math.min(max, to));
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : domain;
};
