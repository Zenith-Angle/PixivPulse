import type {
  AppSettings,
  DashboardData,
  WorkMetrics,
  WorkObservation,
  WorkRecord,
  WorkSample,
  SyncRun,
  SyncState,
} from "../domain/types";
import type { AccountFollowerSample } from "./followerAnalytics";

type DemoDashboardData = DashboardData & { accountFollowerSamples?: AccountFollowerSample[] };

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const metric = (values: Partial<WorkMetrics>): WorkMetrics => ({
  likes: values.likes ?? null,
  bookmarks: values.bookmarks ?? null,
  views: values.views ?? null,
  comments: values.comments ?? null,
  rank: values.rank ?? null,
  responses: values.responses ?? null,
  illustrations: values.illustrations ?? null,
});

const baseWork = (
  key: string,
  id: string,
  title: string,
  type: WorkRecord["type"],
  values: Partial<WorkMetrics>,
  firstSeenHours: number,
  lastSeenHours: number,
  thumbnailUrl: string | null,
): WorkRecord => ({
  key,
  id,
  type,
  title,
  seriesTitle: null,
  publishedAt: hoursAgo(firstSeenHours + 72),
  wordCount: type === "novel" ? 6800 : null,
  pageCount: type === "illust" ? 1 : null,
  isAi: false,
  isR18: false,
  thumbnailUrl,
  workUrl: "https://www.pixiv.net/",
  metrics: metric(values),
  rawLabels: {},
  missingFields: [],
  parserVersion: 1,
  firstSeenAt: hoursAgo(firstSeenHours),
  lastSeenAt: hoursAgo(lastSeenHours),
  lastObservedRunId: "demo-run-latest",
  absentSince: null,
});

const demoWorks: WorkRecord[] = [
  baseWork(
    "illust-10001",
    "10001",
    "星海列车・终点站",
    "illust",
    { likes: 12640, bookmarks: 1820, views: 98760, comments: 214, rank: 4, illustrations: 1 },
    1540,
    3.4,
    "https://i.pximg.net/c/250x250_80_a2_g5/img-master/img/2025/01/01/00/00/00/10001_p0_square1200.jpg",
  ),
  baseWork(
    "novel-10002",
    "10002",
    "雨后的第七码头",
    "novel",
    { likes: 6980, bookmarks: 1120, views: 45210, comments: 68, responses: 34 },
    930,
    18.4,
    "https://i.pximg.net/c/250x250_80_a2_g5/img-master/img/2025/02/02/00/00/00/10002_p0_square1200.jpg",
  ),
  baseWork(
    "illust-10003",
    "10003",
    "夜航日志 / 08",
    "illust",
    { likes: 3420, bookmarks: 406, views: 23680, comments: 41, rank: 28, illustrations: 1 },
    344,
    42,
    null,
  ),
  baseWork(
    "novel-10004",
    "10004",
    "玻璃花房的信",
    "novel",
    { likes: 1710, bookmarks: 388, views: 16980, comments: 19, responses: 12 },
    2100,
    4.8,
    "https://i.pximg.net/c/250x250_80_a2_g5/img-master/img/2025/03/03/00/00/00/10004_p0_square1200.jpg",
  ),
];

const sample = (
  workKey: string,
  runId: string,
  collectedAt: string,
  values: Partial<WorkMetrics>,
  kind: WorkSample["kind"] = "change",
): WorkSample => ({
  workKey,
  runId,
  collectedAt,
  metrics: metric(values),
  parserVersion: 1,
  dataQuality: 0.99,
  kind,
});

const demoSamples: WorkSample[] = [
  sample("illust-10001", "demo-run-oldest", hoursAgo(1540), { likes: 11150, bookmarks: 1470, views: 79800, comments: 174, rank: 9, illustrations: 1 }),
  sample("illust-10001", "demo-run-mid", hoursAgo(420), { likes: 12030, bookmarks: 1684, views: 92300, comments: 201, rank: 6, illustrations: 1 }),
  sample("illust-10001", "demo-run-latest", hoursAgo(3.4), { likes: 12640, bookmarks: 1820, views: 98760, comments: 214, rank: 4, illustrations: 1 }),
  sample("novel-10002", "demo-run-oldest", hoursAgo(930), { likes: 6420, bookmarks: 994, views: 41320, comments: 55, responses: 27 }),
  sample("novel-10002", "demo-run-latest", hoursAgo(18.4), { likes: 6980, bookmarks: 1120, views: 45210, comments: 68, responses: 34 }),
  sample("illust-10003", "demo-run-only", hoursAgo(42), { likes: 3420, bookmarks: 406, views: 23680, comments: 41, rank: 28, illustrations: 1 }),
  sample("novel-10004", "demo-run-oldest", hoursAgo(2100), { likes: 1202, bookmarks: 226, views: 10400, comments: 10, responses: 5 }),
  sample("novel-10004", "demo-run-mid", hoursAgo(180), { likes: 1580, bookmarks: 340, views: 14980, comments: 16, responses: 10 }),
  sample("novel-10004", "demo-run-latest", hoursAgo(4.8), { likes: 1710, bookmarks: 388, views: 16980, comments: 19, responses: 12 }),
];

const demoFollowerSamples: AccountFollowerSample[] = [
  { runId: "demo-followers-oldest", accountId: "DEMO-ACCOUNT", collectedAt: hoursAgo(76), followers: 128400 },
  { runId: "demo-followers-baseline", accountId: "DEMO-ACCOUNT", collectedAt: hoursAgo(26), followers: 129120 },
  { runId: "demo-followers-mid", accountId: "DEMO-ACCOUNT", collectedAt: hoursAgo(17), followers: 129530 },
  { runId: "demo-followers-latest", accountId: "DEMO-ACCOUNT", collectedAt: hoursAgo(3.4), followers: 130240 },
];

const demoObservations: WorkObservation[] = demoSamples.map((item, index) => ({
  id: index + 1,
  workKey: item.workKey,
  runId: item.runId,
  observedAt: item.collectedAt,
  metricsChanged: index % 3 !== 1,
}));

const demoRuns: SyncRun[] = [
  {
    runId: "demo-run-latest",
    trigger: "manual",
    startedAt: hoursAgo(3.6),
    finishedAt: hoursAgo(3.4),
    status: "completed",
    pages: 2,
    works: 4,
    changedWorks: 3,
    errorCode: null,
    errorMessage: null,
  },
  {
    runId: "demo-run-mid",
    trigger: "scheduled",
    startedAt: hoursAgo(18.8),
    finishedAt: hoursAgo(18.4),
    status: "completed",
    pages: 2,
    works: 4,
    changedWorks: 3,
    errorCode: null,
    errorMessage: null,
  },
  {
    runId: "demo-run-failed",
    trigger: "scheduled",
    startedAt: hoursAgo(44),
    finishedAt: hoursAgo(43.9),
    status: "failed",
    pages: 1,
    works: 0,
    changedWorks: 0,
    errorCode: "PAGE_TIMEOUT",
    errorMessage: "第 2 页未在时限内返回，已保留上一次成功快照。",
  },
];

const demoSettings: AppSettings = {
  onboardingComplete: true,
  scheduledSyncEnabled: true,
  syncIntervalHours: 24,
  showPixivChips: false,
  theme: "light",
  lastCompactedAt: hoursAgo(72),
  storageWarningBytes: 25 * 1024 * 1024,
  boundAccount: {
    id: "DEMO-ACCOUNT",
    name: "星野编辑部",
    profileUrl: "https://www.pixiv.net/",
  },
};

const demoSyncState: SyncState = {
  runId: "demo-run-latest",
  status: "completed",
  trigger: "manual",
  ownedTabId: null,
  expectedPage: 2,
  expectedPageCount: 2,
  expectedUrl: "https://www.pixiv.net/users/0/works",
  seenFingerprints: ["demo-page-1", "demo-page-2"],
  seenWorkIds: demoWorks.map((work) => work.id),
  firstPageFingerprint: "demo-page-1",
  retryCount: 0,
  mutationRetryCount: 0,
  leaseExpiresAt: Date.now() + 60_000,
  deadlineAt: Date.now() + 60_000,
  startedAt: hoursAgo(3.6),
  updatedAt: hoursAgo(3.4),
  errorCode: null,
  errorMessage: null,
};

export const createDemoData = (): DashboardData => {
  const data: DemoDashboardData = {
    works: demoWorks.map((work) => ({
      ...work,
      metrics: { ...work.metrics },
      rawLabels: { ...work.rawLabels },
      missingFields: [...work.missingFields],
    })),
    samples: demoSamples.map((sampleItem) => ({ ...sampleItem, metrics: { ...sampleItem.metrics } })),
    observations: demoObservations.map((observation) => ({ ...observation })),
    observationBatches: [],
    runs: demoRuns.map((run) => ({ ...run })),
    coverCache: { ready: 0, failed: 0, skipped: 0, pending: demoWorks.length, bytes: 0, total: demoWorks.length },
    settings: { ...demoSettings },
    syncState: {
      ...demoSyncState,
      seenFingerprints: [...demoSyncState.seenFingerprints],
      seenWorkIds: [...demoSyncState.seenWorkIds],
    },
    accountFollowerSamples: demoFollowerSamples.map((sampleItem) => ({ ...sampleItem })),
  };
  return data;
};

export const createEmptyDashboardData = (): DashboardData => {
  const data: DemoDashboardData = {
    works: [],
    samples: [],
    observations: [],
    observationBatches: [],
    runs: [],
    coverCache: { ready: 0, failed: 0, skipped: 0, pending: 0, bytes: 0, total: 0 },
    settings: {
      onboardingComplete: false,
      scheduledSyncEnabled: true,
      syncIntervalHours: 1,
      showPixivChips: false,
      theme: "system",
      lastCompactedAt: null,
      storageWarningBytes: 25 * 1024 * 1024,
      boundAccount: null,
    },
    syncState: null,
    accountFollowerSamples: [],
  };
  return data;
};
