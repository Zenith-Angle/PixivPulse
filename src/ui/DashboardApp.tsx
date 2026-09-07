import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Gauge,
  Grid2X2,
  Heart,
  Home,
  Image as ImageIcon,
  Info,
  LayoutDashboard,
  List,
  ListFilter,
  Menu,
  MessageCircle,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import { buildIntradayAnalytics } from "../domain/intraday";
import { COVER_CACHE_PIPELINE_VERSION } from "../domain/constants";
import type { IntradayPortfolioAnalysis, IntradayWorkAnalysis } from "../domain/intraday";
import { buildPortfolioTimeline, buildWorkTimeline, type PortfolioTimelinePoint, type WorkTimelinePoint } from "../domain/timeline";
import { beijingExportDate, BUSINESS_TIME_ZONE_LABEL, nextBeijingMidnight } from "../domain/time";
import type {
  CoverCacheSummary,
  DashboardData,
  PixivAccount,
  SyncRun,
  WorkContentType,
  WorkAnalysis,
  WorkMetrics,
  WorkSample,
} from "../domain/types";
import type { MaintenanceResult } from "../domain/messages";
import type { StorageCenterInfo } from "../domain/messages";
import { canonicalJson, decodePortableBytes } from "../data/portable-backup";
import { parsePortableBackupDocument, portableBackupToCsv } from "../data/portable-backup-csv";
import { createNativePortableBackup, type PortableDocumentPreview } from "../data/portable-native";
import { buildPortableImportPlan, type PortableImportPlan } from "../data/import-planner";
import { commitStagedPortableImport, discardStagedPortableImport, stagePortableImport } from "../data/portable-import";
import { chooseBackupDirectory } from "../data/backup-directory";
import { getCurrentCover } from "../data/repository";
import {
  analyzeDashboard,
  contentTypeForWork,
  contentTypeLabel,
  confidenceLabel,
  elapsedHours,
  formatCount,
  formatDelta,
  formatElapsed,
  formatPercent,
  formatTimestamp,
  METRIC_LABELS,
  metricValue,
  samplesForWork,
  triggerDownload,
} from "./helpers";
import { EChartsHost } from "./EChartsHost";
import { AnimatedNumber } from "./AnimatedNumber";
import { StorageCenter, type StorageCenterModel } from "./StorageCenter";
import { ImportPreviewModal } from "./ImportPreviewModal";
import { DataTransferSection } from "./DataTransferSection";
import {
  DASHBOARD_CHART_METRICS,
  DASHBOARD_CHART_METRIC_LABELS,
  buildAbsoluteCompareChartOption,
  buildFollowerChartOption,
  buildGrowthChartOption,
  buildPortfolioChartOption,
  type AbsoluteChartSeriesInput,
  type ChartTimePoint,
  type CompareValueMode,
  type DashboardChartMetric,
} from "./chartOptions";
import { resolveChartTimeRange, type ChartTimeRange, type ChartTimeRangePreset } from "./chartTimeRange";
import { buildCompareBuckets, compareBucketLayout, compareBucketLabel } from "./compareBuckets";
import { buildFollowerAnalytics, type AccountFollowerSample } from "./followerAnalytics";
import {
  buildRankingEntries,
  rankingEntryForAnalysis,
  rankingHistoryForAnalysis,
  rankingHistoryForWork,
  rankingMovementLabel,
  rankingSourceLabel,
  rankingStatusLabel,
  type RankingEntry,
  type RankingObservation,
} from "./rankings";
import { useDashboardData, syncStatusLabel } from "./useDashboardData";
import type { DashboardDataRequest } from "./dashboardDataRequest";
import {
  DEFAULT_WORK_SORT,
  WORK_SORT_OPTIONS,
  sortWorkAnalyses,
  type WorkSort,
  type WorkSortKey,
} from "./workLibrary";

export type DashboardTab = "overview" | "works" | "compare" | "settings";

const TAB_LABELS: Record<DashboardTab, string> = {
  overview: "总览",
  works: "作品",
  compare: "比较",
  settings: "数据与设置",
};

const cn = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

const LEGACY_ONBOARDING_KEY = "pixivpulse:onboarding-seen";
const WORKS_VIEW_MODE_KEY = "pixivpulse:works-view-mode";

type WorksViewMode = "grid" | "list";

const readWorksViewMode = (): WorksViewMode => {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(WORKS_VIEW_MODE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
};

const saveWorksViewMode = (mode: WorksViewMode): void => {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(WORKS_VIEW_MODE_KEY, mode); } catch { /* storage can be unavailable in fixtures */ }
};

const runTimestamp = (run: SyncRun): number => {
  const value = Date.parse(run.finishedAt ?? run.startedAt);
  return Number.isFinite(value) ? value : 0;
};

const latestCompletedRun = (runs: SyncRun[]): SyncRun | null => runs
  .filter((run) => run.status === "completed")
  .slice()
  .sort((left, right) => runTimestamp(right) - runTimestamp(left))[0] ?? null;

const readLegacyOnboardingSeen = (): boolean => {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(LEGACY_ONBOARDING_KEY) === "1"; } catch { return false; }
};

const markLegacyOnboardingSeen = (): void => {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LEGACY_ONBOARDING_KEY, "1"); } catch { /* storage can be unavailable in fixtures */ }
};

const clearLegacyOnboardingSeen = (): void => {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(LEGACY_ONBOARDING_KEY); } catch { /* storage can be unavailable in fixtures */ }
};

const currentMetrics = (analysis: WorkAnalysis): WorkMetrics => analysis.latestSample?.metrics ?? analysis.work.metrics;

const sumMetric = (analyses: WorkAnalysis[], key: keyof WorkMetrics): number =>
  analyses.reduce((total, analysis) => total + (metricValue(analysis, key) ?? 0), 0);

const statusFor = (analysis: WorkAnalysis): "history" | "baseline" | "updated" => {
  if (!analysis.previousSample) return "baseline";
  return (analysis.lastDelta.views.value ?? 0) > 0 ? "updated" : "history";
};

const workConfidence = (analysis: WorkAnalysis): string => confidenceLabel(analysis.confidence);

const useBeijingDateRevision = (): number => {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const arm = (): void => {
      const now = Date.now();
      const midnight = nextBeijingMidnight(now);
      timer = window.setTimeout(() => {
        setRevision((current) => current + 1);
        arm();
      }, midnight == null ? 60_000 : Math.max(50, midnight - now + 50));
    };
    arm();
    return () => window.clearTimeout(timer);
  }, []);
  return revision;
};

const baselineLabel = (label: IntradayPortfolioAnalysis["baselineLabel"]): string => label === "estimated" ? "今日首测基线 · 接近日界" : "今日首测基线 · 部分日";

const todayDelta = (analysis: IntradayWorkAnalysis | null | undefined, key: keyof WorkMetrics): number | null => analysis?.delta[key] ?? null;

const accountLabel = (account: PixivAccount | null | undefined): string => account?.name?.trim() || "尚未绑定账号";

type DashboardFollowerData = DashboardData & { accountFollowerSamples?: AccountFollowerSample[] };

const accountFollowerSamplesFor = (data: DashboardData): AccountFollowerSample[] => {
  const samples = (data as DashboardFollowerData).accountFollowerSamples;
  return Array.isArray(samples) ? samples : [];
};

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn("icon-button", className)}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

type CoverViewState = "loading" | "ready" | "failed" | "skipped-capacity" | "unavailable";

type CoverAwareWork = WorkAnalysis["work"] & {
  /** Optional fields accepted from newer dashboard snapshots. */
  coverPipelineVersion?: unknown;
  pipelineVersion?: unknown;
};

const coverPipelineVersionFor = (work: WorkAnalysis["work"]): number => {
  const candidate = work as CoverAwareWork;
  const value = candidate.coverPipelineVersion ?? candidate.pipelineVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : COVER_CACHE_PIPELINE_VERSION;
};

export const coverRevisionForWork = (work: WorkAnalysis["work"]): string => {
  const pipelineVersion = coverPipelineVersionFor(work);
  return `${work.key}\u0000${work.thumbnailUrl ?? ""}\u0000${pipelineVersion}`;
};

const coverRefreshSignalFor = (coverCache: CoverCacheSummary | undefined): string => coverCache
  ? `${coverCache.ready}:${coverCache.failed}:${coverCache.skipped}:${coverCache.pending}`
  : "";

const revokeObjectUrl = (objectUrlRef: { current: string | null }): void => {
  const objectUrl = objectUrlRef.current;
  objectUrlRef.current = null;
  if (objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
};

function Thumbnail({ work, className, cacheRevision = "", cacheRefreshSignal = "" }: { work: WorkAnalysis["work"]; className?: string; cacheRevision?: string; cacheRefreshSignal?: string }) {
  const isExtension = typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";
  const workKey = work.key;
  const sourceUrl = work.thumbnailUrl;
  const pipelineVersion = coverPipelineVersionFor(work);
  const stableCacheRevision = cacheRevision || coverRevisionForWork(work);
  const [cover, setCover] = useState<{ url: string | null; state: CoverViewState }>(() => ({
    url: isExtension ? null : sourceUrl,
    state: sourceUrl ? (isExtension ? "loading" : "ready") : "unavailable",
  }));
  const coverRef = useRef(cover);
  coverRef.current = cover;
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const cacheRefreshSignalRef = useRef(cacheRefreshSignal);
  cacheRefreshSignalRef.current = cacheRefreshSignal;
  const previousCacheRefreshSignalRef = useRef(cacheRefreshSignal);

  const loadCover = useMemo(() => () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    revokeObjectUrl(objectUrlRef);
    if (!isExtension) {
      setCover({ url: sourceUrl, state: sourceUrl ? "ready" : "unavailable" });
      return;
    }
    if (!sourceUrl) {
      setCover({ url: null, state: "unavailable" });
      return;
    }
    setCover({ url: null, state: "loading" });
    inFlightRef.current = true;
    const requestCacheRefreshSignal = cacheRefreshSignalRef.current;
    void getCurrentCover(workKey, sourceUrl)
      .then((record) => {
        if (requestIdRef.current !== requestId) return;
        inFlightRef.current = false;
        const pipelineMatches = record == null || record.pipelineVersion === undefined || record.pipelineVersion === pipelineVersion;
        if (pipelineMatches && record?.status === "ready" && record.blob && typeof URL.createObjectURL === "function") {
          const objectUrl = URL.createObjectURL(record.blob);
          objectUrlRef.current = objectUrl;
          setCover({ url: objectUrl, state: "ready" });
          return;
        }
        setCover({ url: null, state: pipelineMatches ? record?.status ?? "loading" : "loading" });
        if (cacheRefreshSignalRef.current !== requestCacheRefreshSignal) void loadCover();
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        inFlightRef.current = false;
        setCover({ url: null, state: "failed" });
        if (cacheRefreshSignalRef.current !== requestCacheRefreshSignal) void loadCover();
      });
  }, [isExtension, pipelineVersion, sourceUrl, workKey]);

  useEffect(() => {
    void loadCover();
    return () => {
      requestIdRef.current += 1;
      revokeObjectUrl(objectUrlRef);
    };
  }, [isExtension, loadCover, pipelineVersion, sourceUrl, stableCacheRevision, workKey]);

  useEffect(() => {
    if (cacheRefreshSignal === previousCacheRefreshSignalRef.current) return;
    previousCacheRefreshSignalRef.current = cacheRefreshSignal;
    const current = coverRef.current;
    if (!isExtension || inFlightRef.current || (current.state === "ready" && current.url)) return;
    void loadCover();
  }, [cacheRefreshSignal, isExtension, loadCover]);

  if (!cover.url || cover.state !== "ready") {
    const statusText = cover.state === "failed"
      ? "封面获取失败，下次同步重试"
      : cover.state === "skipped-capacity"
        ? "封面缓存空间已满"
        : cover.state === "unavailable" ? "作品没有可用封面" : "封面正在本地处理";
    return (
      <span className={cn("thumbnail", "thumbnail-placeholder", className)} aria-label={statusText}>
        {contentTypeForWork(work) === "novel" ? <FileText size={17} aria-hidden="true" /> : <ImageIcon size={17} aria-hidden="true" />}
        <small>{statusText}</small>
      </span>
    );
  }
  return (
    <span className={cn("thumbnail", className)}>
      <img
        src={cover.url}
        alt={`${work.title} 封面`}
        loading="lazy"
        onError={() => setCover({ url: null, state: "failed" })}
      />
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: WorkAnalysis["confidence"] }) {
  const tone = confidence === "high" ? "success" : confidence === "medium" ? "neutral" : "warning";
  return <span className={cn("confidence-badge", tone)}>{confidenceLabel(confidence)}</span>;
}

function Sparkline({ analysis }: { analysis: WorkAnalysis }) {
  const pointsWithTime = analysis.sparkline.flatMap((point) => {
    const timestamp = Date.parse(point.at);
    return point.views === null || !Number.isFinite(timestamp) ? [] : [{ timestamp, value: point.views }];
  }).sort((left, right) => left.timestamp - right.timestamp);
  if (pointsWithTime.length < 2) return <span className="sparkline-empty">—</span>;
  const width = 84;
  const height = 30;
  const values = pointsWithTime.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const firstAt = pointsWithTime[0]?.timestamp ?? 0;
  const lastAt = pointsWithTime.at(-1)?.timestamp ?? firstAt;
  const elapsed = Math.max(1, lastAt - firstAt);
  const points = pointsWithTime.map(({ timestamp, value }) => {
    const x = ((timestamp - firstAt) / elapsed) * (width - 4) + 2;
    const y = height - 3 - ((value - min) / range) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = values[0] ?? null;
  const last = values.at(-1) ?? null;
  const label = `浏览绝对值 ${formatCount(first)} 到 ${formatCount(last)}`;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}，横轴按真实采样时间间隔</title>
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <div className="empty-icon">{icon ?? <CircleDashed size={22} aria-hidden="true" />}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function Sidebar({ activeTab, onChange, onOpenOnboarding }: { activeTab: DashboardTab; onChange: (tab: DashboardTab) => void; onOpenOnboarding: () => void }) {
  const [open, setOpen] = useState(false);
  const items: Array<{ key: DashboardTab; icon: ReactNode; hint: string }> = [
    { key: "overview", icon: <LayoutDashboard size={17} aria-hidden="true" />, hint: "作品集动量、洞察和上升作品" },
    { key: "works", icon: <ImageIcon size={17} aria-hidden="true" />, hint: "按作品查看真实采样变化" },
    { key: "compare", icon: <BarChart3 size={17} aria-hidden="true" />, hint: "把两件作品的绝对值放在同一时间轴" },
    { key: "settings", icon: <Settings size={17} aria-hidden="true" />, hint: "同步、导出和隐私限制" },
  ];
  return (
    <aside className={cn("sidebar", open && "sidebar-open")}>
      <div className="sidebar-topline">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); onChange("overview"); setOpen(false); }} aria-label="PixivPulse 总览">
          <img className="brand-mark" src="/icon/48.png" alt="" aria-hidden="true" draggable={false} />
          <span className="brand-copy"><strong>PixivPulse</strong><small>作者增长追踪</small></span>
        </a>
        <IconButton label={open ? "关闭导航" : "打开导航"} className="mobile-menu-button" onClick={() => setOpen((current) => !current)}>
          {open ? <X size={19} /> : <Menu size={19} />}
        </IconButton>
      </div>
      <nav className="primary-nav" aria-label="主导航">
        <p className="nav-label">看板</p>
        {items.map((item) => (
          <button
            type="button"
            key={item.key}
            className={cn("nav-item", activeTab === item.key && "active")}
            aria-current={activeTab === item.key ? "page" : undefined}
            title={item.hint}
            onClick={() => { onChange(item.key); setOpen(false); }}
          >
            {item.icon}<span>{TAB_LABELS[item.key]}</span>{activeTab === item.key && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="local-badge"><span className="status-dot" />数据保存在本机</div>
        <button type="button" className="help-link" onClick={onOpenOnboarding} title="重新查看首次使用说明"><Info size={15} aria-hidden="true" />使用说明</button>
        <p className="version-label">PixivPulse 0.4.19 · 本地优先</p>
      </div>
    </aside>
  );
}

function AccountIdentity({ account, compact = false }: { account: PixivAccount | null | undefined; compact?: boolean }) {
  const name = accountLabel(account);
  const initials = name === "尚未绑定账号" ? "?" : name.slice(0, 1).toUpperCase();
  return (
    <div className={cn("account-identity", compact && "compact")}>
      <span className="account-avatar" aria-hidden="true">{initials}</span>
      <span className="account-copy"><strong>{name}</strong><small>{account ? `Pixiv ID ${account.id}` : "等待第一次同步绑定当前账号"}</small></span>
      {account?.profileUrl && <a href={account.profileUrl} target="_blank" rel="noreferrer" className="account-link" aria-label={`打开 ${name} 的 Pixiv 主页`} title="打开 Pixiv 主页"><ExternalLink size={13} aria-hidden="true" /></a>}
    </div>
  );
}

function StatusToast({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="status-toast" role="status" aria-live="polite"><CheckCircle2 size={17} aria-hidden="true" /><span>{message}</span><IconButton label="关闭提示" onClick={onClose}><X size={16} /></IconButton></div>;
}

function SyncStatus({ data, isSyncing, isPreview }: { data: DashboardData; isSyncing: boolean; isPreview: boolean }) {
  if (isPreview && !isSyncing) {
    return <span className="sync-status neutral"><span className="status-dot" />预览就绪</span>;
  }
  const status = data.syncState?.status ?? (isSyncing ? "opening" : undefined);
  const tone = status === "failed" ? "danger" : status === "completed" ? "success" : status && status !== "idle" ? "progress" : "neutral";
  return <span className={cn("sync-status", tone)}><span className="status-dot" />{syncStatusLabel(status)}</span>;
}

function Header({
  activeTab,
  data,
  isPreview,
  isLoading,
  hasLoadedData,
  isSyncing,
  onSync,
}: {
  activeTab: DashboardTab;
  data: DashboardData;
  isPreview: boolean;
  isLoading: boolean;
  hasLoadedData: boolean;
  isSyncing: boolean;
  onSync: () => void;
}) {
  const lastCollected = data.syncState?.updatedAt ?? data.runs.find((run) => run.status === "completed")?.finishedAt;
  return (
    <header className="page-header">
      <div className="page-heading">
        <p className="breadcrumb">PixivPulse <ChevronRight size={14} aria-hidden="true" /> {TAB_LABELS[activeTab]}</p>
        <h1>{TAB_LABELS[activeTab]}</h1>
      </div>
      <div className="header-actions">
        {isPreview && <span className="preview-pill"><Sparkles size={14} aria-hidden="true" />预览数据</span>}
        {isLoading && !isPreview
          ? <span className="header-loading" role="status"><RefreshCw size={15} className="spin" aria-hidden="true" />正在读取本地数据</span>
          : !hasLoadedData && !isPreview
            ? <span className="header-loading error" role="status"><AlertTriangle size={15} aria-hidden="true" />本地数据读取失败</span>
          : <><AccountIdentity account={data.settings.boundAccount} compact /><div className="last-sync"><SyncStatus data={data} isSyncing={isSyncing} isPreview={isPreview} /><small>{isPreview ? "仅供界面体验" : lastCollected ? `${formatTimestamp(lastCollected)} · UTC+8` : "尚未同步"}</small></div></>}
        <button type="button" className={cn("primary-button sync-button", isSyncing && "busy")} onClick={onSync} disabled={isSyncing || isLoading || !hasLoadedData}>
          <RefreshCw size={16} className={isSyncing || isLoading ? "spin" : undefined} aria-hidden="true" />{isLoading ? "读取中" : isSyncing ? "同步中" : "开始同步"}
        </button>
      </div>
    </header>
  );
}

function DashboardInitialLoading() {
  return <section className="dashboard-initial-loading" role="status" aria-label="正在读取本地数据"><div className="loading-heading"><RefreshCw size={18} className="spin" aria-hidden="true" /><strong>正在读取本地数据</strong></div><div className="loading-metric-grid" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <span key={index} />)}</div><div className="loading-content-lines" aria-hidden="true"><span /><span /><span /></div></section>;
}

function DashboardInitialError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <section className="dashboard-initial-error" role="alert"><AlertTriangle size={24} aria-hidden="true" /><div><strong>本地数据暂时无法读取</strong><p>{error}</p></div><button type="button" className="secondary-button" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />重新读取</button></section>;
}

interface Insight {
  tone: "cyan" | "coral" | "green" | "amber";
  icon: ReactNode;
  title: string;
  body: string;
  confidence: WorkAnalysis["confidence"];
}

const buildInsights = (analyses: WorkAnalysis[], intraday?: IntradayPortfolioAnalysis): Insight[] => {
  const withHistory = analyses.filter((analysis) => analysis.previousSample);
  if (analyses.length === 0) {
    return [{ tone: "amber", icon: <CircleDashed size={18} />, title: "还没有可分析的样本", body: "第一次同步会建立基线；完成第二次同步后，才会判断增长方向。", confidence: "low" }];
  }
  const intradayEligible = intraday?.works.filter((work) => work.points.length >= 2) ?? [];
  if (intraday && (intraday.sampleCount < 2 || intradayEligible.length === 0)) {
    return [{ tone: "amber", icon: <Clock3 size={18} />, title: "今日样本不足", body: `当前为${baselineLabel(intraday.baselineLabel)}；至少需要两次今天的实际观察，才会生成日内洞察。`, confidence: "low" }];
  }
  if (withHistory.length === 0) {
    return [{ tone: "amber", icon: <Clock3 size={18} />, title: "历史样本不足", body: "当前作品都只有一次观察，暂不推断趋势或转化率变化。", confidence: "low" }];
  }
  const insights: Insight[] = [];
  const fastestToday = intraday ? [...intradayEligible].sort((a, b) => (b.delta.views ?? -Infinity) - (a.delta.views ?? -Infinity))[0] : undefined;
  const fastestHistorical = intraday ? undefined : [...withHistory].sort((a, b) => (b.lastDelta.views.value ?? -Infinity) - (a.lastDelta.views.value ?? -Infinity))[0];
  const fastestAnalysis = fastestToday ? analyses.find((analysis) => analysis.work.key === fastestToday.workKey) : fastestHistorical;
  const fastestDelta = intraday ? fastestToday?.delta.views ?? null : fastestHistorical?.lastDelta.views.value ?? null;
  if ((fastestToday || fastestHistorical) && fastestAnalysis && (fastestDelta ?? 0) > 0) {
    insights.push({
      tone: "coral",
      icon: <TrendingUp size={18} />,
      title: `${fastestAnalysis.work.title} 正在获得浏览`,
      body: intraday ? `今日增加 ${formatCount(fastestDelta)} 浏览，来自 ${fastestToday?.sampleCount ?? 0} 次实际观察。` : `上次有效间隔增加 ${formatCount(fastestDelta)} 浏览，${formatElapsed(fastestAnalysis.lastDelta.views.elapsedHours)}。`,
      confidence: fastestAnalysis.confidence,
    });
  }
  const strongestRate = [...withHistory].sort((a, b) => (b.bookmarkRate ?? 0) - (a.bookmarkRate ?? 0))[0];
  if (strongestRate && strongestRate.bookmarkRate !== null && strongestRate.bookmarkRate >= 0.02) {
    insights.push({
      tone: "green",
      icon: <Heart size={18} />,
      title: `${strongestRate.work.title} 的收藏转化较高`,
      body: `当前收藏 / 浏览为 ${formatPercent(strongestRate.bookmarkRate)}，仅基于已采样作品管理页指标。`,
      confidence: strongestRate.confidence,
    });
  }
  const noChange = intraday
    ? intradayEligible.filter((work) => (work.delta.views ?? 0) === 0).length
    : withHistory.filter((analysis) => (analysis.lastDelta.views.value ?? 0) === 0).length;
  if (noChange > 0) {
    insights.push({
      tone: "cyan",
      icon: <Activity size={18} />,
      title: `${noChange} 件作品在本次间隔暂无浏览变化`,
      body: "这不是失败状态；下一次真实采样会继续保留观察记录。",
      confidence: "medium",
    });
  }
  if (insights.length === 0) {
    insights.push({ tone: "amber", icon: <Clock3 size={18} />, title: "等待更多真实变化", body: "当前样本还不足以生成规则洞察，请完成下一次同步后再看。", confidence: "low" });
  }
  return insights.slice(0, 3);
};

function KpiCard({ label, total, delta, changeLabel, detail, icon, tone = "cyan", animationSignal }: { label: string; total: number | null; delta: number | null; changeLabel: string; detail: string; icon: ReactNode; tone?: "cyan" | "coral" | "green" | "amber"; animationSignal?: unknown }) {
  const totalText = formatCount(total);
  const deltaText = formatDelta(delta);
  return (
    <section className={cn("kpi-card", tone)} aria-label={`${label}，总量 ${totalText}，${changeLabel}变化 ${deltaText}`}>
      <div className="kpi-top"><span>{label}</span><span className="kpi-icon">{icon}</span></div>
      <div className="kpi-value-row">
        <strong className="kpi-total"><AnimatedNumber value={totalText} comparisonValue={total} animationSignal={animationSignal} /></strong>
        <span className={cn("kpi-change", delta !== null && delta > 0 && "positive", delta !== null && delta < 0 && "negative")}><AnimatedNumber value={deltaText} comparisonValue={delta} animationSignal={animationSignal} /></span>
      </div>
      <small><span className="kpi-range-label">{changeLabel}变化</span><span> · {detail}</span></small>
    </section>
  );
}

function MetricSelector({ value, onChange, label, metrics = DASHBOARD_CHART_METRICS }: { value: DashboardChartMetric; onChange: (value: DashboardChartMetric) => void; label: string; metrics?: readonly DashboardChartMetric[] }) {
  return (
    <div className="metric-selector" role="group" aria-label={label}>
      {metrics.map((metric) => (
        <button
          type="button"
          key={metric}
          className={cn("metric-selector-button", value === metric && "active")}
          aria-pressed={value === metric}
          onClick={() => onChange(metric)}
        >
          {DASHBOARD_CHART_METRIC_LABELS[metric]}
        </button>
      ))}
    </div>
  );
}

interface ChartRangeControlValue {
  preset: ChartTimeRangePreset;
  start: string;
  end: string;
}

const DEFAULT_CHART_RANGE: ChartRangeControlValue = { preset: "24h", start: "", end: "" };
const OVERVIEW_DEFAULT_CHART_RANGE: ChartRangeControlValue = { preset: "today", start: "", end: "" };
const DEFAULT_RANGE_PRESET_ORDER = ["24h", "today", "3d", "7d", "30d", "3m", "all"] as const;
const OVERVIEW_RANGE_PRESET_ORDER = ["today", "24h", "3d", "7d", "30d", "3m", "all"] as const;

function ChartRangeControl({ value, onChange, ariaLabel = "图表时间范围", presetOrder = DEFAULT_RANGE_PRESET_ORDER }: { value: ChartRangeControlValue; onChange: (value: ChartRangeControlValue) => void; ariaLabel?: string; presetOrder?: readonly Exclude<ChartTimeRangePreset, "custom">[] }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const resolved = resolveChartTimeRange({ preset: draft.preset, start: draft.start || null, end: draft.end || null });
  const selectPreset = (preset: Exclude<ChartTimeRangePreset, "custom">) => {
    const next = { ...value, preset };
    setDraft(next);
    onChange(next);
  };
  return (
    <div className="chart-range-control">
      <div className="chart-range-presets" role="group" aria-label={ariaLabel}>
        {presetOrder.map((preset) => <button type="button" key={preset} className={cn(value.preset === preset && "active")} aria-pressed={value.preset === preset} onClick={() => selectPreset(preset)}>{preset === "24h" ? "近24小时" : preset === "today" ? "今日" : preset === "3d" ? "近3天" : preset === "7d" ? "近7天" : preset === "30d" ? "近30天" : preset === "3m" ? "近3个月" : "全部"}</button>)}
        <button type="button" className={cn((value.preset === "custom" || draft.preset === "custom") && "active")} aria-pressed={value.preset === "custom"} onClick={() => setDraft({ ...draft, preset: "custom" })}>自定义</button>
      </div>
      {draft.preset === "custom" && <div className="chart-custom-range">
        <label><span>起点</span><input type="datetime-local" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.currentTarget.value })} /></label>
        <span className="range-separator">至</span>
        <label><span>终点</span><input type="datetime-local" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.currentTarget.value })} /></label>
        <button type="button" className="chart-range-apply" disabled={!resolved} onClick={() => onChange(draft)}>应用</button>
        {!resolved && draft.start && draft.end && <span className="range-error" role="alert">请选择有效的起止时间</span>}
      </div>}
      <span className="chart-range-zone">{BUSINESS_TIME_ZONE_LABEL}</span>
    </div>
  );
}

const resolvedRange = (value: ChartRangeControlValue): ChartTimeRange | null => resolveChartTimeRange({ preset: value.preset, start: value.start || null, end: value.end || null });

const chartRangeLabel = (value: ChartRangeControlValue): string => value.preset === "24h" ? "近24小时" : value.preset === "today" ? "今日" : value.preset === "3d" ? "近3天" : value.preset === "7d" ? "近7天" : value.preset === "30d" ? "近30天" : value.preset === "3m" ? "近3个月" : value.preset === "all" ? "全部历史" : "自定义范围";

const portfolioTimelineDelta = (timeline: readonly PortfolioTimelinePoint[]): PortfolioTimelinePoint["metrics"] => {
  const first = timeline[0]?.metrics;
  const last = timeline.at(-1)?.metrics;
  const result = { views: null, bookmarks: null, likes: null, comments: null } as PortfolioTimelinePoint["metrics"];
  if (!first || !last || timeline.length < 2) return result;
  for (const key of ["views", "bookmarks", "likes", "comments"] as const) {
    result[key] = first[key] == null || last[key] == null ? null : last[key] - first[key];
  }
  return result;
};

function PortfolioChart({ timeline, rangeValue, onRangeChange, pending = false }: { timeline: PortfolioTimelinePoint[]; rangeValue: ChartRangeControlValue; onRangeChange: (value: ChartRangeControlValue) => void; pending?: boolean }) {
  const [metric, setMetric] = useState<DashboardChartMetric>("views");
  const points = useMemo(() => timeline.map((point, sequence) => ({ at: point.at, value: point.metrics[metric], runId: point.runId, sequence })), [metric, timeline]);
  const validPoints = points.filter((point) => point.value !== null && Number.isFinite(point.value));
  const option = useMemo(() => buildPortfolioChartOption({ points, metric }), [metric, points]);
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  const latest = validPoints.at(-1)?.value ?? null;
  return (
    <div className={cn("chart-panel", pending && "range-pending")} data-testid="portfolio-chart" aria-busy={pending}>
      <div className="chart-control-row"><MetricSelector value={metric} onChange={setMetric} label="作品集图表指标" /><ChartRangeControl value={rangeValue} onChange={onRangeChange} ariaLabel="作品集图表时间范围" presetOrder={OVERVIEW_RANGE_PRESET_ORDER} /></div>
      <EChartsHost
        option={option}
        hasData={validPoints.length >= 1}
        ariaLabel={`${rangeValue.preset === "today" ? "今日" : rangeValue.preset === "all" ? "全部历史" : "所选范围"}作品集${label}采样折线图`}
        emptyMessage="所选时间范围内还没有有效采样。"
        summary={`${label}共 ${formatCount(validPoints.length)} 个有效采样点${latest === null ? "" : `，最近为 ${formatCount(latest)}`}。`}
      />
    </div>
  );
}

const followerIntegrityLabel = (integrity: ReturnType<typeof buildFollowerAnalytics>["recordIntegrity"]): string => {
  if (integrity === "complete") return "记录完整";
  if (integrity === "approximate") return "记录不完整";
  if (integrity === "baseline") return "基线已建立";
  return "暂无足够记录";
};

function FollowerGrowthSection({ data, rangeValue, onRangeChange, pending, animationSignal }: { data: DashboardData; rangeValue: ChartRangeControlValue; onRangeChange: (value: ChartRangeControlValue) => void; pending: boolean; animationSignal?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const dateRevision = useBeijingDateRevision();
  const samples = accountFollowerSamplesFor(data);
  const range = useMemo(() => resolvedRange(rangeValue), [rangeValue]);
  const accountId = data.settings.boundAccount?.id ?? null;
  const analytics = useMemo(() => buildFollowerAnalytics(samples, {
    accountId,
    now: Date.now(),
    range,
  }), [accountId, dateRevision, range, samples]);
  const chartPoints = useMemo(() => analytics.chartSamples.map((sample, sequence) => ({
    at: sample.collectedAt,
    value: sample.followers,
    runId: sample.runId,
    sequence,
  })), [analytics.chartSamples]);
  const option = useMemo(() => buildFollowerChartOption({ points: chartPoints }), [chartPoints]);
  const previewPoints = useMemo(() => analytics.samples.map((sample, sequence) => ({
    at: sample.collectedAt,
    value: sample.followers,
    runId: sample.runId,
    sequence,
  })), [analytics.samples]);
  const previewOption = useMemo(() => buildFollowerChartOption({ points: previewPoints, compact: true }), [previewPoints]);
  const rangeLabel = chartRangeLabel(rangeValue);
  const chartHasData = chartPoints.length >= 2;
  const emptyMessage = samples.length === 0
    ? "尚未记录账号粉丝数；完成一次同步后会建立基线。"
    : chartPoints.length === 1
      ? "已建立粉丝基线，等待下一次同步后绘制增长曲线。"
      : "所选时间范围内暂无粉丝采样。";
  const chartSummary = analytics.rangeSamples.length > 0
    ? `${rangeLabel}粉丝历史共 ${formatCount(analytics.rangeSamples.length)} 个有效采样点。`
    : analytics.chartSamples.length > 0
      ? `所选范围暂无采样，已展示全部 ${formatCount(analytics.chartSamples.length)} 个历史点。`
      : "暂无有效粉丝采样点。";
  return <>
    <section className="section-band follower-growth-band follower-growth-compact" data-testid="follower-growth-section" aria-label="粉丝增长">
      <div className="follower-compact-copy">
        <div className="section-heading"><div><p className="eyebrow">ACCOUNT AUDIENCE</p><h2>粉丝增长</h2></div><span className="section-note">账号级 · 低频指标</span></div>
        <div className="follower-summary follower-summary-compact" aria-label="粉丝增长摘要">
          <div className="follower-stat current"><span>当前粉丝数</span><strong><AnimatedNumber value={formatCount(analytics.current)} comparisonValue={analytics.current} animationSignal={animationSignal} /></strong></div>
          <div className={cn("follower-stat", analytics.rangeDelta !== null && analytics.rangeDelta > 0 && "positive", analytics.rangeDelta !== null && analytics.rangeDelta < 0 && "negative")}><span>{rangeLabel}增长</span><strong><AnimatedNumber value={formatDelta(analytics.rangeDelta)} comparisonValue={analytics.rangeDelta} animationSignal={animationSignal} /></strong></div>
          <div className="follower-stat"><span>最后采集</span><strong className="follower-stat-text">{formatTimestamp(analytics.lastCollectedAt)}</strong></div>
        </div>
      </div>
      <button type="button" className="follower-preview-button" onClick={() => setExpanded(true)} aria-label="打开粉丝增长详细图表">
        <span className="follower-preview-chart" aria-hidden="true">
          {previewPoints.length >= 2
            ? <EChartsHost option={previewOption} hasData compact ariaLabel="" summary="" height={72} className="follower-mini-chart" />
            : <span className="follower-preview-empty">{previewPoints.length === 1 ? "基线已建立" : "等待首次采样"}</span>}
        </span>
        <span className="follower-preview-action"><BarChart3 size={15} aria-hidden="true" />查看详细趋势<ChevronRight size={15} aria-hidden="true" /></span>
      </button>
    </section>
    {expanded && <div className="drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <aside className="detail-drawer follower-detail-drawer" role="dialog" aria-modal="true" aria-label="粉丝增长详细图表">
        <div className="drawer-header"><div><p className="eyebrow">ACCOUNT AUDIENCE</p><h2>粉丝增长</h2><p>账号级历史 · {BUSINESS_TIME_ZONE_LABEL}</p></div><IconButton label="关闭粉丝增长详情" onClick={() => setExpanded(false)}><X size={19} /></IconButton></div>
        <div className="drawer-scroll">
          <div className="follower-summary" aria-label="粉丝增长详情摘要">
            <div className="follower-stat current"><span>当前粉丝数</span><strong><AnimatedNumber value={formatCount(analytics.current)} comparisonValue={analytics.current} animationSignal={animationSignal} /></strong></div>
            <div className={cn("follower-stat", analytics.rangeDelta !== null && analytics.rangeDelta > 0 && "positive", analytics.rangeDelta !== null && analytics.rangeDelta < 0 && "negative")}><span>{rangeLabel}增长</span><strong><AnimatedNumber value={formatDelta(analytics.rangeDelta)} comparisonValue={analytics.rangeDelta} animationSignal={animationSignal} /></strong></div>
            <div className="follower-stat"><span>最后采集时间</span><strong className="follower-stat-text">{formatTimestamp(analytics.lastCollectedAt)}</strong></div>
            <div className={cn("follower-stat", analytics.recordIntegrity === "approximate" && "warning")}><span>记录完整性</span><strong className="follower-stat-text">{followerIntegrityLabel(analytics.recordIntegrity)}</strong></div>
          </div>
          <section className="drawer-section"><div className="section-heading"><div><p className="eyebrow">FOLLOWER HISTORY</p><h3>粉丝数历史</h3></div><span className="section-note">真实时间间隔</span></div><div className={cn("chart-wrap", pending && "range-pending")}><div className="chart-panel" aria-busy={pending}><div className="chart-control-row"><ChartRangeControl value={rangeValue} onChange={onRangeChange} ariaLabel="粉丝增长图表时间范围" presetOrder={OVERVIEW_RANGE_PRESET_ORDER} /></div><EChartsHost option={option} hasData={chartHasData} ariaLabel={`${rangeLabel}账号粉丝数历史图`} emptyMessage={emptyMessage} summary={chartSummary} height={300} /></div></div></section>
        </div>
      </aside>
    </div>}
  </>;
}

function TopMover({ analysis, onOpen }: { analysis: WorkAnalysis; onOpen: () => void }) {
  const delta = analysis.lastDelta.views.value;
  return (
    <button type="button" className="mover-row" onClick={onOpen}>
      <Thumbnail work={analysis.work} />
      <span className="mover-main"><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(analysis.work))} · {formatElapsed(analysis.lastDelta.views.elapsedHours)}</small></span>
      <span className={cn("mover-value", (delta ?? 0) >= 0 ? "positive" : "negative")}>{delta === null ? "—" : <>{(delta ?? 0) >= 0 ? <ArrowUpRight size={15} aria-hidden="true" /> : <ArrowDownRight size={15} aria-hidden="true" />}<AnimatedNumber value={formatDelta(delta)} /></>}</span>
      <ChevronRight size={16} className="row-chevron" aria-hidden="true" />
    </button>
  );
}

function RankingMovement({ entry }: { entry: RankingEntry }) {
  const movement = entry.movement;
  return <span className={cn("ranking-movement", movement !== null && movement > 0 && "positive", movement !== null && movement < 0 && "negative")}>{rankingMovementLabel(movement)}</span>;
}

function RankingSection({ entries, onOpenWork }: { entries: RankingEntry[]; onOpenWork: (key: string) => void }) {
  return (
    <section className="section-band ranking-band" data-testid="ranking-section">
      <div className="section-heading">
        <div><p className="eyebrow">PIXIV RANKING</p><h2>作品排名</h2></div>
        <span className="section-note">仅展示当前已上榜作品</span>
      </div>
      {entries.length === 0 ? (
        <div className="ranking-empty" role="status"><TrendingUp size={19} aria-hidden="true" /><p>排名记录仅在 Pixiv 作者作品页暴露排名时写入；当前没有可展示的已上榜作品。</p></div>
      ) : (
        <div className="ranking-list" aria-label="当前作品排名">
          {entries.map((entry) => (
            <button type="button" className="ranking-row" key={entry.analysis.work.key} onClick={() => onOpenWork(entry.analysis.work.key)}>
              <span className="ranking-position" aria-label={`当前排名第 ${entry.rank} 名`}>#{entry.rank}</span>
              <span className="ranking-main"><strong>{entry.analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(entry.analysis.work))} · {rankingMovementLabel(entry.movement)}</small></span>
              <span className="ranking-meta"><span>{entry.observedAt ? `更新于 ${formatTimestamp(entry.observedAt)}` : "排名时间未知"}</span><span>{rankingSourceLabel(entry.source)}</span></span>
              <RankingMovement entry={entry} />
              <ChevronRight size={16} className="row-chevron" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function OverviewView({ analyses, data, intraday: suppliedIntraday, onOpenWork, onGoToWorks, animationSignal }: { analyses: WorkAnalysis[]; data: DashboardData; intraday?: IntradayPortfolioAnalysis; onOpenWork: (key: string) => void; onGoToWorks: () => void; animationSignal?: unknown }) {
  const intraday = useMemo(() => suppliedIntraday ?? buildIntradayAnalytics({ works: data.works, samples: data.samples, observations: data.observations, observationBatches: data.observationBatches ?? [], configuredIntervalHours: data.settings.syncIntervalHours }), [data.observationBatches, data.observations, data.samples, data.settings.syncIntervalHours, data.works, suppliedIntraday]);
  const [rangeValue, setRangeValue] = useState<ChartRangeControlValue>(OVERVIEW_DEFAULT_CHART_RANGE);
  const [rangePending, startRangeTransition] = useTransition();
  const range = useMemo(() => resolvedRange(rangeValue), [rangeValue]);
  const portfolioTimeline = useMemo(() => range ? buildPortfolioTimeline(data.works.map((work) => work.key), data.samples, data.observations, range, data.observationBatches) : [], [data.observationBatches, data.observations, data.samples, data.works, range]);
  const currentTotal = useMemo(() => analyses.length > 0 ? ({
    views: sumMetric(analyses, "views"),
    bookmarks: sumMetric(analyses, "bookmarks"),
    likes: sumMetric(analyses, "likes"),
    comments: sumMetric(analyses, "comments"),
  }) : ({ views: null, bookmarks: null, likes: null, comments: null }), [analyses]);
  const rangeDelta = useMemo(() => rangeValue.preset === "today" ? intraday.delta : portfolioTimelineDelta(portfolioTimeline), [intraday.delta, portfolioTimeline, rangeValue.preset]);
  const rangeLabel = chartRangeLabel(rangeValue);
  const rangeDeltaDetail = rangeValue.preset === "today" ? "按今日首个检测点计算" : "按范围起点基线计算";
  const setOverviewRange = (value: ChartRangeControlValue) => startRangeTransition(() => setRangeValue(value));
  const insights = buildInsights(analyses, intraday);
  const movers = [...analyses].filter((analysis) => analysis.previousSample).sort((a, b) => (b.lastDelta.views.value ?? -Infinity) - (a.lastDelta.views.value ?? -Infinity)).slice(0, 3);
  const rounds = intraday.sampleCount;
  const recentCompletedRun = latestCompletedRun(data.runs);
  const rankingEntries = useMemo(() => buildRankingEntries(analyses, data.samples), [analyses, data.samples]);
  return (
    <div className="view-stack overview-view">
      <section className="welcome-band">
        <div><p className="eyebrow">作品集信号</p><h2>把每一次真实采样，变成可回看的增长轨迹。</h2><p>这里只计算你本地保存的 Pixiv 作品管理页快照，不替你猜测安装前发生过什么。</p><div className="welcome-account"><AccountIdentity account={data.settings.boundAccount} /></div></div>
        <div className="welcome-meta"><span><Database size={15} aria-hidden="true" />{data.samples.length} 个快照</span><span className="sampling-meta"><Clock3 size={15} aria-hidden="true" /><strong>今日采样轮次</strong><em>{rounds}</em></span><span className="baseline-label"><Info size={14} aria-hidden="true" />{baselineLabel(intraday.baselineLabel)}</span></div>
      </section>
      <div className="kpi-grid">
        <KpiCard label="浏览总量" total={currentTotal.views} delta={rangeDelta.views} changeLabel={rangeLabel} detail={`${portfolioTimeline.length} 个范围采样点`} icon={<Eye size={18} />} tone="coral" animationSignal={animationSignal} />
        <KpiCard label="收藏总量" total={currentTotal.bookmarks} delta={rangeDelta.bookmarks} changeLabel={rangeLabel} detail={rangeDeltaDetail} icon={<BookOpen size={18} />} tone="green" animationSignal={animationSignal} />
        <KpiCard label="获赞总量" total={currentTotal.likes} delta={rangeDelta.likes} changeLabel={rangeLabel} detail={rangeDeltaDetail} icon={<Heart size={18} />} animationSignal={animationSignal} />
        <KpiCard label="评论总量" total={currentTotal.comments} delta={rangeDelta.comments} changeLabel={rangeLabel} detail={rangeDeltaDetail} icon={<MessageCircle size={18} />} tone="amber" animationSignal={animationSignal} />
      </div>
      <FollowerGrowthSection data={data} rangeValue={rangeValue} onRangeChange={setOverviewRange} pending={rangePending} animationSignal={animationSignal} />
      {analyses.length === 0 ? (
        <>
          <EmptyState icon={<RefreshCw size={22} />} title={recentCompletedRun?.works === 0 ? "最近同步没有作品" : "还没有作品快照"} body={recentCompletedRun ? `最近一次同步已完成，Pixiv 返回 ${formatCount(recentCompletedRun.works)} 件作品；下一次同步会继续读取。` : "尚未完成第一次同步；完成后，PixivPulse 会先建立基线，再在后续采样中计算变化。"} action={<button type="button" className="secondary-button" onClick={onGoToWorks}>查看作品页</button>} />
          <RankingSection entries={rankingEntries} onOpenWork={onOpenWork} />
        </>
      ) : (
        <>
          <section className="section-band chart-band">
            <div className="section-heading"><div><p className="eyebrow">PORTFOLIO MOMENTUM</p><h2>{rangeLabel}作品集动量</h2></div><span className="section-note">真实时间间隔 · 范围指标联动</span></div>
            <div className="chart-wrap"><PortfolioChart timeline={portfolioTimeline} rangeValue={rangeValue} onRangeChange={setOverviewRange} pending={rangePending} /></div>
          </section>
          <RankingSection entries={rankingEntries} onOpenWork={onOpenWork} />
          <div className="insight-mover-grid">
            <section className="section-band insight-band">
              <div className="section-heading"><div><p className="eyebrow">RULE-BASED SIGNALS</p><h2>规则洞察</h2></div><span className="section-note">最低样本门槛</span></div>
              <div className="insight-list">
                {insights.map((insight, index) => <article className={cn("insight-row", insight.tone)} key={`${insight.title}-${index}`}><span className="insight-icon">{insight.icon}</span><div><div className="insight-title"><strong>{insight.title}</strong><ConfidenceBadge confidence={insight.confidence} /></div><p>{insight.body}</p></div></article>)}
              </div>
            </section>
            <section className="section-band movers-band">
              <div className="section-heading"><div><p className="eyebrow">TOP MOVERS</p><h2>上升作品</h2></div><button type="button" className="text-button" onClick={onGoToWorks}>查看全部 {formatCount(analyses.length)} 件作品 <ChevronRight size={14} aria-hidden="true" /></button></div>
              <div className="mover-list">{movers.length ? movers.map((analysis) => <TopMover key={analysis.work.key} analysis={analysis} onOpen={() => onOpenWork(analysis.work.key)} />) : <p className="muted-copy">完成第二次同步后，这里会出现有实际变化的作品。</p>}</div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

type WorkTypeFilter = "all" | WorkContentType;
type WorkStatusFilter = "all" | "updated" | "history" | "baseline";

function SortButton({ label, sortKey, sort, onSort }: { label: string; sortKey: WorkSortKey; sort: WorkSort; onSort: (key: WorkSortKey) => void }) {
  const current = sort.key === sortKey;
  return <button type="button" className={cn("sort-button", current && "active")} onClick={() => onSort(sortKey)} aria-label={`按${label}排序`} aria-sort={current ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>{label}<span className="sort-indicator" aria-hidden="true"><ChevronDown size={13} className={sort.direction === "asc" ? "sort-up" : undefined} /></span></button>;
}

function SortDirectionButton({ direction, onToggle }: { direction: WorkSort["direction"]; onToggle: () => void }) {
  const ascending = direction === "asc";
  return <IconButton label={"切换为" + (ascending ? "降序" : "升序")} className="sort-direction-button" onClick={onToggle}>{ascending ? <ArrowUp size={16} aria-hidden="true" /> : <ArrowDown size={16} aria-hidden="true" />}</IconButton>;
}

function TodayDeltaCell({ intraday, metricKey }: { intraday: IntradayWorkAnalysis | null; metricKey: keyof WorkMetrics }) {
  const delta = todayDelta(intraday, metricKey);
  return <td className={cn("delta-cell", "today-delta-cell", delta !== null && delta > 0 && "positive", delta !== null && delta < 0 && "negative")}><span><AnimatedNumber value={delta === null ? "—" : formatDelta(delta)} /></span><small>{intraday ? "今日" : "暂无今日样本"}</small></td>;
}

const formatCompactElapsed = (hours: number | null): string => {
  const label = formatElapsed(hours);
  const prefix = "距上次采样 ";
  return label.startsWith(prefix) ? `${label.slice(prefix.length)}前` : label;
};

const workDescription = (work: WorkAnalysis["work"]): string | null => {
  const value = (work as WorkAnalysis["work"] & { description?: unknown }).description;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const workSeries = (work: WorkAnalysis["work"]): string => work.seriesTitle?.trim() || "独立作品";

const workExtent = (work: WorkAnalysis["work"]): string => {
  if (work.wordCount !== null) return `字数 ${formatCount(work.wordCount)}`;
  if (work.pageCount !== null) return `页数 ${formatCount(work.pageCount)}`;
  return "内容数量未知";
};

const statusLabel = (_analysis: WorkAnalysis, intraday: IntradayWorkAnalysis | null): string => {
  if (!intraday) return "今日暂无浏览变化";
  const delta = todayDelta(intraday, "views");
  if (delta === null) return baselineLabel(intraday.baselineLabel);
  if (delta === 0) return "今日暂无浏览变化";
  return `今日有增长 · 浏览 ${formatDelta(delta)}`;
};

function WorkRow({ analysis, intraday, onOpen, checked, compareDisabled, onToggleCompare }: { analysis: WorkAnalysis; intraday: IntradayWorkAnalysis | null; onOpen: () => void; checked: boolean; compareDisabled: boolean; onToggleCompare: () => void }) {
  const metrics = currentMetrics(analysis);
  const delta = analysis.lastDelta.views.value;
  const contentType = contentTypeForWork(analysis.work);
  const ranking = rankingEntryForAnalysis(analysis);
  return (
    <tr>
      <td className="rank-cell">{ranking ? `#${ranking.rank}` : "—"}<small>{ranking ? "当前排名" : "排名未知"}</small></td>
      <td className="work-name-cell"><div className="work-name-layout"><input type="checkbox" checked={checked} disabled={compareDisabled} onChange={onToggleCompare} aria-label={`加入比较：${analysis.work.title}`} /><button type="button" className="work-link" onClick={onOpen}><Thumbnail work={analysis.work} /><span><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentType)} · {analysis.work.id}</small><small className="work-series-inline">{workSeries(analysis.work)}</small></span></button></div></td>
      <td className="number-cell"><AnimatedNumber value={formatCount(metrics.views)} /></td>
      <TodayDeltaCell intraday={intraday} metricKey="views" />
      <TodayDeltaCell intraday={intraday} metricKey="bookmarks" />
      <TodayDeltaCell intraday={intraday} metricKey="likes" />
      <TodayDeltaCell intraday={intraday} metricKey="comments" />
      <td className="number-cell today-samples-cell">{intraday ? formatCount(intraday.sampleCount) : "—"}<small>今日观察</small></td>
      <td className={cn("delta-cell", delta !== null && delta > 0 && "positive", delta !== null && delta < 0 && "negative")}>{delta === null ? <span>—</span> : <><span>{formatDelta(delta)}</span><small>{formatCompactElapsed(analysis.lastDelta.views.elapsedHours)}</small></>}</td>
      <td className="number-cell recent-seen-cell"><span>{formatTimestamp(analysis.work.lastSeenAt)}</span><small>最近观察</small></td>
      <td className="number-cell total-cell"><AnimatedNumber value={formatCount(metrics.likes)} /></td>
      <td className="number-cell total-cell"><AnimatedNumber value={formatCount(metrics.bookmarks)} /><small className="ratio-label">{formatPercent(analysis.bookmarkRate)}</small></td>
      <td className="sparkline-cell"><Sparkline analysis={analysis} /></td>
      <td className="confidence-cell"><ConfidenceBadge confidence={analysis.confidence} /></td>
      <td><IconButton label={`打开${analysis.work.title}详情`} className="row-action" onClick={onOpen}><ChevronRight size={17} /></IconButton></td>
    </tr>
  );
}

function WorkMetric({ icon, label, value }: { icon: ReactNode; label: string; value: number | null }) {
  return <span className="work-metric"><span className="work-metric-label">{icon}{label}</span><strong><AnimatedNumber value={formatCount(value)} /></strong></span>;
}

function WorkCard({ analysis, intraday, checked, compareDisabled, onToggleCompare, onOpen, coverRevision, coverRefreshSignal }: { analysis: WorkAnalysis; intraday: IntradayWorkAnalysis | null; checked: boolean; compareDisabled: boolean; onToggleCompare: () => void; onOpen: () => void; coverRevision: string; coverRefreshSignal: string }) {
  const metrics = currentMetrics(analysis);
  const contentType = contentTypeForWork(analysis.work);
  const description = workDescription(analysis.work);
  const todayViews = todayDelta(intraday, "views");
  const ranking = rankingEntryForAnalysis(analysis);
  return (
    <article className="work-card" data-testid="work-card">
      <div className="work-cover-frame">
        <button type="button" className="work-cover-button" onClick={onOpen} aria-label={`打开${analysis.work.title}详情`}>
          <Thumbnail work={analysis.work} className="work-cover" cacheRevision={coverRevision} cacheRefreshSignal={coverRefreshSignal} />
        </button>
        {ranking && <span className="rank-badge" aria-label={`当前排名第 ${ranking.rank} 名`}>#{ranking.rank}</span>}
        <label className={cn("work-compare-control", compareDisabled && "disabled")}><input type="checkbox" checked={checked} disabled={compareDisabled} onChange={onToggleCompare} aria-label={`加入比较：${analysis.work.title}`} /><span>比较</span></label>
      </div>
      <div className="work-card-body">
        <div className="work-card-heading">
          <div className="work-card-title-wrap"><button type="button" className="work-card-title" onClick={onOpen}>{analysis.work.title}</button><span className="work-card-series">{workSeries(analysis.work)}</span></div>
          <span className="content-type-badge">{contentTypeLabel(contentType)}</span>
        </div>
        <p className={cn("work-overview", description && "has-description")}>{description ?? `${workExtent(analysis.work)} · ${contentTypeLabel(contentType)}`}</p>
        <div className="work-card-meta"><span>{analysis.work.publishedAt ? `发布于 ${formatTimestamp(analysis.work.publishedAt)}` : "发布时间未知"}</span><span>{workExtent(analysis.work)}</span>{analysis.work.isAi === true && <span className="work-tag ai-tag"><Sparkles size={12} aria-hidden="true" />AI</span>}{analysis.work.isR18 === true && <span className="work-tag r18-tag"><Tag size={12} aria-hidden="true" />R-18</span>}</div>
        <div className="work-metrics" aria-label={`${analysis.work.title}当前数据`}>
          <WorkMetric icon={<Eye size={13} aria-hidden="true" />} label="浏览" value={metrics.views} />
          <WorkMetric icon={<Heart size={13} aria-hidden="true" />} label="赞" value={metrics.likes} />
          <WorkMetric icon={<BookOpen size={13} aria-hidden="true" />} label="收藏" value={metrics.bookmarks} />
          <WorkMetric icon={<MessageCircle size={13} aria-hidden="true" />} label="评论" value={metrics.comments} />
        </div>
        <div className="work-today-stats" aria-label={`${analysis.work.title}今日变化`}><span title="今日浏览" aria-label="今日浏览"><strong className={cn(todayViews !== null && todayViews > 0 && "positive", todayViews !== null && todayViews < 0 && "negative")}><AnimatedNumber value={todayViews === null ? "—" : formatDelta(todayViews)} /></strong></span><span title="今日收藏" aria-label="今日收藏"><strong><AnimatedNumber value={formatDelta(todayDelta(intraday, "bookmarks"))} /></strong></span><span title="今日赞" aria-label="今日赞"><strong><AnimatedNumber value={formatDelta(todayDelta(intraday, "likes"))} /></strong></span><span title="今日评论" aria-label="今日评论"><strong><AnimatedNumber value={formatDelta(todayDelta(intraday, "comments"))} /></strong></span></div>
        <div className="work-card-footer"><span className="work-baseline-label">{statusLabel(analysis, intraday)}</span><span className="work-sample-note" aria-label="今日样本">今日样本 {intraday ? formatCount(intraday.sampleCount) : "—"}</span><button type="button" className="work-detail-button" onClick={onOpen}>查看详情 <ChevronRight size={14} aria-hidden="true" /></button></div>
      </div>
    </article>
  );
}

export function WorksView({ analyses, intradayByWork, compareKeys, onToggleCompare, onOpenWork, completedRunWorks, coverCache }: { analyses: WorkAnalysis[]; intradayByWork?: ReadonlyMap<string, IntradayWorkAnalysis>; compareKeys: string[]; onToggleCompare: (key: string) => void; onOpenWork: (key: string) => void; completedRunWorks?: number | null; coverCache?: CoverCacheSummary | undefined }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<WorkTypeFilter>("all");
  const [status, setStatus] = useState<WorkStatusFilter>("all");
  const [sort, setSort] = useState<WorkSort>(DEFAULT_WORK_SORT);
  const [viewMode, setViewMode] = useState<WorksViewMode>(readWorksViewMode);
  const coverRefreshSignal = coverRefreshSignalFor(coverCache);
  useEffect(() => { saveWorksViewMode(viewMode); }, [viewMode]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matching = analyses.filter((analysis) => {
      if (normalized && !`${analysis.work.title} ${analysis.work.id} ${workSeries(analysis.work)}`.toLocaleLowerCase().includes(normalized)) return false;
      if (type !== "all" && contentTypeForWork(analysis.work) !== type) return false;
      if (status !== "all" && statusFor(analysis) !== status) return false;
      return true;
    });
    return sortWorkAnalyses(matching, sort, intradayByWork);
  }, [analyses, intradayByWork, query, sort, status, type]);
  const onSort = (key: WorkSortKey) => setSort((current) => current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: key === "title" ? "asc" : "desc" });
  const onSortKeyChange = (key: WorkSortKey) => setSort((current) => current.key === key
    ? current
    : { key, direction: key === "title" ? "asc" : "desc" });
  const onSortDirection = () => setSort((current) => ({ ...current, direction: current.direction === "asc" ? "desc" : "asc" }));
  return (
    <div className="view-stack works-view">
      <section className="list-toolbar">
        <div><p className="eyebrow">WORK LIBRARY</p><h2>全部作品 <span>{formatCount(filtered.length)} / {formatCount(analyses.length)}</span></h2><p className="toolbar-caption">勾选作品后可加入比较；点击作品名查看采样细节。</p></div>
        <div className="toolbar-controls">
          <label className="search-field"><Search size={16} aria-hidden="true" /><span className="sr-only">搜索作品</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索标题或 ID" /></label>
          <label className="select-field"><ListFilter size={15} aria-hidden="true" /><span className="sr-only">作品类型</span><select value={type} onChange={(event) => setType(event.currentTarget.value as WorkTypeFilter)}><option value="all">全部类型</option><option value="novel">小说</option><option value="illustration">插画</option><option value="manga">漫画</option><option value="ugoira">动图</option><option value="unknown">作品</option></select></label>
          <label className="select-field"><Filter size={15} aria-hidden="true" /><span className="sr-only">作品状态</span><select value={status} onChange={(event) => setStatus(event.currentTarget.value as WorkStatusFilter)}><option value="all">全部状态</option><option value="updated">有增长</option><option value="history">有历史无增长</option><option value="baseline">仅有基线</option></select></label>
          <label className="select-field sort-select"><SlidersHorizontal size={15} aria-hidden="true" /><span className="sr-only">排序指标</span><select aria-label="排序指标" value={sort.key} onChange={(event) => onSortKeyChange(event.currentTarget.value as WorkSortKey)}>{WORK_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <SortDirectionButton direction={sort.direction} onToggle={onSortDirection} />
          <div className="view-mode-toggle" role="group" aria-label="作品展示方式"><button type="button" className={cn("view-mode-button", viewMode === "grid" && "active")} aria-label="宫格视图" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 size={16} aria-hidden="true" /><span>宫格</span></button><button type="button" className={cn("view-mode-button", viewMode === "list" && "active")} aria-label="列表视图" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List size={17} aria-hidden="true" /><span>列表</span></button></div>
        </div>
      </section>
      <div className="table-summary"><span><ImageIcon size={15} aria-hidden="true" />{analyses.length} 件作品</span><span><Activity size={15} aria-hidden="true" />{analyses.filter((analysis) => analysis.previousSample).length} 件已有历史</span>{coverCache && coverCache.total > 0 && <span title={coverCache.failed > 0 ? `${coverCache.failed} 张失败，将在下次完整同步重试` : undefined}><Database size={15} aria-hidden="true" />本地封面 {coverCache.ready}/{coverCache.total}{coverCache.pending > 0 ? ` · ${coverCache.pending} 张处理中` : ""}{coverCache.skipped > 0 ? ` · ${coverCache.skipped} 张空间不足` : ""}</span>}<span className="summary-tip"><SlidersHorizontal size={14} aria-hidden="true" />变化值只使用相邻真实采样</span></div>
       {filtered.length === 0 ? <EmptyState icon={<Search size={22} />} title={analyses.length ? "没有匹配的作品" : completedRunWorks === 0 ? "最近同步没有作品" : "第一次同步后，作品会出现在这里"} body={analyses.length ? "试试清空搜索词或调整筛选条件。" : completedRunWorks === 0 ? "最近一次同步已完成，Pixiv 返回 0 件作品；下一次同步会继续读取。" : completedRunWorks === null || completedRunWorks === undefined ? "尚未完成第一次同步；完成同步后，真实作品会出现在这里。" : `最近一次同步已完成，Pixiv 返回 ${formatCount(completedRunWorks)} 件作品；当前列表暂时没有可展示的记录。`} /> : viewMode === "grid" ? <><div className="grid-metrics-legend" aria-label="今日数据字段"><span>今日浏览</span><span>今日收藏</span><span>今日赞</span><span>今日评论</span><span>今日样本</span></div><div className="works-grid">{filtered.map((analysis) => { const checked = compareKeys.includes(analysis.work.key); return <WorkCard key={analysis.work.key} analysis={analysis} intraday={intradayByWork?.get(analysis.work.key) ?? null} onOpen={() => onOpenWork(analysis.work.key)} checked={checked} compareDisabled={!checked && compareKeys.length >= MAX_COMPARE_WORKS} onToggleCompare={() => onToggleCompare(analysis.work.key)} coverRevision={coverRevisionForWork(analysis.work)} coverRefreshSignal={coverRefreshSignal} />; })}</div></> : <div className="table-scroll"><table className="works-table"><caption className="sr-only">PixivPulse 作品增长表</caption><thead><tr><th className="number-heading">排名</th><th><SortButton label="作品" sortKey="title" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label="浏览" sortKey="views" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label="今日浏览" sortKey="todayViews" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label="今日收藏" sortKey="todayBookmarks" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label="今日赞" sortKey="todayLikes" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label="今日评论" sortKey="todayComments" sort={sort} onSort={onSort} /></th><th className="number-heading">今日样本</th><th className="number-heading">上次变化</th><th className="number-heading"><SortButton label="最近观察" sortKey="lastSeenAt" sort={sort} onSort={onSort} /></th><th className="number-heading total-heading"><SortButton label="赞总量" sortKey="likes" sort={sort} onSort={onSort} /></th><th className="number-heading total-heading"><SortButton label="收藏总量" sortKey="bookmarks" sort={sort} onSort={onSort} /></th><th>走势</th><th>置信</th><th aria-label="操作" /></tr></thead><tbody>{filtered.map((analysis) => { const checked = compareKeys.includes(analysis.work.key); return <WorkRow key={analysis.work.key} analysis={analysis} intraday={intradayByWork?.get(analysis.work.key) ?? null} onOpen={() => onOpenWork(analysis.work.key)} checked={checked} compareDisabled={!checked && compareKeys.length >= MAX_COMPARE_WORKS} onToggleCompare={() => onToggleCompare(analysis.work.key)} />; })}</tbody></table></div>}
    </div>
  );
}

interface AbsoluteCompareSeries {
  analysis: WorkAnalysis;
  points: Array<{ at: string; value: number | null; runId?: string; sequence?: number }>;
  color: string;
}

const MAX_COMPARE_WORKS = 5;
const SERIES_COLORS = ["#007eaf", "#ff6b5e", "#2f8f6b", "#b7791f", "#9c5b94"];
const COMPARE_CHART_METRICS = ["views", "bookmarks", "likes"] as const satisfies readonly DashboardChartMetric[];

function CompareChart({ series, metric, valueMode, range }: { series: AbsoluteCompareSeries[]; metric: DashboardChartMetric; valueMode: CompareValueMode; range: ChartTimeRange }) {
  const allPoints = series.flatMap((item) => item.points);
  const { start, end, hours } = compareBucketLayout(allPoints, range);
  const drawableSeriesCount = series.filter((item) => valueMode === "delta"
    ? buildCompareBuckets(item.points, start, end, hours).some((bucket) => bucket.value != null)
    : item.points.length >= 2).length;
  const chartSeries: AbsoluteChartSeriesInput[] = series.map((item) => ({
    key: item.analysis.work.key,
    name: item.analysis.work.title,
    color: item.color,
    points: item.points,
  }));
  const option = useMemo(() => buildAbsoluteCompareChartOption({ series: chartSeries, metric, valueMode, range }), [chartSeries, metric, valueMode, range]);
  const metricLabel = DASHBOARD_CHART_METRIC_LABELS[metric];
  const valueLabel = valueMode === "delta" ? "增量" : "总量绝对值";
  return (
    <EChartsHost
      option={option}
      hasData={series.length >= 2 && drawableSeriesCount >= 2}
      ariaLabel={`${series.length} 部作品${metricLabel}${valueLabel}比较折线图`}
      emptyMessage={`至少两部所选作品需要各有两次有效${metricLabel}采样，才能绘制${valueLabel}比较曲线。`}
      summary={valueMode === "delta" ? `${series.length} 部作品，每 ${compareBucketLabel(hours)} ${metricLabel}净增量；北京时间。` : `${series.length} 部作品，${allPoints.length} 个${metricLabel}${valueLabel}采样点；横轴按北京时间的真实采样时刻绘制。`}
      height={286}
      className="compare-chart"
      presentation={valueMode === "delta" ? "buckets" : "trend"}
    />
  );
}

const absoluteTimelinePoints = (points: WorkTimelinePoint[], metric: DashboardChartMetric, preserveMissing = false) => {
  return points
    .slice()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map((point, sequence) => ({ at: point.at, value: point.metrics[metric], runId: point.runId, sequence }))
    .filter((point) => preserveMissing || (point.value != null && Number.isFinite(point.value)));
};

export function CompareView({ analyses, compareKeys, onToggleCompare, onOpenWork, data }: { analyses: WorkAnalysis[]; compareKeys: string[]; onToggleCompare: (key: string) => void; onOpenWork: (key: string) => void; data?: DashboardData }) {
  const [rangeValue, setRangeValue] = useState<ChartRangeControlValue>(DEFAULT_CHART_RANGE);
  const [metric, setMetric] = useState<DashboardChartMetric>("views");
  const [valueMode, setValueMode] = useState<CompareValueMode>("total");
  const range = useMemo(() => resolvedRange(rangeValue), [rangeValue]);
  const selected = compareKeys.slice(0, MAX_COMPARE_WORKS).map((key) => analyses.find((analysis) => analysis.work.key === key)).filter((analysis): analysis is WorkAnalysis => Boolean(analysis));
  const series = selected.map((analysis, index) => {
    const timeline = data && range ? buildWorkTimeline(analysis.work.key, data.samples, data.observations, valueMode === "delta" ? { startMs: null, endMs: range.endMs } : range, data.observationBatches) : analysis.sparkline.map((point, sequence) => ({ workKey: analysis.work.key, at: point.at, runId: `legacy-${sequence}`, metrics: { views: point.views, likes: point.likes, bookmarks: point.bookmarks, comments: null, rank: null, responses: null, illustrations: null } }));
    return {
      analysis,
      color: SERIES_COLORS[index] ?? "#00a7e9",
      points: absoluteTimelinePoints(timeline, metric, valueMode === "delta"),
    };
  });
  return (
    <div className="view-stack compare-view">
      <section className="list-toolbar compare-toolbar"><div><p className="eyebrow">ABSOLUTE COMPARISON</p><h2>比较作品 <span>{selected.length} / {MAX_COMPARE_WORKS}</span></h2><p className="toolbar-caption">2 至 {MAX_COMPARE_WORKS} 部作品使用同一真实时间轴，比较浏览、收藏和获赞的总量或增量。</p></div><div className="compare-help"><Gauge size={17} aria-hidden="true" /><span>最多选择 {MAX_COMPARE_WORKS} 件作品</span></div></section>
      <section className="compare-picker" aria-label="选择比较作品">
        {analyses.length === 0 ? <p className="muted-copy">同步后可从作品列表选择比较对象。</p> : analyses.map((analysis) => { const checked = compareKeys.includes(analysis.work.key); const disabled = !checked && selected.length >= MAX_COMPARE_WORKS; return <label key={analysis.work.key} className={cn("picker-item", checked && "selected", disabled && "disabled")}><input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggleCompare(analysis.work.key)} /><Thumbnail work={analysis.work} /><span><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(analysis.work))} · {workConfidence(analysis)}</small></span></label>; })}
      </section>
      {selected.length > 0 && <section className="compare-work-summary" aria-label="已选作品当前总量">{selected.map((analysis, index) => { const metrics = analysis.latestSample?.metrics ?? analysis.work.metrics; return <article key={analysis.work.key} style={{ "--series-color": SERIES_COLORS[index] } as React.CSSProperties}><div className="compare-work-heading"><Thumbnail work={analysis.work} /><button type="button" onClick={() => onOpenWork(analysis.work.key)}><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(analysis.work))}</small></button></div><div className="compare-work-metrics"><span>浏览<strong><AnimatedNumber value={formatCount(metrics.views)} comparisonValue={metrics.views} /></strong></span><span>收藏<strong><AnimatedNumber value={formatCount(metrics.bookmarks)} comparisonValue={metrics.bookmarks} /></strong></span><span>获赞<strong><AnimatedNumber value={formatCount(metrics.likes)} comparisonValue={metrics.likes} /></strong></span></div></article>; })}</section>}
      {selected.length === 0 ? <EmptyState icon={<BarChart3 size={22} />} title="还没有比较对象" body="从上方选择至少两件作品，比较页会绘制它们的历史曲线。" /> : selected.length === 1 ? <EmptyState icon={<BarChart3 size={22} />} title="还差一件作品" body="再选择一件作品后，即可比较浏览、收藏和获赞的总量或增量曲线。" /> : <section className="section-band compare-band"><div className="section-heading"><div><p className="eyebrow">ABSOLUTE METRIC HISTORY</p><h2>{DASHBOARD_CHART_METRIC_LABELS[metric]}{valueMode === "delta" ? "增量" : "绝对值"}曲线</h2></div><span className="section-note">横轴：北京时间 · 纵轴：{valueMode === "delta" ? `每 ${compareBucketLabel(compareBucketLayout(series.flatMap((item) => item.points), range ?? { preset: "all", startMs: null, endMs: null }).hours)} 净增量` : "累计总量"}</span></div><div className="compare-chart-controls"><div className="compare-chart-selectors"><MetricSelector value={metric} onChange={setMetric} label="比较指标" metrics={COMPARE_CHART_METRICS} /><div className="compare-mode-selector" role="group" aria-label="数值口径"><button type="button" className={cn(valueMode === "total" && "active")} aria-pressed={valueMode === "total"} onClick={() => setValueMode("total")}>总量</button><button type="button" className={cn(valueMode === "delta" && "active")} aria-pressed={valueMode === "delta"} onClick={() => setValueMode("delta")}>增量</button></div></div><ChartRangeControl value={rangeValue} onChange={setRangeValue} /></div><div className="chart-wrap"><CompareChart series={series} metric={metric} valueMode={valueMode} range={range ?? { preset: "all", startMs: null, endMs: null }} /></div><div className="compare-legend">{series.map((item) => <button type="button" key={item.analysis.work.key} className="legend-item" onClick={() => onOpenWork(item.analysis.work.key)}><span className="legend-dot" style={{ backgroundColor: item.color }} />{item.analysis.work.title}<ChevronRight size={14} aria-hidden="true" /></button>)}</div>{valueMode === "delta" && <p className="chart-footnote"><Info size={14} aria-hidden="true" />分段净增量 · 无观察时段留空</p>}{series.some((item) => item.points.length < 2) && <p className="chart-footnote"><Info size={14} aria-hidden="true" />所选范围内不足两次有效{DASHBOARD_CHART_METRIC_LABELS[metric]}观察的作品不会被绘制。</p>}</section>}
    </div>
  );
}

function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description: string; disabled?: boolean }) {
  return <div className="setting-toggle-row"><div><strong>{label}</strong><p>{description}</p></div><button type="button" role="switch" aria-checked={checked} aria-label={label} className={cn("toggle", checked && "checked")} onClick={() => onChange(!checked)} disabled={disabled}><span /></button></div>;
}

function RunStatus({ run, isPreview }: { run: SyncRun; isPreview: boolean }) {
  return <span className={cn("run-status", run.status === "completed" ? "success" : "danger")}>{run.status === "completed" ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}{isPreview ? "示例" : run.status === "completed" ? "完成" : "失败"}</span>;
}

function runNote(run: SyncRun): string {
  if (run.errorMessage && /auth(?:entication)?|登录|认证/i.test(run.errorMessage)) {
    return "旧版本记录；请使用 v0.1.2 重新同步";
  }
  return run.errorMessage ?? `${run.pages} 页`;
}

export function SettingsView({ data, isPreview, error, onSchedule, onShowChips, onExportJson, onExportCsv, onOpenOnboarding, onClearData, storageModel: providedStorageModel, storageBusy = null, onRepairCovers = () => undefined, onMaintainData = () => undefined, onChooseBackup = () => undefined, onImportFile = () => undefined, maintenanceResult = null }: { data: DashboardData; isPreview: boolean; error: string | null; onSchedule: (enabled: boolean, interval: number) => void; onShowChips: (enabled: boolean) => void; onExportJson: () => void; onExportCsv: () => void; onOpenOnboarding: () => void; onClearData?: () => void; storageModel?: StorageCenterModel; storageBusy?: "covers" | "maintenance" | "import" | "backup" | null; onRepairCovers?: () => void; onMaintainData?: () => void; onChooseBackup?: () => void; onImportFile?: (file: File) => void; maintenanceResult?: MaintenanceResult | null }) {
  const storageModel = providedStorageModel ?? storageCenterModel(data, null);
  const supportedIntervals = [0.5, 1, 2, 4, 12, 24] as const;
  const configuredInterval = supportedIntervals.includes(data.settings.syncIntervalHours as (typeof supportedIntervals)[number]) ? data.settings.syncIntervalHours : 1;
  const scheduleValue = data.settings.scheduledSyncEnabled ? String(configuredInterval) : "manual";
  return (
    <div className="view-stack settings-view">
      <section className="list-toolbar"><div><p className="eyebrow">LOCAL CONTROL ROOM</p><h2>数据与设置</h2><p className="toolbar-caption">同步策略、导出和限制都在这里；没有遥测，也没有云端账号。</p></div><button type="button" className="secondary-button" onClick={onOpenOnboarding}><Info size={16} aria-hidden="true" />重新查看首次说明</button></section>
      {error && <div className="error-banner" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>后台连接异常</strong><p>{error}</p></div></div>}
      <section className="setting-section"><div className="section-heading"><div><p className="eyebrow">SYNC POLICY</p><h2>同步策略</h2></div><CalendarClock size={19} aria-hidden="true" /></div><p className="setting-note"><Clock3 size={14} aria-hidden="true" />统计与自动采样统一使用 {BUSINESS_TIME_ZONE_LABEL}；手动同步不会改变自动时刻。</p><Toggle checked={data.settings.scheduledSyncEnabled} onChange={(value) => onSchedule(value, configuredInterval)} label="启用自动同步" description="按北京时间固定刻度运行，例如每 30 分钟固定在整点和半点；必要时会打开临时 Pixiv 标签页并自动关闭。" /><div className="setting-select-row"><div><strong>同步方式与间隔</strong><p>选择“仅手动”即可关闭自动采样；休眠恢复后不会密集补跑。</p></div><label className="select-field"><Clock3 size={15} aria-hidden="true" /><span className="sr-only">同步方式与间隔</span><select value={scheduleValue} onChange={(event) => { const value = event.currentTarget.value; onSchedule(value !== "manual", value === "manual" ? configuredInterval : Number(value)); }}><option value="manual">仅手动</option><option value="0.5">每 30 分钟</option><option value="1">每 1 小时</option><option value="2">每 2 小时</option><option value="4">每 4 小时</option><option value="12">每 12 小时</option><option value="24">每天</option></select></label></div><Toggle checked={data.settings.showPixivChips} onChange={onShowChips} label="在 Pixiv 页面显示轻量提示" description="只显示同步状态小标记；不改变作品页面内容。" /></section>
      <div className="settings-grid"><DataTransferSection isPreview={isPreview} importDisabled={isPreview} importing={storageBusy === "import"} onExportJson={onExportJson} onExportCsv={onExportCsv} onImportFile={onImportFile} /><section className="setting-section"><div className="section-heading"><div><p className="eyebrow">RETENTION RESULT</p><h2>最近整理结果</h2></div><Database size={19} aria-hidden="true" /></div>{maintenanceResult ? <p className="setting-note" role="status"><CheckCircle2 size={14} aria-hidden="true" />保留 {formatCount(maintenanceResult.retainedSamples)} 条样本，删除 {formatCount(maintenanceResult.deletedSamples ?? 0)} 条；{maintenanceResult.pendingReason ? maintenancePendingLabel(maintenanceResult.pendingReason) : "本地整理已完成"}。</p> : <p className="section-description">自动整理在同步后低频执行。前三天完整保留，超过三天后逐级抽稀；写入和删除在同一个浏览器本地事务中完成。</p>}</section></div>
      <StorageCenter model={storageModel} disabled={isPreview} busyAction={storageBusy} onRepairCovers={onRepairCovers} onMaintain={onMaintainData} onChooseBackup={onChooseBackup} />
      <section className="setting-section"><div className="section-heading"><div><p className="eyebrow">PRIVACY & LIMITATIONS</p><h2>隐私与口径</h2></div><Home size={19} aria-hidden="true" /></div><div className="limitation-list"><p><Check size={16} aria-hidden="true" /><span>作品、快照、观察记录和同步日志都只保存在扩展自己的本地存储中。</span></p><p><Check size={16} aria-hidden="true" /><span>浏览量来自 Pixiv 作品管理页，包含作品详情页与 Home 信息流统计；它不同于 Premium Access Analytics。</span></p><p><Check size={16} aria-hidden="true" /><span>缩略图会直接联系 <code>i.pximg.net</code> CDN；加载失败时使用本地占位图。Pixiv 改版也可能影响解析。</span></p><p><Check size={16} aria-hidden="true" /><span>第一次同步只能建立基线，无法重建安装前的增长；没有足够历史时，洞察会明确显示样本不足。</span></p></div></section>
      <section className="setting-section danger-section"><div className="section-heading"><div><p className="eyebrow">ACCOUNT BINDING</p><h2>当前账号</h2></div><Trash2 size={19} aria-hidden="true" /></div><AccountIdentity account={data.settings.boundAccount} /><p className="section-description">清空后，所有本地 PixivPulse 历史都会被删除；下一次同步会绑定当前已登录的 Pixiv 账号。</p><button type="button" className="danger-button" onClick={() => onClearData?.()}><Trash2 size={16} aria-hidden="true" />清空本地数据并重新绑定</button></section>
      <section className="setting-section history-section"><div className="section-heading"><div><p className="eyebrow">SYNC HISTORY</p><h2>同步记录</h2></div><span className="section-note">最近 {Math.min(10, data.runs.length)} 次</span></div>{data.runs.length === 0 ? <p className="muted-copy">尚无同步记录。完成第一次同步后，状态和错误会显示在这里。</p> : <div className="history-table-wrap"><table className="history-table"><thead><tr><th>时间</th><th>触发方式</th><th>结果</th><th>作品</th><th>变化</th><th>备注</th></tr></thead><tbody>{data.runs.slice(0, 10).map((run) => <tr key={run.runId}><td>{formatTimestamp(run.finishedAt ?? run.startedAt)}</td><td>{run.trigger === "scheduled" ? "定时" : run.trigger === "recovery" ? "恢复" : run.trigger === "passive" ? "页面观察" : "手动"}</td><td><RunStatus run={run} isPreview={isPreview} /></td><td>{run.works}</td><td>{run.changedWorks}</td><td>{runNote(run)}</td></tr>)}</tbody></table></div>}</section>
    </div>
  );
}

function absoluteGrowthPoints(timeline: WorkTimelinePoint[], metric: DashboardChartMetric): ChartTimePoint[] {
  return timeline
    .slice()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .flatMap((point, sequence) => {
      const value = point.metrics[metric];
      return value == null || !Number.isFinite(value) || !Number.isFinite(Date.parse(point.at))
        ? []
        : [{ at: point.at, value, runId: point.runId, sequence }];
    });
}

function GrowthChart({ workKey, samples, observations, observationBatches = [] }: { workKey: string; samples: WorkSample[]; observations: DashboardData["observations"]; observationBatches?: DashboardData["observationBatches"] }) {
  const [metric, setMetric] = useState<DashboardChartMetric>("views");
  const [rangeValue, setRangeValue] = useState<ChartRangeControlValue>(DEFAULT_CHART_RANGE);
  const range = useMemo(() => resolvedRange(rangeValue), [rangeValue]);
  const timeline = useMemo(() => range ? buildWorkTimeline(workKey, samples, observations, range, observationBatches) : [], [observationBatches, observations, range, samples, workKey]);
  const points = useMemo(() => absoluteGrowthPoints(timeline, metric), [metric, timeline]);
  const option = useMemo(() => buildGrowthChartOption({ points, metric }), [metric, points]);
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  return (
    <div className="chart-panel" data-testid="growth-chart">
      <div className="chart-control-row"><MetricSelector value={metric} onChange={setMetric} label="作品增长图表指标" /><ChartRangeControl value={rangeValue} onChange={setRangeValue} /></div>
      <EChartsHost
        option={option}
        hasData={points.length >= 2}
        ariaLabel={`${label}绝对总数折线图`}
        emptyMessage={range ? "所选范围内至少需要两次有效观察。" : "请先选择有效的起止时间。"}
        summary={`${label}按绝对总数绘制，共 ${formatCount(points.length)} 个有效采样点；横轴按北京时间的真实采样时刻绘制。`}
        height={238}
      />
    </div>
  );
}

const CHANGE_METRICS = ["views", "likes", "bookmarks", "comments"] as const;

function changeEvents(history: WorkSample[]): Array<{ sample: WorkSample; delta: Pick<WorkMetrics, (typeof CHANGE_METRICS)[number]> }> {
  const changes = history.filter((sample) => sample.kind === "change");
  return changes.map((sample, index) => {
    const previous = changes[index - 1] ?? null;
    const delta = {} as Pick<WorkMetrics, (typeof CHANGE_METRICS)[number]>;
    for (const key of CHANGE_METRICS) {
      const currentValue = sample.metrics[key];
      const previousValue = previous?.metrics[key] ?? null;
      delta[key] = currentValue == null || previousValue == null ? null : currentValue - previousValue;
    }
    return { sample, delta };
  });
}

export function DetailDrawer({ analysis, intraday, samples, observations = [], observationBatches = [], onClose }: { analysis: WorkAnalysis; intraday?: IntradayWorkAnalysis | null; samples?: WorkSample[]; observations?: DashboardData["observations"]; observationBatches?: DashboardData["observationBatches"]; onClose: () => void }) {
  const history = samples && samples.length > 0
    ? samplesForWork(samples, analysis.work.key)
    : samplesForWork(analysis.sparkline.map((point, index) => {
      const richPoint = point as typeof point & { comments?: number | null; rank?: number | null; rankingStatus?: unknown; rankingObservedAt?: unknown; rankingSource?: unknown };
      return {
        workKey: analysis.work.key,
        runId: `history-${index}`,
        collectedAt: point.at,
        metrics: { views: point.views, likes: point.likes, bookmarks: point.bookmarks, comments: richPoint.comments ?? null, rank: richPoint.rank ?? null, responses: null, illustrations: null },
        rankingStatus: richPoint.rankingStatus,
        rankingObservedAt: richPoint.rankingObservedAt,
        rankingSource: richPoint.rankingSource,
        parserVersion: 1,
        dataQuality: 1,
        kind: "change" as const,
      } as WorkSample;
    }), analysis.work.key);
  const rankingHistory: RankingObservation[] = samples && samples.length > 0 ? rankingHistoryForWork(analysis.work, samples) : rankingHistoryForAnalysis(analysis);
  const events = changeEvents(history);
  const metrics = currentMetrics(analysis);
  const metricCards: Array<{ key: keyof WorkMetrics; icon: ReactNode }> = [
    { key: "views", icon: <Eye size={16} /> },
    { key: "likes", icon: <Heart size={16} /> },
    { key: "bookmarks", icon: <BookOpen size={16} /> },
    { key: "comments", icon: <MessageCircle size={16} /> },
    { key: "rank", icon: <TrendingUp size={16} /> },
    { key: "responses", icon: <Activity size={16} /> },
  ];
  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={`${analysis.work.title}详情`}>
        <div className="drawer-header"><div><p className="eyebrow">WORK DETAIL</p><h2>{analysis.work.title}</h2><p>{contentTypeLabel(contentTypeForWork(analysis.work))} · {analysis.work.id} · {workConfidence(analysis)}</p></div><IconButton label="关闭作品详情" onClick={onClose}><X size={19} /></IconButton></div>
        <div className="drawer-scroll">
          <div className="drawer-work-meta"><Thumbnail work={analysis.work} /><div><strong>{intraday ? `今日 ${formatCount(intraday.sampleCount)} 次观察` : "今日暂无采样"}</strong><span>{intraday ? baselineLabel(intraday.baselineLabel) : "今日无记录"} · {analysis.latestSample ? formatElapsed(analysis.lastDelta.views.elapsedHours).replace("上次采样", "上次变化") : "暂无变化记录"}</span></div><a href={analysis.work.workUrl} target="_blank" rel="noreferrer" className="external-link">打开 Pixiv <ExternalLink size={14} aria-hidden="true" /> </a></div>
          <div className="detail-metric-grid">{metricCards.map((item) => { const todayValue = todayDelta(intraday, item.key); const historicalValue = analysis.lastDelta[item.key].value; return <div className="detail-metric" key={item.key}><span>{item.icon}{METRIC_LABELS[item.key]}</span><strong>{formatCount(metrics[item.key])}</strong><small className={cn(todayValue !== null && todayValue > 0 && "positive", todayValue !== null && todayValue < 0 && "negative")}>{todayValue === null ? "今日暂无" : `今日 ${formatDelta(todayValue)}`}</small><small className="long-term">{historicalValue === null ? "相邻变化暂无" : `相邻变化 ${formatDelta(historicalValue)}`}</small></div>; })}</div>
          <section className="drawer-section"><div className="section-heading"><div><p className="eyebrow">ABSOLUTE METRIC HISTORY</p><h3>指标绝对值</h3></div><span className="section-note">默认近24小时 · 真实时间间隔</span></div><GrowthChart workKey={analysis.work.key} samples={history} observations={observations} observationBatches={observationBatches} /></section>
          <section className="drawer-section"><div className="section-heading"><div><p className="eyebrow">CHANGE EVENTS</p><h3>逐次变化记录</h3></div><span className="section-note">{events.length} 次</span></div>{events.length === 0 ? <EmptyState icon={<Clock3 size={20} />} title="还没有变化记录" body="完成同步并捕获到指标变化后，这里会逐次显示四项变化。" /> : <div className="change-event-list">{events.slice().reverse().map(({ sample, delta }, index) => <div className="change-event-row" key={`${sample.runId}-${sample.collectedAt}-${index}`}><div className="change-event-heading"><strong>{index === 0 ? "最近变化" : `变化 ${events.length - index}`}</strong><span>{formatTimestamp(sample.collectedAt)} · UTC+8</span></div><div className="change-event-metrics"><span>浏览 <strong>{formatDelta(delta.views)}</strong></span><span>赞 <strong>{formatDelta(delta.likes)}</strong></span><span>收藏 <strong>{formatDelta(delta.bookmarks)}</strong></span><span>评论 <strong>{formatDelta(delta.comments)}</strong></span></div></div>)}</div>}</section>
          {rankingHistory.length > 0 && <section className="drawer-section ranking-history-section"><div className="section-heading"><div><p className="eyebrow">RANKING HISTORY</p><h3>排名记录</h3></div><span className="section-note">{rankingHistory.length} 次</span></div><div className="ranking-history-list">{rankingHistory.slice().reverse().map((event) => <div className="ranking-history-row" key={`${event.status}-${event.observedAt}`}><span className={cn("snapshot-dot", event.status === "unranked" && "unranked-dot")} /><div><strong>{rankingStatusLabel(event.status)}</strong><small>{event.status === "ranked" ? `当前 #${event.rank}` : "当前未上榜"} · {formatTimestamp(event.observedAt)} · {rankingSourceLabel(event.source)}</small></div></div>)}</div></section>}
        </div>
      </aside>
    </div>
  );
}

function OnboardingModal({ onConfirm, onLater, onClose, error }: { onConfirm: (scheduled: boolean) => void | Promise<void>; onLater: () => void | Promise<void>; onClose: () => void | Promise<void>; error?: string | null }) {
  const [scheduled, setScheduled] = useState(true);
  return (
    <div className="modal-layer" role="presentation">
      <section className="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="modal-topline"><span className="modal-mark"><Activity size={21} aria-hidden="true" /></span><IconButton label="关闭首次使用说明" onClick={onClose}><X size={19} /></IconButton></div>
        <p className="eyebrow">FIRST SYNC</p><h2 id="onboarding-title">先建立你的增长基线</h2><p className="modal-lead">PixivPulse 只在本机记录当前已登录 Pixiv 账号的作品管理页快照。第一次同步不判断增长，它只回答：从今天开始，你的作品是什么状态。</p>
        <div className="onboarding-points"><p><span>01</span><strong>历史从今天开始</strong><small>首次同步建立基线，无法重建安装前的增长。</small></p><p><span>02</span><strong>口径来自作品管理页</strong><small>浏览量包含作品详情页与 Home 信息流统计，不等同于 Premium Access Analytics。</small></p><p><span>03</span><strong>后台采集是可控的</strong><small>后台优先，必要时会打开临时 Pixiv 标签页，完成后自动关闭；浏览器关闭或设备休眠时不会补发密集请求。</small></p><p><span>04</span><strong>数据只留在本机</strong><small>所有作品、快照和同步记录都只保存在本机；缩略图仍会联系 Pixiv CDN。</small></p></div>
        <fieldset className="schedule-choice"><legend>同步方式</legend><label className={cn(!scheduled && "selected")}><input type="radio" name="onboarding-schedule" checked={!scheduled} onChange={() => setScheduled(false)} /><span><HandIcon /><strong>仅手动同步</strong><small>由你决定何时读取当前登录的 Pixiv 账号。</small></span></label><label className={cn(scheduled && "selected")}><input type="radio" name="onboarding-schedule" checked={scheduled} onChange={() => setScheduled(true)} /><span><CalendarClock size={17} aria-hidden="true" /><strong>每 1 小时自动同步</strong><small>按每小时采样，始终只读；可在设置中调整间隔。</small></span></label></fieldset>
        {error && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</p>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={() => void onLater()}>稍后设置</button><button type="button" className="primary-button" onClick={() => void onConfirm(scheduled)}>保存并开始第一次同步 <ArrowUpRight size={16} aria-hidden="true" /></button></div>
      </section>
    </div>
  );
}

export function ClearDataModal({ busy, error, onCancel, onConfirm }: { busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-layer" role="presentation">
      <section className="clear-modal" role="dialog" aria-modal="true" aria-labelledby="clear-data-title">
        <div className="modal-topline"><span className="modal-mark danger-mark"><Trash2 size={21} aria-hidden="true" /></span><IconButton label="取消清空本地数据" onClick={onCancel} disabled={busy}><X size={19} /></IconButton></div>
        <p className="eyebrow">DANGER ZONE</p>
        <h2 id="clear-data-title">清空本地数据并重新绑定？</h2>
        <p className="modal-lead">所有本地 PixivPulse 历史（作品、快照、观察和同步记录）将被永久删除；下一次同步会绑定当前已登录的 Pixiv 账号。此操作不可撤销。</p>
        {error && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={busy}><Trash2 size={16} aria-hidden="true" />{busy ? "正在清空…" : "确认清空并重新绑定"}</button></div>
      </section>
    </div>
  );
}

function HandIcon() {
  return <span className="hand-icon" aria-hidden="true">⌁</span>;
}

const contentCountsForRun = (data: DashboardData, run: SyncRun): Record<WorkContentType, number> => {
  const counts: Record<WorkContentType, number> = {
    novel: 0,
    illustration: 0,
    manga: 0,
    ugoira: 0,
    unknown: 0,
  };
  if (run.works <= 0) return counts;

  const directlyObserved = data.works.filter((work) => work.lastObservedRunId === run.runId);
  // Exported/legacy fixtures may not carry the run id. Only use all records
  // when their cardinality exactly matches the completed run; otherwise leave
  // the unmatched portion explicitly as unknown instead of mislabelling it.
  const fallbackWorks = directlyObserved.length > 0
    ? directlyObserved
    : data.works.length === run.works ? data.works : [];
  fallbackWorks.forEach((work) => { counts[contentTypeForWork(work)] += 1; });
  counts.unknown += Math.max(0, run.works - fallbackWorks.length);
  return counts;
};

function SyncResultBanner({ data, run, onViewAll, onClose }: { data: DashboardData; run: SyncRun; onViewAll: () => void; onClose: () => void }) {
  if (run.works <= 0) {
    return <section className="sync-result-toast empty-result" role="status" aria-live="polite"><CheckCircle2 size={19} aria-hidden="true" /><div><strong>已完成读取，Pixiv 返回 0 件作品</strong><p>本次同步没有可保存的作品记录。</p></div><IconButton label="关闭同步结果" onClick={onClose}><X size={16} /></IconButton></section>;
  }
  const counts = contentCountsForRun(data, run);
  const contentSummary = (["novel", "illustration", "manga", "ugoira", "unknown"] as WorkContentType[])
    .filter((type) => counts[type] > 0)
    .map((type) => `${contentTypeLabel(type)} ${formatCount(counts[type])}`)
    .join(" · ");
  return <section className="sync-result-toast" role="status" aria-live="polite"><CheckCircle2 size={19} aria-hidden="true" /><div><strong>已收集 {formatCount(run.works)} 件作品</strong><p>{contentSummary}</p></div><button type="button" className="text-button sync-result-view" onClick={onViewAll}>查看全部作品 <ChevronRight size={14} aria-hidden="true" /></button><IconButton label="关闭同步结果" onClick={onClose}><X size={16} /></IconButton></section>;
}

function storageCenterModel(data: DashboardData, info: StorageCenterInfo | null): StorageCenterModel {
  const cover = data.coverCache ?? { ready: 0, pending: 0, failed: 0, skipped: 0, bytes: 0, total: 0 };
  const tiers = info?.tiers;
  return {
    originUsageBytes: info?.originUsageBytes ?? null,
    originQuotaBytes: info?.originQuotaBytes ?? null,
    logical: info?.logical ?? { works: data.works.length, samples: data.samples.length, observationBatches: data.observationBatches?.length ?? 0, coverBytes: cover.bytes },
    covers: { ready: cover.ready, pending: cover.pending, failed: cover.failed, total: cover.total },
    tiers: [
      { key: "fresh", label: "近 3 天", count: tiers?.lossless ?? data.samples.filter((sample) => !sample.compactionLevel).length, description: "完整保留" },
      { key: "30m", label: "3–7 天", count: tiers?.["30m"] ?? 0, description: "每 30 分钟" },
      { key: "1h", label: "7–30 天", count: tiers?.["1h"] ?? 0, description: "每 1 小时" },
      { key: "6h", label: "30 天以上", count: tiers?.["6h"] ?? 0, description: "每 6 小时" },
    ],
    backup: info?.backup ?? { configured: false, directoryName: null, permission: "unknown", pendingFrames: 0, lastSuccessAt: null, lastFileName: null, lastError: null },
  };
}

function maintenancePendingLabel(reason: string): string {
  if (reason === "backup-directory-required") return "等待选择抽稀前备份目录";
  if (reason === "backup-verification-failed") return "备份写入或复验失败，抽稀已暂停";
  if (reason === "revision-race") return "数据刚刚更新，将在下一轮重试";
  return `等待处理：${reason}`;
}

interface ImportDialogState {
  fileName: string;
  preview: PortableDocumentPreview;
  plan: PortableImportPlan;
  sessionId: string;
  checksum: string;
}

function sameAnalysisInputs(left: DashboardData, right: DashboardData): boolean {
  return left.works === right.works && left.samples === right.samples;
}

function sameIntradayInputs(left: DashboardData, right: DashboardData): boolean {
  return sameAnalysisInputs(left, right)
    && left.observations === right.observations
    && left.observationBatches === right.observationBatches
    && left.settings.syncIntervalHours === right.settings.syncIntervalHours;
}

function sameOverviewPayload(left: DashboardData, right: DashboardData): boolean {
  return sameIntradayInputs(left, right)
    && left.runs === right.runs
    && left.accountFollowerSamples === right.accountFollowerSamples
    && left.settings === right.settings;
}

export function DashboardApp({ bootstrapRequest = null }: { bootstrapRequest?: DashboardDataRequest | null }) {
  const controller = useDashboardData(bootstrapRequest);
  const { data } = controller;
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [legacyOnboardingSeen] = useState(readLegacyOnboardingSeen);
  const [onboardingClosed, setOnboardingClosed] = useState(legacyOnboardingSeen);
  const [forcedOnboardingOpen, setForcedOnboardingOpen] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [syncResultRun, setSyncResultRun] = useState<SyncRun | null>(null);
  const [pendingManualRunId, setPendingManualRunId] = useState<string | null>(null);
  const latestControllerDataRef = useRef(data);
  latestControllerDataRef.current = data;
  const [overviewPresentation, setOverviewPresentation] = useState(() => ({ data, animationEpoch: 0 }));
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<MaintenanceResult | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageCenterInfo | null>(null);
  const [storageBusy, setStorageBusy] = useState<"covers" | "maintenance" | "import" | "backup" | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const beijingDateRevision = useBeijingDateRevision();
  const analyses = useMemo(() => analyzeDashboard(data), [data.works, data.samples]);
  const overviewAnalyses = useMemo(() => sameAnalysisInputs(overviewPresentation.data, data) ? analyses : analyzeDashboard(overviewPresentation.data), [analyses, data.works, data.samples, overviewPresentation.data.works, overviewPresentation.data.samples]);
  const intraday = useMemo(() => buildIntradayAnalytics({
    works: data.works,
    samples: data.samples,
    observations: data.observations,
    observationBatches: data.observationBatches ?? [],
    now: Date.now(),
    configuredIntervalHours: data.settings.syncIntervalHours,
  }), [beijingDateRevision, data.works, data.samples, data.observations, data.observationBatches, data.settings.syncIntervalHours]);
  const overviewIntraday = useMemo(() => sameIntradayInputs(overviewPresentation.data, data) ? intraday : buildIntradayAnalytics({
    works: overviewPresentation.data.works,
    samples: overviewPresentation.data.samples,
    observations: overviewPresentation.data.observations,
    observationBatches: overviewPresentation.data.observationBatches ?? [],
    now: Date.now(),
    configuredIntervalHours: overviewPresentation.data.settings.syncIntervalHours,
  }), [beijingDateRevision, data.observationBatches, data.observations, data.samples, data.settings.syncIntervalHours, data.works, intraday, overviewPresentation.data.observationBatches, overviewPresentation.data.observations, overviewPresentation.data.samples, overviewPresentation.data.settings.syncIntervalHours, overviewPresentation.data.works]);
  const intradayByWork = useMemo(() => new Map(intraday.works.map((work) => [work.workKey, work] as const)), [intraday]);
  const selectedAnalysis = selectedKey ? analyses.find((analysis) => analysis.work.key === selectedKey) ?? null : null;
  const selectedIntraday = selectedKey ? intradayByWork.get(selectedKey) ?? null : null;
  const newestCompletedRun = useMemo(() => latestCompletedRun(data.runs), [data.runs]);
  const shouldShowOnboarding = controller.hasLoadedData && !controller.isLoading && (forcedOnboardingOpen || (!onboardingClosed && !data.settings.onboardingComplete));
  const storageModel = useMemo(() => storageCenterModel(data, storageInfo), [data, storageInfo]);

  useEffect(() => {
    if (activeTab !== "settings" || controller.isPreview) return;
    let active = true;
    void controller.getStorageCenter().then((result) => { if (active) setStorageInfo(result); });
    return () => { active = false; };
  }, [activeTab, controller.getStorageCenter, controller.isPreview, data.coverCache, data.samples.length]);

  useEffect(() => {
    if (controller.isLoading) return;
    if (pendingManualRunId === null) {
      setOverviewPresentation((current) => sameOverviewPayload(current.data, data) ? current : { ...current, data });
      return;
    }
    // An empty ID means START_SYNC has not returned its assigned generation yet.
    if (!pendingManualRunId) return;

    const targetRun = data.runs.find((run) => run.runId === pendingManualRunId) ?? null;
    if (targetRun?.status === "completed") {
      setOverviewPresentation((current) => ({ data, animationEpoch: current.animationEpoch + 1 }));
      setSyncResultRun(targetRun);
      setPendingManualRunId(null);
      return;
    }

    const targetFailed = targetRun?.status === "failed"
      || (data.syncState?.runId === pendingManualRunId && data.syncState.status === "failed");
    if (targetFailed || controller.error) {
      setOverviewPresentation((current) => ({ ...current, data }));
      setPendingManualRunId(null);
    }
  }, [controller.error, controller.isLoading, data, pendingManualRunId]);

  useEffect(() => {
    if (!legacyOnboardingSeen || controller.isLoading) return;
    if (data.settings.onboardingComplete) {
      clearLegacyOnboardingSeen();
      return;
    }
    let active = true;
    void controller.completeOnboarding().then((result) => {
      if (active && result !== false) clearLegacyOnboardingSeen();
    });
    return () => { active = false; };
  }, [controller.completeOnboarding, controller.isLoading, data.settings.onboardingComplete, legacyOnboardingSeen]);

  useEffect(() => {
    if (!statusToast) return;
    const timeout = window.setTimeout(() => setStatusToast(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [statusToast]);

  const openWork = (key: string) => {
    setSelectedKey(key);
    setActiveTab("works");
  };
  const handleSync = async () => {
    if (pendingManualRunId !== null) return;
    setPendingManualRunId("");
    const runId = await controller.startSync();
    if (runId) {
      setPendingManualRunId(runId);
      return;
    }
    setOverviewPresentation((current) => ({ ...current, data: latestControllerDataRef.current }));
    setPendingManualRunId(null);
  };
  const toggleCompare = (key: string) => setCompareKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : current.length < MAX_COMPARE_WORKS ? [...current, key] : current);
  const openOnboarding = () => {
    setOnboardingError(null);
    setForcedOnboardingOpen(true);
  };
  const dismissOnboarding = async (showToast: boolean) => {
    setOnboardingError(null);
    setOnboardingClosed(true);
    setForcedOnboardingOpen(false);
    markLegacyOnboardingSeen();
    const persisted = await controller.completeOnboarding();
    if (showToast) {
      setStatusToast(persisted === false
        ? "首次说明已关闭，但状态保存失败；可稍后在「数据与设置」中重试。"
        : "首次说明已关闭。可随时在「数据与设置」→「重新查看首次说明」中打开。");
    } else if (persisted === false) {
      setStatusToast("首次说明已关闭，但状态保存失败；可在「数据与设置」中重试。");
    }
  };
  const finishOnboarding = async (scheduled: boolean) => {
    setOnboardingError(null);
    setForcedOnboardingOpen(true);
    markLegacyOnboardingSeen();
    const persisted = await controller.completeOnboarding();
    if (persisted === false) {
      setOnboardingError(controller.error ?? "首次说明状态暂时无法保存，请稍后重试。");
      return;
    }
    clearLegacyOnboardingSeen();
    setOnboardingClosed(true);
    setForcedOnboardingOpen(false);
    await controller.setSchedule(scheduled, 1);
    await handleSync();
  };
  const exportJson = async () => {
    try {
      const backup = await createNativePortableBackup({ account: data.settings.boundAccount ?? null, settings: data.settings });
      triggerDownload(canonicalJson(backup), `pixivpulse-backup-${beijingExportDate(Date.now())}.json`, "application/json;charset=utf-8");
    } catch (exportError) {
      setStatusToast(exportError instanceof Error ? exportError.message : "JSON 备份生成失败");
    }
  };
  const exportCsv = async () => {
    try {
      const backup = await createNativePortableBackup({ account: data.settings.boundAccount ?? null, settings: data.settings });
      triggerDownload(portableBackupToCsv(backup), `pixivpulse-backup-${beijingExportDate(Date.now())}.csv`, "text/csv;charset=utf-8");
    } catch (exportError) {
      setStatusToast(exportError instanceof Error ? exportError.message : "CSV 备份生成失败");
    }
  };
  const maintainData = async () => {
    if (maintenanceBusy) return;
    setMaintenanceBusy(true);
    setStorageBusy("maintenance");
    setMaintenanceResult(null);
    const result = await controller.maintainLocalData();
    setMaintenanceBusy(false);
    setStorageBusy(null);
    if (result) {
      setMaintenanceResult(result);
      setStatusToast(result.pendingReason
        ? maintenancePendingLabel(result.pendingReason)
        : `本地数据整理完成，保留 ${formatCount(result.retainedSamples)} 条历史样本。`);
      await refreshStorageInfo();
    } else {
      setStatusToast(controller.error ?? "本地数据整理失败，请稍后重试。");
    }
  };
  const refreshStorageInfo = async () => setStorageInfo(await controller.getStorageCenter());
  const configureBackupDirectory = async () => {
    if (storageBusy) return;
    setStorageBusy("backup");
    try {
      const config = await chooseBackupDirectory();
      await refreshStorageInfo();
      setStatusToast(`抽稀前备份目录已设为 ${config.directoryName}`);
    } catch (backupError) {
      if (backupError instanceof DOMException && backupError.name === "AbortError") return;
      setStatusToast(backupError instanceof Error ? backupError.message : "备份目录授权失败");
    } finally {
      setStorageBusy(null);
    }
  };
  const repairCovers = async () => {
    setStorageBusy("covers");
    const success = await controller.repairCovers();
    setStorageBusy(null);
    await controller.refresh();
    await refreshStorageInfo();
    setStatusToast(success ? "已登记全部缺失或失效封面，后台会按低频队列逐张补齐。" : controller.error ?? "封面检查失败");
  };
  const previewImport = async (file: File) => {
    setStorageBusy("import");
    setImportError(null);
    try {
      const text = await decodePortableBytes(new Uint8Array(await file.arrayBuffer()));
      const preview = await parsePortableBackupDocument(text, { localAccountId: data.settings.boundAccount?.id ?? null, localIsEmpty: data.works.length === 0 && data.samples.length === 0 });
      const plan = buildPortableImportPlan({ works: data.works, samples: data.samples, accountFollowerSamples: accountFollowerSamplesFor(data), observationBatches: data.observationBatches ?? [], runs: data.runs }, preview.logicalPayload);
      const staged = await stagePortableImport(preview);
      setImportDialog({ fileName: file.name, preview, plan, sessionId: staged.sessionId, checksum: staged.checksum });
    } catch (readError) {
      setStatusToast(readError instanceof Error ? readError.message : "备份文件读取失败");
    } finally {
      setStorageBusy(null);
    }
  };
  const cancelImport = async () => {
    const current = importDialog;
    setImportDialog(null);
    setImportError(null);
    if (current) await discardStagedPortableImport(current.sessionId).catch(() => undefined);
  };
  const confirmImport = async () => {
    if (!importDialog || storageBusy) return;
    setStorageBusy("import");
    setImportError(null);
    try {
      const result = await commitStagedPortableImport(importDialog.sessionId, importDialog.checksum);
      setImportDialog(null);
      await controller.refresh();
      await refreshStorageInfo();
      setStatusToast(`导入完成：新增 ${result.works} 件作品、${result.samples} 条样本，跳过 ${result.duplicates} 条重复记录。`);
      void controller.repairCovers();
    } catch (commitError) {
      setImportError(commitError instanceof Error ? commitError.message : "导入事务失败");
    } finally {
      setStorageBusy(null);
    }
  };
  const requestClearData = () => {
    setClearError(null);
    setClearModalOpen(true);
  };
  const confirmClearData = async () => {
    setClearBusy(true);
    setClearError(null);
    const success = await controller.clearLocalData();
    setClearBusy(false);
    if (success) {
      setClearModalOpen(false);
      setSelectedKey(null);
      setCompareKeys([]);
      setActiveTab("overview");
      setOnboardingClosed(false);
      return;
    }
    setClearError(controller.error ?? "清空失败，请稍后重试。");
  };
  return (
    <div className={cn("app-shell", controller.isPreview && "preview-mode")}>
      <Sidebar activeTab={activeTab} onChange={setActiveTab} onOpenOnboarding={openOnboarding} />
      <main className="dashboard-main">
        <Header activeTab={activeTab} data={data} isPreview={controller.isPreview} isLoading={controller.isLoading} hasLoadedData={controller.hasLoadedData} isSyncing={controller.isSyncing} onSync={() => void handleSync()} />
        {controller.isPreview && <div className="preview-banner" role="status"><Sparkles size={16} aria-hidden="true" /><span><strong>预览数据</strong> · 当前浏览器未连接扩展后台，下面是可交互的本地示例，不代表已完成真实同步。</span></div>}
        <div className="dashboard-content">{controller.isLoading && !controller.isPreview ? <DashboardInitialLoading /> : !controller.hasLoadedData && controller.error ? <DashboardInitialError error={controller.error} onRetry={() => void controller.refresh()} /> : <>{activeTab === "overview" && <OverviewView analyses={overviewAnalyses} data={overviewPresentation.data} intraday={overviewIntraday} onOpenWork={openWork} onGoToWorks={() => setActiveTab("works")} animationSignal={overviewPresentation.animationEpoch} />}{activeTab === "works" && <WorksView analyses={analyses} intradayByWork={intradayByWork} compareKeys={compareKeys} onToggleCompare={toggleCompare} onOpenWork={openWork} completedRunWorks={newestCompletedRun?.works ?? null} coverCache={data.coverCache} />}{activeTab === "compare" && <CompareView analyses={analyses} compareKeys={compareKeys} onToggleCompare={toggleCompare} onOpenWork={openWork} data={data} />}{activeTab === "settings" && <SettingsView data={data} isPreview={controller.isPreview} error={controller.error} onSchedule={(enabled, interval) => void controller.setSchedule(enabled, interval)} onShowChips={(enabled) => void controller.setShowChips(enabled)} onExportJson={() => void exportJson()} onExportCsv={exportCsv} onOpenOnboarding={openOnboarding} onClearData={requestClearData} storageModel={storageModel} storageBusy={storageBusy} onRepairCovers={() => void repairCovers()} onMaintainData={() => void maintainData()} onChooseBackup={() => void configureBackupDirectory()} onImportFile={(file) => void previewImport(file)} maintenanceResult={maintenanceResult} />}</>}</div>
      </main>
      {selectedAnalysis && <DetailDrawer analysis={selectedAnalysis} intraday={selectedIntraday} samples={data.samples} observations={data.observations} observationBatches={data.observationBatches} onClose={() => setSelectedKey(null)} />}
      {shouldShowOnboarding && <OnboardingModal onConfirm={(scheduled) => void finishOnboarding(scheduled)} onLater={() => void dismissOnboarding(true)} onClose={() => void dismissOnboarding(false)} error={onboardingError} />}
      {clearModalOpen && <ClearDataModal busy={clearBusy} error={clearError} onCancel={() => { if (!clearBusy) setClearModalOpen(false); }} onConfirm={() => void confirmClearData()} />}
      {importDialog && <ImportPreviewModal fileName={importDialog.fileName} preview={importDialog.preview} plan={importDialog.plan} busy={storageBusy === "import"} error={importError} onCancel={() => void cancelImport()} onConfirm={() => void confirmImport()} />}
      {syncResultRun && <SyncResultBanner data={data} run={syncResultRun} onViewAll={() => setActiveTab("works")} onClose={() => setSyncResultRun(null)} />}
      {statusToast && <StatusToast message={statusToast} onClose={() => setStatusToast(null)} />}
    </div>
  );
}
