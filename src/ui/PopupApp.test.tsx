import { act, fireEvent, render, renderHook, screen, waitFor, cleanup } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { DashboardData, SyncState } from "../domain/types";
import { beijingDayRange } from "../domain/time";
import { createDemoData } from "./demoData";
import { PopupApp, usePopupData } from "./PopupApp";

const activeState = (status: SyncState["status"]): SyncState => ({
  ...createDemoData().syncState!,
  status,
  transport: "api",
});

const dataWithWorks = (count: number): DashboardData => {
  const base = createDemoData();
  const works = Array.from({ length: count }, (_, index) => {
    const source = base.works[index % base.works.length]!;
    return { ...source, key: `${source.type}-${index + 1}`, id: String(index + 1), title: `作品 ${index + 1}` };
  });
  return { ...base, works, syncState: { ...base.syncState!, seenWorkIds: works.map((work) => work.id) } };
};

describe("PixivPulse popup", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads the local work count from the runtime", async () => {
    const data = dataWithWorks(34);
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data } : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const { container } = render(<PopupApp />);

    await waitFor(() => expect(screen.getByText("34", { exact: true })).toBeTruthy());
    const brandMark = container.querySelector(".popup-brand-mark");
    expect(brandMark?.tagName).toBe("IMG");
    expect(brandMark).toHaveAttribute("src", "/icon/48.png");
    expect(screen.getByText("本地作品")).toBeTruthy();
    expect(screen.getByText("粉丝总数")).toBeTruthy();
    expect(screen.getByText("今日")).toBeTruthy();
    expect(screen.getByText("今日浏览")).toBeTruthy();
    expect(screen.getByText("今日获赞")).toBeTruthy();
    expect(screen.getByText("今日收藏")).toBeTruthy();
    expect(screen.getByText("今日评论")).toBeTruthy();
    expect(screen.getByText("今日采样")).toBeTruthy();
    expect(screen.queryByText("SYNC CONTROL")).toBeNull();
    expect(screen.queryByText("RECENT RUN")).toBeNull();
    expect(screen.queryByText("SCHEDULE")).toBeNull();
    expect(screen.queryByText("最近同步")).toBeNull();
    expect(screen.queryByText(/后台只读采集优先/)).toBeNull();
  });

  it("shows a loading state instead of real zero data while the primed request is pending", async () => {
    const data = dataWithWorks(34);
    let resolveRequest: ((value: { ok: true; data: DashboardData }) => void) | undefined;
    const request = new Promise<{ ok: true; data: DashboardData }>((resolve) => { resolveRequest = resolve; });
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    render(<StrictMode><PopupApp bootstrapRequest={request} /></StrictMode>);

    expect(screen.getByRole("status", { name: "正在读取本地数据" })).toBeTruthy();
    expect(screen.queryByText("本地作品")).toBeNull();
    expect(screen.queryByText("尚未绑定账号")).toBeNull();
    expect(screen.queryByText("尚无同步记录")).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => resolveRequest?.({ ok: true, data }));
    await waitFor(() => expect(screen.getByText("34", { exact: true })).toBeTruthy());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows a retryable error instead of real zero data when initial hydration fails", async () => {
    const data = dataWithWorks(34);
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    render(<PopupApp bootstrapRequest={Promise.resolve({ ok: false, error: "本地数据库暂时不可用" })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("本地数据暂时无法读取");
    expect(screen.queryByText("本地作品")).toBeNull();
    expect(screen.queryByText("尚未绑定账号")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(screen.getByText("34", { exact: true })).toBeTruthy());
  });

  it("keeps the newest popup refresh when an older response resolves later", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const sendMessage = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const initialData = dataWithWorks(1);
    const olderData = dataWithWorks(2);
    const newestData = dataWithWorks(3);

    const { result } = renderHook(() => usePopupData());
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending.shift()?.({ ok: true, data: initialData });
      await Promise.resolve();
    });

    const olderRefresh = result.current.refresh();
    const olderResolve = pending.at(-1);
    const newestRefresh = result.current.refresh();
    const newestResolve = pending.at(-1);
    await act(async () => {
      newestResolve?.({ ok: true, data: newestData });
      await newestRefresh;
    });
    await act(async () => {
      olderResolve?.({ ok: true, data: olderData });
      await olderRefresh;
    });

    expect(result.current.data).toBe(newestData);
    expect(result.current.data.works).toHaveLength(3);
  });

  it("shows same-day follower growth after two observations without an older baseline", async () => {
    const data = dataWithWorks(34);
    const day = beijingDayRange(Date.now())!;
    data.accountFollowerSamples = [
      { runId: "today-first", accountId: data.settings.boundAccount!.id, collectedAt: new Date(day.startMs).toISOString(), followers: 834 },
      { runId: "today-latest", accountId: data.settings.boundAccount!.id, collectedAt: new Date(day.startMs + 1).toISOString(), followers: 835 },
    ];
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data } : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    render(<PopupApp />);

    const today = await screen.findByText("今日", { exact: true });
    await waitFor(() => expect(today.parentElement?.textContent).toContain("+1"));
    expect(screen.getByText("835", { exact: true })).toBeTruthy();
  });

  it("keeps a fixed action-popup width instead of collapsing to Chrome's initial viewport", () => {
    const css = readFileSync("entrypoints/popup/styles.css", "utf8");

    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*width:\s*360px;[^}]*min-width:\s*360px;/s);
    expect(css).not.toContain("max-width: 100vw");
    expect(css).not.toMatch(/@media\s*\(max-width:\s*340px\)[\s\S]*html,\s*body,\s*#root\s*\{[^}]*width:\s*100%/);
  });

  it("uses the current project icon as the popup and dashboard favicon", () => {
    for (const path of ["entrypoints/popup/index.html", "entrypoints/dashboard/index.html"]) {
      const html = readFileSync(path, "utf8");
      expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/icon/32.png" />');
    }
  });

  it("starts local hydration before loading the full popup and dashboard UI modules", () => {
    const popupMain = readFileSync("entrypoints/popup/main.tsx", "utf8");
    const dashboardMain = readFileSync("entrypoints/dashboard/main.tsx", "utf8");
    expect(popupMain.indexOf("primeDashboardDataRequest()"))
      .toBeLessThan(popupMain.indexOf('import("../../src/ui/PopupApp")'));
    expect(dashboardMain.indexOf("primeDashboardDataRequest()"))
      .toBeLessThan(dashboardMain.indexOf('import("./App")'));
  });

  it("loads existing data without motion, then rolls a storage-driven increase", async () => {
    let data = dataWithWorks(34);
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data } : { ok: true });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    render(<PopupApp />);
    const localWorks = await screen.findByText("本地作品");
    const animated = localWorks.parentElement!.querySelector(".animated-number")!;
    await waitFor(() => expect(animated).toHaveAttribute("data-current-value", "34"));
    expect(animated).not.toHaveAttribute("data-roll-direction");

    data = dataWithWorks(35);
    storageListener?.({ ["pixivPulse.dataRevision"]: { oldValue: 1, newValue: 2 } }, "local");
    await waitFor(() => expect(animated).toHaveAttribute("data-current-value", "35"));
    expect(animated).toHaveAttribute("data-roll-direction", "increase");
  });

  it("ships the rolling track styles in both popup and dashboard surfaces", () => {
    const popupCss = readFileSync("entrypoints/popup/styles.css", "utf8");
    const dashboardCss = readFileSync("entrypoints/dashboard/styles.css", "utf8");
    for (const css of [popupCss, dashboardCss]) {
      expect(css).toContain(".animated-number-track-increase");
      expect(css).toContain("@keyframes animated-number-roll-up");
      expect(css).toContain("@keyframes animated-number-roll-down");
    }
  });

  it("triggers a manual sync and disables the action while active", async () => {
    const data = createDemoData();
    const activeData = { ...data, syncState: activeState("collecting") };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "GET_DASHBOARD_DATA") return { ok: true, data };
      if (message.type === "START_SYNC") return { ok: true, data: activeData };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    render(<PopupApp />);

    const button = await screen.findByRole("button", { name: "立即同步" });
    fireEvent.click(button);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "START_SYNC", trigger: "manual" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "同步中" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText("正在采集作品")).toBeTruthy();
  });

  it("reports sync errors and successful collection feedback", async () => {
    const failedData = createDemoData();
    const failedSend = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data: failedData } : { ok: false, error: "Pixiv 页面暂时不可用" });
    vi.stubGlobal("chrome", { runtime: { sendMessage: failedSend } });
    render(<PopupApp />);
    fireEvent.click(await screen.findByRole("button", { name: "立即同步" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pixiv 页面暂时不可用");

    cleanup();
    const complete = { ...createDemoData(), runs: [{ ...createDemoData().runs[0]!, status: "completed" as const, works: 4 }] };
    const completeSend = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data: failedData } : { ok: true, data: complete });
    vi.stubGlobal("chrome", { runtime: { sendMessage: completeSend } });
    render(<PopupApp />);
    fireEvent.click(await screen.findByRole("button", { name: "立即同步" }));
    expect((await screen.findByRole("status")).textContent).toContain("已收集 4 件作品");
  });

  it("opens the full dashboard from the popup", async () => {
    const data = createDemoData();
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data } : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    render(<PopupApp />);

    fireEvent.click(await screen.findByRole("button", { name: "打开完整看板" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "OPEN_DASHBOARD" }));
  });

  it("updates the compact schedule selector", async () => {
    const data = createDemoData();
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data } : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    render(<PopupApp />);

    const selector = await screen.findByRole("combobox", { name: "同步间隔" });
    fireEvent.change(selector, { target: { value: "2" } });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "SET_SCHEDULED_SYNC", enabled: true, intervalHours: 2 }));
    expect((selector as HTMLSelectElement).value).toBe("2");
  });
});
