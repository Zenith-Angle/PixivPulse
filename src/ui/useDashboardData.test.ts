import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoData, createEmptyDashboardData } from "./demoData";
import { useDashboardData, isUnsupportedRuntimeMessageError } from "./useDashboardData";

describe("useDashboardData compatibility", () => {
  it("consumes a settled primed request once under StrictMode", async () => {
    const data = createDemoData();
    const sendMessage = vi.fn(async () => ({ ok: true, data: createEmptyDashboardData() }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);

    const { result } = renderHook(() => useDashboardData(Promise.resolve({ ok: true, data })), { wrapper });

    await waitFor(() => expect(result.current.data).toBe(data));
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => result.current.refresh());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("consumes a pending primed request without an empty fallback read", async () => {
    const data = createDemoData();
    let resolveRequest: ((value: { ok: true; data: typeof data }) => void) | undefined;
    const request = new Promise<{ ok: true; data: typeof data }>((resolve) => { resolveRequest = resolve; });
    const sendMessage = vi.fn(async () => ({ ok: true, data: createEmptyDashboardData() }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);

    const { result } = renderHook(() => useDashboardData(request), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data.works).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => resolveRequest?.({ ok: true, data }));
    await waitFor(() => expect(result.current.data).toBe(data));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("recognizes an older service worker that does not know an optional message", () => {
    expect(isUnsupportedRuntimeMessageError({ ok: false, error: "Unsupported message" })).toBe(true);
    expect(isUnsupportedRuntimeMessageError({ ok: false, error: "Database unavailable" })).toBe(false);
    expect(isUnsupportedRuntimeMessageError({ ok: true })).toBe(false);
  });

  it("keeps the newest dashboard refresh when an older response resolves later", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type !== "GET_DASHBOARD_DATA") return Promise.resolve({ ok: true });
      return new Promise((resolve) => pending.push(resolve));
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const initialData = createEmptyDashboardData();
    const olderData = createDemoData();
    const newestData = createDemoData();
    newestData.works[0] = { ...newestData.works[0]!, title: "最新响应作品" };

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending.shift()?.({ ok: true, data: initialData });
      await Promise.resolve();
    });

    const olderRefresh = result.current.refresh();
    const olderResolve = pending.at(-1);
    const newestRefresh = result.current.refresh();
    const newestResolve = pending.at(-1);
    expect(sendMessage).toHaveBeenCalledTimes(3);

    await act(async () => {
      newestResolve?.({ ok: true, data: newestData });
      await newestRefresh;
    });
    expect(result.current.data).toBe(newestData);

    await act(async () => {
      olderResolve?.({ ok: true, data: olderData });
      await olderRefresh;
    });
    expect(result.current.data).toBe(newestData);
    expect(result.current.data.works[0]?.title).toBe("最新响应作品");
  });

  it("keeps the loaded dashboard visible while a background data refresh is pending", async () => {
    const data = createDemoData();
    let resolveRefresh: ((value: unknown) => void) | undefined;
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, data })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));

    let refresh: Promise<void> | undefined;
    await act(async () => {
      refresh = result.current.refresh();
      await Promise.resolve();
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBe(data);

    await act(async () => {
      resolveRefresh?.({ ok: true, data });
      await refresh;
    });
  });

  it("refreshes sync-state changes without reloading the full dashboard payload", async () => {
    const data = createDemoData();
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const collecting = { ...data.syncState!, status: "collecting" as const, updatedAt: new Date().toISOString() };
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_SYNC_STATE"
      ? { ok: true, syncState: collecting }
      : { ok: true, data });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));
    const works = result.current.data.works;
    storageListener?.({ "pixivPulse.syncState": { oldValue: data.syncState, newValue: collecting } }, "local");

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_SYNC_STATE" }));
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "GET_DASHBOARD_DATA")).toHaveLength(1);
    expect(result.current.data.works).toBe(works);
    expect(result.current.data.syncState).toBe(collecting);
    expect(result.current.isLoading).toBe(false);
  });

  it("upgrades a debounced sync-state refresh when a data revision arrives in the same window", async () => {
    const data = createDemoData();
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));
    sendMessage.mockClear();
    storageListener?.({ "pixivPulse.syncState": { newValue: data.syncState } }, "local");
    storageListener?.({ "pixivPulse.dataRevision": { newValue: "next" } }, "local");

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({ type: "GET_DASHBOARD_DATA" });
    expect(sendMessage).not.toHaveBeenCalledWith({ type: "GET_SYNC_STATE" });
  });

  it("keeps a newer applied sync state when an older full response finishes later", async () => {
    const initial = createDemoData();
    const refreshed = createDemoData();
    refreshed.works = refreshed.works.slice(0, 2);
    const collecting = { ...initial.syncState!, status: "collecting" as const, updatedAt: new Date().toISOString() };
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    let resolveFull: ((value: unknown) => void) | undefined;
    let fullReads = 0;
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type === "GET_SYNC_STATE") return Promise.resolve({ ok: true, syncState: collecting });
      fullReads += 1;
      if (fullReads === 1) return Promise.resolve({ ok: true, data: initial });
      return new Promise((resolve) => { resolveFull = resolve; });
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));
    const fullRefresh = result.current.refresh();
    storageListener?.({ "pixivPulse.syncState": { newValue: collecting } }, "local");
    await waitFor(() => expect(result.current.data.syncState).toBe(collecting));
    await act(async () => {
      resolveFull?.({ ok: true, data: refreshed });
      await fullRefresh;
    });

    expect(result.current.data.works).toBe(refreshed.works);
    expect(result.current.data.syncState).toBe(collecting);
  });

  it("uses the full response state when a later lightweight state read fails", async () => {
    const initial = createDemoData();
    const refreshed = createDemoData();
    const completed = { ...refreshed.syncState!, status: "completed" as const, updatedAt: new Date().toISOString() };
    refreshed.syncState = completed;
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    let resolveFull: ((value: unknown) => void) | undefined;
    let fullReads = 0;
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type === "GET_SYNC_STATE") return Promise.resolve({ ok: false, error: "状态读取失败" });
      fullReads += 1;
      if (fullReads === 1) return Promise.resolve({ ok: true, data: initial });
      return new Promise((resolve) => { resolveFull = resolve; });
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));
    const fullRefresh = result.current.refresh();
    storageListener?.({ "pixivPulse.syncState": { newValue: completed } }, "local");
    await waitFor(() => expect(result.current.error).toBe("状态读取失败"));
    await act(async () => {
      resolveFull?.({ ok: true, data: refreshed });
      await fullRefresh;
    });

    expect(result.current.data.syncState).toBe(completed);
    expect(result.current.error).toBeNull();
  });

  it("does not let a late start response overwrite a full refresh", async () => {
    const initial = createDemoData();
    const refreshed = createDemoData();
    const collecting = { ...refreshed.syncState!, status: "collecting" as const, updatedAt: new Date().toISOString() };
    refreshed.syncState = collecting;
    let resolveStart: ((value: unknown) => void) | undefined;
    let fullReads = 0;
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type === "START_SYNC") return new Promise((resolve) => { resolveStart = resolve; });
      fullReads += 1;
      return Promise.resolve({ ok: true, data: fullReads === 1 ? initial : refreshed });
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));
    const start = result.current.startSync();
    await result.current.refresh();
    await act(async () => {
      resolveStart?.({ ok: true, syncState: { ...collecting, status: "opening" } });
      await start;
    });

    expect(result.current.data.syncState).toBe(collecting);
  });

  it("updates only the cover summary when the cover cache revision changes", async () => {
    const data = createDemoData();
    const coverCache = { ready: 3, failed: 0, skipped: 0, pending: 1, bytes: 4096, total: 4 };
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_COVER_CACHE_SUMMARY"
      ? { ok: true, coverCache }
      : { ok: true, data });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.hasLoadedData).toBe(true));
    const works = result.current.data.works;
    const samples = result.current.data.samples;
    storageListener?.({ "pixivPulse.coverCacheRevision": { newValue: "cover-next" } }, "local");

    await waitFor(() => expect(result.current.data.coverCache).toBe(coverCache));
    expect(result.current.data.works).toBe(works);
    expect(result.current.data.samples).toBe(samples);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "GET_DASHBOARD_DATA")).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: "GET_COVER_CACHE_SUMMARY" });
  });

  it("does not clear an initial dashboard error after a lightweight state read succeeds", async () => {
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const syncState = createDemoData().syncState;
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_SYNC_STATE"
      ? { ok: true, syncState }
      : { ok: false, error: "本地数据库暂时不可用" });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.error).toBe("本地数据库暂时不可用"));
    storageListener?.({ "pixivPulse.syncState": { newValue: syncState } }, "local");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_SYNC_STATE" }));

    expect(result.current.hasLoadedData).toBe(false);
    expect(result.current.error).toBe("本地数据库暂时不可用");
  });

  it("does not delay a queued data refresh when unrelated storage changes arrive", async () => {
    vi.useFakeTimers();
    try {
      const data = createDemoData();
      let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
      const sendMessage = vi.fn(async () => ({ ok: true, data }));
      vi.stubGlobal("chrome", {
        runtime: { sendMessage },
        storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
      });

      const { result } = renderHook(() => useDashboardData(Promise.resolve({ ok: true, data })));
      await act(async () => { await Promise.resolve(); });
      expect(result.current.hasLoadedData).toBe(true);
      sendMessage.mockClear();
      storageListener?.({ "pixivPulse.dataRevision": { newValue: "next" } }, "local");
      await act(async () => { await vi.advanceTimersByTimeAsync(60); });
      storageListener?.({ "pixivPulse.unrelated": { newValue: true } }, "local");
      await act(async () => { await vi.advanceTimersByTimeAsync(21); });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith({ type: "GET_DASHBOARD_DATA" });
    } finally {
      vi.useRealTimers();
    }
  });
});
