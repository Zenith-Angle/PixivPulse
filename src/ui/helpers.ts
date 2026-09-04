import type {
  DashboardData,
  MetricDelta,
  WorkAnalysis,
  WorkContentType,
  WorkMetrics,
  WorkRecord,
  WorkSample,
} from "../domain/types";
import { formatBeijingTimestamp } from "../domain/time";

export {
  buildRankingEntries,
  normalizeRank,
  normalizeRankingStatus,
  rankingEntryForAnalysis,
  rankingHistoryForAnalysis,
  rankingHistoryForWork,
  rankingMovement,
  rankingMovementLabel,
  rankingSourceLabel,
  rankingStatusLabel,
} from "./rankings";
export type { RankingEntry, RankingObservation, RankingStatus } from "./rankings";

/**
 * Keep the dashboard's content labels independent from the parser so older
 * local records can still be rendered without guessing their subtype.
 */
export const WORK_CONTENT_TYPE_LABELS: Record<WorkContentType, string> = {
  novel: "小说",
  illustration: "插画",
  manga: "漫画",
  ugoira: "动图",
  unknown: "作品",
};

export const contentTypeForWork = (work: Pick<WorkRecord, "type" | "contentType">): WorkContentType => {
  const value: unknown = work.contentType;
  if (value === "novel" || value === "illustration" || value === "manga" || value === "ugoira" || value === "unknown") {
    return value;
  }
  // A legacy record only has the broad work type. A novel is unambiguous;
  // illust records stay unknown until the parser supplies a subtype.
  return work.type === "novel" ? "novel" : "unknown";
};

export const contentTypeLabel = (value: WorkContentType): string => WORK_CONTENT_TYPE_LABELS[value];

export const METRIC_KEYS: Array<keyof WorkMetrics> = [
  "views",
  "likes",
  "bookmarks",
  "comments",
  "rank",
  "responses",
  "illustrations",
];

export const METRIC_LABELS: Record<keyof WorkMetrics, string> = {
  views: "浏览",
  likes: "赞",
  bookmarks: "收藏",
  comments: "评论",
  rank: "排名",
  responses: "回复",
  illustrations: "插画数",
};

const toTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const elapsedHours = (from: string | null, to: string | null): number | null => {
  const fromMs = toTime(from);
  const toMs = toTime(to);
  if (fromMs === null || toMs === null || toMs < fromMs) return null;
  return (toMs - fromMs) / (60 * 60 * 1000);
};

export const formatElapsed = (hours: number | null): string => {
  if (hours === null || !Number.isFinite(hours)) return "暂无有效间隔";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `距上次采样 ${minutes} 分钟`;
  }
  if (hours < 24) return `距上次采样 ${hours.toFixed(1)} 小时`;
  return `距上次采样 ${(hours / 24).toFixed(1)} 天`;
};

export const formatTimestamp = (value: string | null | undefined): string => {
  const timestamp = toTime(value);
  if (timestamp === null) return "未记录";
  return formatBeijingTimestamp(timestamp, { includeYear: false }) ?? "未记录";
};

export const formatCount = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
};

export const formatDelta = (value: number | null | undefined, suffix = ""): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${formatCount(rounded)}${suffix}`;
};

export const formatPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
};

export const metricValue = (work: WorkAnalysis, key: keyof WorkMetrics): number | null => {
  const latest = work.latestSample?.metrics ?? work.work.metrics;
  return latest[key];
};

export const samplesForWork = (samples: WorkSample[], workKey: string): WorkSample[] =>
  samples
    .filter((sample) => sample.workKey === workKey)
    .sort((a, b) => (toTime(a.collectedAt) ?? 0) - (toTime(b.collectedAt) ?? 0));

const makeDelta = (
  current: number | null,
  previous: number | null,
  currentAt: string | null,
  previousAt: string | null,
): MetricDelta => {
  const interval = elapsedHours(previousAt, currentAt);
  if (current === null || previous === null || interval === null) {
    return {
      value: null,
      fromAt: previousAt,
      toAt: currentAt,
      elapsedHours: interval,
      confidence: "insufficient",
    };
  }
  return {
    value: current - previous,
    fromAt: previousAt,
    toAt: currentAt,
    elapsedHours: interval,
    confidence: "exact",
  };
};

export const analyzeWork = (work: WorkRecord, samples: WorkSample[]): WorkAnalysis => {
  const history = samplesForWork(samples, work.key);
  const latestSample = history.at(-1) ?? null;
  const previousSample = history.at(-2) ?? null;
  const currentMetrics = latestSample?.metrics ?? work.metrics;
  const previousMetrics = previousSample?.metrics ?? null;
  const lastDelta = {} as Record<keyof WorkMetrics, MetricDelta>;
  for (const key of METRIC_KEYS) {
    lastDelta[key] = makeDelta(
      currentMetrics[key],
      previousMetrics?.[key] ?? null,
      latestSample?.collectedAt ?? work.lastSeenAt,
      previousSample?.collectedAt ?? null,
    );
  }

  const views = currentMetrics.views;
  const bookmarks = currentMetrics.bookmarks;
  const likes = currentMetrics.likes;
  return {
    work,
    latestSample,
    previousSample,
    lastDelta,
    bookmarkRate: views && views > 0 && bookmarks !== null ? bookmarks / views : null,
    likeRate: views && views > 0 && likes !== null ? likes / views : null,
    // Keep ranking metadata on runtime sparkline points for detail views and
    // old exported records, while the public WorkAnalysis type remains
    // backwards compatible with consumers that only know the four legacy
    // fields.
    sparkline: history.map((sample) => ({
      at: sample.collectedAt,
      runId: sample.runId,
      views: sample.metrics.views,
      bookmarks: sample.metrics.bookmarks,
      likes: sample.metrics.likes,
      comments: sample.metrics.comments,
      rank: sample.metrics.rank,
      rankingStatus: (sample as WorkSample & { rankingStatus?: unknown }).rankingStatus,
      rankingObservedAt: (sample as WorkSample & { rankingObservedAt?: unknown }).rankingObservedAt,
      rankingSource: (sample as WorkSample & { rankingSource?: unknown }).rankingSource,
    })) as WorkAnalysis["sparkline"],
    confidence: history.length >= 3 ? "high" : history.length >= 2 ? "medium" : "low",
  };
};

export const analyzeDashboard = (data: DashboardData): WorkAnalysis[] =>
  data.works.map((work) => analyzeWork(work, data.samples));

export const csvCell = (value: unknown): string => {
  const raw = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications may execute cells beginning with these characters.
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replaceAll('"', '""')}"`;
};

export const toSafeCsv = (data: DashboardData): string => {
  const rows: unknown[][] = [
    ["作品 ID", "标题", "类型", "浏览", "赞", "收藏", "评论", "上次变化 UTC", "上次变化（北京时间 UTC+8）", "首次观察 UTC", "首次观察（北京时间 UTC+8）"],
    ...data.works.map((work) => [
      work.id,
      work.title,
      work.type === "illust" ? "插画" : "小说",
      work.metrics.views,
      work.metrics.likes,
      work.metrics.bookmarks,
      work.metrics.comments,
      work.lastSeenAt,
      formatBeijingTimestamp(work.lastSeenAt, { includeYear: true }),
      work.firstSeenAt,
      formatBeijingTimestamp(work.firstSeenAt, { includeYear: true }),
    ]),
  ];
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
};

export const triggerDownload = (contents: string, filename: string, mimeType: string): boolean => {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
};

export const confidenceLabel = (confidence: WorkAnalysis["confidence"]): string => {
  if (confidence === "high") return "高置信";
  if (confidence === "medium") return "中置信";
  return "样本不足";
};
