import type { ChartTimePoint } from "./chartOptions";
import { beijingDayRange, parseInstant, type TimeInput } from "../domain/time";

/** The range choices exposed by chart controls. */
export type ChartTimeRangePreset = "24h" | "today" | "3d" | "7d" | "30d" | "3m" | "all" | "custom";

/**
 * User-facing chart range input.
 *
 * Date-only values are interpreted as Beijing civil dates. Datetimes without
 * an explicit offset follow the same Beijing-time rule as `domain/time`.
 */
export interface ChartTimeRangeRequest {
  preset?: ChartTimeRangePreset;
  start?: TimeInput | null;
  end?: TimeInput | null;
  /** Injected clock value for deterministic `today` ranges and tests. */
  now?: TimeInput | null;
}

/**
 * Resolved inclusive chart bounds, expressed as UTC milliseconds.
 *
 * `null` means unbounded (the `all` preset). Both bounds are inclusive so a
 * custom end date includes the whole Beijing day and a minute-level end
 * includes that minute's final millisecond.
 */
export interface ChartTimeRange {
  preset: ChartTimeRangePreset;
  startMs: number | null;
  endMs: number | null;
}

export type ChartTimeRangeInput = ChartTimeRangeRequest | ChartTimeRange;
export type ChartTimeRangeOptions = ChartTimeRangeRequest;
export type TimestampAccessor<T> = (value: T) => TimeInput | null | undefined;

const DATE_ONLY_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{4}([-/.])\d{1,2}\1\d{1,2}$/,
  /^\d{4}年\d{1,2}月\d{1,2}日?$/,
] as const;

// `datetime-local` emits this minute precision. The parser in domain/time
// accepts the optional offset forms shown here and supplies Beijing UTC+8
// when the offset is absent.
const MINUTE_PRECISION_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/;

function isDateOnly(value: TimeInput): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return DATE_ONLY_PATTERNS.some((pattern) => pattern.test(text));
}

function isMinutePrecision(value: TimeInput): value is string {
  return typeof value === "string" && MINUTE_PRECISION_PATTERN.test(value.trim());
}

function addMilliseconds(value: number, amount: number): number | null {
  const result = value + amount;
  return Number.isSafeInteger(result) ? result : null;
}

function startBoundary(value: TimeInput): number | null {
  if (isDateOnly(value)) return beijingDayRange(value)?.startMs ?? null;
  return parseInstant(value);
}

function endBoundary(value: TimeInput): number | null {
  if (isDateOnly(value)) {
    const day = beijingDayRange(value);
    return day == null ? null : day.endMs - 1;
  }

  const timestamp = parseInstant(value);
  if (timestamp == null) return null;

  // A minute-level datetime is a user-selected minute, not merely its first
  // millisecond. Keep the whole minute in a custom range.
  return isMinutePrecision(value) ? addMilliseconds(timestamp, 59_999) : timestamp;
}

function isResolvedRange(value: ChartTimeRangeInput): value is ChartTimeRange {
  return typeof value === "object"
    && value !== null
    && "startMs" in value
    && "endMs" in value;
}

/**
 * Resolve a chart range against the fixed Beijing business timezone.
 * Invalid custom endpoints, reversed bounds, and invalid `today` clocks
 * return `null` so callers fail closed instead of showing an accidental
 * range.
 */
export function resolveChartTimeRange(input: ChartTimeRangeRequest = {}): ChartTimeRange | null {
  const preset = input.preset ?? "today";

  if (preset === "all") return { preset, startMs: null, endMs: null };

  if (preset === "24h") {
    const nowInput = input.now === undefined ? Date.now() : input.now;
    const now = parseInstant(nowInput);
    if (now == null) return null;
    return { preset, startMs: now - 24 * 60 * 60_000, endMs: now };
  }

  if (preset === "today" || preset === "3d" || preset === "7d" || preset === "30d" || preset === "3m") {
    const nowInput = input.now === undefined ? Date.now() : input.now;
    const now = parseInstant(nowInput);
    const day = now == null ? null : beijingDayRange(now);
    if (now == null || day == null || now < day.startMs || now >= day.endMs) return null;
    const days = preset === "today" ? 1 : preset === "3d" ? 3 : preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
    return { preset, startMs: day.startMs - (days - 1) * 86_400_000, endMs: now };
  }

  if (preset !== "custom" || input.start == null || input.end == null) return null;
  const startMs = startBoundary(input.start);
  const endMs = endBoundary(input.end);
  if (startMs == null || endMs == null || endMs < startMs) return null;
  return { preset, startMs, endMs };
}

export const getChartTimeRange = resolveChartTimeRange;
export const buildChartTimeRange = resolveChartTimeRange;

function defaultTimestamp(value: unknown): TimeInput | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  // `at` is the ChartTimePoint shape; the other names cover domain records
  // without requiring each caller to write a one-line accessor.
  for (const key of ["at", "timestamp", "observedAt", "collectedAt"] as const) {
    const candidate = record[key];
    if (candidate instanceof Date || typeof candidate === "number" || typeof candidate === "string") return candidate;
  }
  return null;
}

function resolvedRange(input: ChartTimeRangeInput): ChartTimeRange | null {
  return isResolvedRange(input) ? input : resolveChartTimeRange(input);
}

/** Return whether an instant falls within inclusive chart bounds. */
export function isInChartTimeRange(
  value: TimeInput | null | undefined,
  range: ChartTimeRangeInput,
): boolean {
  const timestamp = parseInstant(value);
  const resolved = resolvedRange(range);
  if (timestamp == null || resolved == null) return false;
  return (resolved.startMs == null || timestamp >= resolved.startMs)
    && (resolved.endMs == null || timestamp <= resolved.endMs);
}

/** Filter timestamped values while preserving their input order. */
export function filterTimestamped<T>(
  values: readonly T[],
  range: ChartTimeRangeInput = {},
  getTimestamp: TimestampAccessor<T> = defaultTimestamp as TimestampAccessor<T>,
): T[] {
  const resolved = resolvedRange(range);
  if (resolved == null) return [];
  return values.filter((value) => isInChartTimeRange(getTimestamp(value), resolved));
}

/** Filter the standard chart point shape by a preset or resolved range. */
export function filterChartTimePoints<T extends ChartTimePoint>(
  points: readonly T[],
  range: ChartTimeRangeInput = {},
): T[] {
  return filterTimestamped(points, range, (point) => point.at);
}

export const filterChartPoints = filterChartTimePoints;
export const filterByChartTimeRange = filterTimestamped;
