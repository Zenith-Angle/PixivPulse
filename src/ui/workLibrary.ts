import type { IntradayWorkAnalysis } from "../domain/intraday";
import type { WorkAnalysis, WorkMetrics } from "../domain/types";
import { metricValue } from "./helpers";

export const WORK_SORT_OPTIONS = [
  { value: "publishedAt", label: "发布时间" },
  { value: "views", label: "浏览总量" },
  { value: "bookmarks", label: "收藏总量" },
  { value: "likes", label: "赞总量" },
  { value: "todayViews", label: "今日浏览" },
  { value: "todayBookmarks", label: "今日收藏" },
  { value: "todayLikes", label: "今日赞" },
  { value: "todayComments", label: "今日评论" },
  { value: "lastSeenAt", label: "最近观察" },
  { value: "title", label: "作品标题" },
] as const;

export type WorkSortKey = (typeof WORK_SORT_OPTIONS)[number]["value"];
export type WorkSortDirection = "asc" | "desc";
export interface WorkSort {
  key: WorkSortKey;
  direction: WorkSortDirection;
}

export const DEFAULT_WORK_SORT: WorkSort = { key: "publishedAt", direction: "desc" };

const TODAY_METRIC_KEYS: Partial<Record<WorkSortKey, keyof WorkMetrics>> = {
  todayViews: "views",
  todayBookmarks: "bookmarks",
  todayLikes: "likes",
  todayComments: "comments",
};

const asFiniteNumber = (value: number | null | undefined): number | null => value !== null && value !== undefined && Number.isFinite(value) ? value : null;

const asTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const compareNumbers = (left: number | null, right: number | null, direction: WorkSortDirection): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
};

const compareDates = (left: number | null, right: number | null, direction: WorkSortDirection): number => compareNumbers(left, right, direction);

const comparePublishedAt = (left: WorkAnalysis, right: WorkAnalysis): number => compareDates(
  asTimestamp(left.work.publishedAt),
  asTimestamp(right.work.publishedAt),
  "desc",
);

const compareKeys = (left: WorkAnalysis, right: WorkAnalysis): number => left.work.key.localeCompare(right.work.key, "en", { numeric: true, sensitivity: "base" });

const todayValue = (
  analysis: WorkAnalysis,
  key: WorkSortKey,
  intradayByWork?: ReadonlyMap<string, IntradayWorkAnalysis>,
): number | null => {
  const metric = TODAY_METRIC_KEYS[key];
  return metric ? asFiniteNumber(intradayByWork?.get(analysis.work.key)?.delta[metric]) : null;
};

const primaryValue = (
  analysis: WorkAnalysis,
  key: WorkSortKey,
  intradayByWork?: ReadonlyMap<string, IntradayWorkAnalysis>,
): number | string | null => {
  switch (key) {
    case "publishedAt": return asTimestamp(analysis.work.publishedAt);
    case "views": return asFiniteNumber(metricValue(analysis, "views"));
    case "bookmarks": return asFiniteNumber(metricValue(analysis, "bookmarks"));
    case "likes": return asFiniteNumber(metricValue(analysis, "likes"));
    case "todayViews":
    case "todayBookmarks":
    case "todayLikes":
    case "todayComments": return todayValue(analysis, key, intradayByWork);
    case "lastSeenAt": return asTimestamp(analysis.work.lastSeenAt);
    case "title": return analysis.work.title.trim();
  }
};

export const compareWorkAnalyses = (
  left: WorkAnalysis,
  right: WorkAnalysis,
  sort: WorkSort,
  intradayByWork?: ReadonlyMap<string, IntradayWorkAnalysis>,
): number => {
  const leftValue = primaryValue(left, sort.key, intradayByWork);
  const rightValue = primaryValue(right, sort.key, intradayByWork);
  let primaryComparison: number;
  if (typeof leftValue === "string" && typeof rightValue === "string") {
    const lexical = leftValue.localeCompare(rightValue, "zh-CN", { sensitivity: "base", numeric: true });
    primaryComparison = sort.direction === "asc" ? lexical : -lexical;
  } else if (typeof leftValue === "number" || typeof rightValue === "number") {
    primaryComparison = compareNumbers(
      typeof leftValue === "number" ? leftValue : null,
      typeof rightValue === "number" ? rightValue : null,
      sort.direction,
    );
  } else {
    primaryComparison = 0;
  }
  if (primaryComparison !== 0) return primaryComparison;

  const publishedComparison = comparePublishedAt(left, right);
  return publishedComparison !== 0 ? publishedComparison : compareKeys(left, right);
};

export const sortWorkAnalyses = (
  analyses: readonly WorkAnalysis[],
  sort: WorkSort = DEFAULT_WORK_SORT,
  intradayByWork?: ReadonlyMap<string, IntradayWorkAnalysis>,
): WorkAnalysis[] => [...analyses].sort((left, right) => compareWorkAnalyses(left, right, sort, intradayByWork));
