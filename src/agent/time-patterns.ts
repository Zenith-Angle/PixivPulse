import type { DashboardData, WorkMetrics } from "../domain/types";
import type { ToolDefinition } from "./types";

const METRICS = ["views", "bookmarks", "likes", "comments"] as const;
type Metric = typeof METRICS[number];
const HOUR = 3600000, DAY = 24 * HOUR, BEIJING = 8 * HOUR;
const stamp = (at: number) => new Date(at + BEIJING).toISOString().replace("Z", "+08:00");
const dateOf = (at: number) => stamp(at).slice(0, 10);

export const TIME_PATTERNS_TOOL: ToolDefinition = {
  name: "analyze_time_patterns",
  description: "Compute observed metric INCREMENTS across ALL selected works locally, grouped by recurring time of day, weekday, or calendar date. Use FIRST for when engagement is high/low, day/night, weekday/weekend, and daily trends. Returns all-hour/day summary, peaks, lows, normalized rates and missing/coarse coverage in one call. Never approximate these with top works, record counts or paginated raw history. Empty workKeys means all works. Supports multiple metrics together. Does not read novel prose.",
  parameters: { type: "object", properties: {
    dimension: { type: "string", enum: ["hour_of_day", "weekday", "date"] },
    metrics: { type: "array", items: { type: "string", enum: METRICS }, minItems: 1, maxItems: 4 },
    workKeys: { type: "array", items: { type: "string" }, description: "Empty = whole portfolio; specific keys only when the user asks for a subset." },
    from: { type: ["string", "null"], description: "ISO with timezone; null = earliest available observation." },
    to: { type: ["string", "null"], description: "ISO with timezone; null = latest available observation." },
    bucketHours: { type: "integer", enum: [1, 2, 3, 4, 6, 12], description: "Time-of-day slot width; ignored for weekday/date. Start with 1 unless user specifies a coarser period. If coverage is coarse, follow suggestedDimension and suggestedBucketHours; when 24 is suggested use date dimension with bucketHours 1." },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 60, description: "24 covers all hourly slots, 7 weekdays. Summary is computed over ALL rows, regardless of pagination." },
  }, required: ["dimension", "metrics", "workKeys", "from", "to", "bucketHours", "offset", "limit"], additionalProperties: false },
};

interface Event { at: number; metrics?: WorkMetrics; unknownChange?: boolean; precisionHours?: number }
interface Point { at: number; metrics: WorkMetrics; precisionHours: number }
interface Cell { delta: number; positive: number; negative: number; hours: number; days: Set<string>; works: Set<string> }
const emptyCell = (): Cell => ({ delta: 0, positive: 0, negative: 0, hours: 0, days: new Set(), works: new Set() });

// Index once per knowledge snapshot. Only confirmed unchanged observations can
// carry a value forward; a reported change whose sample is missing breaks it.
export function createTimePatternQuery(data: DashboardData) {
  const indexed = new Map<string, Point[]>();
  const events = new Map(data.works.map(work => [work.key, new Map<number, Event>()]));
  const byRun = new Map<string, { at: number; metrics: WorkMetrics; precisionHours: number }>();
  const add = (key: string, event: Event) => {
    const rows = events.get(key); if (!rows || !Number.isFinite(event.at)) return;
    const previous = rows.get(event.at);
    rows.set(event.at, { ...previous, ...event, unknownChange: !!previous?.unknownChange || !!event.unknownChange });
  };
  for (const sample of data.samples) {
    const at = Date.parse(sample.rollupSourceCollectedAt ?? sample.collectedAt);
    if (!Number.isFinite(at)) continue;
    const precisionHours = sample.kind === "daily-rollup" || sample.compactionLevel === "daily" || sample.compactionLevel === "day" ? 24
      : ({ "30m": 0.5, "1h": 1, "2h": 2, "6h": 6 } as Record<string, number>)[sample.compactionLevel ?? ""] ?? 0;
    add(sample.workKey, { at, metrics: sample.metrics, precisionHours });
    byRun.set(`${sample.workKey}:${sample.runId}`, { at, metrics: sample.metrics, precisionHours });
  }
  const observe = (workKey: string, runId: string, at: number, changed: boolean) => {
    const sample = byRun.get(`${workKey}:${runId}`);
    if (changed && sample && sample.at <= at) add(workKey, { at, metrics: sample.metrics, precisionHours: sample.precisionHours });
    else add(workKey, { at, unknownChange: changed });
  };
  for (const observation of data.observations) observe(observation.workKey, observation.runId, Date.parse(observation.observedAt), observation.metricsChanged);
  for (const batch of data.observationBatches ?? []) {
    const changed = new Set(batch.changedWorkKeys);
    for (const key of batch.workKeys) observe(key, batch.runId, Date.parse(batch.observedAt), changed.has(key));
  }
  for (const work of data.works) add(work.key, { at: Date.parse(work.lastSeenAt), metrics: work.metrics });
  for (const [key, values] of events) {
    let known: WorkMetrics | undefined;
    let precision = 0;
    const points: Point[] = [];
    for (const event of [...values.values()].sort((a, b) => a.at - b.at)) {
      if (event.metrics) { known = event.metrics; precision = event.precisionHours ?? 0; }
      else if (event.unknownChange) known = undefined;
      if (known) points.push({ at: event.at, metrics: known, precisionHours: precision });
      else points.push({ at: event.at, metrics: { views: null, bookmarks: null, likes: null, comments: null, rank: null, responses: null, illustrations: null }, precisionHours: 0 });
    }
    indexed.set(key, points);
  }

  return (args: Record<string, unknown>) => {
    const properties = TIME_PATTERNS_TOOL.parameters.properties as object;
    if (Object.keys(args).sort().join() !== Object.keys(properties).sort().join()) throw new Error("Unexpected temporal query arguments");
    if (!["hour_of_day", "weekday", "date"].includes(String(args.dimension)) || ![1, 2, 3, 4, 6, 12].includes(Number(args.bucketHours)) || !Number.isInteger(args.bucketHours)) throw new Error("Invalid time dimension");
    if (!Array.isArray(args.metrics) || !args.metrics.length || args.metrics.length > 4 || new Set(args.metrics).size !== args.metrics.length || args.metrics.some(metric => !METRICS.includes(metric))) throw new Error("Invalid metrics");
    if (!Array.isArray(args.workKeys) || new Set(args.workKeys).size !== args.workKeys.length || args.workKeys.some(key => !indexed.has(key))) throw new Error("Unknown work keys");
    if (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0 || !Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 60) throw new Error("Invalid pagination");
    const bound = (value: unknown) => {
      if (value === null) return null;
      if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Time must include timezone");
      return Date.parse(value);
    };
    const from = bound(args.from), to = bound(args.to);
    if (from !== null && to !== null && from > to) throw new Error("Reversed range");
    const metrics = args.metrics as Metric[], keys = args.workKeys.length ? args.workKeys as string[] : [...indexed.keys()];
    const slotHours = args.dimension === "hour_of_day" ? Number(args.bucketHours) : 24;
    const width = slotHours * HOUR;
    const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const slotOf = (at: number) => {
      if (args.dimension === "date") return dateOf(at);
      if (args.dimension === "weekday") return weekday[new Date(at + BEIJING).getUTCDay()]!;
      const start = Math.floor(new Date(at + BEIJING).getUTCHours() / slotHours) * slotHours;
      return `${String(start).padStart(2, "0")}:00–${String(start + slotHours).padStart(2, "0")}:00`;
    };
    const groups = new Map<string, Cell[]>();
    const cellsFor = (slot: string) => { if (!groups.has(slot)) groups.set(slot, metrics.map(emptyCell)); return groups.get(slot)!; };
    if (args.dimension === "hour_of_day") for (let hour = 0; hour < 24; hour += slotHours) cellsFor(slotOf(Date.UTC(2026, 0, 1, hour) - BEIJING));
    if (args.dimension === "weekday") for (const day of [...weekday.slice(1), weekday[0]!]) cellsFor(day);
    let intervals = 0, accepted = 0, coarse = 0, boundary = 0, missing = 0, crossSlot = 0;
    let earliest = Infinity, latest = -Infinity;
    const gaps: number[] = [];
    const coarseWidths: number[] = [];
    const excludedChange = metrics.map(() => 0);
    for (const key of keys) {
      const points = indexed.get(key)!;
      for (let index = 1; index < points.length; index++) {
        const a = points[index - 1]!, b = points[index]!;
        if (from !== null && b.at <= from || to !== null && a.at >= to) continue;
        if (from !== null && a.at < from || to !== null && b.at > to) { boundary++; continue; }
        const elapsed = b.at - a.at; if (elapsed <= 0) continue;
        intervals++; gaps.push(elapsed / HOUR);
        earliest = Math.min(earliest, a.at); latest = Math.max(latest, b.at);
        const slot = slotOf(b.at - 1), cells = cellsFor(slot);
        // Ten percent tolerance accommodates sampling jitter. Large/compacted
        // intervals cannot identify an hourly peak and are reported separately.
        if (elapsed > width * 1.1 || b.precisionHours > slotHours) {
          coarse++;
          coarseWidths.push(Math.max(elapsed / HOUR / 1.1, b.precisionHours));
          metrics.forEach((metric, i) => { const left = a.metrics[metric], right = b.metrics[metric]; if (left !== null && right !== null && Number.isFinite(left) && Number.isFinite(right)) excludedChange[i]! += right - left; });
          continue;
        }
        let usable = false;
        metrics.forEach((metric, i) => {
          const left = a.metrics[metric], right = b.metrics[metric];
          if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right)) return;
          usable = true;
          const cell = cells[i]!, delta = right - left;
          cell.delta += delta; cell.positive += Math.max(0, delta); cell.negative += Math.min(0, delta);
          cell.hours += elapsed / HOUR; cell.days.add(dateOf(b.at - 1)); cell.works.add(key);
        });
        if (usable) { accepted++; if (slotOf(a.at) !== slot) crossSlot++; } else missing++;
      }
    }
    // Calendar rows include explicitly unobserved dates, never fabricated zeros.
    if (args.dimension === "date" && Number.isFinite(earliest)) {
      for (let day = Math.floor((earliest + BEIJING) / DAY) * DAY - BEIJING; day < latest; day += DAY) cellsFor(dateOf(day));
    }
    const entries = [...groups];
    if (args.dimension === "date") entries.sort(([a], [b]) => a.localeCompare(b));
    const positiveTotals = metrics.map((_, i) => entries.reduce((n, [, cells]) => n + cells[i]!.positive, 0));
    const summary = metrics.map((metric, i) => {
      const measured = entries.filter(([, cells]) => cells[i]!.hours > 0).sort((a, b) => b[1][i]!.delta / b[1][i]!.hours - a[1][i]!.delta / a[1][i]!.hours);
      const high = measured[0], low = measured.at(-1);
      const varies = high && low && Math.abs(high[1][i]!.delta / high[1][i]!.hours - low[1][i]!.delta / low[1][i]!.hours) > 1e-12;
      return { metric, observedNetChange: measured.length ? entries.reduce((n, [, cells]) => n + cells[i]!.delta, 0) : null, peak: varies ? high[0] : null, low: varies ? low[0] : null, comparableSlots: measured.length, excludedCoarseNetChange: excludedChange[i] };
    });
    const rows = entries.map(([slot, cells]) => ({ slot, values: cells.map((cell, i) => cell.hours > 0
      ? [cell.delta, cell.positive, cell.negative, cell.delta / cell.hours, positiveTotals[i]! > 0 ? cell.positive / positiveTotals[i]! : null, cell.hours, cell.days.size, cell.works.size]
      : [null, null, null, null, null, 0, 0, 0]) }));
    const offset = Number(args.offset), limit = Number(args.limit);
    gaps.sort((a, b) => a - b);
    const medianHours = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null;
    coarseWidths.sort((a, b) => a - b);
    const neededWidth = coarseWidths.length ? coarseWidths[Math.floor(coarseWidths.length / 2)]! : medianHours === null ? slotHours : medianHours / 1.1;
    const suggestedBucketHours = [1, 2, 3, 4, 6, 12, 24].find(hours => hours >= neededWidth) ?? 24;
    return { dimension: args.dimension, timezone: "Asia/Shanghai", selectedWorks: keys.length, metrics,
      fromAt: Number.isFinite(earliest) ? stamp(earliest) : null, toAt: Number.isFinite(latest) ? stamp(latest) : null,
      bucketHours: slotHours, summary,
      coverage: { intervals, accepted, excludedCoarse: coarse, excludedBoundary: boundary, missingPairs: missing, crossSlotIntervals: crossSlot, medianIntervalHours: medianHours, suggestedBucketHours, suggestedDimension: args.dimension === "hour_of_day" && suggestedBucketHours === 24 ? "date" : args.dimension },
      valueColumns: ["netChange", "positiveChange", "negativeChange", "netPerWorkHour", "shareOfPositiveChange", "observedWorkHours", "observedDays", "coveredWorks"],
      total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, rows: rows.slice(offset, offset + limit),
      interpretation: "values align to metrics then valueColumns. Null is unobserved, zero is observed no change. Increments belong to the interval END slot (exact boundary belongs to preceding slot), not exact event times; cross-slot intervals are approximate. No interpolation. Rates normalize by observed work-hours to reduce sampling-frequency/portfolio-size bias, NOT whole-account events/hour. Positive/negative changes are net observed counter differences, not individual events. Compare coverage/observedDays before calling a pattern typical. Excluded coarse changes cannot be assigned to narrow slots; retry with coarser buckets or date dimension if needed. Peaks/lows rank normalized rates over ALL rows. This is historical observation, NOT an optimal publishing-time or causal claim.",
    };
  };
}
