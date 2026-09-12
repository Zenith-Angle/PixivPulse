import { describe, expect, it, vi, afterEach } from "vitest";
import { runAgent } from "./runner";
import { DEFAULT_AGENT_CONFIG, type AgentMessage } from "./types";
import { createDemoData } from "../ui/demoData";
import { analysisIntent, initialAnalysisTools } from "./workflow";
import { KNOWLEDGE_TOOLS } from "./knowledge";

const user = (content: string): AgentMessage => ({ id: "u", role: "user", content, at: "now", status: "complete", traces: [] });
const temporalArgs = { dimension: "hour_of_day", metrics: ["views", "bookmarks", "likes"], workKeys: [], from: null, to: null, bucketHours: 1, offset: 0, limit: 24 };
function turn(protocol: "responses" | "chat", calls: [string, unknown][], answer = "") {
  const toolCalls = calls.map(([name, args], i) => ({ id: `c${i}`, name, arguments: JSON.stringify(args) }));
  const event = protocol === "responses"
    ? { type: "response.completed", response: { status: "completed", output: [
      ...toolCalls.map(call => ({ ...call, type: "function_call", call_id: call.id })),
      ...(answer ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }] : []),
    ] } }
    : { choices: [{ index: 0, delta: { content: answer, tool_calls: toolCalls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }, finish_reason: calls.length ? "tool_calls" : "stop" }] };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("task-directed analysis workflow", () => {
  it.each([
    ["白天和夜间哪个收藏增长更快", "temporal", "analyze_time_patterns"],
    ["周末和工作日点赞有差别吗", "temporal", "analyze_time_patterns"],
    ["看看每日的增长趋势", "temporal", "analyze_time_patterns"],
    ["阅读量最高的五篇", "ranking", "rank_works"],
    ["比较这两个系列的收藏", "comparison", "compare_works"],
    ["检查数据完整性", "quality", "get_data_quality"],
    ["分析人物关系与叙事", "content", "search_works"],
  ] as const)("routes %s to relevant capabilities without a mandatory overview", (question, intent, tool) => {
    expect(analysisIntent([user(question)])).toBe(intent);
    const names = initialAnalysisTools(KNOWLEDGE_TOOLS, intent, [user(question)]).map(tool => tool.name);
    expect(names).toContain(tool); expect(names).not.toContain("get_work_history");
  });
  it("inherits a short follow-up's dimension but changes strategy for a new explicit topic", () => {
    expect(analysisIntent([user("哪些时段浏览更多"), user("那收藏呢")])).toBe("temporal");
    expect(analysisIntent([user("哪些时段浏览更多"), user("改为分析人物关系")])).toBe("content");
    expect(initialAnalysisTools(KNOWLEDGE_TOOLS, "temporal", [user("导出逐条原始记录")])).toContainEqual(expect.objectContaining({ name: "get_work_history" }));
  });
  it.each(["responses", "chat"] as const)("executes a whole-population aggregate and meaningful public feedback through %s", async protocol => {
    const data = createDemoData();
    const initial = "我会比较各时段的浏览、收藏和点赞增量，并核对哪些时段有足够观测。";
    const milestone = "当前记录的采样间隔较长，暂时无法可靠判断小时峰谷；需要按更宽的时段比较。";
    let step = 0;
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!step++) {
        const names = body.tools.map((tool: { name?: string; function?: { name: string } }) => tool.name ?? tool.function?.name);
        expect(names).toContain("analyze_time_patterns"); expect(names).not.toContain("get_work_history");
        return turn(protocol, [["report_progress", { message: initial }], ["analyze_time_patterns", temporalArgs]]);
      }
      const context = JSON.stringify(body.input ?? body.messages);
      expect(context).toContain("excludedCoarse"); expect(context).not.toContain('"collectedAt"');
      return turn(protocol, [["report_progress", { message: milestone }]], "示例数据的小时覆盖不足，不能据此判断高峰。[S1]");
    });
    vi.stubGlobal("fetch", fetch);
    const hooks = { onText: vi.fn(), onTrace: vi.fn(), onUsage: vi.fn(), onCommentary: vi.fn(), onStatus: vi.fn() };
    await runAgent({ ...DEFAULT_AGENT_CONFIG, protocol, shareData: true, memoryEnabled: false }, [user("一天里哪些时段浏览、收藏、点赞最多")], data, true, new AbortController().signal, hooks);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hooks.onTrace).toHaveBeenCalledTimes(1);
    const trace = hooks.onTrace.mock.calls[0]![0];
    expect(trace.name).toBe("analyze_time_patterns");
    const aggregate = JSON.parse(trace.result).data;
    expect(aggregate.selectedWorks).toBe(data.works.length); expect(aggregate.rows).toHaveLength(24);
    expect(aggregate.metrics).toEqual(["views", "bookmarks", "likes"]);
    expect(aggregate.coverage.excludedCoarse).toBeGreaterThan(0);
    expect(hooks.onCommentary.mock.calls.map(([, text]) => text)).toEqual([initial, milestone]);
    expect(hooks.onStatus).toHaveBeenCalledWith("正在比较不同时间的变化");
    expect(hooks.onText.mock.calls.flat().join("")).toContain("小时覆盖不足");
  });
  it.each(["responses", "chat"] as const)("can open exact-record tools for a specific gap with %s, without a data or token quota", async protocol => {
    const data = createDemoData(), names: string[][] = [];
    let step = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      names.push(body.tools.map((tool: { name?: string; function?: { name: string } }) => tool.name ?? tool.function?.name));
      if (!step++) return turn(protocol, [["request_analysis_tools", { tools: ["get_work_history"], question: "一个时段存在负变化，需要检查对应作品的计数是否回退。", reason: "聚合可以发现回退，但不能展示两个原始端点。" }]]);
      if (step === 2) return turn(protocol, [["get_work_history", { workKey: data.works[0]!.key, from: null, to: null, offset: 0, limit: 5 }]]);
      return turn(protocol, [], "已核对原始记录。[S1]");
    }));
    const hooks = { onText: vi.fn(), onTrace: vi.fn(), onUsage: vi.fn() };
    await runAgent({ ...DEFAULT_AGENT_CONFIG, protocol, shareData: true, memoryEnabled: false }, [user("分析时段变化并核对异常")], data, true, new AbortController().signal, hooks);
    expect(names[0]).not.toContain("get_work_history"); expect(names[1]).toContain("get_work_history");
    expect(hooks.onTrace).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hooks.onTrace.mock.calls[0]![0].result).error).toBeUndefined();
    expect(hooks.onText).toHaveBeenCalledWith("已核对原始记录。[S1]");
  });
  it("offers whole-portfolio temporal aggregation instead of raw-history pagination for the reported failure", async () => {
    // User-supplied failed run: 15 sources, 9 raw-history pages / 450 rows,
    // 76,038 bytes, no time-of-day aggregate. No private titles/data copied.
    const question: AgentMessage = { id: "question", role: "user", content: "分析一下我的阅读量、收藏、点赞这些数据，它们当然整体是比较一致的，但是我想看它们在一天里边的分布情况，在每天哪些时间段比较少，哪些时间段比较多", at: "now", status: "complete", traces: [] };
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const sent = JSON.parse(init.body);
      const names = sent.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("analyze_time_patterns");
      expect(names).not.toContain("get_work_history");
      expect(names).not.toContain("rank_works");
      expect(sent.instructions).not.toContain('"totals"');
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "需要比较各时段的增量与覆盖。" }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetch);
    await runAgent({ ...DEFAULT_AGENT_CONFIG, shareData: true, memoryEnabled: false }, [question], createDemoData(), true, new AbortController().signal, { onText: vi.fn(), onTrace: vi.fn(), onUsage: vi.fn() });
  });
});
