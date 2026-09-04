import { describe, expect, it } from "vitest";
import type { IntradayWorkAnalysis } from "../domain/intraday";
import type { DashboardData, WorkAnalysis, WorkMetrics } from "../domain/types";
import { analyzeDashboard } from "./helpers";
import {
  DEFAULT_WORK_SORT,
  WORK_SORT_OPTIONS,
  sortWorkAnalyses,
  type WorkSort,
} from "./workLibrary";

const metric = (values: Partial<WorkMetrics>): WorkMetrics => ({
  likes: values.likes ?? null,
  bookmarks: values.bookmarks ?? null,
  views: values.views ?? null,
  comments: values.comments ?? null,
  rank: values.rank ?? null,
  responses: values.responses ?? null,
  illustrations: values.illustrations ?? null,
});

const sourceWork = (key: string, title: string, publishedAt: string | null, values: Partial<WorkMetrics>) => ({
  key,
  id: key,
  type: "illust" as const,
  title,
  seriesTitle: null,
  publishedAt,
  wordCount: null,
  pageCount: 1,
  isAi: false,
  isR18: false,
  thumbnailUrl: null,
  workUrl: `https://www.pixiv.net/artworks/${key}`,
  metrics: metric(values),
  rawLabels: {},
  missingFields: [],
  parserVersion: 1,
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-31T00:00:00.000Z",
  lastObservedRunId: "run",
  absentSince: null,
});

const makeAnalyses = (...works: ReturnType<typeof sourceWork>[]): WorkAnalysis[] => {
  const data: DashboardData = {
    works,
    samples: [],
    observations: [],
    runs: [],
    settings: {
      onboardingComplete: true,
      scheduledSyncEnabled: false,
      syncIntervalHours: 1,
      showPixivChips: false,
      theme: "light",
      lastCompactedAt: null,
      storageWarningBytes: 1,
    },
    syncState: null,
  };
  return analyzeDashboard(data);
};

const intraday = (workKey: string, values: Partial<WorkMetrics>): IntradayWorkAnalysis => ({
  workKey,
  date: "2026-08-31",
  baselineAt: "2026-08-30T00:00:00.000Z",
  baselineLabel: "partial",
  sampleCount: 2,
  changeSampleCount: 1,
  points: [],
  delta: metric(values),
});

const sort = (key: WorkSort["key"], direction: WorkSort["direction"]): WorkSort => ({ key, direction });

describe("work library sorting", () => {
  it("defaults to newest published work first", () => {
    const analyses = makeAnalyses(
      sourceWork("older", "旧作", "2026-08-20T00:00:00.000Z", { views: 20 }),
      sourceWork("newer", "新作", "2026-08-31T00:00:00.000Z", { views: 10 }),
    );

    expect(sortWorkAnalyses(analyses, DEFAULT_WORK_SORT).map((item) => item.work.key)).toEqual(["newer", "older"]);
  });

  it("sorts total and today metrics by quantity", () => {
    const analyses = makeAnalyses(
      sourceWork("a", "A", "2026-08-30T00:00:00.000Z", { views: 100, bookmarks: 80, likes: 10 }),
      sourceWork("b", "B", "2026-08-29T00:00:00.000Z", { views: 100, bookmarks: 20, likes: 90 }),
    );
    const today = new Map([
      ["a", intraday("a", { views: 4, bookmarks: 2, likes: 9, comments: 1 })],
      ["b", intraday("b", { views: 8, bookmarks: 7, likes: 3, comments: 6 })],
    ]);

    expect(sortWorkAnalyses(analyses, sort("bookmarks", "desc"), today).map((item) => item.work.key)).toEqual(["a", "b"]);
    expect(sortWorkAnalyses(analyses, sort("likes", "asc"), today).map((item) => item.work.key)).toEqual(["a", "b"]);
    expect(sortWorkAnalyses(analyses, sort("todayViews", "desc"), today).map((item) => item.work.key)).toEqual(["b", "a"]);
    expect(sortWorkAnalyses(analyses, sort("todayBookmarks", "asc"), today).map((item) => item.work.key)).toEqual(["a", "b"]);
    expect(sortWorkAnalyses(analyses, sort("todayLikes", "desc"), today).map((item) => item.work.key)).toEqual(["a", "b"]);
    expect(sortWorkAnalyses(analyses, sort("todayComments", "asc"), today).map((item) => item.work.key)).toEqual(["a", "b"]);
  });

  it("keeps missing or invalid dates at the bottom in either direction", () => {
    const analyses = makeAnalyses(
      sourceWork("invalid", "非法日期", "not-a-date", { views: 20 }),
      sourceWork("missing", "缺失日期", null, { views: 30 }),
      sourceWork("valid", "有效日期", "2026-08-31T00:00:00.000Z", { views: 10 }),
    );

    expect(sortWorkAnalyses(analyses, sort("publishedAt", "desc")).map((item) => item.work.key)).toEqual(["valid", "invalid", "missing"]);
    expect(sortWorkAnalyses(analyses, sort("publishedAt", "asc")).map((item) => item.work.key)).toEqual(["valid", "invalid", "missing"]);
  });

  it("uses published time then work key as a stable tie breaker", () => {
    const analyses = makeAnalyses(
      sourceWork("z-key", "同值 Z", "2026-08-20T00:00:00.000Z", { views: 10 }),
      sourceWork("a-key", "同值 A", "2026-08-31T00:00:00.000Z", { views: 10 }),
      sourceWork("b-key", "同日 B", "2026-08-31T00:00:00.000Z", { views: 10 }),
    );

    expect(sortWorkAnalyses(analyses, sort("views", "desc")).map((item) => item.work.key)).toEqual(["a-key", "b-key", "z-key"]);
  });

  it("applies both title sort directions", () => {
    const analyses = makeAnalyses(
      sourceWork("a", "A 作品", "2026-08-30T00:00:00.000Z", {}),
      sourceWork("b", "B 作品", "2026-08-29T00:00:00.000Z", {}),
    );

    expect(sortWorkAnalyses(analyses, sort("title", "asc")).map((item) => item.work.key)).toEqual(["a", "b"]);
    expect(sortWorkAnalyses(analyses, sort("title", "desc")).map((item) => item.work.key)).toEqual(["b", "a"]);
  });

  it("exposes the requested sort keys", () => {
    expect(WORK_SORT_OPTIONS.map((option) => option.value)).toEqual([
      "publishedAt",
      "views",
      "bookmarks",
      "likes",
      "todayViews",
      "todayBookmarks",
      "todayLikes",
      "todayComments",
      "lastSeenAt",
      "title",
    ]);
  });
});
