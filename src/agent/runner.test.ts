import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoData } from "../ui/demoData";
import { DEFAULT_AGENT_CONFIG, type AgentMessage } from "./types";
import { generateTurn, safeAgentError, testConnection } from "./provider";
import { runAgent, selectHistory } from "./runner";
import * as novel from "./novel";

const config = { ...DEFAULT_AGENT_CONFIG, apiKey: "never-log-this-key", shareData: true };
const user: AgentMessage = { id: "u1", role: "user", content: "分析作品集", at: "now", status: "complete", traces: [] };
const response = (output: unknown[], inputTokens = 12) => ({ type: "response.completed", response: { id: "r1", object: "response", status: "completed", output, usage: { input_tokens: inputTokens, output_tokens: 4 } } });
const message = (text: string) => ({ id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const hooks = () => ({ onText: vi.fn(), onTrace: vi.fn(), onBudget: vi.fn(), onUsage: vi.fn() });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Agent protocol and execution acceptance", () => {
  it.each(["responses", "chat"] as const)("streams public commentary independently of final text with %s", async protocol => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } })));
    const onText = vi.fn(), onCommentary = vi.fn();
    const running = generateTurn({ ...config, protocol }, "test", [], [user], [], new AbortController().signal, onText, undefined, onCommentary);
    const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    if (protocol === "responses") {
      emit({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "report_progress", arguments: "" } });
      emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"message":"先核对' });
    } else emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "report_progress", arguments: '{"message":"先核对' } }] } }] });
    await vi.waitFor(() => expect(onCommentary).toHaveBeenCalledWith(0, "先核对"));
    expect(onText).not.toHaveBeenCalled();
    if (protocol === "responses") {
      emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: '证据。"}' });
      emit(response([{ type: "function_call", id: "f", call_id: "c", name: "report_progress", arguments: '{"message":"先核对证据。"}' }]));
    } else emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '证据。"}' } }] }, finish_reason: "tool_calls" }] });
    controller.close(); await running;
    expect(onCommentary).toHaveBeenLastCalledWith(0, "先核对证据。");
    expect(onText).not.toHaveBeenCalled();
  });
  it("separates public updates, real operations and final answers for general metric queries", async () => {
    const call = { type: "function_call", id: "p", call_id: "p", name: "report_progress", arguments: '{"message":"先核对可用指标，再比较差异。"}' };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sse([response([call, { type: "function_call", id: "q", call_id: "q", name: "get_overview", arguments: "{}" }])])).mockResolvedValueOnce(sse([response([message("最终结论 [S2]")])])));
    const events = { ...hooks(), onCommentary: vi.fn(), onOperation: vi.fn() };
    await runAgent({ ...config, analysisFocus: "metrics" }, [user], createDemoData(), false, new AbortController().signal, events);
    expect(events.onCommentary).toHaveBeenCalledWith("0:0", "先核对可用指标，再比较差异。");
    expect(events.onTrace.mock.calls.every(([trace]) => trace.name !== "report_progress")).toBe(true);
    expect(events.onOperation.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "operation", status: "complete" });
    expect(events.onText.mock.calls.flat().join("")).toBe("最终结论 [S2]");
  });
  it("answers simple questions directly and does not force commentary or extra requests", async () => {
    const fetch = vi.fn().mockResolvedValue(sse([response([message("你好！")])])); vi.stubGlobal("fetch", fetch);
    const events = { ...hooks(), onCommentary: vi.fn(), onOperation: vi.fn() };
    await runAgent({ ...config, shareData: false }, [user], createDemoData(), false, new AbortController().signal, events);
    expect(fetch).toHaveBeenCalledTimes(1); expect(events.onCommentary).not.toHaveBeenCalled(); expect(events.onOperation).not.toHaveBeenCalled();
  });
  it("keeps an answer accompanying only commentary without another model request", async () => {
    const fetch = vi.fn().mockResolvedValue(sse([response([{ type: "function_call", id: "p", call_id: "p", name: "report_progress", arguments: '{"message":"下面按两个方面说明。"}' }, message("完整回答")])])); vi.stubGlobal("fetch", fetch);
    const events = { ...hooks(), onToolTurn: vi.fn() };
    await runAgent({ ...config, shareData: false }, [user], createDemoData(), false, new AbortController().signal, events);
    expect(fetch).toHaveBeenCalledTimes(1); expect(events.onToolTurn).not.toHaveBeenCalled();
    expect(events.onText.mock.calls.flat().join("")).toBe("完整回答");
  });
  it("reports reasoning activity and streams answer deltas before completion", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    const onText = vi.fn(), onProgress = vi.fn();
    const running = generateTurn(config, "test", [], [user], [], new AbortController().signal, onText, onProgress);
    const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    emit({ type: "response.reasoning_text.delta", delta: "internal reasoning not displayed" });
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith("模型正在处理问题"));
    expect(onText).not.toHaveBeenCalled();
    emit({ type: "response.output_text.delta", delta: "第一段" });
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith("第一段"));
    emit({ type: "response.output_text.delta", delta: "第二段" });
    emit(response([message("第一段第二段")])); controller.close();
    expect((await running).text).toBe("第一段第二段");
    expect(onProgress).toHaveBeenCalledWith("正在输出回答");
  });
  it("delivers done-only text before completion and reconciles partially streamed blocks without duplicates", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } })));
    const onText = vi.fn();
    const running = generateTurn(config, "test", [], [user], [], new AbortController().signal, onText);
    const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "前" });
    emit({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "前段" });
    await vi.waitFor(() => expect(onText.mock.calls.flat().join("")).toBe("前段"));
    emit({ type: "response.output_item.done", output_index: 1, item: { ...message("后段"), id: "m2" } });
    await vi.waitFor(() => expect(onText.mock.calls.flat().join("")).toBe("前段后段"));
    emit(response([message("前段"), { ...message("后段"), id: "m2" }])); controller.close();
    expect((await running).text).toBe("前段后段");
    expect(onText.mock.calls.flat().join("")).toBe("前段后段");
  });
  it("reports each sampled title and separates a tool preamble from the final answer", async () => {
    const data = createDemoData(), work = data.works.find(row => row.type === "novel")!;
    data.works = [{ ...work, key: "a", title: "样本甲" }, { ...work, key: "b", title: "样本乙" }];
    vi.spyOn(novel, "readNovelSample").mockImplementation(async (_data, args) => ({ cached: args.workKey === "b", result: { sampledCharacters: 500, totalCharacters: 1000 } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sse([response([message("先读取两个样本。"), { type: "function_call", id: "f", call_id: "c", name: "read_content_samples", arguments: JSON.stringify({ workKeys: ["a", "b"], refresh: false }) }])])).mockResolvedValueOnce(sse([response([message("建议与不确定性 [S1]")])])));
    let answer = ""; const preambles: string[] = []; const stages: string[] = [];
    await runAgent({ ...config, sampleOriginals: true }, [{ ...user, content: "根据 2–3 篇正文采样分析特点与新方向，不将少量样本当全库结论" }], data, false, new AbortController().signal, { ...hooks(), onText: text => { answer += text; }, onToolTurn: text => { preambles.push(text); answer = ""; }, onProgress: stage => stages.push(stage) });
    expect(answer).toBe("建议与不确定性 [S1]"); expect(preambles).toEqual(["先读取两个样本。"]);
    expect(stages).toContain("读取正文：《样本甲》"); expect(stages).toContain("读取正文：《样本乙》");
    expect(stages.some(stage => stage.startsWith("复用正文片段：《样本乙》"))).toBe(true);
    expect(stages).toContain("结合已获取的证据组织回答");
  });
  it("accepts eight requested original samples with live per-work progress and no three-read ceiling", async () => {
    const data = createDemoData(), work = data.works.find(row => row.type === "novel")!;
    data.works = Array.from({ length: 8 }, (_, i) => ({ ...work, key: `sample-${i}`, id: String(100 + i), title: `样本 ${i + 1}` }));
    const read = vi.spyOn(novel, "readNovelSample").mockResolvedValue({ cached: false, result: { sampledCharacters: 600, totalCharacters: 5000 } });
    const fetch = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f", call_id: "c", name: "read_content_samples", arguments: JSON.stringify({ workKeys: data.works.map(w => w.key), refresh: false }) }])])).mockResolvedValueOnce(sse([response([message("有限样本的特点与小规模试验 [S1]")])]));
    vi.stubGlobal("fetch", fetch);
    const events = { ...hooks(), onReading: vi.fn() };
    await runAgent({ ...config, sampleOriginals: true }, [{ ...user, content: "根据 5-8 篇正文采样，列出可保留的创作特点与新方向" }], data, false, new AbortController().signal, events);
    expect(read).toHaveBeenCalledTimes(8);
    expect(events.onReading.mock.calls.filter(([event]) => event.status === "complete")).toHaveLength(8);
    expect(events.onReading.mock.calls.filter(([event]) => event.status === "queued")).toHaveLength(8);
    const payload = JSON.parse(events.onTrace.mock.calls.at(-1)![0].result);
    expect(payload.data.works).toHaveLength(8);
    expect(payload.data.works.every((row: { error?: string }) => !row.error)).toBe(true);
  });
  it("finishes automatic tool rounds when repeated queries add no new evidence", async () => {
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const request = JSON.parse(init.body);
      return sse([response(request.tools?.length ? [{ type: "function_call", id: "f", call_id: `c${fetch.mock.calls.length}`, name: "get_overview", arguments: "{}" }] : [message("已有证据足够 [S1]")])]);
    });
    vi.stubGlobal("fetch", fetch);
    await runAgent({ ...config, maxSteps: 0, inputBudget: 0, totalInputBudget: 0 }, [user], createDemoData(), false, new AbortController().signal, hooks());
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(4);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).tools).toBeUndefined();
  });
  it("allows tool use with an unlimited per-request budget and a finite cumulative budget", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f", call_id: "c", name: "get_overview", arguments: "{}" }])])).mockResolvedValueOnce(sse([response([message("已有事实 [S1]")])]));
    vi.stubGlobal("fetch", fetch);
    await runAgent({ ...config, inputBudget: 0, totalInputBudget: 160000 }, [user], createDemoData(), false, new AbortController().signal, hooks());
    expect(JSON.parse(fetch.mock.calls[0]![1].body).tools.length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("closes tools after an original-reading failure instead of retrying another channel", async () => {
    const data = createDemoData(), work = data.works.find(work => work.type === "novel")!;
    const read = vi.spyOn(novel, "readNovelSample").mockRejectedValue(new Error("页面要求验证"));
    const call = (id: string, name: string, args: object) => ({ type: "function_call", id, call_id: id, name, arguments: JSON.stringify(args) });
    const fetch = vi.fn().mockResolvedValueOnce(sse([response([
      call("a", "sample_novel", { workKey: work.key, focus: "balanced", keyword: "", refresh: false }),
      call("b", "read_content_samples", { workKeys: [work.key], refresh: true }),
    ])])).mockResolvedValueOnce(sse([response([message("正文读取失败，请先处理网站访问提示。")])]));
    vi.stubGlobal("fetch", fetch);
    await runAgent({ ...config, sampleOriginals: true }, [{ ...user, content: "读取正文" }], data, false, new AbortController().signal, hooks());
    expect(read).toHaveBeenCalledTimes(1);
    const final = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(final.tools).toBeUndefined();
    expect(final.instructions).toContain("local cooldown is NOT a new HTTP 429");
    expect(final.input.filter((item: { type: string }) => item.type === "function_call_output")).toHaveLength(2);
  });
  it("prioritizes prose with compact routing, multi-work reading and bounded evidence", async () => {
    const data = createDemoData(), work = data.works.find(work => work.type === "novel")!;
    data.works = [{ ...work, key: "a" }, { ...work, key: "b" }];
    const read = vi.spyOn(novel, "readNovelSample").mockImplementation(async (_d, args, _s, _r, limits) => ({ cached: false, result: { workKey: args.workKey, excerpts: [{ text: "正文".repeat(Math.floor(limits!.maxChars / 2)) }], coverage: 0.1 } }));
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f", call_id: "c", name: "read_content_samples", arguments: JSON.stringify({ workKeys: ["a", "b"], refresh: false }) }])]))
      .mockResolvedValueOnce(sse([response([message("有正文依据的建议 [S1]")])]));
    vi.stubGlobal("fetch", fetchMock);
    const events = hooks();
    await runAgent({ ...config, sampleOriginals: true }, [{ ...user, content: "根据正文比较角色与题材" }], data, false, new AbortController().signal, events);
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(first.tools.some((tool: { name: string }) => tool.name === "get_followers")).toBe(false);
    expect(first.instructions).toContain("identify works by their verified title");
    expect(first.instructions).not.toContain('"totals"');
    expect(read).toHaveBeenCalledTimes(2);
    const result = JSON.parse(events.onTrace.mock.calls[0]![0].result);
    expect(result.error).toBeUndefined(); expect(result.data.works).toHaveLength(2);
    const usage = events.onUsage.mock.calls.at(-1)![0];
    expect(usage.evidenceBytes.content).toBeGreaterThan(5000);
    expect(usage.evidenceBytes.statistics).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("enforces cumulative per-work coverage across different sampling positions", async () => {
    const data = createDemoData(), work = data.works.find(work => work.type === "novel")!;
    const read = vi.spyOn(novel, "readNovelSample").mockResolvedValue({ cached: false, result: { sampledCharacters: 500, totalCharacters: 1000, excerpts: [{ text: "片段" }] } });
    const call = (focus: string) => sse([response([{ type: "function_call", id: focus, call_id: focus, name: "sample_novel", arguments: JSON.stringify({ workKey: work.key, focus, keyword: "", refresh: false }) }])]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(call("start")).mockResolvedValueOnce(call("end")).mockResolvedValueOnce(sse([response([message("依据已读片段分析")])])));
    const events = hooks();
    await runAgent({ ...config, sampleOriginals: true, readingDepth: "standard" }, [{ ...user, content: "采样正文" }], data, false, new AbortController().signal, events);
    expect(read).toHaveBeenCalledTimes(1);
    expect(events.onTrace.mock.calls.at(-1)![0].result).toContain("采样额度已用完");
  });
  it("keeps sampling available after locating a novel and completes the three-request flow", async () => {
    const data = createDemoData();
    const work = data.works.find(work => work.type === "novel")!;
    vi.spyOn(novel, "readNovelSample").mockResolvedValue({ cached: false, result: { workKey: work.key, excerpts: [{ text: "原文片段" }], coverage: 0.2 } });
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f1", call_id: "c1", name: "search_works", arguments: JSON.stringify({ query: work.id, offset: 0, limit: 1 }) }])]))
      .mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f2", call_id: "c2", name: "sample_novel", arguments: JSON.stringify({ workKey: work.key, focus: "balanced", keyword: "", refresh: false }) }])]))
      .mockResolvedValueOnce(sse([response([message("原文片段分析 [S3]")])]));
    vi.stubGlobal("fetch", fetchMock);
    await runAgent({ ...config, sampleOriginals: true }, [user], data, false, new AbortController().signal, hooks());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).tools.some((tool: { name: string }) => tool.name === "sample_novel")).toBe(true);
    expect(novel.readNovelSample).toHaveBeenCalledTimes(1);
  });
  it("rejects text-only fake tool instructions instead of declaring completion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([response([message('<｜DSML｜tool_calls>not executed')])])));
    await expect(runAgent(config, [user], createDemoData(), false, new AbortController().signal, hooks())).rejects.toThrow("未执行的工具指令");
  });
  it("requires separate consent for original sampling and disables it in preview", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sse([response([message("ok")])]));
    vi.stubGlobal("fetch", fetchMock);
    for (const [sampleOriginals, preview] of [[false, false], [true, true], [true, false]]) {
      await runAgent({ ...config, sampleOriginals: sampleOriginals! }, [user], createDemoData(), preview!, new AbortController().signal, hooks());
    }
    const sent = fetchMock.mock.calls.map(call => JSON.parse(call[1].body).tools.some((tool: { name: string }) => tool.name === "sample_novel"));
    expect(sent).toEqual([false, false, true]);
  });
  it("answers a simple overview in one request and does not send raw samples", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([response([message("4 件作品 [S1]")])]));
    vi.stubGlobal("fetch", fetchMock);
    const data = createDemoData();
    const events = hooks();
    await runAgent(config, [user], data, false, new AbortController().signal, events);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.instructions).toContain('"workCount":4');
    expect(sent.instructions).not.toContain(data.works[0]!.title);
    expect(events.onTrace.mock.calls[0]![0].name).toBe("get_overview");
  });
  it("reserves a final synthesis request at the cumulative budget boundary", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => JSON.parse(init.body).tools ? sse([response([{ type: "function_call", id: "f", call_id: `c${Date.now()}`, name: "get_overview", arguments: "{}" }])]) : sse([response([message("总结 [S1]")])]));
    vi.stubGlobal("fetch", fetchMock);
    await runAgent({ ...config, inputBudget: 24000, totalInputBudget: 48000, maxSteps: 20 }, [user], createDemoData(), false, new AbortController().signal, hooks());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThan(5);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).tools).toBeUndefined();
  });
  it("runs real SDK Responses streaming, tool execution and stateless reasoning replay", async () => {
    const reasoning = { id: "reason1", type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "provider supplied reasoning" }] };
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([response([reasoning, { type: "function_call", id: "fc", call_id: "call1", name: "get_overview", arguments: "{}" }])]))
      .mockResolvedValueOnce(sse([{ type: "response.output_text.delta", delta: "共有作品，依据 [S1]。" }, response([message("共有作品，依据 [S1]。")])]));
    vi.stubGlobal("fetch", fetchMock);
    const events = hooks();
    await runAgent(config, [user], createDemoData(), true, new AbortController().signal, events);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${config.apiKey}`);
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(second.store).toBe(false); expect(second.previous_response_id).toBeUndefined();
    expect(second.input).toContainEqual(reasoning);
    expect(second.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call1" });
    const data = JSON.parse(second.input.at(-1).output);
    expect(data.source).toBe("S2"); expect(data.data.workCount).toBe(createDemoData().works.length);
    expect(events.onText).toHaveBeenCalledWith("共有作品，依据 [S1]。");
    expect(events.onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ input: 24, output: 8, requests: 2, memoryHits: 1 }));
    expect(JSON.stringify(second)).not.toContain(config.apiKey);
  });

  it("assembles fragmented Chat Completions calls and replays provider reasoning_content", async () => {
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "cc", choices: [{ index: 0, delta, finish_reason }] });
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([
      chunk({ reasoning_content: "provider reason" }),
      chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "search_works", arguments: '{"query":"",' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"offset":0,"limit":1}' } }] }, "tool_calls"),
    ])).mockResolvedValueOnce(sse([chunk({ content: "结果 [S1]" }, "stop")]));
    vi.stubGlobal("fetch", fetchMock);
    await runAgent({ ...config, protocol: "chat", outputParameter: "max_tokens" }, [user], createDemoData(), false, new AbortController().signal, hooks());
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(second.max_tokens).toBe(config.maxOutputTokens); expect(second.max_completion_tokens).toBeUndefined();
    expect(second.messages.at(-2).reasoning_content).toBe("provider reason");
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("does not expose data or data-access tools when sharing is off", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([response([message("普通对话")])]));
    vi.stubGlobal("fetch", fetchMock);
    const data = createDemoData();
    await runAgent({ ...config, shareData: false }, [user], data, false, new AbortController().signal, hooks());
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.tools.map((tool: { name: string }) => tool.name)).toEqual(["report_progress"]); expect(sent.instructions).not.toContain("Available snapshot");
    expect(JSON.stringify(sent)).not.toContain(data.works[0]!.title);
  });

  it("returns recoverable schema errors to the model instead of executing unknown tools", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "fc", call_id: "c", name: "execute_shell", arguments: "{}" }])]))
      .mockResolvedValueOnce(sse([response([message("工具不可用")])]));
    vi.stubGlobal("fetch", fetchMock);
    const events = hooks();
    await runAgent(config, [user], createDemoData(), false, new AbortController().signal, events);
    expect(events.onTrace.mock.calls.at(-1)![0].result).toContain("Invalid tool");
  });

  it.each(["response.incomplete", "response.failed"])("fails visibly for %s", async (type) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([{ type, response: { status: "incomplete" } }])));
    await expect(runAgent(config, [user], createDemoData(), false, new AbortController().signal, hooks())).rejects.toThrow();
  });
  it("detects a dropped stream after partial output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([{ type: "response.output_text.delta", delta: "partial" }])));
    const events = hooks();
    await expect(runAgent(config, [user], createDemoData(), false, new AbortController().signal, events)).rejects.toThrow("提前断开");
    expect(events.onText).toHaveBeenCalledWith("partial");
  });
  it("honors stop without initiating requests", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController(); abort.abort();
    await expect(runAgent(config, [user], createDemoData(), false, abort.signal, hooks())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("masks provider error bodies containing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: config.apiKey } }), { status: 401, headers: { "content-type": "application/json" } })));
    const error = await generateTurn(config, "test", [], [{ role: "user", content: "hello" }], [], new AbortController().signal, () => {}).catch((e: unknown) => e);
    expect(safeAgentError(error)).toContain("认证失败"); expect(safeAgentError(error)).not.toContain(config.apiKey);
  });
  it("connection test performs both tool request and result return without portfolio data", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f", call_id: "p1", name: "connection_probe", arguments: "{}" }])]))
      .mockResolvedValueOnce(sse([response([message("OK")])]));
    vi.stubGlobal("fetch", fetchMock);
    await testConnection(config, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).tool_choice).toBe("auto");
  });
  it("trims whole old turns and preserves the current question", () => {
    const result = selectHistory([{ ...user, content: "a".repeat(2000) }, { ...user, id: "a", role: "assistant", content: "b".repeat(1000) }, { ...user, id: "new", content: "current" }], 500);
    expect(result.trimmedTurns).toBe(1); expect(result.messages.map((m) => m.id)).toEqual(["new"]);
    expect(() => selectHistory([{ ...user, content: "中".repeat(2000) }], 500)).toThrow("超出上下文预算");
  });
  it("enforces the configured tool round limit before an unbounded loop", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sse([response([{ type: "function_call", id: "f", call_id: "c", name: "get_overview", arguments: "{}" }])]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runAgent({ ...config, maxSteps: 1 }, [user], createDemoData(), false, new AbortController().signal, hooks())).rejects.toThrow("工具轮数");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).tools).toBeUndefined();
  });
  it("times out a hanging stream instead of reporting success", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(new Error("aborted"))); } }), { headers: { "content-type": "text/event-stream" } })));
      const running = generateTurn({ ...config, timeoutSeconds: 10 }, "test", [], [{ role: "user", content: "test" }], [], new AbortController().signal, () => {});
      const assertion = expect(running).rejects.toThrow("超时");
      await vi.advanceTimersByTimeAsync(10001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
  it("reduces oversized pages with correct continuation instead of dropping all evidence", async () => {
    const data = createDemoData();
    const work = data.works[0]!;
    data.works = Array.from({ length: 30 }, (_, index) => ({ ...work, key: `k${index}`, title: "长".repeat(300), description: "文".repeat(600) }));
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([response([{ type: "function_call", id: "f", call_id: "c", name: "search_works", arguments: '{"query":"","offset":0,"limit":30}' }])])).mockResolvedValueOnce(sse([response([message("请缩小范围")])]));
    vi.stubGlobal("fetch", fetchMock);
    const events = hooks();
    await runAgent(config, [user], data, false, new AbortController().signal, events);
    const result = JSON.parse(events.onTrace.mock.calls.at(-1)![0].result);
    expect(result.error).toBeUndefined();
    expect(result.data.total).toBe(30);
    expect(result.data.rows.length).toBeGreaterThan(0);
    expect(result.data.rows.length).toBeLessThan(30);
    expect(result.data.nextOffset).toBe(result.data.rows.length);
  });
});
