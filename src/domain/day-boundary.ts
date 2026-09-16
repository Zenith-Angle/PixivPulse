import { beijingDayRange } from "./time";

/** Small collection jitter is an estimated boundary, never an exact midnight. */
export const MIDNIGHT_GRACE_MS = 5 * 60_000;

// All works in an observation batch share an instant. Avoid repeating the
// timezone formatter for every work while keeping the business-time contract.
const dayStarts = new Map<number, number | null>();
function dayStart(at: number): number | null {
  const cached = dayStarts.get(at);
  if (cached !== undefined) return cached;
  const start = beijingDayRange(at)?.startMs ?? null;
  if (dayStarts.size >= 8192) dayStarts.delete(dayStarts.keys().next().value!);
  dayStarts.set(at, start);
  return start;
}

export function isMidnight(at: number): boolean {
  return dayStart(at) === at;
}

/** Read-only accounting coordinates. Original observation timestamps stay intact.
 * Only the first observation in the five-minute midnight window is shared by
 * adjacent days. Later observations retain their actual coordinates.
 */
export function dayBoundaryCoordinates(times: readonly number[]): Map<number, number> {
  const firstByDay = new Map<number, number>();
  for (const at of times) {
    const start = dayStart(at);
    if (start === null || at - start > MIDNIGHT_GRACE_MS) continue;
    firstByDay.set(start, Math.min(at, firstByDay.get(start) ?? Infinity));
  }
  return new Map([...firstByDay].map(([midnight, at]) => [at, midnight]));
}
