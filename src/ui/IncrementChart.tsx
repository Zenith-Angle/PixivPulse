import { t } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildAbsoluteCompareChartOption, DASHBOARD_CHART_METRIC_LABELS, type ChartTimePoint, type DashboardChartMetric } from "./chartOptions";
import { buildCompareBuckets, compareBucketLabel, compareBucketLayout } from "./compareBuckets";
import type { ChartTimeRange } from "./chartTimeRange";
import { EChartsHost } from "./EChartsHost";
import { formatDelta, formatTimestamp } from "./helpers";

/** Uses the same observed buckets as comparison; missing intervals stay missing. */
export function IncrementChart({ points, metric, range, name }: { points: ChartTimePoint[]; metric: DashboardChartMetric; range: ChartTimeRange; name: string }) {
  const layout = useMemo(() => compareBucketLayout(points, range), [points, range]);
  const buckets = useMemo(() => buildCompareBuckets(points, layout.start, layout.end, layout.hours), [points, layout]);
  const option = useMemo(() => buildAbsoluteCompareChartOption({
    series: [{ key: "increment", name, color: "#007eaf", points }], metric, valueMode: "delta", range,
  }), [points, metric, name, range]);
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  return <section className="increment-panel" aria-label={t("{value0}{value1}增量", { value0: name, value1: label })}>
    <div className="increment-heading"><h3>{t("{value0}增量", { value0: label })}</h3><span>{t("每 {value0} · 与上方范围一致", { value0: compareBucketLabel(layout.hours) })}</span></div>
    <EChartsHost option={option} hasData={buckets.some((bucket) => bucket.value !== null)} presentation="buckets" height={190}
      ariaLabel={t("{value0}{value1}分段增量图", { value0: name, value1: label })} emptyMessage={t("所选范围内尚无可计算的增量，至少需要两次有效观察。")}
      summary={<>{t("每 {value0} 的已观察净增量；无观察时段留空，负值表示回落。", { value0: compareBucketLabel(layout.hours) })}</>} />
  </section>;
}

/** Lightweight SVG keeps the library responsive even with many work cards. */
type IncrementPreviewProps = { points: ChartTimePoint[]; range: ChartTimeRange; name: string; onOpen: () => void };

export function IncrementPreview(props: IncrementPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !host.current) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "200px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [visible]);
  return <div ref={host} className="increment-preview-slot">{visible
    ? <VisibleIncrementPreview {...props} />
    : <button type="button" className="increment-preview increment-preview-placeholder" onClick={props.onOpen} aria-label={t("查看{value0}增量详情", { value0: props.name })} />}</div>;
}

function VisibleIncrementPreview({ points, range, name, onOpen }: IncrementPreviewProps) {
  const { start, end, hours } = compareBucketLayout(points, range);
  const buckets = buildCompareBuckets(points, start, end, hours);
  const values = buckets.flatMap((bucket) => bucket.value == null ? [] : [bucket.value]);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const y = (value: number) => 49 - (value - min) / (max - min) * 42;
  const x = (at: number) => 4 + (at - start) / Math.max(1, end - start) * 272;
  return <button type="button" className="increment-preview" onClick={onOpen} aria-label={t("查看{value0}增量详情", { value0: name })}>
    <span className="increment-preview-heading"><span>{t("今日浏览增量 · 每 {value0}", { value0: compareBucketLabel(hours) })}</span><span>{t("详情 ›")}</span></span>
    {values.length === 0 ? <span className="increment-preview-empty">{t("等待两次有效观察")}</span> : <svg viewBox="0 0 280 56" role="img" aria-label={t("{value0}今日浏览增量，最高 {value1}", { value0: name, value1: formatDelta(Math.max(...values)) })}>
      <line x1="4" x2="276" y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.2" />
      {buckets.map((bucket, index) => {
        if (bucket.value == null) return null;
        const cx = x((bucket.start + bucket.end) / 2);
        const previous = buckets[index - 1];
        return <g key={bucket.start}>
          {previous?.value != null && <line x1={x((previous.start + previous.end) / 2)} y1={y(previous.value)} x2={cx} y2={y(bucket.value)} stroke="currentColor" strokeWidth="1.8" />}
          <circle cx={cx} cy={y(bucket.value)} r="2.8" fill={bucket.value < 0 ? "#ff6b5e" : "currentColor"}><title>{t("{value0} 至 {value1}：{value2}", { value0: formatTimestamp(new Date(bucket.start).toISOString()), value1: formatTimestamp(new Date(bucket.end).toISOString()), value2: formatDelta(bucket.value) })}</title></circle>
        </g>;
      })}
    </svg>}
  </button>;
}
