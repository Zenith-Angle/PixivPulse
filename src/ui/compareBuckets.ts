import type { ChartTimePoint } from "./chartOptions";
import type { ChartTimeRange } from "./chartTimeRange";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR;

export interface CompareBucket {
  start: number;
  end: number;
  value: number | null;
}

export function compareBucketHours(range: ChartTimeRange, span = 0): number {
  const fixed = { today: 1, "24h": 1, "3d": 3, "7d": 6, "30d": 24, "3m": 72 };
  if (range.preset in fixed) return fixed[range.preset as keyof typeof fixed];
  const duration = range.startMs != null && range.endMs != null ? range.endMs - range.startMs : span;
  return duration <= DAY ? 1 : duration <= 3 * DAY ? 3 : duration <= 7 * DAY ? 6
    : duration <= 30 * DAY ? 24 : duration <= 90 * DAY ? 72 : Math.ceil(duration / (30 * DAY)) * 24;
}

export function compareBucketLabel(hours: number): string {
  return hours < 24 ? `${hours} 小时` : `${hours / 24} 天`;
}

export function compareBucketLayout(points: readonly ChartTimePoint[], range: ChartTimeRange) {
  let first = Infinity;
  let last = -Infinity;
  for (const point of points) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at)) continue;
    first = Math.min(first, at);
    last = Math.max(last, at);
  }
  const start = range.startMs ?? (Number.isFinite(first) ? first : 0);
  const end = range.endMs ?? (Number.isFinite(last) ? last : 0);
  return { start, end, hours: compareBucketHours(range, end - start) };
}

export function buildCompareBuckets(points: readonly ChartTimePoint[], start: number, end: number, hours: number): CompareBucket[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(hours) || hours <= 0) return [];
  const width = hours * HOUR;
  const alignedStart = Math.floor((start + BEIJING_OFFSET) / width) * width - BEIJING_OFFSET;
  const buckets: CompareBucket[] = [];
  for (let at = alignedStart; at < end; at += width) {
    buckets.push({ start: Math.max(start, at), end: Math.min(end, at + width), value: null });
  }
  const ordered = points.map((point, index) => ({ ...point, time: Date.parse(point.at), order: point.sequence ?? index }))
    .filter((point) => Number.isFinite(point.time) && point.time <= end)
    .sort((a, b) => a.time - b.time || a.order - b.order);
  let previous: typeof ordered[number] | undefined;
  for (const point of ordered) {
    if (point.value == null || !Number.isFinite(point.value)) { previous = undefined; continue; }
    // Changes belong to (start, end]; a boundary observation closes the preceding bucket.
    if (previous?.value != null && point.time > start) {
      const index = Math.max(0, Math.ceil((point.time - alignedStart) / width) - 1);
      const bucket = buckets[index];
      if (bucket) {
        bucket.value = (bucket.value ?? 0) + point.value - previous.value;
      }
    }
    previous = point;
  }
  return buckets;
}
