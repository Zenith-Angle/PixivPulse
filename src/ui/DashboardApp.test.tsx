import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as repository from "../data/repository";
import type { WorkAnalysis } from "../domain/types";
import { buildIntradayAnalytics } from "../domain/intraday";
import { DATA_REVISION_STORAGE_KEY } from "../data/local-state";
import { createDemoData, createEmptyDashboardData } from "./demoData";
import { analyzeDashboard, toSafeCsv } from "./helpers";
import { ClearDataModal, CompareView, DashboardApp, DetailDrawer, OverviewView, SettingsView, WorksView } from "./DashboardApp";

describe("PixivPulse dashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows a loading surface instead of empty-account semantics during primed hydration", async () => {
    const data = createDemoData();
    let resolveRequest: ((value: { ok: true; data: typeof data }) => void) | undefined;
    const request = new Promise<{ ok: true; data: typeof data }>((resolve) => { resolveRequest = resolve; });
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    render(<StrictMode><DashboardApp bootstrapRequest={request} /></StrictMode>);

    expect(screen.getByRole("status", { name: "正在读取本地数据" })).toBeTruthy();
    expect(screen.queryByText("尚未绑定账号")).toBeNull();
    expect(screen.queryByText("尚未同步")).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => resolveRequest?.({ ok: true, data }));
    await waitFor(() => expect(screen.getAllByText("星野编辑部").length).toBeGreaterThan(0));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows a retryable error instead of an empty dashboard when initial hydration fails", async () => {
    const data = createDemoData();
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    render(<DashboardApp bootstrapRequest={Promise.resolve({ ok: false, error: "本地数据库暂时不可用" })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("本地数据暂时无法读取");
    expect(screen.queryByText("尚未绑定账号")).toBeNull();
    expect(screen.queryByText("还没有可分析的样本")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(screen.getAllByText("星野编辑部").length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a clearly labelled local preview when the extension runtime is absent", async () => {
    vi.stubGlobal("chrome", undefined);
    const { container } = render(<DashboardApp />);

    expect((await screen.findAllByText("预览数据", { exact: true })).length).toBeGreaterThanOrEqual(1);
    const brandMark = container.querySelector(".brand-mark");
    expect(brandMark?.tagName).toBe("IMG");
    expect(brandMark).toHaveAttribute("src", "/icon/48.png");
    expect(screen.getByRole("status").textContent).toContain("当前浏览器未连接扩展后台");
    expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
  });

  it("keeps empty works and no-history comparison states explicit", () => {
    const empty = createEmptyDashboardData();
    render(<WorksView analyses={[]} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);
    expect(screen.getByText("第一次同步后，作品会出现在这里")).toBeTruthy();

    const noHistoryAnalysis = analyzeDashboard({
      ...empty,
      works: [createDemoData().works[2]!],
      samples: [createDemoData().samples[5]!],
    })[0] as WorkAnalysis;
    render(<CompareView analyses={[noHistoryAnalysis]} compareKeys={[noHistoryAnalysis.work.key]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);
    expect(screen.getByText("还差一件作品")).toBeTruthy();
    expect(screen.getByText("再选择一件作品后，即可比较浏览、收藏和获赞的总量或增量曲线。")).toBeTruthy();
  });

  it("compares two selected works with absolute views, bookmarks, and likes curves", () => {
    const data = createDemoData();
    const analyses = analyzeDashboard(data);
    const selected = analyses.slice(0, 2);
    render(<CompareView analyses={analyses} compareKeys={selected.map((analysis) => analysis.work.key)} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} data={data} />);

    expect(screen.getByRole("heading", { name: "浏览绝对值曲线" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 部作品浏览总量绝对值比较折线图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "浏览", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收藏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "获赞" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "总量", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "增量", pressed: false })).toBeTruthy();
    expect(screen.getByLabelText("已选作品当前总量").querySelectorAll("article")).toHaveLength(2);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[2]).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(screen.getByRole("heading", { name: "收藏绝对值曲线" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 部作品收藏总量绝对值比较折线图" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "增量" }));
    expect(screen.getByRole("heading", { name: "收藏增量曲线" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 部作品收藏增量比较折线图" })).toBeTruthy();
    expect(screen.getByText("分段净增量 · 无观察时段留空")).toBeTruthy();
    expect(screen.getByText("分段净增量")).toBeTruthy();
    expect(screen.queryByText("平滑趋势")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "总量" }));
    expect(screen.getByText("平滑趋势")).toBeTruthy();
  });

  it("allows up to five comparison works and disables a sixth choice", () => {
    const analyses = analyzeDashboard(createDemoData());
    const extras = [0, 1].map((index) => ({
      ...analyses[index]!,
      work: {
        ...analyses[index]!.work,
        key: `extra-${index}`,
        id: `extra-${index}`,
        title: `额外作品 ${index + 1}`,
      },
    }));
    const expanded = [...analyses, ...extras];
    const selectedKeys = expanded.slice(0, 5).map((analysis) => analysis.work.key);

    render(<CompareView analyses={expanded} compareKeys={selectedKeys} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "比较作品 5 / 5" })).toBeTruthy();
    expect(screen.getByLabelText("已选作品当前总量").querySelectorAll("article")).toHaveLength(5);
    expect(screen.getByRole("img", { name: "5 部作品浏览总量绝对值比较折线图" })).toBeTruthy();
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.slice(0, 5).forEach((checkbox) => expect(checkbox).toBeChecked());
    expect(checkboxes[5]).toBeDisabled();
  });

  it("guards formula-like values in CSV exports", () => {
    const data = createDemoData();
    data.works[0]!.title = "=HYPERLINK(\"https://example.test\",\"打开\")";
    const csv = toSafeCsv(data);
    expect(csv).toContain("'=HYPERLINK(\"\"https://example.test\"\",\"\"打开\"\")");
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("北京时间 UTC+8");
  });

  it("offers manual and 30-minute/1-hour schedule choices", () => {
    const data = createEmptyDashboardData();
    render(<SettingsView data={data} isPreview={true} error={null} onSchedule={vi.fn()} onShowChips={vi.fn()} onExportJson={vi.fn()} onExportCsv={vi.fn()} onOpenOnboarding={vi.fn()} onClearData={vi.fn()} />);

    expect(screen.getByRole("option", { name: "仅手动" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "每 30 分钟" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "每 1 小时" })).toBeTruthy();
  });

  it("exposes migration-only maintenance and keeps it disabled in preview", () => {
    const onMaintainData = vi.fn();
    render(<SettingsView data={createEmptyDashboardData()} isPreview={false} error={null} onSchedule={vi.fn()} onShowChips={vi.fn()} onExportJson={vi.fn()} onExportCsv={vi.fn()} onOpenOnboarding={vi.fn()} onMaintainData={onMaintainData} />);
    fireEvent.click(screen.getByRole("button", { name: "整理已有数据" }));
    expect(onMaintainData).toHaveBeenCalledTimes(1);
    cleanup();
    render(<SettingsView data={createEmptyDashboardData()} isPreview={true} error={null} onSchedule={vi.fn()} onShowChips={vi.fn()} onExportJson={vi.fn()} onExportCsv={vi.fn()} onOpenOnboarding={vi.fn()} onMaintainData={onMaintainData} />);
    expect(screen.getByRole("button", { name: "整理已有数据" })).toBeDisabled();
  });

  it("labels passive creator-page observations separately from manual syncs", () => {
    const data = createEmptyDashboardData();
    data.runs = [{
      runId: "passive-page-observation",
      trigger: "passive",
      startedAt: "2026-08-31T00:00:00.000Z",
      finishedAt: "2026-08-31T00:00:01.000Z",
      status: "completed",
      pages: 1,
      works: 2,
      changedWorks: 1,
      errorCode: null,
      errorMessage: null,
    }];
    render(<SettingsView data={data} isPreview={false} error={null} onSchedule={vi.fn()} onShowChips={vi.fn()} onExportJson={vi.fn()} onExportCsv={vi.fn()} onOpenOnboarding={vi.fn()} onClearData={vi.fn()} />);

    expect(screen.getByText("页面观察")).toBeTruthy();
  });

  it("shows the bound account and links KPI deltas to the selected chart range", () => {
    const data = createDemoData();
    const analyses = analyzeDashboard(data);
    const intraday = buildIntradayAnalytics({ works: data.works, samples: data.samples, observations: data.observations, configuredIntervalHours: 1 });
    intraday.delta.bookmarks = 0;
    render(<OverviewView analyses={analyses} data={data} intraday={intraday} onOpenWork={vi.fn()} onGoToWorks={vi.fn()} />);

    expect(screen.getByText("星野编辑部")).toBeTruthy();
    expect(screen.getByText("Pixiv ID DEMO-ACCOUNT")).toBeTruthy();
    expect(screen.getByTestId("follower-growth-section")).toBeTruthy();
    expect(screen.getByText("当前粉丝数")).toBeTruthy();
    expect(screen.getByText("粉丝增长")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /账号粉丝数历史图/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开粉丝增长详细图表" }));
    expect(screen.getByRole("dialog", { name: "粉丝增长详细图表" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /账号粉丝数历史图/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭粉丝增长详情" }));
    const viewsCard = screen.getByRole("region", { name: /浏览总量/ });
    expect(viewsCard.textContent).toContain("184,630");
    expect(screen.getAllByText("今日变化")).toHaveLength(4);
    expect(within(screen.getByTestId("follower-growth-section")).getByText("今日增长")).toBeTruthy();
    expect(screen.getByText("今日采样轮次")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "近24小时" }));
    expect(viewsCard.textContent).toContain("+12,350");
    expect(screen.getAllByText("近24小时变化")).toHaveLength(4);
    expect(within(screen.getByTestId("follower-growth-section")).getByText("近24小时增长")).toBeTruthy();
    expect(screen.getByText("浏览总量")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "近24小时作品集动量" })).toBeTruthy();

    cleanup();
    const intradayByWork = new Map(intraday.works.map((work) => [work.workKey, work] as const));
    render(<WorksView analyses={analyses} intradayByWork={intradayByWork} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);
    expect(screen.getAllByText("今日浏览").length).toBeGreaterThan(0);
    expect(screen.getAllByText("今日收藏").length).toBeGreaterThan(0);
    expect(screen.getAllByText("今日赞").length).toBeGreaterThan(0);
    expect(screen.getAllByText("今日样本").length).toBeGreaterThan(0);
    expect(screen.getAllByText("今日暂无浏览变化").length).toBeGreaterThan(0);
  });

  it("defaults overview to Today, places Last 24 hours beside it, and exposes longer Beijing ranges", () => {
    const data = createDemoData();
    const analyses = analyzeDashboard(data);
    const intraday = buildIntradayAnalytics({ works: data.works, samples: data.samples, observations: data.observations, configuredIntervalHours: 1 });
    render(<OverviewView analyses={analyses} data={data} intraday={intraday} onOpenWork={vi.fn()} onGoToWorks={vi.fn()} />);

    expect(screen.getByRole("button", { name: "今日", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "近24小时", pressed: false })).toBeTruthy();
    const presetButtons = within(screen.getByRole("group", { name: "作品集图表时间范围" })).getAllByRole("button");
    expect(presetButtons.slice(0, 2).map((button) => button.textContent)).toEqual(["今日", "近24小时"]);
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByRole("button", { name: "全部", pressed: true })).toBeTruthy();
    expect(screen.getAllByText("全部历史变化")).toHaveLength(4);
    expect(screen.getByText("浏览总量")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "全部历史作品集动量" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "近3天" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "近7天" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "近30天" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "近3个月" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    expect(screen.getByLabelText("起点")).toBeTruthy();
    expect(screen.getByLabelText("终点")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("起点"), { target: { value: "2026-08-31T12:00" } });
    fireEvent.change(screen.getByLabelText("终点"), { target: { value: "2026-08-30T12:00" } });
    expect(screen.getByRole("alert").textContent).toContain("有效的起止时间");
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部", pressed: true })).toBeTruthy();
  });

  it("updates the compact follower delta with the overview time range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T10:00:00+08:00"));
    const data = createDemoData();
    data.accountFollowerSamples = [
      { runId: "range-start", accountId: "DEMO-ACCOUNT", collectedAt: "2026-09-01T12:00:00+08:00", followers: 90 },
      { runId: "before-today", accountId: "DEMO-ACCOUNT", collectedAt: "2026-09-01T23:00:00+08:00", followers: 100 },
      { runId: "today-early", accountId: "DEMO-ACCOUNT", collectedAt: "2026-09-02T01:00:00+08:00", followers: 105 },
      { runId: "today-latest", accountId: "DEMO-ACCOUNT", collectedAt: "2026-09-02T09:00:00+08:00", followers: 110 },
    ];
    render(<OverviewView analyses={analyzeDashboard(data)} data={data} onOpenWork={vi.fn()} onGoToWorks={vi.fn()} />);

    const follower = within(screen.getByTestId("follower-growth-section"));
    expect(follower.getByText("今日增长").parentElement?.textContent).toContain("+10");
    fireEvent.click(screen.getByRole("button", { name: "近24小时" }));
    expect(follower.getByText("近24小时增长").parentElement?.textContent).toContain("+20");
  });

  it("keeps latest absolute totals when a historical custom range is selected", () => {
    const data = createDemoData();
    render(<OverviewView analyses={analyzeDashboard(data)} data={data} onOpenWork={vi.fn()} onGoToWorks={vi.fn()} />);
    const viewsCard = screen.getByRole("region", { name: /浏览总量/ });
    expect(viewsCard.textContent).toContain("184,630");

    const beijingInput = (timestamp: number) => new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.change(screen.getByLabelText("起点"), { target: { value: beijingInput(Date.now() - 2_200 * 60 * 60 * 1000) } });
    fireEvent.change(screen.getByLabelText("终点"), { target: { value: beijingInput(Date.now() - 100 * 60 * 60 * 1000) } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(screen.getByRole("heading", { name: "自定义范围作品集动量" })).toBeTruthy();
    expect(viewsCard.textContent).toContain("184,630");
  });

  it("replays overview numbers once when a manual-sync animation epoch changes", () => {
    const data = createDemoData();
    const props = { analyses: analyzeDashboard(data), data, onOpenWork: vi.fn(), onGoToWorks: vi.fn() };
    const { rerender } = render(<OverviewView {...props} animationSignal={0} />);
    expect(document.querySelectorAll(".overview-view .animated-number-rolling")).toHaveLength(0);

    rerender(<OverviewView {...props} animationSignal={1} />);
    expect(document.querySelectorAll(".kpi-grid .animated-number-rolling")).toHaveLength(8);
    expect(document.querySelectorAll(".follower-summary-compact .animated-number-rolling").length).toBeGreaterThanOrEqual(1);
  });

  it("shows a follower baseline empty state instead of inventing a one-point curve", () => {
    const data = createEmptyDashboardData();
    data.settings = {
      ...data.settings,
      boundAccount: { id: "DEMO-ACCOUNT", name: "星野编辑部", profileUrl: "https://www.pixiv.net/" },
    };
    data.accountFollowerSamples = [{
      runId: "follower-baseline",
      accountId: "DEMO-ACCOUNT",
      collectedAt: new Date().toISOString(),
      followers: 130240,
    }];
    render(<OverviewView analyses={[]} data={data} onOpenWork={vi.fn()} onGoToWorks={vi.fn()} />);

    expect(screen.getByText("当前粉丝数")).toBeTruthy();
    expect(screen.getByText("基线已建立")).toBeTruthy();
    expect(screen.queryByText("已建立粉丝基线，等待下一次同步后绘制增长曲线。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开粉丝增长详细图表" }));
    expect(screen.getByText("已建立粉丝基线，等待下一次同步后绘制增长曲线。")).toBeTruthy();
  });

  it("renders a single available point instead of replacing short history with an empty state", () => {
    const data = createDemoData();
    data.works = data.works.slice(0, 1);
    const workKey = data.works[0]!.key;
    const collectedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    data.samples = [{
      workKey,
      runId: "only-local-point",
      collectedAt,
      metrics: { ...data.works[0]!.metrics },
      parserVersion: 1,
      dataQuality: 1,
      kind: "change",
    }];
    data.observations = [];
    data.observationBatches = [];

    render(<OverviewView analyses={analyzeDashboard(data)} data={data} onOpenWork={vi.fn()} onGoToWorks={vi.fn()} />);

    expect(screen.queryByText("所选时间范围内还没有两轮有效采样。")).toBeNull();
    expect(screen.getByText(/浏览共 1 个有效采样点/)).toBeTruthy();
  });

  it("shows every captured change event with four metric deltas", () => {
    const data = createDemoData();
    const analysis = analyzeDashboard(data)[0]!;
    const workSamples = data.samples.filter((sample) => sample.workKey === analysis.work.key && sample.kind === "change");
    const { container } = render(<DetailDrawer analysis={analysis} samples={data.samples} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "逐次变化记录" })).toBeTruthy();
    expect(container.querySelectorAll(".change-event-row")).toHaveLength(workSamples.length);
    expect(container.querySelector(".change-event-metrics")?.textContent).toContain("浏览");
    expect(container.querySelector(".change-event-metrics")?.textContent).toContain("赞");
    expect(container.querySelector(".change-event-metrics")?.textContent).toContain("收藏");
    expect(container.querySelector(".change-event-metrics")?.textContent).toContain("评论");
    expect(container.querySelector(".change-event-heading")?.textContent).toContain("UTC+8");
    expect(screen.getByRole("heading", { name: "指标绝对值" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "浏览绝对总数折线图" })).toBeTruthy();
    expect(screen.getByText(/浏览按绝对总数绘制/)).toBeTruthy();
    expect(screen.getByText(/横轴按北京时间的真实采样时刻绘制/)).toBeTruthy();
  });

  it("refreshes an open dashboard when a committed data revision changes", async () => {
    const empty = createEmptyDashboardData();
    empty.settings.onboardingComplete = true;
    const updated = createDemoData();
    let reads = 0;
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "GET_DASHBOARD_DATA") {
        reads += 1;
        return { ok: true, data: reads === 1 ? empty : updated };
      }
      return { ok: true, data: empty };
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: (listener: typeof storageListener) => { storageListener = listener; }, removeListener: vi.fn() } },
    });
    render(<DashboardApp />);
    await waitFor(() => expect(reads).toBe(1));
    storageListener?.({ "pixivPulse.dataRevision": { oldValue: "a", newValue: "b" } }, "local");
    await waitFor(() => expect(screen.getAllByText("星野编辑部").length).toBeGreaterThan(0));
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("switches between the complete grid and dense list views", () => {
    const data = createDemoData();
    const analyses = analyzeDashboard(data);
    render(<WorksView analyses={analyses} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);

    expect(screen.getAllByTestId("work-card")).toHaveLength(data.works.length);
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.getByRole("table", { name: "PixivPulse 作品增长表" })).toBeTruthy();
    expect(screen.queryAllByTestId("work-card")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "宫格视图" }));
    expect(screen.getAllByTestId("work-card")).toHaveLength(data.works.length);
    expect(window.localStorage.getItem("pixivpulse:works-view-mode")).toBe("grid");
  });

  it("orders the works grid by newest published time by default", () => {
    const data = createDemoData();
    data.samples = [];
    data.observations = [];
    data.works = data.works.slice(0, 3).map((work, index) => ({
      ...work,
      key: `published-${index}`,
      title: `发布时间作品 ${index + 1}`,
      publishedAt: ["2026-08-20T00:00:00.000Z", "2026-08-31T00:00:00.000Z", "2026-08-25T00:00:00.000Z"][index]!,
    }));
    const analyses = analyzeDashboard(data);
    render(<WorksView analyses={analyses} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);

    expect(screen.getAllByTestId("work-card").map((card) => card.querySelector(".work-card-title")?.textContent)).toEqual([
      "发布时间作品 2",
      "发布时间作品 3",
      "发布时间作品 1",
    ]);
  });

  it("exposes shared sort controls and sortable list columns", () => {
    const analyses = analyzeDashboard(createDemoData());
    const { container } = render(<WorksView analyses={analyses} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "排序指标" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换为升序" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.getByRole("button", { name: "按今日浏览排序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按今日收藏排序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按今日赞排序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按今日评论排序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按赞总量排序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按收藏总量排序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "按最近观察排序" })).toBeTruthy();
    const table = screen.getByRole("table", { name: "PixivPulse 作品增长表" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(15);
    expect(within(table).getAllByRole("row")[1]?.querySelectorAll("td")).toHaveLength(15);
    expect(within(table).getAllByRole("checkbox")[0]?.closest("td")).toHaveClass("work-name-cell");
    expect(within(table).getAllByText(/\d+\.\d+ 天前/).length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".sort-indicator")).toHaveLength(9);

    fireEvent.click(screen.getByRole("button", { name: "按赞总量排序" }));
    expect(screen.getByRole("button", { name: "按赞总量排序" })).toHaveAttribute("aria-sort", "descending");
    expect(container.querySelectorAll(".sort-indicator")).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: "按收藏总量排序" }));
    expect(screen.getByRole("button", { name: "按收藏总量排序" })).toHaveAttribute("aria-sort", "descending");
    expect(container.querySelectorAll(".sort-indicator")).toHaveLength(9);

    fireEvent.change(screen.getByRole("combobox", { name: "排序指标" }), { target: { value: "likes" } });
    expect(screen.getByRole("button", { name: "切换为升序" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "切换为升序" }));
    expect(screen.getByRole("button", { name: "切换为降序" })).toBeTruthy();
  });

  it("renders every work in a 34-work library and keeps unknown subtypes explicit", () => {
    const template = createDemoData().works[0]!;
    const works = Array.from({ length: 34 }, (_, index) => ({
      ...template,
      key: `illust-${index}`,
      id: String(20000 + index),
      title: `完整作品 ${index + 1}`,
      ...(index % 4 === 0 ? { contentType: "illustration" as const } : {}),
      seriesTitle: index % 2 === 0 ? "测试系列" : null,
    }));
    const analyses = analyzeDashboard({ ...createEmptyDashboardData(), works });
    render(<WorksView analyses={analyses} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);

    expect(screen.getAllByTestId("work-card")).toHaveLength(34);
    expect(screen.getAllByText("测试系列").length).toBeGreaterThan(0);
    expect(screen.getAllByText("独立作品").length).toBeGreaterThan(0);
    expect(screen.getAllByText("插画").length).toBeGreaterThan(0);
    expect(screen.getAllByText("作品").length).toBeGreaterThan(0);
  });

  it("keeps a card visible with a placeholder when its CDN cover fails", () => {
    const analysis = analyzeDashboard(createDemoData())[0]!;
    render(<WorksView analyses={[analysis]} compareKeys={[]} onToggleCompare={vi.fn()} onOpenWork={vi.fn()} />);
    const cover = screen.getByRole("img", { name: `${analysis.work.title} 封面` });
    fireEvent.error(cover);

    expect(screen.getByLabelText("封面获取失败，下次同步重试")).toBeTruthy();
    expect(screen.getByText(analysis.work.title)).toBeTruthy();
  });

  it("does not reload a ready cover when equivalent work data and cache counts change", async () => {
    const analysis = analyzeDashboard(createDemoData())[0]!;
    const sourceUrl = analysis.work.thumbnailUrl!;
    const getCurrentCover = vi.spyOn(repository, "getCurrentCover").mockResolvedValue({
      key: analysis.work.key,
      workKey: analysis.work.key,
      sourceUrl,
      pipelineVersion: 1,
      lastAttemptRunId: "cover-run",
      status: "ready",
      blob: new Blob(["cover"], { type: "image/jpeg" }),
      width: 1,
      height: 1,
      bytes: 5,
      attemptedAt: "2026-09-02T00:00:00.000Z",
    });
    const createObjectURL = vi.fn(() => "blob:cover");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    const renderProps = {
      analyses: [analysis],
      compareKeys: [],
      onToggleCompare: vi.fn(),
      onOpenWork: vi.fn(),
      coverCache: { ready: 0, failed: 0, skipped: 0, pending: 1, bytes: 0, total: 1 },
    };
    const { rerender } = render(<WorksView {...renderProps} />);
    await waitFor(() => expect(getCurrentCover).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("img", { name: `${analysis.work.title} 封面` })).toBeTruthy();

    rerender(<WorksView {...renderProps} analyses={[{ ...analysis, work: { ...analysis.work } }]} coverCache={{ ...renderProps.coverCache, ready: 1, pending: 0 }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: `${analysis.work.title} 封面` })).toBeTruthy());

    expect(getCurrentCover).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("shows a floating type breakdown after the exact manually requested sync completes", async () => {
    const baseline = createEmptyDashboardData();
    baseline.settings.onboardingComplete = true;
    baseline.runs = [{ runId: "old-run", trigger: "manual", startedAt: "2026-08-29T00:00:00.000Z", finishedAt: "2026-08-29T00:01:00.000Z", status: "completed", pages: 1, works: 1, changedWorks: 1, errorCode: null, errorMessage: null }];
    const completed = createDemoData();
    completed.settings.onboardingComplete = true;
    completed.runs = [{ runId: "new-run", trigger: "manual", startedAt: "2026-08-30T00:00:00.000Z", finishedAt: "2026-08-30T00:01:00.000Z", status: "completed", pages: 1, works: 2, changedWorks: 2, errorCode: null, errorMessage: null }, ...baseline.runs];
    completed.works = completed.works.slice(0, 2).map((work) => ({ ...work, lastObservedRunId: "new-run" }));
    let dashboardReads = 0;
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "GET_DASHBOARD_DATA") {
        dashboardReads += 1;
        return { ok: true, data: dashboardReads === 1 ? baseline : completed };
      }
      if (message.type === "START_SYNC") return { ok: true, data: baseline, syncState: { runId: "new-run" } };
      return { ok: true, data: baseline };
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });
    render(<DashboardApp />);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_DASHBOARD_DATA" }));
    fireEvent.click(screen.getByRole("button", { name: "开始同步" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "START_SYNC", trigger: "manual" }));
    storageListener?.({ [DATA_REVISION_STORAGE_KEY]: { newValue: "completed" } }, "local");
    await waitFor(() => expect(screen.getByText("已收集 2 件作品")).toBeTruthy());
    expect(screen.getByText(/小说 1/)).toBeTruthy();
    expect(screen.getByText(/作品 1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看全部作品" })).toBeTruthy();
    const toast = screen.getByText("已收集 2 件作品").closest(".sync-result-toast");
    expect(toast).toBeTruthy();
    expect(toast?.closest(".dashboard-content")).toBeNull();
  });

  it("makes a zero-work completion explicit in the floating sync result", async () => {
    const baseline = createEmptyDashboardData();
    baseline.settings.onboardingComplete = true;
    baseline.runs = [{ runId: "old-run", trigger: "manual", startedAt: "2026-08-29T00:00:00.000Z", finishedAt: "2026-08-29T00:01:00.000Z", status: "completed", pages: 1, works: 1, changedWorks: 0, errorCode: null, errorMessage: null }];
    const completed = { ...baseline, runs: [{ runId: "empty-run", trigger: "manual" as const, startedAt: "2026-08-30T00:00:00.000Z", finishedAt: "2026-08-30T00:01:00.000Z", status: "completed" as const, pages: 1, works: 0, changedWorks: 0, errorCode: null, errorMessage: null }, ...baseline.runs], works: [] };
    let dashboardReads = 0;
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "GET_DASHBOARD_DATA") {
        dashboardReads += 1;
        return { ok: true, data: dashboardReads === 1 ? baseline : completed };
      }
      if (message.type === "START_SYNC") return { ok: true, data: baseline, syncState: { runId: "empty-run" } };
      return { ok: true, data: baseline };
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });
    render(<DashboardApp />);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_DASHBOARD_DATA" }));
    fireEvent.click(screen.getByRole("button", { name: "开始同步" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "START_SYNC", trigger: "manual" }));
    storageListener?.({ [DATA_REVISION_STORAGE_KEY]: { newValue: "completed" } }, "local");
    await waitFor(() => expect(screen.getByText("已完成读取，Pixiv 返回 0 件作品")).toBeTruthy());
  });

  it("keeps the dashboard body mounted while manual sync status changes", async () => {
    const baseline = createDemoData();
    baseline.settings.onboardingComplete = true;
    const opening = { ...baseline.syncState!, runId: "manual-stable", status: "opening" as const, updatedAt: new Date().toISOString() };
    const collecting = { ...opening, status: "collecting" as const, updatedAt: new Date(Date.now() + 1).toISOString() };
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "START_SYNC") return { ok: true, syncState: opening };
      if (message.type === "GET_SYNC_STATE") return { ok: true, syncState: collecting };
      return { ok: true, data: baseline };
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });

    const { container } = render(<DashboardApp />);
    await waitFor(() => expect(container.querySelector(".overview-view")).toBeTruthy());
    const dashboardBody = container.querySelector(".overview-view");
    fireEvent.click(screen.getByRole("button", { name: "开始同步" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "START_SYNC", trigger: "manual" }));
    storageListener?.({ "pixivPulse.syncState": { oldValue: opening, newValue: collecting } }, "local");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_SYNC_STATE" }));

    expect(container.querySelector(".overview-view")).toBe(dashboardBody);
    expect(screen.queryByRole("status", { name: "正在读取本地数据" })).toBeNull();
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "GET_DASHBOARD_DATA")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "同步中" })).toBeDisabled();
  });

  it("ignores an unrelated scheduled completion while waiting for the exact manual run", async () => {
    const baseline = createEmptyDashboardData();
    baseline.settings.onboardingComplete = true;
    const unrelated = { ...baseline, runs: [{ runId: "scheduled-run", trigger: "scheduled" as const, startedAt: "2026-09-02T01:00:00.000Z", finishedAt: "2026-09-02T01:01:00.000Z", status: "completed" as const, pages: 1, works: 3, changedWorks: 1, errorCode: null, errorMessage: null }] };
    const completed = { ...baseline, runs: [{ runId: "manual-run", trigger: "manual" as const, startedAt: "2026-09-02T02:00:00.000Z", finishedAt: "2026-09-02T02:01:00.000Z", status: "completed" as const, pages: 1, works: 0, changedWorks: 0, errorCode: null, errorMessage: null }, ...unrelated.runs] };
    const reads = [baseline, unrelated, completed];
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | null = null;
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "START_SYNC"
      ? { ok: true, data: baseline, syncState: { runId: "manual-run" } }
      : { ok: true, data: reads.shift() ?? completed });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }), removeListener: vi.fn() } },
    });
    render(<DashboardApp />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "开始同步" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "START_SYNC", trigger: "manual" }));

    await act(async () => storageListener?.({ [DATA_REVISION_STORAGE_KEY]: { newValue: 1 } }, "local"));
    await waitFor(() => expect(sendMessage.mock.calls.filter(([message]) => message.type === "GET_DASHBOARD_DATA")).toHaveLength(2));
    expect(screen.queryByText(/已收集 3 件作品/)).toBeNull();
    expect(screen.queryByText(/Pixiv 返回 0 件作品/)).toBeNull();

    await act(async () => storageListener?.({ [DATA_REVISION_STORAGE_KEY]: { newValue: 2 } }, "local"));
    await waitFor(() => expect(screen.getByText("已完成读取，Pixiv 返回 0 件作品")).toBeTruthy());
  });

  it("requires an explicit confirmation before clearing local data", () => {
    const onClearData = vi.fn();
    render(<SettingsView data={createEmptyDashboardData()} isPreview={true} error={null} onSchedule={vi.fn()} onShowChips={vi.fn()} onExportJson={vi.fn()} onExportCsv={vi.fn()} onOpenOnboarding={vi.fn()} onClearData={onClearData} />);
    expect(onClearData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清空本地数据并重新绑定" }));
    expect(onClearData).toHaveBeenCalledTimes(1);

    cleanup();
    const onConfirm = vi.fn();
    render(<ClearDataModal busy={false} error={null} onCancel={vi.fn()} onConfirm={onConfirm} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清空并重新绑定" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("migrates the legacy onboarding key without flashing the first-run modal", async () => {
    window.localStorage.setItem("pixivpulse:onboarding-seen", "1");
    let resolveDashboard: ((value: unknown) => void) | undefined;
    const dashboardResponse = new Promise((resolve) => { resolveDashboard = resolve; });
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type === "GET_DASHBOARD_DATA") return dashboardResponse;
      if (message.type === "SET_ONBOARDING_COMPLETE") return Promise.resolve({ ok: true, data: { ...createEmptyDashboardData(), settings: { ...createEmptyDashboardData().settings, onboardingComplete: true } } });
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    render(<DashboardApp />);

    expect(screen.queryByRole("dialog", { name: "先建立你的增长基线" })).toBeNull();
    resolveDashboard?.({ ok: true, data: createEmptyDashboardData() });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "SET_ONBOARDING_COMPLETE", complete: true }));
    expect(screen.queryByRole("dialog", { name: "先建立你的增长基线" })).toBeNull();
  });

  it("persists a first-run later choice and tells the user where to reopen it", async () => {
    const empty = createEmptyDashboardData();
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "GET_DASHBOARD_DATA") return { ok: true, data: empty };
      if (message.type === "SET_ONBOARDING_COMPLETE") return { ok: true, data: { ...empty, settings: { ...empty.settings, onboardingComplete: true } } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("button", { name: "稍后设置" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "SET_ONBOARDING_COMPLETE", complete: true }));
    expect(screen.getByText("首次说明已关闭。可随时在「数据与设置」→「重新查看首次说明」中打开。")).toBeTruthy();
    expect(sendMessage.mock.calls.some(([message]) => message.type === "START_SYNC")).toBe(false);
  });

  it("does not show completed onboarding again, but supports an explicit reopen", async () => {
    const data = createDemoData();
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "GET_DASHBOARD_DATA" ? { ok: true, data } : { ok: true, data });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    render(<DashboardApp />);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_DASHBOARD_DATA" }));
    expect(screen.queryByRole("dialog", { name: "先建立你的增长基线" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "数据与设置" }));
    fireEvent.click(screen.getByRole("button", { name: "重新查看首次说明" }));
    expect(await screen.findByRole("dialog", { name: "先建立你的增长基线" })).toBeTruthy();
  });
});
