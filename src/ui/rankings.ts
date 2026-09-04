import type { WorkAnalysis, WorkRecord, WorkSample } from "../domain/types";

export type RankingStatus = "ranked" | "unranked" | "unknown";

export interface RankingObservation {
  status: "ranked" | "unranked";
  rank: number | null;
  observedAt: string;
  source: string | null;
}

export interface RankingEntry {
  analysis: WorkAnalysis;
  rank: number;
  observedAt: string;
  source: string | null;
  previousRank: number | null;
  movement: number | null;
  status: "ranked";
}

interface RankingFields {
  rankingStatus?: unknown;
  rankingObservedAt?: unknown;
  rankingSource?: unknown;
}

type RankingCarrier = RankingFields & {
  metrics?: { rank?: unknown };
};

type RichSparklinePoint = {
  at?: unknown;
  rank?: unknown;
  rankingStatus?: unknown;
  rankingObservedAt?: unknown;
  rankingSource?: unknown;
};

const rankingFields = (value: unknown): RankingFields => (value !== null && typeof value === "object" ? value as RankingFields : {});

const rankValue = (value: unknown): number | null => {
  const candidate = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) return null;
  return candidate;
};

const validTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return value;
};

/**
 * Treat old records that have no rankingStatus as ranked when their rank is a
 * positive number. Explicit unranked records remain unranked and all other
 * records stay unknown.
 */
export const normalizeRankingStatus = (status: unknown, rank: unknown): RankingStatus => {
  const normalizedStatus = typeof status === "string" ? status.trim().toLocaleLowerCase() : "";
  const normalizedRank = rankValue(rank);
  if (normalizedStatus === "ranked" || normalizedStatus === "ranking") return normalizedRank === null ? "unknown" : "ranked";
  if (normalizedStatus === "unranked" || normalizedStatus === "not-ranked" || normalizedStatus === "not_ranked") return "unranked";
  if (normalizedStatus === "unknown" || (normalizedStatus === "" && normalizedRank === null)) return "unknown";
  return normalizedRank === null ? "unknown" : "ranked";
};

export const normalizeRank = (value: unknown): number | null => rankValue(value);

const carrierEvent = (carrier: RankingCarrier, fallbackAt: unknown): RankingObservation | null => {
  const fields = rankingFields(carrier);
  const rank = rankValue(carrier.metrics?.rank);
  const status = normalizeRankingStatus(fields.rankingStatus, rank);
  if (status === "unknown") return null;
  const observedAt = validTimestamp(fields.rankingObservedAt) ?? validTimestamp(fallbackAt);
  if (!observedAt) return null;
  return {
    status,
    rank: status === "ranked" ? rank : null,
    observedAt,
    source: typeof fields.rankingSource === "string" && fields.rankingSource.trim() ? fields.rankingSource.trim() : null,
  };
};

const compareTimestamp = (left: string, right: string): number => (Date.parse(left) || 0) - (Date.parse(right) || 0);

const dedupeRankingObservations = (observations: RankingObservation[]): RankingObservation[] => {
  const byObservedAt = new Map<string, RankingObservation>();
  observations.forEach((observation) => {
    // rankingObservedAt is already normalized to observedAt. A later record
    // with the same explicit observation replaces the older duplicate.
    const timestamp = Date.parse(observation.observedAt);
    byObservedAt.set(Number.isFinite(timestamp) ? String(timestamp) : observation.observedAt, observation);
  });
  return [...byObservedAt.values()].sort((left, right) => compareTimestamp(left.observedAt, right.observedAt));
};

/** Return only explicit ranked/unranked observations, oldest first. */
export const rankingHistoryForWork = (work: WorkRecord, samples: readonly WorkSample[] = []): RankingObservation[] => {
  const events: RankingObservation[] = [];
  const orderedSamples = samples
    .filter((sample) => sample.workKey === work.key)
    .slice()
    .sort((left, right) => (Date.parse(left.collectedAt) || 0) - (Date.parse(right.collectedAt) || 0) || (left.id ?? 0) - (right.id ?? 0));
  for (const sample of orderedSamples) {
    const event = carrierEvent(sample as RankingCarrier, sample.collectedAt);
    if (event) events.push(event);
  }

  // A record-only/legacy export may not carry its sample rows. Add the record
  // as a fallback, but do not let it overwrite a newer explicit sample.
  const recordEvent = carrierEvent(work as RankingCarrier, work.lastSeenAt);
  // Once sample rows exist they are the authoritative ranking timeline. The
  // denormalized work record may be stale (notably after an unranked state),
  // so use it only for record-only/legacy exports.
  if (events.length === 0 && recordEvent) events.push(recordEvent);
  if (events.length > 0) return dedupeRankingObservations(events);
  return recordEvent ? [recordEvent] : [];
};

/**
 * Recover ranking history from WorkAnalysis objects when a view only has
 * analysis data. New analyses carry rich ranking fields on their runtime
 * sparkline points; the fallback still supports manually-created analyses.
 */
export const rankingHistoryForAnalysis = (analysis: WorkAnalysis): RankingObservation[] => {
  const events: RankingObservation[] = [];
  for (const point of analysis.sparkline as Array<RichSparklinePoint>) {
    const carrier: RankingCarrier = {
      metrics: { rank: point.rank },
      rankingStatus: point.rankingStatus,
      rankingObservedAt: point.rankingObservedAt,
      rankingSource: point.rankingSource,
    };
    const event = carrierEvent(carrier, point.at);
    if (event) events.push(event);
  }
  const adjacentSamples = [analysis.previousSample, analysis.latestSample].filter((sample): sample is WorkSample => sample !== null);
  for (const sample of adjacentSamples) {
    const event = carrierEvent(sample as RankingCarrier, sample.collectedAt);
    if (event) events.push(event);
  }
  const recordEvent = carrierEvent(analysis.work as RankingCarrier, analysis.work.lastSeenAt);
  // A denormalized work record can lag an explicit unranked sample; only use
  // it when the analysis has no ranking events at all.
  if (events.length === 0 && recordEvent) events.push(recordEvent);
  return dedupeRankingObservations(events);
};

export const rankingMovement = (currentRank: number, previousRank: number | null): number | null =>
  previousRank === null ? null : previousRank - currentRank;

const latestRankedIndex = (history: RankingObservation[]): number => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.status === "ranked" && history[index]?.rank !== null) return index;
  }
  return -1;
};

export const rankingEntryForAnalysis = (analysis: WorkAnalysis, history = rankingHistoryForAnalysis(analysis)): RankingEntry | null => {
  const latestEvent = history.at(-1);
  // An explicit unranked observation is current state, not a missing value;
  // keep it in detail history but do not surface the work in current ranks.
  if (latestEvent?.status === "unranked") return null;
  const currentIndex = latestRankedIndex(history);
  if (currentIndex < 0) return null;
  const current = history[currentIndex];
  if (!current || current.rank === null) return null;
  let previousRank: number | null = null;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.status === "ranked" && item.rank !== null) {
      previousRank = item.rank;
      break;
    }
  }
  return {
    analysis,
    rank: current.rank,
    observedAt: current.observedAt,
    source: current.source,
    previousRank,
    movement: rankingMovement(current.rank, previousRank),
    status: "ranked",
  };
};

export const buildRankingEntries = (
  analyses: readonly WorkAnalysis[],
  samples?: readonly WorkSample[],
): RankingEntry[] => analyses
  .map((analysis) => rankingEntryForAnalysis(
    analysis,
    samples ? rankingHistoryForWork(analysis.work, samples) : rankingHistoryForAnalysis(analysis),
  ))
  .filter((entry): entry is RankingEntry => entry !== null)
  .sort((left, right) => left.rank - right.rank || left.analysis.work.title.localeCompare(right.analysis.work.title, "zh-CN"));

export const rankingSourceLabel = (source: string | null | undefined): string => {
  const normalized = source?.trim().toLocaleLowerCase();
  if (!normalized) return "来源未记录";
  if (normalized.includes("api")) return "Pixiv API";
  return "Pixiv作品页";
};

export const rankingMovementLabel = (movement: number | null): string => {
  if (movement === null) return "暂无上次排名";
  if (movement > 0) return `上升 ${formatRankDistance(movement)} 名`;
  if (movement < 0) return `下降 ${formatRankDistance(Math.abs(movement))} 名`;
  return "排名无变化";
};

const formatRankDistance = (value: number): string => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);

export const rankingStatusLabel = (status: RankingStatus): string => {
  if (status === "ranked") return "已上榜";
  if (status === "unranked") return "未上榜";
  return "排名未知";
};
