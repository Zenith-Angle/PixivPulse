import type {
  MetricDelta,
  WorkAnalysis,
  WorkMetrics,
  WorkRecord,
  WorkSample,
  WorkObservation,
} from "./types";

const METRIC_KEYS = Object.keys({
  likes: true,
  bookmarks: true,
  views: true,
  comments: true,
  rank: true,
  responses: true,
  illustrations: true,
}) as Array<keyof WorkMetrics>;

function timestamp(value: string): number | null {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function sortSamples(samples: WorkSample[]): WorkSample[] {
  return samples
    .filter((sample) => sample.workKey)
    .slice()
    .sort((left, right) => {
      const leftAt = timestamp(left.collectedAt) ?? 0;
      const rightAt = timestamp(right.collectedAt) ?? 0;
      return leftAt - rightAt || (left.id ?? 0) - (right.id ?? 0);
    });
}

function metricDelta(previous: WorkSample | null, latest: WorkSample | null, key: keyof WorkMetrics): MetricDelta {
  const fromAt = previous?.collectedAt ?? null;
  const toAt = latest?.collectedAt ?? null;
  const from = previous?.metrics[key] ?? null;
  const to = latest?.metrics[key] ?? null;
  const fromTimestamp = fromAt ? timestamp(fromAt) : null;
  const toTimestamp = toAt ? timestamp(toAt) : null;
  const elapsedHours = fromTimestamp != null && toTimestamp != null && toTimestamp > fromTimestamp
    ? (toTimestamp - fromTimestamp) / 3_600_000
    : null;

  if (from == null || to == null || elapsedHours == null) {
    return { value: null, fromAt, toAt, elapsedHours, confidence: "insufficient" };
  }
  return {
    value: to - from,
    fromAt,
    toAt,
    elapsedHours,
    // The interval is measured from the two actual collection timestamps;
    // it is not silently labeled as a 24-hour rate.
    confidence: "exact",
};
}

export function calculateMetricDelta(
  previous: WorkSample | null,
  latest: WorkSample | null,
  key: keyof WorkMetrics,
): MetricDelta {
  return metricDelta(previous, latest, key);
}

export function calculateRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return numerator / denominator;
}

export function buildSparkline(samples: WorkSample[], workKey?: string): WorkAnalysis["sparkline"] {
  return sortSamples(samples)
    .filter((sample) => workKey == null || sample.workKey === workKey)
    .map((sample) => ({
      at: sample.collectedAt,
      views: sample.metrics.views,
      bookmarks: sample.metrics.bookmarks,
      likes: sample.metrics.likes,
    }));
}

export function selectLatestAndPrevious(samples: WorkSample[], workKey: string): {
  latestSample: WorkSample | null;
  previousSample: WorkSample | null;
} {
  const ordered = sortSamples(samples).filter((sample) => sample.workKey === workKey);
  return {
    latestSample: ordered.at(-1) ?? null,
    previousSample: ordered.at(-2) ?? null,
  };
}

function confidenceFor(sampleCount: number, observationCount: number): WorkAnalysis["confidence"] {
  if (sampleCount >= 3 && observationCount >= 3) return "high";
  if (sampleCount >= 2 && observationCount >= 2) return "medium";
  return "low";
}

export function analyzeWork(
  work: WorkRecord,
  samples: WorkSample[],
  observations: WorkObservation[] = [],
): WorkAnalysis {
  const selected = selectLatestAndPrevious(samples, work.key);
  const workSamples = sortSamples(samples).filter((sample) => sample.workKey === work.key);
  const workObservations = observations.filter((observation) => observation.workKey === work.key);
  const lastDelta = {} as Record<keyof WorkMetrics, MetricDelta>;
  for (const key of METRIC_KEYS) lastDelta[key] = metricDelta(selected.previousSample, selected.latestSample, key);

  const latestMetrics = selected.latestSample?.metrics ?? work.metrics;
  return {
    work,
    latestSample: selected.latestSample,
    previousSample: selected.previousSample,
    lastDelta,
    bookmarkRate: calculateRatio(latestMetrics.bookmarks, latestMetrics.views),
    likeRate: calculateRatio(latestMetrics.likes, latestMetrics.views),
    sparkline: buildSparkline(workSamples),
    confidence: confidenceFor(workSamples.length, workObservations.length),
  };
}

export function analyzeWorks(
  works: WorkRecord[],
  samples: WorkSample[],
  observations: WorkObservation[] = [],
): WorkAnalysis[] {
  return works.map((work) => analyzeWork(work, samples, observations));
}

export const getWorkAnalysis = analyzeWork;
