import { beijingDayRange } from "./time";

/** Small collection jitter is an estimated boundary, never an exact midnight. */
export const MIDNIGHT_GRACE_MS = 5 * 60_000;

export function isMidnight(at: number): boolean {
  return beijingDayRange(at)?.startMs === at;
}

/** Read-only accounting coordinates. Original observation timestamps stay intact.
 * Only the first observation in the five-minute midnight window is shared by
 * adjacent days. Later observations retain their actual coordinates.
 */
export function dayBoundaryCoordinates(times: readonly number[]): Map<number, number> {
  const firstByDay = new Map<number, number>();
  for (const at of times) {
    const day = beijingDayRange(at);
    if (!day || at - day.startMs > MIDNIGHT_GRACE_MS) continue;
    firstByDay.set(day.startMs, Math.min(at, firstByDay.get(day.startMs) ?? Infinity));
  }
  return new Map([...firstByDay].map(([midnight, at]) => [at, midnight]));
}
