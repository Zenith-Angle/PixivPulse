import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bookmark,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  Heart,
  LayoutDashboard,
  MessageCircle,
  RefreshCw,
  Wifi,
} from "lucide-react";
import { buildIntradayAnalytics } from "../domain/intraday";
import { nextBeijingMidnight } from "../domain/time";
import type { RuntimeResponse } from "../domain/messages";
import type { DashboardData, SyncState } from "../domain/types";
import { createDemoData, createEmptyDashboardData } from "./demoData";
import { DATA_REVISION_STORAGE_KEY } from "../data/local-state";
import { AnimatedNumber } from "./AnimatedNumber";
import { formatCount, formatDelta, formatTimestamp } from "./helpers";
import { buildFollowerAnalytics, type AccountFollowerSample, type FollowerAnalytics } from "./followerAnalytics";
import { sendRuntimeMessage, type DashboardDataRequest } from "./dashboardDataRequest";

const SYNC_STATUSES: SyncState["status"][] = ["opening", "collecting", "rechecking", "committing"];

export const POPUP_SCHEDULE_OPTIONS = [
  { value: "manual", label: "仅手动" },
  { value: "0.5", label: "每 30 分钟" },
  { value: "1", label: "每 1 小时" },
  { value: "2", label: "每 2 小时" },
  { value: "4", label: "每 4 小时" },
  { value: "12", label: "每 12 小时" },
  { value: "24", label: "每天" },
] as const;

const hasRuntime = (): boolean => typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";

const isActiveStatus = (status: SyncState["status"] | null | undefined): boolean => Boolean(status && SYNC_STATUSES.includes(status));

const statusLabel = (status: SyncState["status"] | null | undefined): string => {
  switch (status) {
    case "opening": return "正在启动采集";
    case "collecting": return "正在采集作品";
    case "rechecking": return "正在复核页面";
    case "committing": return "正在保存快照";
    case "completed": return "同步完成";
    case "failed": return "同步失败";
    default: return "等待同步";
  }
};

const latestRun = (data: DashboardData) => data.runs[0] ?? null;

const syncStatus = (data: DashboardData): SyncState["status"] => data.syncState?.status ?? latestRun(data)?.status ?? "idle";

const syncError = (data: DashboardData): string | null => {
  if (isActiveStatus(data.syncState?.status)) return data.syncState?.errorMessage ?? null;
  return data.syncState?.errorMessage ?? latestRun(data)?.errorMessage ?? null;
};

const completedWorkCount = (data: DashboardData): number => latestRun(data)?.status === "completed"
  ? latestRun(data)?.works ?? data.works.length
  : data.syncState?.seenWorkIds.length ?? data.works.length;

type PopupFollowerData = DashboardData & { accountFollowerSamples?: AccountFollowerSample[] };

const accountFollowerSamplesFor = (data: DashboardData): AccountFollowerSample[] => {
  const samples = (data as PopupFollowerData).accountFollowerSamples;
  return Array.isArray(samples) ? samples : [];
};

interface RuntimeResponseExtras {
  transport?: string;
  fallback?: boolean | string;
}

const transportLabel = (data?: DashboardData, response?: RuntimeResponse | null): string | null => {
  const responseExtras = response as (RuntimeResponse & RuntimeResponseExtras) | null | undefined;
  const transport = data?.syncState?.transport ?? responseExtras?.transport;
  if (transport === "api") return "后台 API 直采";
  if (transport === "tab") return "标签页回退采集";
  if (typeof transport === "string" && transport) return `传输：${transport}`;
  if (responseExtras?.fallback === true) return "后台回退采集";
  if (typeof responseExtras?.fallback === "string" && responseExtras.fallback) return `后台回退：${responseExtras.fallback}`;
  return null;
};

export interface PopupController {
  data: DashboardData;
  isPreview: boolean;
  isLoading: boolean;
  hasLoadedData: boolean;
  isSyncing: boolean;
  error: string | null;
  feedback: string | null;
  transport: string | null;
  refresh: () => Promise<void>;
  startSync: () => Promise<void>;
  setSchedule: (value: string) => Promise<void>;
  openDashboard: () => Promise<void>;
}

export function usePopupData(bootstrapRequest: DashboardDataRequest | null = null): PopupController {
  const isPreview = useMemo(() => !hasRuntime(), []);
  const [data, setData] = useState<DashboardData>(() => (isPreview ? createDemoData() : createEmptyDashboardData()));
  const [isLoading, setIsLoading] = useState(!isPreview);
  const [hasLoadedData, setHasLoadedData] = useState(isPreview);
  const [syncRequested, setSyncRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [transport, setTransport] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const syncRequestedRef = useRef(false);
  const initialLoadStartedRef = useRef(false);
  const bootstrapRequestRef = useRef(bootstrapRequest);
  const loadRequestRef = useRef(0);

  const setSyncRequestedState = (value: boolean): void => {
    syncRequestedRef.current = value;
    setSyncRequested(value);
  };

  const applyResponse = useCallback((response: RuntimeResponse | null): DashboardData | null => {
    if (!response?.ok) return null;
    const nextData = response.data ?? null;
    if (nextData) {
      const mergedData = response.syncState === undefined
        ? nextData
        : { ...nextData, syncState: response.syncState ?? null };
      setData(mergedData);
      setTransport(transportLabel(mergedData, response));
      return mergedData;
    } else if (response.syncState) {
      setData((current) => ({ ...current, syncState: response.syncState ?? null }));
      setTransport(transportLabel(undefined, response));
    }
    return nextData;
  }, []);

  const finishRequestedSync = useCallback((nextData: DashboardData | null, response?: RuntimeResponse | null): void => {
    const status = nextData ? syncStatus(nextData) : response?.ok ? response.syncState?.status : null;
    if (!syncRequestedRef.current || isActiveStatus(status)) return;
    setSyncRequestedState(false);
    if (status === "completed" && nextData) setFeedback(`已收集 ${formatCount(completedWorkCount(nextData))} 件作品`);
  }, []);

  const load = useCallback(async (request?: DashboardDataRequest) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (!hasRuntime()) {
      setIsLoading(false);
      return;
    }
    setIsLoading((current) => current || !loadedRef.current);
    const response = await (request ?? sendRuntimeMessage({ type: "GET_DASHBOARD_DATA" }));
    if (requestId !== loadRequestRef.current) return;
    if (response?.ok && response.data) {
      const nextData = applyResponse(response);
      setHasLoadedData(true);
      setError(null);
      finishRequestedSync(nextData, response);
      loadedRef.current = true;
    } else {
      setError(response && !response.ok ? response.error : "扩展后台未返回本地数据");
      if (syncRequestedRef.current) setSyncRequestedState(false);
    }
    setIsLoading(false);
  }, [applyResponse, finishRequestedSync]);

  const refresh = useCallback(() => load(), [load]);

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    const request = bootstrapRequestRef.current ?? undefined;
    bootstrapRequestRef.current = null;
    void load(request);
  }, [load]);

  const status = syncStatus(data);
  const isSyncing = syncRequested || isActiveStatus(status);

  useEffect(() => {
    if (!hasRuntime() || !isSyncing) return;
    const timer = window.setTimeout(() => void refresh(), 1_000);
    return () => window.clearTimeout(timer);
  }, [isSyncing, refresh]);

  useEffect(() => {
    if (!hasRuntime() || !chrome.storage?.onChanged) return;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== "local" || (!changes["pixivPulse.settings"] && !changes["pixivPulse.syncState"] && !changes[DATA_REVISION_STORAGE_KEY])) return;
      void refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  const startSync = useCallback(async () => {
    setError(null);
    setFeedback(null);
    setSyncRequestedState(true);
    const response = await sendRuntimeMessage({ type: "START_SYNC", trigger: "manual" });
    if (!response) {
      setSyncRequestedState(false);
      setFeedback("预览数据不会执行真实同步");
      return;
    }
    if (!response.ok) {
      setSyncRequestedState(false);
      setError(response.error);
      return;
    }
    const nextData = applyResponse(response);
    finishRequestedSync(nextData, response);
    if (!nextData) void refresh();
  }, [applyResponse, finishRequestedSync, refresh]);

  const setSchedule = useCallback(async (value: string) => {
    const option = POPUP_SCHEDULE_OPTIONS.find((item) => item.value === value) ?? POPUP_SCHEDULE_OPTIONS[2];
    const enabled = option.value !== "manual";
    const intervalHours = enabled ? Number(option.value) : data.settings.syncIntervalHours || 1;
    setData((current) => ({ ...current, settings: { ...current.settings, scheduledSyncEnabled: enabled, syncIntervalHours: intervalHours } }));
    setError(null);
    if (!hasRuntime()) return;
    const response = await sendRuntimeMessage({ type: "SET_SCHEDULED_SYNC", enabled, intervalHours });
    if (response?.ok) applyResponse(response);
    else if (response && !response.ok) setError(response.error);
  }, [applyResponse, data.settings.syncIntervalHours]);

  const openDashboard = useCallback(async () => {
    const response = await sendRuntimeMessage({ type: "OPEN_DASHBOARD" });
    if (response && !response.ok) setError(response.error);
    if (!response) setFeedback("预览数据未连接扩展后台");
  }, []);

  return {
    data,
    isPreview,
    isLoading,
    hasLoadedData,
    isSyncing,
    error: error ?? syncError(data),
    feedback,
    transport,
    refresh,
    startSync,
    setSchedule,
    openDashboard,
  };
}

function IconLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="popup-icon-label">{icon}{children}</span>;
}

function AccountBlock({ data, follower }: { data: DashboardData; follower: FollowerAnalytics }) {
  const account = data.settings.boundAccount;
  const todayDelta = follower.todayDelta;
  const todayLabel = follower.todayConfidence === "approximate" ? "今日首轮采样至今（部分基线）" : "北京时间今日粉丝增长";
  return <section className="popup-account" aria-label="当前 Pixiv 账号"><span className="account-avatar" aria-hidden="true">{account?.name?.slice(0, 1) || "?"}</span><div className="popup-account-identity"><strong>{account?.name || "尚未绑定账号"}</strong><small>{account ? `Pixiv ID ${account.id}` : "第一次同步后绑定当前登录账号"}</small></div><div className="popup-account-followers" aria-label="账号粉丝统计"><span><small>粉丝总数</small><strong><AnimatedNumber value={formatCount(follower.current)} comparisonValue={follower.current} /></strong></span><span className={todayDelta !== null && todayDelta > 0 ? "positive" : todayDelta !== null && todayDelta < 0 ? "negative" : undefined} aria-label={todayLabel}><small title={todayLabel}>今日</small><strong><AnimatedNumber value={formatDelta(todayDelta)} comparisonValue={todayDelta} /></strong></span></div></section>;
}

function Metric({ label, value, rawValue, icon, tone, animate }: { label: string; value: string; rawValue: number | null; icon: ReactNode; tone: "views" | "likes" | "bookmarks" | "comments"; animate: boolean }) {
  return <div className={`popup-metric ${tone}`}><IconLabel icon={icon}>{label}</IconLabel><strong><AnimatedNumber value={value} comparisonValue={rawValue} animate={animate} /></strong></div>;
}

const headerStatusLabel = (status: SyncState["status"], isLoading: boolean, isSyncing: boolean, isPreview: boolean): string => {
  if (isLoading) return "读取中";
  if (isSyncing) return "同步中";
  if (isPreview) return "预览";
  if (status === "failed") return "需处理";
  return "已连接";
};

const runSummary = (last: ReturnType<typeof latestRun>, isPreview: boolean): string => {
  if (!last) return "尚无同步记录";
  if (isPreview) return `预览样本 ${formatCount(last.works)} 件 · ${formatTimestamp(last.finishedAt ?? last.startedAt)}`;
  if (last.status === "completed") return `上次同步 ${formatTimestamp(last.finishedAt ?? last.startedAt)} · ${formatCount(last.works)} 件作品 · ${formatCount(last.changedWorks)} 件有变化`;
  return `上次同步失败 · ${formatTimestamp(last.finishedAt ?? last.startedAt)}`;
};

function PopupInitialLoading() {
  return <div className="popup-shell"><header className="popup-header"><div className="popup-brand"><img className="popup-brand-mark" src="/icon/48.png" alt="" aria-hidden="true" draggable={false} /><strong>PixivPulse</strong></div><div className="popup-header-actions"><span className="popup-header-status active"><span className="status-dot" />读取中</span></div></header><main className="popup-main popup-initial-loading" role="status" aria-label="正在读取本地数据"><div className="popup-loading-title"><RefreshCw size={18} className="spin" aria-hidden="true" /><strong>正在读取本地数据</strong></div><div className="popup-loading-grid" aria-hidden="true"><span /><span /><span /><span /></div><div className="popup-loading-lines" aria-hidden="true"><span /><span /></div></main><footer className="popup-footer"><div className="dashboard-link popup-dashboard-link-loading" aria-hidden="true"><LayoutDashboard size={15} />打开完整看板</div></footer></div>;
}

function PopupInitialError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="popup-shell"><header className="popup-header"><div className="popup-brand"><img className="popup-brand-mark" src="/icon/48.png" alt="" aria-hidden="true" draggable={false} /><strong>PixivPulse</strong></div><div className="popup-header-actions"><span className="popup-header-status error"><span className="status-dot" />读取失败</span></div></header><main className="popup-main popup-initial-error" role="alert"><AlertTriangle size={22} aria-hidden="true" /><strong>本地数据暂时无法读取</strong><p>{error}</p><button type="button" className="sync-action" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />重新读取</button></main><footer className="popup-footer"><div className="dashboard-link popup-dashboard-link-loading" aria-hidden="true"><LayoutDashboard size={15} />打开完整看板</div></footer></div>;
}

export function PopupApp({ bootstrapRequest = null }: { bootstrapRequest?: DashboardDataRequest | null }) {
  const controller = usePopupData(bootstrapRequest);
  const { data } = controller;
  const [beijingDateRevision, setBeijingDateRevision] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const arm = (): void => {
      const now = Date.now();
      const midnight = nextBeijingMidnight(now);
      timer = window.setTimeout(() => {
        setBeijingDateRevision((current) => current + 1);
        arm();
      }, midnight == null ? 60_000 : Math.max(50, midnight - now + 50));
    };
    arm();
    return () => window.clearTimeout(timer);
  }, []);
  const intraday = useMemo(() => buildIntradayAnalytics({
    works: data.works,
    samples: data.samples,
    observations: data.observations,
    observationBatches: data.observationBatches ?? [],
    now: Date.now(),
    configuredIntervalHours: data.settings.syncIntervalHours,
  }), [beijingDateRevision, data.works, data.samples, data.observations, data.observationBatches, data.settings.syncIntervalHours]);
  const followerAnalytics = useMemo(() => buildFollowerAnalytics(accountFollowerSamplesFor(data), {
    accountId: data.settings.boundAccount?.id ?? null,
    now: Date.now(),
  }), [beijingDateRevision, data, data.settings.boundAccount?.id]);
  const status = syncStatus(data);
  const last = latestRun(data);
  const selectedSchedule = data.settings.scheduledSyncEnabled ? String(data.settings.syncIntervalHours) : "manual";
  const currentSchedule = POPUP_SCHEDULE_OPTIONS.some((option) => option.value === selectedSchedule) ? selectedSchedule : "1";
  const headerStatus = headerStatusLabel(status, controller.isLoading, controller.isSyncing, controller.isPreview);
  const displayedTransport = controller.transport ?? transportLabel(data);
  const statusTone = isActiveStatus(status) ? "active" : status === "failed" ? "error" : status === "completed" ? "success" : "idle";
  const statusText = controller.isLoading
    ? "正在读取本地状态"
    : controller.isSyncing && isActiveStatus(status)
      ? statusLabel(status)
      : controller.isSyncing
        ? "正在启动采集"
        : controller.isPreview
          ? "预览就绪"
          : statusLabel(status);

  if (controller.isLoading && !controller.isPreview) return <PopupInitialLoading />;
  if (!controller.hasLoadedData && controller.error) return <PopupInitialError error={controller.error} onRetry={() => void controller.refresh()} />;

  return <div className="popup-shell">
    <header className="popup-header"><div className="popup-brand"><img className="popup-brand-mark" src="/icon/48.png" alt="" aria-hidden="true" draggable={false} /><strong>PixivPulse</strong></div><div className="popup-header-actions"><span className={`popup-header-status ${statusTone}`}><span className="status-dot" />{headerStatus}</span>{controller.isPreview && <span className="preview-pill">预览数据</span>}</div></header>
    <main className="popup-main">
      <AccountBlock data={data} follower={followerAnalytics} />
      <section className="popup-metrics" aria-label="北京时间今日指标"><Metric label="今日浏览" value={formatDelta(intraday.delta.views)} rawValue={intraday.delta.views} icon={<Eye size={15} aria-hidden="true" />} tone="views" animate={!controller.isLoading} /><Metric label="今日获赞" value={formatDelta(intraday.delta.likes)} rawValue={intraday.delta.likes} icon={<Heart size={15} aria-hidden="true" />} tone="likes" animate={!controller.isLoading} /><Metric label="今日收藏" value={formatDelta(intraday.delta.bookmarks)} rawValue={intraday.delta.bookmarks} icon={<Bookmark size={15} aria-hidden="true" />} tone="bookmarks" animate={!controller.isLoading} /><Metric label="今日评论" value={formatDelta(intraday.delta.comments)} rawValue={intraday.delta.comments} icon={<MessageCircle size={15} aria-hidden="true" />} tone="comments" animate={!controller.isLoading} /></section>
      <div className="popup-meta" aria-label="本地数据摘要"><span><Database size={13} aria-hidden="true" /><span>本地作品</span><strong><AnimatedNumber value={formatCount(data.works.length)} comparisonValue={data.works.length} animate={!controller.isLoading} /></strong></span><span><Clock3 size={13} aria-hidden="true" /><span>今日采样</span><strong><AnimatedNumber value={formatCount(intraday.sampleCount)} comparisonValue={intraday.sampleCount} animate={!controller.isLoading} /></strong><small>轮</small></span></div>
      <section className="sync-band" aria-label="同步"><div className="sync-band-info"><div className="sync-status-line"><span className={`popup-status ${statusTone}`}><span className="status-dot" />{statusText}</span></div><p className="sync-summary"><span className="sync-summary-text">{runSummary(last, controller.isPreview)}</span>{displayedTransport && <><span className="sync-summary-separator">·</span><span className="transport-label"><Wifi size={12} aria-hidden="true" />{displayedTransport}</span></>}</p></div><button type="button" className="sync-action" onClick={() => void controller.startSync()} disabled={controller.isSyncing || controller.isLoading} title="立即读取作品管理页"><RefreshCw size={16} className={controller.isSyncing ? "spin" : undefined} aria-hidden="true" />{controller.isLoading ? "正在读取" : controller.isSyncing ? "同步中" : "立即同步"}</button>{controller.feedback && <p className="popup-feedback" role="status"><CheckCircle2 size={15} aria-hidden="true" />{controller.feedback}</p>}{controller.error && <p className="popup-error" role="alert"><AlertTriangle size={15} aria-hidden="true" />{controller.error}</p>}</section>
      <section className="schedule-row" aria-label="自动同步"><div className="schedule-label"><CalendarClock size={16} aria-hidden="true" /><strong>自动同步</strong></div><label className="popup-select"><span className="sr-only">同步间隔</span><select aria-label="同步间隔" value={currentSchedule} onChange={(event) => void controller.setSchedule(event.currentTarget.value)}>{POPUP_SCHEDULE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></section>
    </main>
    <footer className="popup-footer"><button type="button" className="dashboard-link" onClick={() => void controller.openDashboard()}><LayoutDashboard size={15} aria-hidden="true" />打开完整看板</button></footer>
  </div>;
}
