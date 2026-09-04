/** The timezone used for all business-day calculations and human-facing time. */
export const BUSINESS_TIME_ZONE = "Asia/Shanghai" as const;
export const BUSINESS_TIME_ZONE_LABEL = "北京时间（UTC+8）" as const;

const BUSINESS_OFFSET_MINUTES = 8 * 60;
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60_000;

export type TimeInput = Date | string | number;

export interface BeijingDayRange {
  date: string;
  startMs: number;
  endMs: number;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface CivilDateTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEPARATED_DATE_PATTERN = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const CJK_DATE_PATTERN = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/;

const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat("en-US-u-nu-latn", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface BeijingDisplayOptions {
  includeYear?: boolean;
  includeSeconds?: boolean;
}

function isFiniteTime(value: number): boolean {
  return Number.isFinite(value) && Number.isSafeInteger(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidCivilDate(value: CivilDate): boolean {
  return Number.isInteger(value.year)
    && value.year >= 0
    && value.year <= 99_999
    && Number.isInteger(value.month)
    && value.month >= 1
    && value.month <= 12
    && Number.isInteger(value.day)
    && value.day >= 1
    && value.day <= daysInMonth(value.year, value.month);
}

function parseDateOnly(value: string): CivilDate | null {
  const isoMatch = value.match(ISO_DATE_PATTERN);
  const separatedMatch = value.match(SEPARATED_DATE_PATTERN);
  const cjkMatch = value.match(CJK_DATE_PATTERN);
  const match = isoMatch ?? separatedMatch ?? cjkMatch;
  if (!match) return null;
  const civil = isoMatch || cjkMatch
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : { year: Number(match[1]), month: Number(match[3]), day: Number(match[4]) };
  return isValidCivilDate(civil) ? civil : null;
}

/** Convert a validated civil clock value to a UTC millisecond value. */
function civilToUtcMs(value: CivilDateTime, offsetMinutes: number): number | null {
  if (!isValidCivilDate(value)
    || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23
    || !Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59
    || !Number.isInteger(value.second) || value.second < 0 || value.second > 59
    || !Number.isInteger(value.millisecond) || value.millisecond < 0 || value.millisecond > 999
    || !Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 23 * MINUTES_PER_HOUR + 59) {
    return null;
  }

  // Date.UTC treats years 0..99 as 1900..1999. Setting the full year on an
  // existing Date avoids that legacy special case while retaining Date's
  // well-tested range and TimeClip behavior.
  const utcDate = new Date(0);
  utcDate.setUTCFullYear(value.year, value.month - 1, value.day);
  utcDate.setUTCHours(value.hour, value.minute, value.second, value.millisecond);
  const utcMs = utcDate.getTime();
  if (!isFiniteTime(utcMs)) return null;

  const instantMs = utcMs - offsetMinutes * MILLISECONDS_PER_MINUTE;
  return isFiniteTime(instantMs) ? instantMs : null;
}

function isoFromMs(value: number): string | null {
  if (!isFiniteTime(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function formatDateKeyParts(value: number): string | null {
  if (!isFiniteTime(value)) return null;
  try {
    const parts = BEIJING_DATE_FORMATTER.formatToParts(new Date(value));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return null;
    return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  } catch {
    return null;
  }
}

/**
 * Parse a value that represents an absolute instant into milliseconds.
 * Invalid values return null; this helper never substitutes the current time.
 */
export function parseInstant(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return isFiniteTime(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const timestamp = new Date(value).getTime();
    return isFiniteTime(timestamp) ? timestamp : null;
  }
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  // ISO/Pixiv civil values go through the deterministic business-time parser
  // first so host timezone settings cannot change their meaning.
  const normalized = normalizePixivDateTime(text);
  if (normalized) {
    const timestamp = Date.parse(normalized);
    return isFiniteTime(timestamp) ? timestamp : null;
  }

  // Date.parse is permissive and may roll impossible ISO-looking dates such
  // as 2026-02-30 into a different day. Keep malformed Pixiv-like values
  // invalid rather than allowing that fallback to silently change their date.
  if (/^\d{4}(?:[-/.]\d{1,2}[-/.]\d{1,2}|年\d{1,2}月\d{1,2}日?)(?:$|T|t| )/.test(text)) return null;

  const timestamp = Date.parse(text);
  return isFiniteTime(timestamp) ? timestamp : null;
}

/** Return the Beijing YYYY-MM-DD key for an absolute instant. */
export function beijingDateKey(value: TimeInput | null | undefined): string | null {
  if (typeof value === "string") {
    const civil = parseDateOnly(value.trim());
    if (civil) {
      return `${String(civil.year).padStart(4, "0")}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`;
    }
  }
  const timestamp = parseInstant(value);
  return timestamp == null ? null : formatDateKeyParts(timestamp);
}

/**
 * Return the UTC millisecond range for one Beijing civil day. The end is
 * exclusive, so timestamps satisfy startMs <= t < endMs.
 */
export function beijingDayRange(value: TimeInput | null | undefined): BeijingDayRange | null {
  const input = typeof value === "string" ? value.trim() : value;
  const civil = typeof input === "string" ? parseDateOnly(input) : null;
  const date = civil
    ? `${String(civil.year).padStart(4, "0")}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`
    : beijingDateKey(input);
  if (!date) return null;

  const resolvedCivil = civil ?? parseDateOnly(date);
  if (!resolvedCivil) return null;
  const startMs = civilToUtcMs({ ...resolvedCivil, hour: 0, minute: 0, second: 0, millisecond: 0 }, BUSINESS_OFFSET_MINUTES);
  if (startMs == null) return null;
  const endMs = startMs + MILLISECONDS_PER_DAY;
  if (!isFiniteTime(endMs) || endMs <= startMs) return null;
  return { date, startMs, endMs };
}

/** Return the inclusive last millisecond of a Beijing day as UTC ISO. */
export function beijingDayEndIso(dateKey: string): string | null {
  const range = beijingDayRange(dateKey);
  return range ? isoFromMs(range.endMs - 1) : null;
}

/** Return the next Beijing 00:00 boundary as a UTC millisecond timestamp. */
export function nextBeijingMidnight(value?: TimeInput | null): number | null {
  // An omitted argument is a useful convenience for callers scheduling from
  // the current instant, but an explicitly supplied undefined/null remains an
  // invalid input and must not silently turn into "now".
  const input = arguments.length === 0 ? Date.now() : value;
  const range = beijingDayRange(input);
  return range?.endMs ?? null;
}

/** Format an instant using a stable Beijing display timezone. */
export function formatBeijingTimestamp(
  value: TimeInput | null | undefined,
  options: BeijingDisplayOptions = {},
): string | null {
  const timestamp = parseInstant(value);
  if (timestamp == null) return null;
  try {
    return new Intl.DateTimeFormat("zh-CN-u-nu-latn", {
      timeZone: BUSINESS_TIME_ZONE,
      ...(options.includeYear ? { year: "numeric" as const } : {}),
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(options.includeSeconds ? { second: "2-digit" as const } : {}),
      hourCycle: "h23",
    }).format(new Date(timestamp));
  } catch {
    return null;
  }
}

/** Return the Beijing date used in export filenames. */
export function beijingExportDate(value: TimeInput | null | undefined): string | null {
  return beijingDateKey(value);
}

/**
 * Normalize Pixiv date entries to UTC ISO.
 *
 * Explicit Z/offset values preserve their instant. Date-only values and ISO
 * datetimes without a timezone are civil Beijing times (UTC+8). Unsupported
 * or invalid values return null.
 */
export function normalizePixivDateTime(value: unknown): string | null {
  if (value instanceof Date || typeof value === "number") {
    const timestamp = parseInstant(value);
    return timestamp == null ? null : isoFromMs(timestamp);
  }
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  const civilDate = parseDateOnly(text);
  if (civilDate) {
    return isoFromMs(civilToUtcMs({ ...civilDate, hour: 0, minute: 0, second: 0, millisecond: 0 }, BUSINESS_OFFSET_MINUTES) ?? NaN);
  }

  const match = text.match(ISO_DATE_TIME_PATTERN);
  if (!match) return null;
  const civil: CivilDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || 0),
  };

  let offsetMinutes = BUSINESS_OFFSET_MINUTES;
  if (match[8] === "Z") {
    offsetMinutes = 0;
  } else if (match[9]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    const magnitude = offsetHour * MINUTES_PER_HOUR + offsetMinute;
    offsetMinutes = match[9] === "+" ? magnitude : -magnitude;
  }

  const timestamp = civilToUtcMs(civil, offsetMinutes);
  return timestamp == null ? null : isoFromMs(timestamp);
}
