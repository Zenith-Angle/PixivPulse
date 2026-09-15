import { t } from "../i18n";
import { LanguagePicker } from "../i18n/LanguagePicker";
import { displayedSyncStatus, latestSyncResultAt } from "./syncPresentation";
import {
  lazy,
  Suspense,
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
import { IncrementChart, IncrementPreview } from "./IncrementChart";
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

const LazyAgentView = lazy(async () => {
  try { return { default: (await import("./AgentView")).AgentView }; }
  catch {
    // An unpacked extension update can remove a chunk still referenced by this tab.
    // Resolve to a recovery view rather than rejecting React.lazy or auto-reloading.
    return { default: function AgentLoadFailure() {
      return <section className="agent-empty" role="alert"><h2>{t("Agent 资源加载失败")}</h2><p>{t("扩展更新后，已打开的看板可能仍引用旧文件。请刷新看板以加载当前版本。")}</p><button type="button" className="secondary-button" onClick={() => window.location.reload()}>{t("刷新看板")}</button><p>{t("本机已保存的作品数据和对话记录不会被删除。")}</p></section>;
    } };
  }
});

export type DashboardTab = "overview" | "works" | "compare" | "agent" | "settings";

const TAB_LABELS: Record<DashboardTab, string> = {
  overview: t("总览"),
  works: t("作品"),
  compare: t("比较"),
  agent: t("Agent 分析"),
  settings: t("数据与设置"),
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

const baselineLabel = (label: IntradayPortfolioAnalysis["baselineLabel"]): string => label === "estimated" ? t("今日首测基线 · 接近日界") : t("今日首测基线 · 部分日");

const todayDelta = (analysis: IntradayWorkAnalysis | null | undefined, key: keyof WorkMetrics): number | null => analysis?.delta[key] ?? null;

const accountLabel = (account: PixivAccount | null | undefined): string => account?.name?.trim() || t("尚未绑定账号");

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
      ? t("封面获取失败，下次同步重试")
      : cover.state === "skipped-capacity"
        ? t("封面缓存空间已满")
        : cover.state === "unavailable" ? t("作品没有可用封面") : t("封面正在本地处理");
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
        alt={t("{p0} 封面", { p0: work.title })}
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
    { key: "overview", icon: <LayoutDashboard size={17} aria-hidden="true" />, hint: t("作品集动量、洞察和上升作品") },
    { key: "works", icon: <ImageIcon size={17} aria-hidden="true" />, hint: t("按作品查看真实采样变化") },
    { key: "compare", icon: <BarChart3 size={17} aria-hidden="true" />, hint: t("把两件作品的绝对值放在同一时间轴") },
    { key: "agent", icon: <Sparkles size={17} aria-hidden="true" />, hint: t("与你的模型对话，按需分析本地作品") },
    { key: "settings", icon: <Settings size={17} aria-hidden="true" />, hint: t("同步、导出和隐私限制") },
  ];
  return (
    <aside className={cn("sidebar", open && "sidebar-open")}>
      <div className="sidebar-topline">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); onChange("overview"); setOpen(false); }} aria-label={t("PixivPulse 总览")}>
          <img className="brand-mark" src="/icon/48.png" alt="" aria-hidden="true" draggable={false} />
          <span className="brand-copy"><strong>PixivPulse</strong><small>{t("作者增长追踪")}</small></span>
        </a>
        <IconButton label={open ? t("关闭导航") : t("打开导航")} className="mobile-menu-button" onClick={() => setOpen((current) => !current)}>
          {open ? <X size={19} /> : <Menu size={19} />}
        </IconButton>
      </div>
      <nav className="primary-nav" aria-label={t("主导航")}>
        <p className="nav-label">{t("看板")}</p>
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
        <LanguagePicker />
        <div className="local-badge"><span className="status-dot" />{t("数据保存在本机")}</div>
        <button type="button" className="help-link" onClick={onOpenOnboarding} title={t("重新查看首次使用说明")}><Info size={15} aria-hidden="true" />{t("使用说明")}</button>
        <p className="version-label">{t("PixivPulse 0.5.16 · 本地优先")}</p>
      </div>
    </aside>
  );
}

function AccountIdentity({ account, compact = false }: { account: PixivAccount | null | undefined; compact?: boolean }) {
  const name = accountLabel(account);
  const initials = name === t("尚未绑定账号") ? "?" : name.slice(0, 1).toUpperCase();
  return (
    <div className={cn("account-identity", compact && "compact")}>
      <span className="account-avatar" aria-hidden="true">{initials}</span>
      <span className="account-copy"><strong>{name}</strong><small>{account ? `Pixiv ID ${account.id}` : t("等待第一次同步绑定当前账号")}</small></span>
      {account?.profileUrl && <a href={account.profileUrl} target="_blank" rel="noreferrer" className="account-link" aria-label={t("打开 {p0} 的 Pixiv 主页", { p0: name })} title={t("打开 Pixiv 主页")}><ExternalLink size={13} aria-hidden="true" /></a>}
    </div>
  );
}

function StatusToast({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="status-toast" role="status" aria-live="polite"><CheckCircle2 size={17} aria-hidden="true" /><span>{t(message)}</span><IconButton label={t("关闭提示")} onClick={onClose}><X size={16} /></IconButton></div>;
}

function SyncStatus({ data, isSyncing, isPreview }: { data: DashboardData; isSyncing: boolean; isPreview: boolean }) {
  if (isPreview && !isSyncing) {
    return <span className="sync-status neutral"><span className="status-dot" />{t("预览就绪")}</span>;
  }
  const status = isSyncing && !["opening", "collecting", "rechecking", "committing"].includes(data.syncState?.status ?? "")
    ? "opening" : displayedSyncStatus(data);
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
  const lastCollected = latestSyncResultAt(data);
  return (
    <header className="page-header">
      <div className="page-heading">
        <p className="breadcrumb">PixivPulse <ChevronRight size={14} aria-hidden="true" /> {TAB_LABELS[activeTab]}</p>
        <h1>{TAB_LABELS[activeTab]}</h1>
      </div>
      <div className="header-actions">
        {isPreview && <span className="preview-pill"><Sparkles size={14} aria-hidden="true" />{t("预览数据")}</span>}
        {isLoading && !isPreview
          ? <span className="header-loading" role="status"><RefreshCw size={15} className="spin" aria-hidden="true" />{t("正在读取本地数据")}</span>
          : !hasLoadedData && !isPreview
            ? <span className="header-loading error" role="status"><AlertTriangle size={15} aria-hidden="true" />{t("本地数据读取失败")}</span>
          : <><AccountIdentity account={data.settings.boundAccount} compact /><div className="last-sync"><SyncStatus data={data} isSyncing={isSyncing} isPreview={isPreview} /><small>{isPreview ? t("仅供界面体验") : lastCollected ? `${formatTimestamp(lastCollected)} · UTC+8` : t("尚未同步")}</small></div></>}
        <button type="button" className={cn("primary-button sync-button", isSyncing && "busy")} onClick={onSync} disabled={isSyncing || isLoading || !hasLoadedData}>
          <RefreshCw size={16} className={isSyncing || isLoading ? "spin" : undefined} aria-hidden="true" />{isLoading ? t("读取中") : isSyncing ? t("同步中") : t("开始同步")}
        </button>
      </div>
    </header>
  );
}

function DashboardInitialLoading() {
  return <section className="dashboard-initial-loading" role="status" aria-label={t("正在读取本地数据")}><div className="loading-heading"><RefreshCw size={18} className="spin" aria-hidden="true" /><strong>{t("正在读取本地数据")}</strong></div><div className="loading-metric-grid" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <span key={index} />)}</div><div className="loading-content-lines" aria-hidden="true"><span /><span /><span /></div></section>;
}

function DashboardInitialError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <section className="dashboard-initial-error" role="alert"><AlertTriangle size={24} aria-hidden="true" /><div><strong>{t("本地数据暂时无法读取")}</strong><p>{t(error)}</p></div><button type="button" className="secondary-button" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />{t("重新读取")}</button></section>;
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
    return [{ tone: "amber", icon: <CircleDashed size={18} />, title: t("还没有可分析的样本"), body: t("第一次同步会建立基线；完成第二次同步后，才会判断增长方向。"), confidence: "low" }];
  }
  const intradayEligible = intraday?.works.filter((work) => work.points.length >= 2) ?? [];
  if (intraday && (intraday.sampleCount < 2 || intradayEligible.length === 0)) {
    return [{ tone: "amber", icon: <Clock3 size={18} />, title: t("今日样本不足"), body: t("当前为{p0}；至少需要两次今天的实际观察，才会生成日内洞察。", { p0: baselineLabel(intraday.baselineLabel) }), confidence: "low" }];
  }
  if (withHistory.length === 0) {
    return [{ tone: "amber", icon: <Clock3 size={18} />, title: t("历史样本不足"), body: t("当前作品都只有一次观察，暂不推断趋势或转化率变化。"), confidence: "low" }];
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
      title: t("{p0} 正在获得浏览", { p0: fastestAnalysis.work.title }),
      body: intraday ? t("今日增加 {p0} 浏览，来自 {p1} 次实际观察。", { p0: formatCount(fastestDelta), p1: fastestToday?.sampleCount ?? 0 }) : t("上次有效间隔增加 {p0} 浏览，{p1}。", { p0: formatCount(fastestDelta), p1: formatElapsed(fastestAnalysis.lastDelta.views.elapsedHours) }),
      confidence: fastestAnalysis.confidence,
    });
  }
  const strongestRate = [...withHistory].sort((a, b) => (b.bookmarkRate ?? 0) - (a.bookmarkRate ?? 0))[0];
  if (strongestRate && strongestRate.bookmarkRate !== null && strongestRate.bookmarkRate >= 0.02) {
    insights.push({
      tone: "green",
      icon: <Heart size={18} />,
      title: t("{p0} 的收藏转化较高", { p0: strongestRate.work.title }),
      body: t("当前收藏 / 浏览为 {p0}，仅基于已采样作品管理页指标。", { p0: formatPercent(strongestRate.bookmarkRate) }),
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
      title: t("{p0} 件作品在本次间隔暂无浏览变化", { p0: noChange }),
      body: t("这不是失败状态；下一次真实采样会继续保留观察记录。"),
      confidence: "medium",
    });
  }
  if (insights.length === 0) {
    insights.push({ tone: "amber", icon: <Clock3 size={18} />, title: t("等待更多真实变化"), body: t("当前样本还不足以生成规则洞察，请完成下一次同步后再看。"), confidence: "low" });
  }
  return insights.slice(0, 3);
};

function KpiCard({ label, total, delta, changeLabel, detail, icon, tone = "cyan", animationSignal }: { label: string; total: number | null; delta: number | null; changeLabel: string; detail: string; icon: ReactNode; tone?: "cyan" | "coral" | "green" | "amber"; animationSignal?: unknown }) {
  const totalText = formatCount(total);
  const deltaText = formatDelta(delta);
  return (
    <section className={cn("kpi-card", tone)} aria-label={t("{p0}，总量 {p1}，{p2}变化 {p3}", { p0: label, p1: totalText, p2: changeLabel, p3: deltaText })}>
      <div className="kpi-top"><span>{label}</span><span className="kpi-icon">{icon}</span></div>
      <div className="kpi-value-row">
        <strong className="kpi-total"><AnimatedNumber value={totalText} comparisonValue={total} animationSignal={animationSignal} /></strong>
        <span className={cn("kpi-change", delta !== null && delta > 0 && "positive", delta !== null && delta < 0 && "negative")}><AnimatedNumber value={deltaText} comparisonValue={delta} animationSignal={animationSignal} /></span>
      </div>
      <small><span className="kpi-range-label">{t("{range}变化", { range: changeLabel })}</span><span> · {detail}</span></small>
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

function ChartRangeControl({ value, onChange, ariaLabel = t("图表时间范围"), presetOrder = DEFAULT_RANGE_PRESET_ORDER }: { value: ChartRangeControlValue; onChange: (value: ChartRangeControlValue) => void; ariaLabel?: string; presetOrder?: readonly Exclude<ChartTimeRangePreset, "custom">[] }) {
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
        {presetOrder.map((preset) => <button type="button" key={preset} className={cn(value.preset === preset && "active")} aria-pressed={value.preset === preset} onClick={() => selectPreset(preset)}>{preset === "24h" ? t("近24小时") : preset === "today" ? t("今日") : preset === "3d" ? t("近3天") : preset === "7d" ? t("近7天") : preset === "30d" ? t("近30天") : preset === "3m" ? t("近3个月") : t("全部")}</button>)}
        <button type="button" className={cn((value.preset === "custom" || draft.preset === "custom") && "active")} aria-pressed={value.preset === "custom"} onClick={() => setDraft({ ...draft, preset: "custom" })}>{t("自定义")}</button>
      </div>
      {draft.preset === "custom" && <div className="chart-custom-range">
        <label><span>{t("起点")}</span><input type="datetime-local" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.currentTarget.value })} /></label>
        <span className="range-separator">{t("至")}</span>
        <label><span>{t("终点")}</span><input type="datetime-local" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.currentTarget.value })} /></label>
        <button type="button" className="chart-range-apply" disabled={!resolved} onClick={() => onChange(draft)}>{t("应用")}</button>
        {!resolved && draft.start && draft.end && <span className="range-error" role="alert">{t("请选择有效的起止时间")}</span>}
      </div>}
      <span className="chart-range-zone">{t(BUSINESS_TIME_ZONE_LABEL)}</span>
    </div>
  );
}

const resolvedRange = (value: ChartRangeControlValue): ChartTimeRange | null => resolveChartTimeRange({ preset: value.preset, start: value.start || null, end: value.end || null });

const chartRangeLabel = (value: ChartRangeControlValue): string => value.preset === "24h" ? t("近24小时") : value.preset === "today" ? t("今日") : value.preset === "3d" ? t("近3天") : value.preset === "7d" ? t("近7天") : value.preset === "30d" ? t("近30天") : value.preset === "3m" ? t("近3个月") : value.preset === "all" ? t("全部历史") : t("自定义范围");

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
  const incrementPoints = useMemo(() => timeline.map((point) => ({ at: point.at, value: point.metrics[metric], runId: point.runId })), [timeline, metric]);
  const range = useMemo(() => resolvedRange(rangeValue), [rangeValue]);
  return (
    <div className={cn("chart-panel", pending && "range-pending")} data-testid="portfolio-chart" aria-busy={pending}>
      <div className="chart-control-row"><MetricSelector value={metric} onChange={setMetric} label={t("作品集图表指标")} /><ChartRangeControl value={rangeValue} onChange={onRangeChange} ariaLabel={t("作品集图表时间范围")} presetOrder={OVERVIEW_RANGE_PRESET_ORDER} /></div>
      <EChartsHost
        option={option}
        hasData={validPoints.length >= 1}
        ariaLabel={t("{p0}作品集{p1}采样折线图", { p0: rangeValue.preset === "today" ? t("今日") : rangeValue.preset === "all" ? t("全部历史") : t("所选范围"), p1: label })}
        emptyMessage={t("所选时间范围内还没有有效采样。")}
        summary={t("{p0}共 {p1} 个有效采样点{p2}。", { p0: label, p1: formatCount(validPoints.length), p2: latest === null ? "" : t("，最近为 {p0}", { p0: formatCount(latest) }) })}
      />
      {range && <IncrementChart points={incrementPoints} metric={metric} range={range} name={t("作品集")} />}
    </div>
  );
}

const followerIntegrityLabel = (integrity: ReturnType<typeof buildFollowerAnalytics>["recordIntegrity"]): string => {
  if (integrity === "complete") return t("记录完整");
  if (integrity === "approximate") return t("记录不完整");
  if (integrity === "baseline") return t("基线已建立");
  return t("暂无足够记录");
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
    ? t("尚未记录账号粉丝数；完成一次同步后会建立基线。")
    : chartPoints.length === 1
      ? t("已建立粉丝基线，等待下一次同步后绘制增长曲线。")
      : t("所选时间范围内暂无粉丝采样。");
  const chartSummary = analytics.rangeSamples.length > 0
    ? t("{p0}粉丝历史共 {p1} 个有效采样点。", { p0: rangeLabel, p1: formatCount(analytics.rangeSamples.length) })
    : analytics.chartSamples.length > 0
      ? t("所选范围暂无采样，已展示全部 {p0} 个历史点。", { p0: formatCount(analytics.chartSamples.length) })
      : t("暂无有效粉丝采样点。");
  return <>
    <section className="section-band follower-growth-band follower-growth-compact" data-testid="follower-growth-section" aria-label={t("粉丝增长")}>
      <div className="follower-compact-copy">
        <div className="section-heading"><div><p className="eyebrow">ACCOUNT AUDIENCE</p><h2>{t("粉丝增长")}</h2></div><span className="section-note">{t("账号级 · 低频指标")}</span></div>
        <div className="follower-summary follower-summary-compact" aria-label={t("粉丝增长摘要")}>
          <div className="follower-stat current"><span>{t("当前粉丝数")}</span><strong><AnimatedNumber value={formatCount(analytics.current)} comparisonValue={analytics.current} animationSignal={animationSignal} /></strong></div>
          <div className={cn("follower-stat", analytics.rangeDelta !== null && analytics.rangeDelta > 0 && "positive", analytics.rangeDelta !== null && analytics.rangeDelta < 0 && "negative")}><span>{t("{range}增长", { range: rangeLabel })}</span><strong><AnimatedNumber value={formatDelta(analytics.rangeDelta)} comparisonValue={analytics.rangeDelta} animationSignal={animationSignal} /></strong></div>
          <div className="follower-stat"><span>{t("最后采集")}</span><strong className="follower-stat-text">{formatTimestamp(analytics.lastCollectedAt)}</strong></div>
        </div>
      </div>
      <button type="button" className="follower-preview-button" onClick={() => setExpanded(true)} aria-label={t("打开粉丝增长详细图表")}>
        <span className="follower-preview-chart" aria-hidden="true">
          {previewPoints.length >= 2
            ? <EChartsHost option={previewOption} hasData compact ariaLabel="" summary="" height={72} className="follower-mini-chart" />
            : <span className="follower-preview-empty">{previewPoints.length === 1 ? t("基线已建立") : t("等待首次采样")}</span>}
        </span>
        <span className="follower-preview-action"><BarChart3 size={15} aria-hidden="true" />{t("查看详细趋势")}<ChevronRight size={15} aria-hidden="true" /></span>
      </button>
    </section>
    {expanded && <div className="drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <aside className="detail-drawer follower-detail-drawer" role="dialog" aria-modal="true" aria-label={t("粉丝增长详细图表")}>
        <div className="drawer-header"><div><p className="eyebrow">ACCOUNT AUDIENCE</p><h2>{t("粉丝增长")}</h2><p>{t("账号级历史 ·")} {t(BUSINESS_TIME_ZONE_LABEL)}</p></div><IconButton label={t("关闭粉丝增长详情")} onClick={() => setExpanded(false)}><X size={19} /></IconButton></div>
        <div className="drawer-scroll">
          <div className="follower-summary" aria-label={t("粉丝增长详情摘要")}>
            <div className="follower-stat current"><span>{t("当前粉丝数")}</span><strong><AnimatedNumber value={formatCount(analytics.current)} comparisonValue={analytics.current} animationSignal={animationSignal} /></strong></div>
            <div className={cn("follower-stat", analytics.rangeDelta !== null && analytics.rangeDelta > 0 && "positive", analytics.rangeDelta !== null && analytics.rangeDelta < 0 && "negative")}><span>{t("{range}增长", { range: rangeLabel })}</span><strong><AnimatedNumber value={formatDelta(analytics.rangeDelta)} comparisonValue={analytics.rangeDelta} animationSignal={animationSignal} /></strong></div>
            <div className="follower-stat"><span>{t("最后采集时间")}</span><strong className="follower-stat-text">{formatTimestamp(analytics.lastCollectedAt)}</strong></div>
            <div className={cn("follower-stat", analytics.recordIntegrity === "approximate" && "warning")}><span>{t("记录完整性")}</span><strong className="follower-stat-text">{followerIntegrityLabel(analytics.recordIntegrity)}</strong></div>
          </div>
          <section className="drawer-section"><div className="section-heading"><div><p className="eyebrow">FOLLOWER HISTORY</p><h3>{t("粉丝数历史")}</h3></div><span className="section-note">{t("真实时间间隔")}</span></div><div className={cn("chart-wrap", pending && "range-pending")}><div className="chart-panel" aria-busy={pending}><div className="chart-control-row"><ChartRangeControl value={rangeValue} onChange={onRangeChange} ariaLabel={t("粉丝增长图表时间范围")} presetOrder={OVERVIEW_RANGE_PRESET_ORDER} /></div><EChartsHost option={option} hasData={chartHasData} ariaLabel={t("{p0}账号粉丝数历史图", { p0: rangeLabel })} emptyMessage={emptyMessage} summary={chartSummary} height={300} /></div></div></section>
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
        <div><p className="eyebrow">PIXIV RANKING</p><h2>{t("作品排名")}</h2></div>
        <span className="section-note">{t("仅展示当前已上榜作品")}</span>
      </div>
      {entries.length === 0 ? (
        <div className="ranking-empty" role="status"><TrendingUp size={19} aria-hidden="true" /><p>{t("排名记录仅在 Pixiv 作者作品页暴露排名时写入；当前没有可展示的已上榜作品。")}</p></div>
      ) : (
        <div className="ranking-list" aria-label={t("当前作品排名")}>
          {entries.map((entry) => (
            <button type="button" className="ranking-row" key={entry.analysis.work.key} onClick={() => onOpenWork(entry.analysis.work.key)}>
              <span className="ranking-position" aria-label={t("当前排名第 {p0} 名", { p0: entry.rank })}>#{entry.rank}</span>
              <span className="ranking-main"><strong>{entry.analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(entry.analysis.work))} · {rankingMovementLabel(entry.movement)}</small></span>
              <span className="ranking-meta"><span>{entry.observedAt ? t("更新于 {p0}", { p0: formatTimestamp(entry.observedAt) }) : t("排名时间未知")}</span><span>{rankingSourceLabel(entry.source)}</span></span>
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
  const rangeDeltaDetail = rangeValue.preset === "today" ? t("按今日首个检测点计算") : t("按范围起点基线计算");
  const setOverviewRange = (value: ChartRangeControlValue) => startRangeTransition(() => setRangeValue(value));
  const insights = buildInsights(analyses, intraday);
  const movers = [...analyses].filter((analysis) => analysis.previousSample).sort((a, b) => (b.lastDelta.views.value ?? -Infinity) - (a.lastDelta.views.value ?? -Infinity)).slice(0, 3);
  const rounds = intraday.sampleCount;
  const recentCompletedRun = latestCompletedRun(data.runs);
  const rankingEntries = useMemo(() => buildRankingEntries(analyses, data.samples), [analyses, data.samples]);
  return (
    <div className="view-stack overview-view">
      <section className="welcome-band">
        <div><p className="eyebrow">{t("作品集信号")}</p><h2>{t("把每一次真实采样，变成可回看的增长轨迹。")}</h2><p>{t("这里只计算你本地保存的 Pixiv 作品管理页快照，不替你猜测安装前发生过什么。")}</p><div className="welcome-account"><AccountIdentity account={data.settings.boundAccount} /></div></div>
        <div className="welcome-meta"><span><Database size={15} aria-hidden="true" />{data.samples.length} {t("个快照")}</span><span className="sampling-meta"><Clock3 size={15} aria-hidden="true" /><strong>{t("今日采样轮次")}</strong><em>{rounds}</em></span><span className="baseline-label"><Info size={14} aria-hidden="true" />{baselineLabel(intraday.baselineLabel)}</span></div>
      </section>
      <div className="kpi-grid">
        <KpiCard label={t("浏览总量")} total={currentTotal.views} delta={rangeDelta.views} changeLabel={rangeLabel} detail={t("{p0} 个范围采样点", { p0: portfolioTimeline.length })} icon={<Eye size={18} />} tone="coral" animationSignal={animationSignal} />
        <KpiCard label={t("收藏总量")} total={currentTotal.bookmarks} delta={rangeDelta.bookmarks} changeLabel={rangeLabel} detail={rangeDeltaDetail} icon={<BookOpen size={18} />} tone="green" animationSignal={animationSignal} />
        <KpiCard label={t("获赞总量")} total={currentTotal.likes} delta={rangeDelta.likes} changeLabel={rangeLabel} detail={rangeDeltaDetail} icon={<Heart size={18} />} animationSignal={animationSignal} />
        <KpiCard label={t("评论总量")} total={currentTotal.comments} delta={rangeDelta.comments} changeLabel={rangeLabel} detail={rangeDeltaDetail} icon={<MessageCircle size={18} />} tone="amber" animationSignal={animationSignal} />
      </div>
      <FollowerGrowthSection data={data} rangeValue={rangeValue} onRangeChange={setOverviewRange} pending={rangePending} animationSignal={animationSignal} />
      {analyses.length === 0 ? (
        <>
          <EmptyState icon={<RefreshCw size={22} />} title={recentCompletedRun?.works === 0 ? t("最近同步没有作品") : t("还没有作品快照")} body={recentCompletedRun ? t("最近一次同步已完成，Pixiv 返回 {p0} 件作品；下一次同步会继续读取。", { p0: formatCount(recentCompletedRun.works) }) : t("尚未完成第一次同步；完成后，PixivPulse 会先建立基线，再在后续采样中计算变化。")} action={<button type="button" className="secondary-button" onClick={onGoToWorks}>{t("查看作品页")}</button>} />
          <RankingSection entries={rankingEntries} onOpenWork={onOpenWork} />
        </>
      ) : (
        <>
          <section className="section-band chart-band">
            <div className="section-heading"><div><p className="eyebrow">PORTFOLIO MOMENTUM</p><h2>{t("{range}作品集动量", { range: rangeLabel })}</h2></div><span className="section-note">{t("真实时间间隔 · 范围指标联动")}</span></div>
            <div className="chart-wrap"><PortfolioChart timeline={portfolioTimeline} rangeValue={rangeValue} onRangeChange={setOverviewRange} pending={rangePending} /></div>
          </section>
          <RankingSection entries={rankingEntries} onOpenWork={onOpenWork} />
          <div className="insight-mover-grid">
            <section className="section-band insight-band">
              <div className="section-heading"><div><p className="eyebrow">RULE-BASED SIGNALS</p><h2>{t("规则洞察")}</h2></div><span className="section-note">{t("最低样本门槛")}</span></div>
              <div className="insight-list">
                {insights.map((insight, index) => <article className={cn("insight-row", insight.tone)} key={`${insight.title}-${index}`}><span className="insight-icon">{insight.icon}</span><div><div className="insight-title"><strong>{insight.title}</strong><ConfidenceBadge confidence={insight.confidence} /></div><p>{insight.body}</p></div></article>)}
              </div>
            </section>
            <section className="section-band movers-band">
              <div className="section-heading"><div><p className="eyebrow">TOP MOVERS</p><h2>{t("上升作品")}</h2></div><button type="button" className="text-button" onClick={onGoToWorks}>{t("查看全部")} {formatCount(analyses.length)} {t("件作品")} <ChevronRight size={14} aria-hidden="true" /></button></div>
              <div className="mover-list">{movers.length ? movers.map((analysis) => <TopMover key={analysis.work.key} analysis={analysis} onOpen={() => onOpenWork(analysis.work.key)} />) : <p className="muted-copy">{t("完成第二次同步后，这里会出现有实际变化的作品。")}</p>}</div>
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
  return <button type="button" className={cn("sort-button", current && "active")} onClick={() => onSort(sortKey)} aria-label={t("按{p0}排序", { p0: label })} aria-sort={current ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>{label}<span className="sort-indicator" aria-hidden="true"><ChevronDown size={13} className={sort.direction === "asc" ? "sort-up" : undefined} /></span></button>;
}

function SortDirectionButton({ direction, onToggle }: { direction: WorkSort["direction"]; onToggle: () => void }) {
  const ascending = direction === "asc";
  return <IconButton label={t("切换为{direction}", { direction: ascending ? t("降序") : t("升序") })} className="sort-direction-button" onClick={onToggle}>{ascending ? <ArrowUp size={16} aria-hidden="true" /> : <ArrowDown size={16} aria-hidden="true" />}</IconButton>;
}

function TodayDeltaCell({ intraday, metricKey }: { intraday: IntradayWorkAnalysis | null; metricKey: keyof WorkMetrics }) {
  const delta = todayDelta(intraday, metricKey);
  return <td className={cn("delta-cell", "today-delta-cell", delta !== null && delta > 0 && "positive", delta !== null && delta < 0 && "negative")}><span><AnimatedNumber value={delta === null ? "—" : formatDelta(delta)} /></span><small>{intraday ? t("今日") : t("暂无今日样本")}</small></td>;
}

const formatCompactElapsed = (hours: number | null): string => {
  const label = formatElapsed(hours);
  const prefix = t("距上次采样 ");
  return label.startsWith(prefix) ? t("{p0}前", { p0: label.slice(prefix.length) }) : label;
};

const workDescription = (work: WorkAnalysis["work"]): string | null => {
  const value = (work as WorkAnalysis["work"] & { description?: unknown }).description;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const workSeries = (work: WorkAnalysis["work"]): string => work.seriesTitle?.trim() || t("独立作品");

const workExtent = (work: WorkAnalysis["work"]): string => {
  if (work.wordCount !== null) return t("字数 {p0}", { p0: formatCount(work.wordCount) });
  if (work.pageCount !== null) return t("页数 {p0}", { p0: formatCount(work.pageCount) });
  return t("内容数量未知");
};

const statusLabel = (_analysis: WorkAnalysis, intraday: IntradayWorkAnalysis | null): string => {
  if (!intraday) return t("今日暂无浏览变化");
  const delta = todayDelta(intraday, "views");
  if (delta === null) return baselineLabel(intraday.baselineLabel);
  if (delta === 0) return t("今日暂无浏览变化");
  return t("今日有增长 · 浏览 {p0}", { p0: formatDelta(delta) });
};

function WorkIncrementPreview({ analysis, intraday, range, onOpen }: { analysis: WorkAnalysis; intraday: IntradayWorkAnalysis | null; range: ChartTimeRange; onOpen: () => void }) {
  const points = useMemo(() => intraday
    ? intraday.points.map((point) => ({ at: point.observedAt, value: point.metrics.views, runId: point.runId }))
    : analysis.sparkline.map((point) => ({ at: point.at, value: point.views })), [analysis.sparkline, intraday]);
  return <IncrementPreview points={points} range={range} name={analysis.work.title} onOpen={onOpen} />;
}

function WorkRow({ analysis, intraday, onOpen, previewRange }: { analysis: WorkAnalysis; intraday: IntradayWorkAnalysis | null; onOpen: () => void; previewRange: ChartTimeRange }) {
  const metrics = currentMetrics(analysis);
  const delta = analysis.lastDelta.views.value;
  const contentType = contentTypeForWork(analysis.work);
  const ranking = rankingEntryForAnalysis(analysis);
  return (
    <tr>
      <td className="rank-cell">{ranking ? `#${ranking.rank}` : "—"}<small>{ranking ? t("当前排名") : t("排名未知")}</small></td>
      <td className="work-name-cell"><div className="work-name-layout"><button type="button" className="work-link" onClick={onOpen}><Thumbnail work={analysis.work} /><span><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentType)} · {analysis.work.id}</small><small className="work-series-inline">{workSeries(analysis.work)}</small></span></button></div></td>
      <td className="number-cell"><AnimatedNumber value={formatCount(metrics.views)} /></td>
      <TodayDeltaCell intraday={intraday} metricKey="views" />
      <TodayDeltaCell intraday={intraday} metricKey="bookmarks" />
      <TodayDeltaCell intraday={intraday} metricKey="likes" />
      <TodayDeltaCell intraday={intraday} metricKey="comments" />
      <td className="number-cell today-samples-cell">{intraday ? formatCount(intraday.sampleCount) : "—"}<small>{t("今日观察")}</small></td>
      <td className={cn("delta-cell", delta !== null && delta > 0 && "positive", delta !== null && delta < 0 && "negative")}>{delta === null ? <span>—</span> : <><span>{formatDelta(delta)}</span><small>{formatCompactElapsed(analysis.lastDelta.views.elapsedHours)}</small></>}</td>
      <td className="number-cell recent-seen-cell"><span>{formatTimestamp(analysis.work.lastSeenAt)}</span><small>{t("最近观察")}</small></td>
      <td className="number-cell total-cell"><AnimatedNumber value={formatCount(metrics.likes)} /></td>
      <td className="number-cell total-cell"><AnimatedNumber value={formatCount(metrics.bookmarks)} /><small className="ratio-label">{formatPercent(analysis.bookmarkRate)}</small></td>
      <td className="sparkline-cell"><WorkIncrementPreview analysis={analysis} intraday={intraday} range={previewRange} onOpen={onOpen} /></td>
      <td className="confidence-cell"><ConfidenceBadge confidence={analysis.confidence} /></td>
      <td><IconButton label={t("打开{p0}详情", { p0: analysis.work.title })} className="row-action" onClick={onOpen}><ChevronRight size={17} /></IconButton></td>
    </tr>
  );
}

function WorkMetric({ icon, label, value }: { icon: ReactNode; label: string; value: number | null }) {
  return <span className="work-metric"><span className="work-metric-label">{icon}{label}</span><strong><AnimatedNumber value={formatCount(value)} /></strong></span>;
}

function WorkCard({ analysis, intraday, previewRange, onOpen, coverRevision, coverRefreshSignal }: { analysis: WorkAnalysis; intraday: IntradayWorkAnalysis | null; previewRange: ChartTimeRange; onOpen: () => void; coverRevision: string; coverRefreshSignal: string }) {
  const metrics = currentMetrics(analysis);
  const contentType = contentTypeForWork(analysis.work);
  const description = workDescription(analysis.work);
  const todayViews = todayDelta(intraday, "views");
  const ranking = rankingEntryForAnalysis(analysis);
  return (
    <article className="work-card" data-testid="work-card">
      <div className="work-cover-frame">
        <button type="button" className="work-cover-button" onClick={onOpen} aria-label={t("打开{p0}详情", { p0: analysis.work.title })}>
          <Thumbnail work={analysis.work} className="work-cover" cacheRevision={coverRevision} cacheRefreshSignal={coverRefreshSignal} />
        </button>
        {ranking && <span className="rank-badge" aria-label={t("当前排名第 {p0} 名", { p0: ranking.rank })}>#{ranking.rank}</span>}
      </div>
      <div className="work-card-body">
        <div className="work-card-heading">
          <div className="work-card-title-wrap"><button type="button" className="work-card-title" onClick={onOpen}>{analysis.work.title}</button><span className="work-card-series">{workSeries(analysis.work)}</span></div>
          <span className="content-type-badge">{contentTypeLabel(contentType)}</span>
        </div>
        <p className={cn("work-overview", description && "has-description")}>{description ?? `${workExtent(analysis.work)} · ${contentTypeLabel(contentType)}`}</p>
        <div className="work-card-meta"><span>{analysis.work.publishedAt ? t("发布于 {p0}", { p0: formatTimestamp(analysis.work.publishedAt) }) : t("发布时间未知")}</span><span>{workExtent(analysis.work)}</span>{analysis.work.isAi === true && <span className="work-tag ai-tag"><Sparkles size={12} aria-hidden="true" />AI</span>}{analysis.work.isR18 === true && <span className="work-tag r18-tag"><Tag size={12} aria-hidden="true" />R-18</span>}</div>
        <div className="work-metrics" aria-label={t("{p0}当前数据", { p0: analysis.work.title })}>
          <WorkMetric icon={<Eye size={13} aria-hidden="true" />} label={t("浏览")} value={metrics.views} />
          <WorkMetric icon={<Heart size={13} aria-hidden="true" />} label={t("赞")} value={metrics.likes} />
          <WorkMetric icon={<BookOpen size={13} aria-hidden="true" />} label={t("收藏")} value={metrics.bookmarks} />
          <WorkMetric icon={<MessageCircle size={13} aria-hidden="true" />} label={t("评论")} value={metrics.comments} />
        </div>
        <div className="work-today-stats" aria-label={t("{p0}今日变化", { p0: analysis.work.title })}><span title={t("今日浏览")} aria-label={t("今日浏览")}><strong className={cn(todayViews !== null && todayViews > 0 && "positive", todayViews !== null && todayViews < 0 && "negative")}><AnimatedNumber value={todayViews === null ? "—" : formatDelta(todayViews)} /></strong></span><span title={t("今日收藏")} aria-label={t("今日收藏")}><strong><AnimatedNumber value={formatDelta(todayDelta(intraday, "bookmarks"))} /></strong></span><span title={t("今日赞")} aria-label={t("今日赞")}><strong><AnimatedNumber value={formatDelta(todayDelta(intraday, "likes"))} /></strong></span><span title={t("今日评论")} aria-label={t("今日评论")}><strong><AnimatedNumber value={formatDelta(todayDelta(intraday, "comments"))} /></strong></span></div>
        <WorkIncrementPreview analysis={analysis} intraday={intraday} range={previewRange} onOpen={onOpen} />
        <div className="work-card-footer"><span className="work-baseline-label">{statusLabel(analysis, intraday)}</span><span className="work-sample-note" aria-label={t("今日样本")}>{t("今日样本")} {intraday ? formatCount(intraday.sampleCount) : "—"}</span><button type="button" className="work-detail-button" onClick={onOpen}>{t("查看详情")} <ChevronRight size={14} aria-hidden="true" /></button></div>
      </div>
    </article>
  );
}

export function WorksView({ analyses, intradayByWork, onOpenWork, completedRunWorks, coverCache }: { analyses: WorkAnalysis[]; intradayByWork?: ReadonlyMap<string, IntradayWorkAnalysis>; onOpenWork: (key: string) => void; completedRunWorks?: number | null; coverCache?: CoverCacheSummary | undefined }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<WorkTypeFilter>("all");
  const [status, setStatus] = useState<WorkStatusFilter>("all");
  const [sort, setSort] = useState<WorkSort>(DEFAULT_WORK_SORT);
  const [viewMode, setViewMode] = useState<WorksViewMode>(readWorksViewMode);
  const dateRevision = useBeijingDateRevision();
  const previewRange = useMemo(() => resolveChartTimeRange({ preset: "today" })!, [analyses, dateRevision]);
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
        <div><p className="eyebrow">WORK LIBRARY</p><h2>{t("全部作品")} <span>{formatCount(filtered.length)} / {formatCount(analyses.length)}</span></h2><p className="toolbar-caption">{t("点击作品查看总量与增量；多作品对照请前往比较页。")}</p></div>
        <div className="toolbar-controls">
          <label className="search-field"><Search size={16} aria-hidden="true" /><span className="sr-only">{t("搜索作品")}</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("搜索标题或 ID")} /></label>
          <label className="select-field"><ListFilter size={15} aria-hidden="true" /><span className="sr-only">{t("作品类型")}</span><select value={type} onChange={(event) => setType(event.currentTarget.value as WorkTypeFilter)}><option value="all">{t("全部类型")}</option><option value="novel">{t("小说")}</option><option value="illustration">{t("插画")}</option><option value="manga">{t("漫画")}</option><option value="ugoira">{t("动图")}</option><option value="unknown">{t("作品")}</option></select></label>
          <label className="select-field"><Filter size={15} aria-hidden="true" /><span className="sr-only">{t("作品状态")}</span><select value={status} onChange={(event) => setStatus(event.currentTarget.value as WorkStatusFilter)}><option value="all">{t("全部状态")}</option><option value="updated">{t("有增长")}</option><option value="history">{t("有历史无增长")}</option><option value="baseline">{t("仅有基线")}</option></select></label>
          <label className="select-field sort-select"><SlidersHorizontal size={15} aria-hidden="true" /><span className="sr-only">{t("排序指标")}</span><select aria-label={t("排序指标")} value={sort.key} onChange={(event) => onSortKeyChange(event.currentTarget.value as WorkSortKey)}>{WORK_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <SortDirectionButton direction={sort.direction} onToggle={onSortDirection} />
          <div className="view-mode-toggle" role="group" aria-label={t("作品展示方式")}><button type="button" className={cn("view-mode-button", viewMode === "grid" && "active")} aria-label={t("宫格视图")} aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 size={16} aria-hidden="true" /><span>{t("宫格")}</span></button><button type="button" className={cn("view-mode-button", viewMode === "list" && "active")} aria-label={t("列表视图")} aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List size={17} aria-hidden="true" /><span>{t("列表")}</span></button></div>
        </div>
      </section>
      <div className="table-summary"><span><ImageIcon size={15} aria-hidden="true" />{analyses.length} {t("件作品")}</span><span><Activity size={15} aria-hidden="true" />{analyses.filter((analysis) => analysis.previousSample).length} {t("件已有历史")}</span>{coverCache && coverCache.total > 0 && <span title={coverCache.failed > 0 ? t("{p0} 张失败，将在下次完整同步重试", { p0: coverCache.failed }) : undefined}><Database size={15} aria-hidden="true" />{t("本地封面")} {coverCache.ready}/{coverCache.total}{coverCache.pending > 0 ? t(" · {p0} 张处理中", { p0: coverCache.pending }) : ""}{coverCache.skipped > 0 ? t(" · {p0} 张空间不足", { p0: coverCache.skipped }) : ""}</span>}<span className="summary-tip"><SlidersHorizontal size={14} aria-hidden="true" />{t("变化值只使用相邻真实采样")}</span></div>
       {filtered.length === 0 ? <EmptyState icon={<Search size={22} />} title={analyses.length ? t("没有匹配的作品") : completedRunWorks === 0 ? t("最近同步没有作品") : t("第一次同步后，作品会出现在这里")} body={analyses.length ? t("试试清空搜索词或调整筛选条件。") : completedRunWorks === 0 ? t("最近一次同步已完成，Pixiv 返回 0 件作品；下一次同步会继续读取。") : completedRunWorks === null || completedRunWorks === undefined ? t("尚未完成第一次同步；完成同步后，真实作品会出现在这里。") : t("最近一次同步已完成，Pixiv 返回 {p0} 件作品；当前列表暂时没有可展示的记录。", { p0: formatCount(completedRunWorks) })} /> : viewMode === "grid" ? <><div className="grid-metrics-legend" aria-label={t("今日数据字段")}><span>{t("今日浏览")}</span><span>{t("今日收藏")}</span><span>{t("今日赞")}</span><span>{t("今日评论")}</span><span>{t("今日样本")}</span></div><div className="works-grid">{filtered.map((analysis) => { return <WorkCard key={analysis.work.key} analysis={analysis} intraday={intradayByWork?.get(analysis.work.key) ?? null} onOpen={() => onOpenWork(analysis.work.key)} previewRange={previewRange} coverRevision={coverRevisionForWork(analysis.work)} coverRefreshSignal={coverRefreshSignal} />; })}</div></> : <div className="table-scroll"><table className="works-table"><caption className="sr-only">{t("PixivPulse 作品增长表")}</caption><thead><tr><th className="number-heading">{t("排名")}</th><th><SortButton label={t("作品")} sortKey="title" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label={t("浏览")} sortKey="views" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label={t("今日浏览")} sortKey="todayViews" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label={t("今日收藏")} sortKey="todayBookmarks" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label={t("今日赞")} sortKey="todayLikes" sort={sort} onSort={onSort} /></th><th className="number-heading"><SortButton label={t("今日评论")} sortKey="todayComments" sort={sort} onSort={onSort} /></th><th className="number-heading">{t("今日样本")}</th><th className="number-heading">{t("上次变化")}</th><th className="number-heading"><SortButton label={t("最近观察")} sortKey="lastSeenAt" sort={sort} onSort={onSort} /></th><th className="number-heading total-heading"><SortButton label={t("赞总量")} sortKey="likes" sort={sort} onSort={onSort} /></th><th className="number-heading total-heading"><SortButton label={t("收藏总量")} sortKey="bookmarks" sort={sort} onSort={onSort} /></th><th>{t("今日浏览增量")}</th><th>{t("置信")}</th><th aria-label={t("操作")} /></tr></thead><tbody>{filtered.map((analysis) => { return <WorkRow key={analysis.work.key} analysis={analysis} intraday={intradayByWork?.get(analysis.work.key) ?? null} onOpen={() => onOpenWork(analysis.work.key)} previewRange={previewRange} />; })}</tbody></table></div>}
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
  const valueLabel = valueMode === "delta" ? t("增量") : t("总量绝对值");
  return (
    <EChartsHost
      option={option}
      hasData={series.length >= 2 && drawableSeriesCount >= 2}
      ariaLabel={t("{p0} 部作品{p1}{p2}比较折线图", { p0: series.length, p1: metricLabel, p2: valueLabel })}
      emptyMessage={t("至少两部所选作品需要各有两次有效{p0}采样，才能绘制{p1}比较曲线。", { p0: metricLabel, p1: valueLabel })}
      summary={valueMode === "delta" ? t("{p0} 部作品，每 {p1} {p2}净增量；北京时间。", { p0: series.length, p1: compareBucketLabel(hours), p2: metricLabel }) : t("{p0} 部作品，{p1} 个{p2}{p3}采样点；横轴按北京时间的真实采样时刻绘制。", { p0: series.length, p1: allPoints.length, p2: metricLabel, p3: valueLabel })}
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
  const [query, setQuery] = useState("");
  const [type, setType] = useState<WorkTypeFilter>("all");
  const [onlySelected, setOnlySelected] = useState(false);
  const range = useMemo(() => resolvedRange(rangeValue), [rangeValue]);
  const selected = compareKeys.slice(0, MAX_COMPARE_WORKS).map((key) => analyses.find((analysis) => analysis.work.key === key)).filter((analysis): analysis is WorkAnalysis => Boolean(analysis));
  const candidates = analyses.filter((analysis) => {
    const text = `${analysis.work.title} ${analysis.work.id} ${workSeries(analysis.work)}`.toLocaleLowerCase();
    return text.includes(query.trim().toLocaleLowerCase()) && (type === "all" || contentTypeForWork(analysis.work) === type)
      && (!onlySelected || compareKeys.includes(analysis.work.key));
  });
  const available = candidates.filter((analysis) => !compareKeys.includes(analysis.work.key));
  const quickAdd = available.slice(0, MAX_COMPARE_WORKS - selected.length);
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
      <section className="list-toolbar compare-toolbar"><div><p className="eyebrow">ABSOLUTE COMPARISON</p><h2>{t("比较作品")} <span>{selected.length} / {MAX_COMPARE_WORKS}</span></h2><p className="toolbar-caption">{t("2 至")} {MAX_COMPARE_WORKS} {t("部作品使用同一真实时间轴，比较浏览、收藏和获赞的总量或增量。")}</p></div><div className="compare-help"><Gauge size={17} aria-hidden="true" /><span>{t("最多选择")} {MAX_COMPARE_WORKS} {t("件作品")}</span></div></section>
      <section className="compare-selection" aria-label={t("比较对象管理")}>
        <div className="compare-selection-controls">
          <label className="search-field"><Search size={16} aria-hidden="true" /><span className="sr-only">{t("搜索比较作品")}</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("搜索标题、ID 或系列")} /></label>
          <label className="select-field"><span className="sr-only">{t("比较作品类型")}</span><select value={type} onChange={(event) => setType(event.currentTarget.value as WorkTypeFilter)}><option value="all">{t("全部类型")}</option><option value="novel">{t("小说")}</option><option value="illustration">{t("插画")}</option><option value="manga">{t("漫画")}</option><option value="ugoira">{t("动图")}</option><option value="unknown">{t("作品")}</option></select></label>
          <button type="button" className="text-button" aria-pressed={onlySelected} onClick={() => setOnlySelected(!onlySelected)}>{onlySelected ? t("查看全部作品") : t("只看已选")}</button>
          <button type="button" className="text-button" disabled={quickAdd.length === 0} onClick={() => quickAdd.forEach((analysis) => onToggleCompare(analysis.work.key))}>{available.length <= MAX_COMPARE_WORKS - selected.length ? t("全选筛选结果") : t("加入前 {p0} 件", { p0: quickAdd.length || MAX_COMPARE_WORKS })}</button>
          <button type="button" className="text-button" disabled={selected.length === 0} onClick={() => selected.forEach((analysis) => onToggleCompare(analysis.work.key))}>{t("清空选择")}</button>
        </div>
        <div className="compare-selection-status"><span>{t("匹配")} {candidates.length} {t("件 · 已选")} {selected.length} / {MAX_COMPARE_WORKS}</span><span>{selected.length === MAX_COMPARE_WORKS ? t("已达上限，移除一件即可替换") : t("选择后即时更新图表")}</span></div>
        <div className="compare-picker" aria-label={t("选择比较作品")}>
          {candidates.length === 0 ? <p className="muted-copy">{analyses.length === 0 ? t("同步后可在此选择比较对象。") : t("没有匹配的作品，请调整搜索或筛选。")}</p> : candidates.map((analysis) => { const checked = compareKeys.includes(analysis.work.key); const disabled = !checked && selected.length >= MAX_COMPARE_WORKS; return <label key={analysis.work.key} className={cn("picker-item", checked && "selected", disabled && "disabled")}><input type="checkbox" checked={checked} disabled={disabled} aria-label={t("比较：{p0}", { p0: analysis.work.title })} onChange={() => onToggleCompare(analysis.work.key)} /><Thumbnail work={analysis.work} /><span><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(analysis.work))} · {workConfidence(analysis)}</small></span></label>; })}
        </div>
      </section>
      {selected.length > 0 && <section className="compare-work-summary" aria-label={t("已选作品当前总量")}>{selected.map((analysis, index) => { const metrics = analysis.latestSample?.metrics ?? analysis.work.metrics; return <article key={analysis.work.key} style={{ "--series-color": SERIES_COLORS[index] } as React.CSSProperties}><div className="compare-work-heading"><IconButton label={t("移除比较：{p0}", { p0: analysis.work.title })} onClick={() => onToggleCompare(analysis.work.key)}><X size={14} /></IconButton><Thumbnail work={analysis.work} /><button type="button" onClick={() => onOpenWork(analysis.work.key)}><strong>{analysis.work.title}</strong><small>{contentTypeLabel(contentTypeForWork(analysis.work))}</small></button></div><div className="compare-work-metrics"><span>{t("浏览")}<strong><AnimatedNumber value={formatCount(metrics.views)} comparisonValue={metrics.views} /></strong></span><span>{t("收藏")}<strong><AnimatedNumber value={formatCount(metrics.bookmarks)} comparisonValue={metrics.bookmarks} /></strong></span><span>{t("获赞")}<strong><AnimatedNumber value={formatCount(metrics.likes)} comparisonValue={metrics.likes} /></strong></span></div></article>; })}</section>}
      {selected.length === 0 ? <EmptyState icon={<BarChart3 size={22} />} title={t("还没有比较对象")} body={t("从上方选择至少两件作品，比较页会绘制它们的历史曲线。")} /> : selected.length === 1 ? <EmptyState icon={<BarChart3 size={22} />} title={t("还差一件作品")} body={t("再选择一件作品后，即可比较浏览、收藏和获赞的总量或增量曲线。")} /> : <section className="section-band compare-band"><div className="section-heading"><div><p className="eyebrow">ABSOLUTE METRIC HISTORY</p><h2>{t("{metric}{mode}曲线", { metric: DASHBOARD_CHART_METRIC_LABELS[metric], mode: valueMode === "delta" ? t("增量") : t("绝对值") })}</h2></div><span className="section-note">{t("横轴：北京时间 · 纵轴：")}{valueMode === "delta" ? t("每 {p0} 净增量", { p0: compareBucketLabel(compareBucketLayout(series.flatMap((item) => item.points), range ?? { preset: "all", startMs: null, endMs: null }).hours) }) : t("累计总量")}</span></div><div className="compare-chart-controls"><div className="compare-chart-selectors"><MetricSelector value={metric} onChange={setMetric} label={t("比较指标")} metrics={COMPARE_CHART_METRICS} /><div className="compare-mode-selector" role="group" aria-label={t("数值口径")}><button type="button" className={cn(valueMode === "total" && "active")} aria-pressed={valueMode === "total"} onClick={() => setValueMode("total")}>{t("总量")}</button><button type="button" className={cn(valueMode === "delta" && "active")} aria-pressed={valueMode === "delta"} onClick={() => setValueMode("delta")}>{t("增量")}</button></div></div><ChartRangeControl value={rangeValue} onChange={setRangeValue} /></div><div className="chart-wrap"><CompareChart series={series} metric={metric} valueMode={valueMode} range={range ?? { preset: "all", startMs: null, endMs: null }} /></div><div className="compare-legend">{series.map((item) => <button type="button" key={item.analysis.work.key} className="legend-item" onClick={() => onOpenWork(item.analysis.work.key)}><span className="legend-dot" style={{ backgroundColor: item.color }} />{item.analysis.work.title}<ChevronRight size={14} aria-hidden="true" /></button>)}</div>{valueMode === "delta" && <p className="chart-footnote"><Info size={14} aria-hidden="true" />{t("分段净增量 · 无观察时段留空")}</p>}{series.some((item) => item.points.length < 2) && <p className="chart-footnote"><Info size={14} aria-hidden="true" />{t("所选范围内不足两次有效{metric}观察的作品不会被绘制。", { metric: DASHBOARD_CHART_METRIC_LABELS[metric] })}</p>}</section>}
    </div>
  );
}

function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description: string; disabled?: boolean }) {
  return <div className="setting-toggle-row"><div><strong>{label}</strong><p>{description}</p></div><button type="button" role="switch" aria-checked={checked} aria-label={label} className={cn("toggle", checked && "checked")} onClick={() => onChange(!checked)} disabled={disabled}><span /></button></div>;
}

function RunStatus({ run, isPreview }: { run: SyncRun; isPreview: boolean }) {
  return <span className={cn("run-status", run.status === "completed" ? "success" : "danger")}>{run.status === "completed" ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}{isPreview ? t("示例") : run.status === "completed" ? t("完成") : t("失败")}</span>;
}

function runNote(run: SyncRun): string {
  if (run.errorMessage && /auth(?:entication)?|登录|认证/i.test(run.errorMessage)) {
    return t("旧版本记录；请使用 v0.1.2 重新同步");
  }
  return run.errorMessage ? t(run.errorMessage) : t("{p0} 页", { p0: run.pages });
}

export function SettingsView({ data, isPreview, error, onSchedule, onShowChips, onExportJson, onExportCsv, onOpenOnboarding, onClearData, storageModel: providedStorageModel, storageBusy = null, onRepairCovers = () => undefined, onMaintainData = () => undefined, onChooseBackup = () => undefined, onImportFile = () => undefined, maintenanceResult = null }: { data: DashboardData; isPreview: boolean; error: string | null; onSchedule: (enabled: boolean, interval: number) => void; onShowChips: (enabled: boolean) => void; onExportJson: () => void; onExportCsv: () => void; onOpenOnboarding: () => void; onClearData?: () => void; storageModel?: StorageCenterModel; storageBusy?: "covers" | "maintenance" | "import" | "backup" | null; onRepairCovers?: () => void; onMaintainData?: () => void; onChooseBackup?: () => void; onImportFile?: (file: File) => void; maintenanceResult?: MaintenanceResult | null }) {
  const storageModel = providedStorageModel ?? storageCenterModel(data, null);
  const supportedIntervals = [0.5, 1, 2, 4, 12, 24] as const;
  const configuredInterval = supportedIntervals.includes(data.settings.syncIntervalHours as (typeof supportedIntervals)[number]) ? data.settings.syncIntervalHours : 1;
  const scheduleValue = data.settings.scheduledSyncEnabled ? String(configuredInterval) : "manual";
  return (
    <div className="view-stack settings-view">
      <section className="list-toolbar"><div><p className="eyebrow">LOCAL CONTROL ROOM</p><h2>{t("数据与设置")}</h2><p className="toolbar-caption">{t("同步策略、导出和限制都在这里；没有遥测，也没有云端账号。")}</p></div><button type="button" className="secondary-button" onClick={onOpenOnboarding}><Info size={16} aria-hidden="true" />{t("重新查看首次说明")}</button></section>
      {error && <div className="error-banner" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>{t("后台连接异常")}</strong><p>{t(error)}</p></div></div>}
      <section className="setting-section"><div className="section-heading"><div><p className="eyebrow">SYNC POLICY</p><h2>{t("同步策略")}</h2></div><CalendarClock size={19} aria-hidden="true" /></div><p className="setting-note"><Clock3 size={14} aria-hidden="true" />{t("统计与自动采样统一使用")} {t(BUSINESS_TIME_ZONE_LABEL)}{t("；手动同步不会改变自动时刻。")}</p><Toggle checked={data.settings.scheduledSyncEnabled} onChange={(value) => onSchedule(value, configuredInterval)} label={t("启用自动同步")} description={t("按北京时间固定刻度运行，例如每 30 分钟固定在整点和半点；必要时会打开临时 Pixiv 标签页并自动关闭。")} /><div className="setting-select-row"><div><strong>{t("同步方式与间隔")}</strong><p>{t("选择“仅手动”即可关闭自动采样；休眠恢复后不会密集补跑。")}</p></div><label className="select-field"><Clock3 size={15} aria-hidden="true" /><span className="sr-only">{t("同步方式与间隔")}</span><select value={scheduleValue} onChange={(event) => { const value = event.currentTarget.value; onSchedule(value !== "manual", value === "manual" ? configuredInterval : Number(value)); }}><option value="manual">{t("仅手动")}</option><option value="0.5">{t("每 30 分钟")}</option><option value="1">{t("每 1 小时")}</option><option value="2">{t("每 2 小时")}</option><option value="4">{t("每 4 小时")}</option><option value="12">{t("每 12 小时")}</option><option value="24">{t("每天")}</option></select></label></div><Toggle checked={data.settings.showPixivChips} onChange={onShowChips} label={t("在 Pixiv 页面显示轻量提示")} description={t("只显示同步状态小标记；不改变作品页面内容。")} /></section>
      <div className="settings-grid"><DataTransferSection isPreview={isPreview} importDisabled={isPreview} importing={storageBusy === "import"} onExportJson={onExportJson} onExportCsv={onExportCsv} onImportFile={onImportFile} /><section className="setting-section"><div className="section-heading"><div><p className="eyebrow">RETENTION RESULT</p><h2>{t("最近整理结果")}</h2></div><Database size={19} aria-hidden="true" /></div>{maintenanceResult ? <p className="setting-note" role="status"><CheckCircle2 size={14} aria-hidden="true" />{t("保留 {retained} 条样本，删除 {deleted} 条；{status}。", { retained: formatCount(maintenanceResult.retainedSamples), deleted: formatCount(maintenanceResult.deletedSamples ?? 0), status: maintenanceResult.pendingReason ? maintenancePendingLabel(maintenanceResult.pendingReason) : t("本地整理已完成") })}</p> : <p className="section-description">{t("自动整理在同步后低频执行。前三天完整保留，超过三天后逐级抽稀；写入和删除在同一个浏览器本地事务中完成。")}</p>}</section></div>
      <StorageCenter model={storageModel} disabled={isPreview} busyAction={storageBusy} onRepairCovers={onRepairCovers} onMaintain={onMaintainData} onChooseBackup={onChooseBackup} />
      <section className="setting-section"><div className="section-heading"><div><p className="eyebrow">PRIVACY & LIMITATIONS</p><h2>{t("隐私与口径")}</h2></div><Home size={19} aria-hidden="true" /></div><div className="limitation-list"><p><Check size={16} aria-hidden="true" /><span>{t("看板数据保存在扩展本地；开启 Agent 数据分享后，按需查询结果会发送至你配置的 API 服务。")}</span></p><p><Check size={16} aria-hidden="true" /><span>{t("浏览量来自 Pixiv 作品管理页，包含作品详情页与 Home 信息流统计；它不同于 Premium Access Analytics。")}</span></p><p><Check size={16} aria-hidden="true" /><span>{t("缩略图会直接联系")} <code>i.pximg.net</code> {t("CDN；加载失败时使用本地占位图。Pixiv 改版也可能影响解析。")}</span></p><p><Check size={16} aria-hidden="true" /><span>{t("第一次同步只能建立基线，无法重建安装前的增长；没有足够历史时，洞察会明确显示样本不足。")}</span></p></div></section>
      <section className="setting-section danger-section"><div className="section-heading"><div><p className="eyebrow">ACCOUNT BINDING</p><h2>{t("当前账号")}</h2></div><Trash2 size={19} aria-hidden="true" /></div><AccountIdentity account={data.settings.boundAccount} /><p className="section-description">{t("清空后，本地作品历史会被删除；下一次同步会绑定当前已登录的 Pixiv 账号。Agent 对话需在 Agent 工作区单独导出或删除。")}</p><button type="button" className="danger-button" onClick={() => onClearData?.()}><Trash2 size={16} aria-hidden="true" />{t("清空本地数据并重新绑定")}</button></section>
      <section className="setting-section history-section"><div className="section-heading"><div><p className="eyebrow">SYNC HISTORY</p><h2>{t("同步记录")}</h2></div><span className="section-note">{t("最近")} {Math.min(10, data.runs.length)} {t("次")}</span></div>{data.runs.length === 0 ? <p className="muted-copy">{t("尚无同步记录。完成第一次同步后，状态和错误会显示在这里。")}</p> : <div className="history-table-wrap"><table className="history-table"><thead><tr><th>{t("时间")}</th><th>{t("触发方式")}</th><th>{t("结果")}</th><th>{t("作品")}</th><th>{t("变化")}</th><th>{t("备注")}</th></tr></thead><tbody>{data.runs.slice(0, 10).map((run) => <tr key={run.runId}><td>{formatTimestamp(run.finishedAt ?? run.startedAt)}</td><td>{run.trigger === "scheduled" ? t("定时") : run.trigger === "recovery" ? t("恢复") : run.trigger === "passive" ? t("页面观察") : t("手动")}</td><td><RunStatus run={run} isPreview={isPreview} /></td><td>{run.works}</td><td>{run.changedWorks}</td><td>{runNote(run)}</td></tr>)}</tbody></table></div>}</section>
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
  // The range-start point carries the last known value, so the first observed
  // change keeps its predecessor without rebuilding the entire history.
  const incrementPoints = useMemo(() => absoluteTimelinePoints(timeline, metric, true), [timeline, metric]);
  const option = useMemo(() => buildGrowthChartOption({ points, metric }), [metric, points]);
  const label = DASHBOARD_CHART_METRIC_LABELS[metric];
  return (
    <div className="chart-panel" data-testid="growth-chart">
      <div className="chart-control-row"><MetricSelector value={metric} onChange={setMetric} label={t("作品增长图表指标")} /><ChartRangeControl value={rangeValue} onChange={setRangeValue} /></div>
      <EChartsHost
        option={option}
        hasData={points.length >= 2}
        ariaLabel={t("{p0}绝对总数折线图", { p0: label })}
        emptyMessage={range ? t("所选范围内至少需要两次有效观察。") : t("请先选择有效的起止时间。")}
        summary={t("{p0}按绝对总数绘制，共 {p1} 个有效采样点；横轴按北京时间的真实采样时刻绘制。", { p0: label, p1: formatCount(points.length) })}
        height={238}
      />
      {range && <IncrementChart points={incrementPoints} metric={metric} range={range} name={t("作品")} />}
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
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={t("{p0}详情", { p0: analysis.work.title })}>
        <div className="drawer-header"><div><p className="eyebrow">WORK DETAIL</p><h2>{analysis.work.title}</h2><p>{contentTypeLabel(contentTypeForWork(analysis.work))} · {analysis.work.id} · {workConfidence(analysis)}</p></div><IconButton label={t("关闭作品详情")} onClick={onClose}><X size={19} /></IconButton></div>
        <div className="drawer-scroll">
          <div className="drawer-work-meta"><Thumbnail work={analysis.work} /><div><strong>{intraday ? t("今日 {p0} 次观察", { p0: formatCount(intraday.sampleCount) }) : t("今日暂无采样")}</strong><span>{intraday ? baselineLabel(intraday.baselineLabel) : t("今日无记录")} · {analysis.latestSample ? formatElapsed(analysis.lastDelta.views.elapsedHours).replace(t("上次采样"), t("上次变化")) : t("暂无变化记录")}</span></div><a href={analysis.work.workUrl} target="_blank" rel="noreferrer" className="external-link">{t("打开 Pixiv")} <ExternalLink size={14} aria-hidden="true" /> </a></div>
          <div className="detail-metric-grid">{metricCards.map((item) => { const todayValue = todayDelta(intraday, item.key); const historicalValue = analysis.lastDelta[item.key].value; return <div className="detail-metric" key={item.key}><span>{item.icon}{METRIC_LABELS[item.key]}</span><strong>{formatCount(metrics[item.key])}</strong><small className={cn(todayValue !== null && todayValue > 0 && "positive", todayValue !== null && todayValue < 0 && "negative")}>{todayValue === null ? t("今日暂无") : t("今日 {p0}", { p0: formatDelta(todayValue) })}</small><small className="long-term">{historicalValue === null ? t("相邻变化暂无") : t("相邻变化 {p0}", { p0: formatDelta(historicalValue) })}</small></div>; })}</div>
          <section className="drawer-section"><div className="section-heading"><div><p className="eyebrow">ABSOLUTE METRIC HISTORY</p><h3>{t("指标绝对值")}</h3></div><span className="section-note">{t("默认近24小时 · 真实时间间隔")}</span></div><GrowthChart workKey={analysis.work.key} samples={history} observations={observations} observationBatches={observationBatches} /></section>
          <section className="drawer-section"><div className="section-heading"><div><p className="eyebrow">CHANGE EVENTS</p><h3>{t("逐次变化记录")}</h3></div><span className="section-note">{events.length} {t("次")}</span></div>{events.length === 0 ? <EmptyState icon={<Clock3 size={20} />} title={t("还没有变化记录")} body={t("完成同步并捕获到指标变化后，这里会逐次显示四项变化。")} /> : <div className="change-event-list">{events.slice().reverse().map(({ sample, delta }, index) => <div className="change-event-row" key={`${sample.runId}-${sample.collectedAt}-${index}`}><div className="change-event-heading"><strong>{index === 0 ? t("最近变化") : t("变化 {p0}", { p0: events.length - index })}</strong><span>{formatTimestamp(sample.collectedAt)} · UTC+8</span></div><div className="change-event-metrics"><span>{t("浏览")} <strong>{formatDelta(delta.views)}</strong></span><span>{t("赞")} <strong>{formatDelta(delta.likes)}</strong></span><span>{t("收藏")} <strong>{formatDelta(delta.bookmarks)}</strong></span><span>{t("评论")} <strong>{formatDelta(delta.comments)}</strong></span></div></div>)}</div>}</section>
          {rankingHistory.length > 0 && <section className="drawer-section ranking-history-section"><div className="section-heading"><div><p className="eyebrow">RANKING HISTORY</p><h3>{t("排名记录")}</h3></div><span className="section-note">{rankingHistory.length} {t("次")}</span></div><div className="ranking-history-list">{rankingHistory.slice().reverse().map((event) => <div className="ranking-history-row" key={`${event.status}-${event.observedAt}`}><span className={cn("snapshot-dot", event.status === "unranked" && "unranked-dot")} /><div><strong>{rankingStatusLabel(event.status)}</strong><small>{event.status === "ranked" ? t("当前 #{p0}", { p0: event.rank ?? "—" }) : t("当前未上榜")} · {formatTimestamp(event.observedAt)} · {rankingSourceLabel(event.source)}</small></div></div>)}</div></section>}
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
        <div className="modal-topline"><span className="modal-mark"><Activity size={21} aria-hidden="true" /></span><IconButton label={t("关闭首次使用说明")} onClick={onClose}><X size={19} /></IconButton></div>
        <p className="eyebrow">FIRST SYNC</p><h2 id="onboarding-title">{t("先建立你的增长基线")}</h2><p className="modal-lead">{t("PixivPulse 只在本机记录当前已登录 Pixiv 账号的作品管理页快照。第一次同步不判断增长，它只回答：从今天开始，你的作品是什么状态。")}</p>
        <div className="onboarding-points"><p><span>01</span><strong>{t("历史从今天开始")}</strong><small>{t("首次同步建立基线，无法重建安装前的增长。")}</small></p><p><span>02</span><strong>{t("口径来自作品管理页")}</strong><small>{t("浏览量包含作品详情页与 Home 信息流统计，不等同于 Premium Access Analytics。")}</small></p><p><span>03</span><strong>{t("后台采集是可控的")}</strong><small>{t("后台优先，必要时会打开临时 Pixiv 标签页，完成后自动关闭；浏览器关闭或设备休眠时不会补发密集请求。")}</small></p><p><span>04</span><strong>{t("数据只留在本机")}</strong><small>{t("所有作品、快照和同步记录都只保存在本机；缩略图仍会联系 Pixiv CDN。")}</small></p></div>
        <fieldset className="schedule-choice"><legend>{t("同步方式")}</legend><label className={cn(!scheduled && "selected")}><input type="radio" name="onboarding-schedule" checked={!scheduled} onChange={() => setScheduled(false)} /><span><HandIcon /><strong>{t("仅手动同步")}</strong><small>{t("由你决定何时读取当前登录的 Pixiv 账号。")}</small></span></label><label className={cn(scheduled && "selected")}><input type="radio" name="onboarding-schedule" checked={scheduled} onChange={() => setScheduled(true)} /><span><CalendarClock size={17} aria-hidden="true" /><strong>{t("每 1 小时自动同步")}</strong><small>{t("按每小时采样，始终只读；可在设置中调整间隔。")}</small></span></label></fieldset>
        {error && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{t(error)}</p>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={() => void onLater()}>{t("稍后设置")}</button><button type="button" className="primary-button" onClick={() => void onConfirm(scheduled)}>{t("保存并开始第一次同步")} <ArrowUpRight size={16} aria-hidden="true" /></button></div>
      </section>
    </div>
  );
}

export function ClearDataModal({ busy, error, onCancel, onConfirm }: { busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-layer" role="presentation">
      <section className="clear-modal" role="dialog" aria-modal="true" aria-labelledby="clear-data-title">
        <div className="modal-topline"><span className="modal-mark danger-mark"><Trash2 size={21} aria-hidden="true" /></span><IconButton label={t("取消清空本地数据")} onClick={onCancel} disabled={busy}><X size={19} /></IconButton></div>
        <p className="eyebrow">DANGER ZONE</p>
        <h2 id="clear-data-title">{t("清空本地数据并重新绑定？")}</h2>
        <p className="modal-lead">{t("所有本地 PixivPulse 历史（作品、快照、观察和同步记录）将被永久删除；下一次同步会绑定当前已登录的 Pixiv 账号。此操作不可撤销。")}</p>
        {error && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{t(error)}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>{t("取消")}</button><button type="button" className="danger-button" onClick={onConfirm} disabled={busy}><Trash2 size={16} aria-hidden="true" />{busy ? t("正在清空…") : t("确认清空并重新绑定")}</button></div>
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
    return <section className="sync-result-toast empty-result" role="status" aria-live="polite"><CheckCircle2 size={19} aria-hidden="true" /><div><strong>{t("已完成读取，Pixiv 返回 0 件作品")}</strong><p>{t("本次同步没有可保存的作品记录。")}</p></div><IconButton label={t("关闭同步结果")} onClick={onClose}><X size={16} /></IconButton></section>;
  }
  const counts = contentCountsForRun(data, run);
  const contentSummary = (["novel", "illustration", "manga", "ugoira", "unknown"] as WorkContentType[])
    .filter((type) => counts[type] > 0)
    .map((type) => `${contentTypeLabel(type)} ${formatCount(counts[type])}`)
    .join(" · ");
  return <section className="sync-result-toast" role="status" aria-live="polite"><CheckCircle2 size={19} aria-hidden="true" /><div><strong>{t("已收集")} {formatCount(run.works)} {t("件作品")}</strong><p>{contentSummary}</p></div><button type="button" className="text-button sync-result-view" onClick={onViewAll}>{t("查看全部作品")} <ChevronRight size={14} aria-hidden="true" /></button><IconButton label={t("关闭同步结果")} onClick={onClose}><X size={16} /></IconButton></section>;
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
      { key: "fresh", label: t("近 3 天"), count: tiers?.lossless ?? data.samples.filter((sample) => !sample.compactionLevel).length, description: t("完整保留") },
      { key: "30m", label: t("3–7 天"), count: tiers?.["30m"] ?? 0, description: t("每 30 分钟") },
      { key: "1h", label: t("7–30 天"), count: tiers?.["1h"] ?? 0, description: t("每 1 小时") },
      { key: "6h", label: t("30 天以上"), count: tiers?.["6h"] ?? 0, description: t("每 6 小时") },
    ],
    backup: info?.backup ?? { configured: false, directoryName: null, permission: "unknown", pendingFrames: 0, lastSuccessAt: null, lastFileName: null, lastError: null },
  };
}

function maintenancePendingLabel(reason: string): string {
  if (reason === "backup-directory-required") return t("等待选择抽稀前备份目录");
  if (reason === "backup-verification-failed") return t("备份写入或复验失败，抽稀已暂停");
  if (reason === "revision-race") return t("数据刚刚更新，将在下一轮重试");
  return t("等待处理：{p0}", { p0: reason });
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
  const [agentOpened, setAgentOpened] = useState(false);
  useEffect(() => { if (activeTab === "agent") setAgentOpened(true); }, [activeTab]);
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
        ? t("首次说明已关闭，但状态保存失败；可稍后在「数据与设置」中重试。")
        : t("首次说明已关闭。可随时在「数据与设置」→「重新查看首次说明」中打开。"));
    } else if (persisted === false) {
      setStatusToast(t("首次说明已关闭，但状态保存失败；可在「数据与设置」中重试。"));
    }
  };
  const finishOnboarding = async (scheduled: boolean) => {
    setOnboardingError(null);
    setForcedOnboardingOpen(true);
    markLegacyOnboardingSeen();
    const persisted = await controller.completeOnboarding();
    if (persisted === false) {
      setOnboardingError(controller.error ?? t("首次说明状态暂时无法保存，请稍后重试。"));
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
      setStatusToast(exportError instanceof Error ? exportError.message : t("JSON 备份生成失败"));
    }
  };
  const exportCsv = async () => {
    try {
      const backup = await createNativePortableBackup({ account: data.settings.boundAccount ?? null, settings: data.settings });
      triggerDownload(portableBackupToCsv(backup), `pixivpulse-backup-${beijingExportDate(Date.now())}.csv`, "text/csv;charset=utf-8");
    } catch (exportError) {
      setStatusToast(exportError instanceof Error ? exportError.message : t("CSV 备份生成失败"));
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
        : t("本地数据整理完成，保留 {p0} 条历史样本。", { p0: formatCount(result.retainedSamples) }));
      await refreshStorageInfo();
    } else {
      setStatusToast(controller.error ?? t("本地数据整理失败，请稍后重试。"));
    }
  };
  const refreshStorageInfo = async () => setStorageInfo(await controller.getStorageCenter());
  const configureBackupDirectory = async () => {
    if (storageBusy) return;
    setStorageBusy("backup");
    try {
      const config = await chooseBackupDirectory();
      await refreshStorageInfo();
      setStatusToast(t("抽稀前备份目录已设为 {p0}", { p0: config.directoryName }));
    } catch (backupError) {
      if (backupError instanceof DOMException && backupError.name === "AbortError") return;
      setStatusToast(backupError instanceof Error ? backupError.message : t("备份目录授权失败"));
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
    setStatusToast(success ? t("已登记全部缺失或失效封面，后台会按低频队列逐张补齐。") : controller.error ?? t("封面检查失败"));
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
      setStatusToast(readError instanceof Error ? readError.message : t("备份文件读取失败"));
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
      setStatusToast(t("导入完成：新增 {p0} 件作品、{p1} 条样本，跳过 {p2} 条重复记录。", { p0: result.works, p1: result.samples, p2: result.duplicates }));
      void controller.repairCovers();
    } catch (commitError) {
      setImportError(commitError instanceof Error ? commitError.message : t("导入事务失败"));
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
    setClearError(controller.error ?? t("清空失败，请稍后重试。"));
  };
  return (
    <div className={cn("app-shell", controller.isPreview && "preview-mode")}>
      <Sidebar activeTab={activeTab} onChange={setActiveTab} onOpenOnboarding={openOnboarding} />
      <main className="dashboard-main">
        <Header activeTab={activeTab} data={data} isPreview={controller.isPreview} isLoading={controller.isLoading} hasLoadedData={controller.hasLoadedData} isSyncing={controller.isSyncing} onSync={() => void handleSync()} />
        {controller.isPreview && <div className="preview-banner" role="status"><Sparkles size={16} aria-hidden="true" /><span><strong>{t("预览数据")}</strong> {t("· 当前浏览器未连接扩展后台，下面是可交互的本地示例，不代表已完成真实同步。")}</span></div>}
        {agentOpened && controller.hasLoadedData && <div hidden={activeTab !== "agent"} className="dashboard-content"><Suspense fallback={<p role="status">{t("正在载入 Agent…")}</p>}><LazyAgentView data={data} isPreview={controller.isPreview} active={activeTab === "agent"} /></Suspense></div>}
        <div hidden={activeTab === "agent" && controller.hasLoadedData} className="dashboard-content">{controller.isLoading && !controller.isPreview ? <DashboardInitialLoading /> : !controller.hasLoadedData && controller.error ? <DashboardInitialError error={controller.error} onRetry={() => void controller.refresh()} /> : <>{activeTab === "overview" && <OverviewView analyses={overviewAnalyses} data={overviewPresentation.data} intraday={overviewIntraday} onOpenWork={openWork} onGoToWorks={() => setActiveTab("works")} animationSignal={overviewPresentation.animationEpoch} />}{activeTab === "works" && <WorksView analyses={analyses} intradayByWork={intradayByWork} onOpenWork={openWork} completedRunWorks={newestCompletedRun?.works ?? null} coverCache={data.coverCache} />}{activeTab === "compare" && <CompareView analyses={analyses} compareKeys={compareKeys} onToggleCompare={toggleCompare} onOpenWork={openWork} data={data} />}{activeTab === "settings" && <SettingsView data={data} isPreview={controller.isPreview} error={controller.error} onSchedule={(enabled, interval) => void controller.setSchedule(enabled, interval)} onShowChips={(enabled) => void controller.setShowChips(enabled)} onExportJson={() => void exportJson()} onExportCsv={exportCsv} onOpenOnboarding={openOnboarding} onClearData={requestClearData} storageModel={storageModel} storageBusy={storageBusy} onRepairCovers={() => void repairCovers()} onMaintainData={() => void maintainData()} onChooseBackup={() => void configureBackupDirectory()} onImportFile={(file) => void previewImport(file)} maintenanceResult={maintenanceResult} />}</>}</div>
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
