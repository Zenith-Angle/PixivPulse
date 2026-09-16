import { buildWorkTimelines } from "./timeline";
import { beijingDayRange } from "./time";
import type { ObservationBatch, WorkObservation, WorkSample } from "./types";

const KEYS = ["views", "bookmarks", "likes", "comments"] as const;

/** Recomputed from retained observations; never writes or fabricates history. */
export function buildDailySummary(
  date: string,
  workKeys: readonly string[],
  samples: readonly WorkSample[],
  observations: readonly WorkObservation[],
  batches: readonly ObservationBatch[] = [],
) {
  const day = beijingDayRange(date);
  const delta = { views: null, bookmarks: null, likes: null, comments: null } as Record<typeof KEYS[number], number | null>;
  let coveredWorks = 0, closedWorks = 0, completeWorks = 0, estimatedWorks = 0;
  let fromAt: string | null = null, toAt: string | null = null;
  const historicalKeys = new Set(day ? samples.filter(sample => Date.parse(sample.collectedAt) < day.endMs).map(sample => sample.workKey) : []);
  let workIndex = 0;
  const uniqueKeys = [...new Set(workKeys)];
  if (day) for (const points of buildWorkTimelines(workKeys, samples, observations, { startMs: day.startMs, endMs: day.endMs }, batches)) {
    const key = uniqueKeys[workIndex++]!;
    const first = points[0], last = points.at(-1);
    // A work first discovered at the closing midnight has no history that day.
    if (!first || !last || Date.parse(first.at) >= day.endMs) {
      if (historicalKeys.has(key)) coveredWorks++;
      continue;
    }
    coveredWorks++;
    const closes = Date.parse(last.at) === day.endMs;
    if (closes) closedWorks++;
    if (closes && Date.parse(first.at) === day.startMs && KEYS.every(metric => first.metrics[metric] != null && last.metrics[metric] != null)) {
      if (first.sourceAt || last.sourceAt) estimatedWorks++;
      else completeWorks++;
    }
    const firstSource = first.sourceAt ?? first.at, lastSource = last.sourceAt ?? last.at;
    if (fromAt === null || Date.parse(firstSource) < Date.parse(fromAt)) fromAt = firstSource;
    if (toAt === null || Date.parse(lastSource) > Date.parse(toAt)) toAt = lastSource;
    if (Date.parse(last.at) <= Date.parse(first.at)) continue;
    for (const metric of KEYS) {
      const a = first.metrics[metric], b = last.metrics[metric];
      if (a != null && b != null) delta[metric] = (delta[metric] ?? 0) + b - a;
    }
  }
  const status = coveredWorks === 0 ? "missing" : completeWorks === coveredWorks ? "complete"
    : completeWorks + estimatedWorks === coveredWorks ? "estimated" : "partial";
  return { date, delta, status, coveredWorks, closedWorks, completeWorks, estimatedWorks, fromAt, toAt };
}
