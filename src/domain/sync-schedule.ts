import { beijingDayRange } from "./time";

const MINUTES_PER_BEIJING_DAY = 24 * 60;
const MILLISECONDS_PER_MINUTE = 60_000;

function isValidInterval(intervalMinutes: number): boolean {
  return Number.isFinite(intervalMinutes)
    && Number.isInteger(intervalMinutes)
    && intervalMinutes > 0
    && MINUTES_PER_BEIJING_DAY % intervalMinutes === 0;
}

function isValidTimestamp(timestampMs: number): boolean {
  return Number.isSafeInteger(timestampMs);
}

/** Return whether an instant is exactly on a fixed Beijing sync slot. */
export function isBeijingSyncSlot(timestampMs: number, intervalMinutes: number): boolean {
  if (!isValidTimestamp(timestampMs) || !isValidInterval(intervalMinutes)) return false;

  const day = beijingDayRange(timestampMs);
  if (!day) return false;

  const intervalMs = intervalMinutes * MILLISECONDS_PER_MINUTE;
  return (timestampMs - day.startMs) % intervalMs === 0;
}

/** Return the strictly next fixed wall-clock sync slot in Beijing time. */
export function nextBeijingSyncSlot(nowMs: number, intervalMinutes: number): number | null {
  if (!isValidTimestamp(nowMs) || !isValidInterval(intervalMinutes)) return null;

  const day = beijingDayRange(nowMs);
  if (!day) return null;

  const intervalMs = intervalMinutes * MILLISECONDS_PER_MINUTE;
  const elapsedMs = nowMs - day.startMs;
  const nextSlot = day.startMs + (Math.floor(elapsedMs / intervalMs) + 1) * intervalMs;
  return Number.isSafeInteger(nextSlot) ? nextSlot : null;
}
