import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardData, SyncState } from "../domain/types";
import type { RuntimeMessage, RuntimeResponse, StorageCenterInfo } from "../domain/messages";
import type { MaintenanceResult } from "../domain/messages";
import { createDemoData, createEmptyDashboardData } from "./demoData";
import { DATA_REVISION_STORAGE_KEY } from "../data/local-state";
import { sendRuntimeMessage, type DashboardDataRequest } from "./dashboardDataRequest";

const hasChromeRuntime = (): boolean =>
  typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";

export const isUnsupportedRuntimeMessageError = (response: RuntimeResponse | null): boolean =>
  response?.ok === false && /unsupported message/i.test(response.error);

export interface DashboardController {
  data: DashboardData;
  isPreview: boolean;
  isLoading: boolean;
  hasLoadedData: boolean;
  isSyncing: boolean;
  lastRefreshAt: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  startSync: () => Promise<string | null>;
  setSchedule: (enabled: boolean, intervalHours: number) => Promise<void>;
  setShowChips: (enabled: boolean) => Promise<void>;
  completeOnboarding: () => Promise<void | boolean>;
  clearLocalData: () => Promise<boolean>;
  maintainLocalData: () => Promise<MaintenanceResult | null>;
  getStorageCenter: () => Promise<StorageCenterInfo | null>;
  repairCovers: () => Promise<boolean>;
  setLocalData: (update: (data: DashboardData) => DashboardData) => void;
}

export const useDashboardData = (bootstrapRequest: DashboardDataRequest | null = null): DashboardController => {
  const isPreview = useMemo(() => !hasChromeRuntime(), []);
  const [data, setData] = useState<DashboardData>(() => (isPreview ? createDemoData() : createEmptyDashboardData()));
  const [isLoading, setIsLoading] = useState(!isPreview);
  const [hasLoadedData, setHasLoadedData] = useState(isPreview);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(() => (isPreview ? new Date().toISOString() : null));
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
  const syncStateRequestRef = useRef(0);
  const syncStateAppliedVersionRef = useRef(0);
  const coverCacheRequestRef = useRef(0);
  const coverCacheAppliedVersionRef = useRef(0);
  const hasLoadedDataRef = useRef(isPreview);
  const initialLoadStartedRef = useRef(false);
  const bootstrapRequestRef = useRef(bootstrapRequest);

  const load = useCallback(async (request?: DashboardDataRequest) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    syncStateRequestRef.current += 1;
    coverCacheRequestRef.current += 1;
    const syncStateAppliedVersionAtStart = syncStateAppliedVersionRef.current;
    const coverCacheAppliedVersionAtStart = coverCacheAppliedVersionRef.current;
    const isInitialLoad = !hasLoadedDataRef.current;
    if (!hasChromeRuntime()) {
      setIsLoading(false);
      setLastRefreshAt(new Date().toISOString());
      return;
    }
    if (isInitialLoad) setIsLoading(true);
    const response = await (request ?? sendRuntimeMessage({ type: "GET_DASHBOARD_DATA" }));
    if (requestId !== refreshRequestRef.current) return;
    if (response?.ok && response.data) {
      const responseData = response.data;
      setData((current) => {
        const nextSyncState = syncStateAppliedVersionRef.current === syncStateAppliedVersionAtStart
          ? response.syncState === undefined ? responseData.syncState : response.syncState ?? null
          : current.syncState;
        const nextCoverCache = coverCacheAppliedVersionRef.current === coverCacheAppliedVersionAtStart
          ? responseData.coverCache
          : current.coverCache;
        if (nextSyncState === responseData.syncState && nextCoverCache === responseData.coverCache) return responseData;
        const nextData = { ...responseData, syncState: nextSyncState };
        if (nextCoverCache === undefined) delete nextData.coverCache;
        else nextData.coverCache = nextCoverCache;
        return nextData;
      });
      hasLoadedDataRef.current = true;
      setHasLoadedData(true);
      setError(null);
      setLastRefreshAt(new Date().toISOString());
    } else {
      setError(response && !response.ok ? response.error : "扩展后台未返回本地数据");
    }
    setIsLoading(false);
  }, []);

  const refresh = useCallback(() => load(), [load]);

  const refreshSyncState = useCallback(async () => {
    if (!hasChromeRuntime()) return;
    const requestId = syncStateRequestRef.current + 1;
    syncStateRequestRef.current = requestId;
    const response = await sendRuntimeMessage({ type: "GET_SYNC_STATE" });
    if (requestId !== syncStateRequestRef.current) return;
    if (response?.ok && "syncState" in response) {
      syncStateAppliedVersionRef.current += 1;
      setData((current) => ({ ...current, syncState: response.syncState ?? null }));
      if (hasLoadedDataRef.current) setError(null);
    } else if (response && !response.ok) {
      if (hasLoadedDataRef.current) setError(response.error);
    }
  }, []);

  const refreshCoverCache = useCallback(async () => {
    if (!hasChromeRuntime()) return;
    const requestId = coverCacheRequestRef.current + 1;
    coverCacheRequestRef.current = requestId;
    const response = await sendRuntimeMessage({ type: "GET_COVER_CACHE_SUMMARY" });
    if (requestId !== coverCacheRequestRef.current) return;
    if (response?.ok && response.coverCache) {
      const coverCache = response.coverCache;
      coverCacheAppliedVersionRef.current += 1;
      setData((current) => ({ ...current, coverCache }));
      if (hasLoadedDataRef.current) setError(null);
    } else if (response && !response.ok && hasLoadedDataRef.current) {
      setError(response.error);
    }
  }, []);

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    const request = bootstrapRequestRef.current ?? undefined;
    bootstrapRequestRef.current = null;
    void load(request);
  }, [load]);

  useEffect(() => {
    if (!hasChromeRuntime() || !chrome.storage?.onChanged) return undefined;
    let refreshTimer: number | undefined;
    let pendingRefreshFlags = 0;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      const hasDataRevision = DATA_REVISION_STORAGE_KEY in changes;
      const hasSyncState = "pixivPulse.syncState" in changes;
      const hasCoverRevision = "pixivPulse.coverCacheRevision" in changes;
      if (!hasDataRevision && !hasSyncState && !hasCoverRevision) return;
      if (hasDataRevision) pendingRefreshFlags = 4;
      else if ((pendingRefreshFlags & 4) === 0) {
        if (hasSyncState) pendingRefreshFlags |= 1;
        if (hasCoverRevision) pendingRefreshFlags |= 2;
      }
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const flags = pendingRefreshFlags;
        pendingRefreshFlags = 0;
        if ((flags & 4) !== 0) void refresh();
        else {
          if ((flags & 1) !== 0) void refreshSyncState();
          if ((flags & 2) !== 0) void refreshCoverCache();
        }
      }, 80);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      window.clearTimeout(refreshTimer);
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [refresh, refreshCoverCache, refreshSyncState]);

  const startSync = useCallback(async () => {
    if (!hasChromeRuntime()) {
      setIsSyncing(true);
      setData((current) => ({
        ...current,
        syncState: current.syncState
          ? { ...current.syncState, status: "opening", trigger: "manual", updatedAt: new Date().toISOString() }
          : null,
      }));
      window.setTimeout(() => setIsSyncing(false), 900);
      return null;
    }
    setIsSyncing(true);
    setError(null);
    const requestId = syncStateRequestRef.current + 1;
    syncStateRequestRef.current = requestId;
    const response = await sendRuntimeMessage({ type: "START_SYNC", trigger: "manual" });
    if (response?.ok) {
      if (requestId === syncStateRequestRef.current && "syncState" in response) {
        syncStateAppliedVersionRef.current += 1;
        setData((current) => ({ ...current, syncState: response.syncState ?? null }));
      }
      setIsSyncing(false);
      return response.syncState?.runId ?? null;
    } else if (response && !response.ok) {
      setError(response.error);
    }
    setIsSyncing(false);
    return null;
  }, []);

  const setSchedule = useCallback(async (enabled: boolean, intervalHours: number) => {
    setData((current) => ({
      ...current,
      settings: { ...current.settings, scheduledSyncEnabled: enabled, syncIntervalHours: intervalHours },
    }));
    if (!hasChromeRuntime()) return;
    const response = await sendRuntimeMessage({ type: "SET_SCHEDULED_SYNC", enabled, intervalHours });
    if (response?.ok && response.data) setData(response.data);
    if (response && !response.ok) setError(response.error);
  }, []);

  const setShowChips = useCallback(async (enabled: boolean) => {
    setData((current) => ({ ...current, settings: { ...current.settings, showPixivChips: enabled } }));
    if (!hasChromeRuntime()) return;
    const response = await sendRuntimeMessage({ type: "SET_SHOW_CHIPS", enabled });
    if (response?.ok && response.data) setData(response.data);
    if (response && !response.ok) setError(response.error);
  }, []);

  const completeOnboarding = useCallback(async (): Promise<void | boolean> => {
    setError(null);
    setData((current) => ({
      ...current,
      settings: { ...current.settings, onboardingComplete: true },
    }));
    if (!hasChromeRuntime()) return true;
    const response = await sendRuntimeMessage({ type: "SET_ONBOARDING_COMPLETE", complete: true });
    if (response?.ok) {
      if (response.data) setData(response.data);
      return true;
    }
    if (response && !response.ok) setError(response.error);
    return false;
  }, []);

  const clearLocalData = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!hasChromeRuntime()) {
      setData(createEmptyDashboardData());
      setLastRefreshAt(new Date().toISOString());
      return true;
    }
    const response = await sendRuntimeMessage({ type: "CLEAR_LOCAL_DATA" });
    if (response?.ok) {
      setData(response.data ?? createEmptyDashboardData());
      if (response.syncState !== undefined) {
        setData((current) => ({ ...current, syncState: response.syncState ?? null }));
      }
      setLastRefreshAt(new Date().toISOString());
      return true;
    }
    if (response && !response.ok) setError(response.error);
    return false;
  }, []);

  const maintainLocalData = useCallback(async (): Promise<MaintenanceResult | null> => {
    setError(null);
    if (!hasChromeRuntime()) return { rewrittenBatches: 0, retainedSamples: data.samples.length, skippedLegacyObservations: 0, cleanedCovers: 0, cleanedStagedPages: 0 };
    const response = await sendRuntimeMessage({ type: "MAINTAIN_LOCAL_DATA" });
    if (response?.ok) {
      if (response.data) setData(response.data);
      return response.maintenance ?? null;
    }
    if (response && !response.ok) setError(response.error);
    return null;
  }, [data.samples.length]);

  const runSimpleMessage = useCallback(async (message: RuntimeMessage): Promise<RuntimeResponse | null> => {
    setError(null);
    if (!hasChromeRuntime()) return { ok: true };
    const response = await sendRuntimeMessage(message);
    if (response?.ok) {
      if (response.data) setData(response.data);
      return response;
    }
    if (response && !response.ok) setError(response.error);
    return response;
  }, []);

  const getStorageCenter = useCallback(async (): Promise<StorageCenterInfo | null> => {
    if (!hasChromeRuntime()) return null;
    const response = await sendRuntimeMessage({ type: "GET_STORAGE_CENTER" });
    // A dashboard tab can outlive an unpacked-extension rebuild. In that case the
    // previous service worker still serves normal dashboard data but does not know
    // this newer optional message yet. Treat that as an unavailable enhancement,
    // not as data loss or a broken database.
    if (isUnsupportedRuntimeMessageError(response)) return null;
    if (response && !response.ok) setError(response.error);
    return response?.ok ? response.storageCenter ?? null : null;
  }, []);

  const repairCovers = useCallback(async (): Promise<boolean> => {
    const response = await runSimpleMessage({ type: "REPAIR_COVERS" });
    return response?.ok === true;
  }, [runSimpleMessage]);

  return {
    data,
    isPreview,
    isLoading,
    hasLoadedData,
    isSyncing: isSyncing || ["opening", "collecting", "rechecking", "committing"].includes(data.syncState?.status ?? "idle"),
    lastRefreshAt,
    error,
    refresh,
    startSync,
    setSchedule,
    setShowChips,
    completeOnboarding,
    clearLocalData,
    maintainLocalData,
    getStorageCenter,
    repairCovers,
    setLocalData: setData,
  };
};

export const syncStatusLabel = (status: SyncState["status"] | null | undefined): string => {
  switch (status) {
    case "opening":
      return "正在打开 Pixiv";
    case "collecting":
      return "正在采集作品";
    case "rechecking":
      return "正在复核页面";
    case "committing":
      return "正在保存快照";
    case "completed":
      return "同步完成";
    case "failed":
      return "同步失败";
    default:
      return "等待同步";
  }
};
