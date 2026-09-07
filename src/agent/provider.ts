import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionAssistantMessageParam } from "openai/resources/chat/completions";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { validateConfig } from "./config";
import type { AgentConfig, ToolDefinition } from "./types";

export class AgentError extends Error {}
export type WireMessage = ChatCompletionMessageParam;
export interface TurnResult {
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  chat: ChatCompletionAssistantMessageParam;
  output: ResponseInputItem[];
  usage: { input: number; output: number; cachedInput?: number };
}

export function safeAgentError(error: unknown): string {
  if (error instanceof AgentError) return error.message;
  if (error instanceof OpenAI.APIError) {
    switch (error.status) {
      case 401: case 403: return "认证失败或权限不足，请检查 API key、模型权限和账户状态。";
      case 404: return "找不到 API 端点或模型，请检查 Base URL、协议和模型名称。";
      case 429: return "API 限流或额度不足，请检查账户配额后重试。";
      case 400: case 422: return "API 拒绝了请求，请检查模型的协议、工具调用、输出参数和上下文限制。";
      default: return error.status ? `API 请求失败（HTTP ${error.status}），请稍后重试。` : "网络连接失败，请检查地址、域名权限和服务可用性。";
    }
  }
  return "请求失败，请检查网络和 API 配置后重试。";
}

function client(config: AgentConfig) {
  return new OpenAI({ apiKey: config.apiKey || "local-no-key", baseURL: config.baseUrl,
    dangerouslyAllowBrowser: true, maxRetries: 0, timeout: config.timeoutSeconds * 1000,
    // Never attach Pixiv cookies or follow an endpoint redirect with a credential.
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (!config.apiKey) headers.delete("authorization");
      return fetch(url, { ...init, headers, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    },
  });
}

export async function listModels(config: AgentConfig, signal: AbortSignal): Promise<string[]> {
  const c = validateConfig(config, false);
  const result = await client(c).models.list({ signal });
  return [...new Set(result.data.map((model) => model.id).filter((id) => typeof id === "string"))].sort();
}

export async function generateTurn(config: AgentConfig, system: string, chat: WireMessage[], input: ResponseInputItem[], tools: ToolDefinition[], signal: AbortSignal, onText: (text: string) => void, onProgress: (stage: string) => void = () => {}): Promise<TurnResult> {
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, config.timeoutSeconds * 1000);
  const relay = () => abort.abort();
  signal.addEventListener("abort", relay, { once: true });
  if (signal.aborted) relay();
  let text = "";
  let lastStage = "";
  const progress = (stage: string) => { if (stage !== lastStage) { lastStage = stage; onProgress(stage); } };
  progress("等待模型响应");
  const addText = (chunk: string) => {
    progress("正在输出回答");
    text += chunk;
    if (text.length > 1_000_000) throw new AgentError("回答超出本地安全长度限制，请缩小问题范围。");
    onText(chunk);
  };
  try {
    if (config.protocol === "responses") {
      const stream = await client(config).responses.create({ model: config.model, instructions: system, input, stream: true, store: false,
        max_output_tokens: config.maxOutputTokens,
        ...(config.temperature === null ? {} : { temperature: config.temperature }),
        ...(tools.length ? { tools: tools.map((tool) => ({ type: "function" as const, ...tool, strict: true })), tool_choice: "auto" as const } : {}),
      }, { signal: abort.signal });
      let final: TurnResult | null = null;
      progress("模型已连接，等待内容");
      for await (const event of stream) {
        if (event.type.startsWith("response.reasoning")) progress("模型正在处理问题");
        if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") progress("模型正在准备工具调用");
        if (event.type === "response.output_item.added" && event.item.type === "function_call") progress("模型正在准备工具调用");
        if (event.type === "response.output_text.delta") addText(event.delta);
        if (event.type === "response.refusal.delta") addText(event.delta);
        if (event.type === "response.failed" || event.type === "error") throw new AgentError("模型返回生成失败，请重试或更换模型。");
        if (event.type === "response.incomplete") throw new AgentError("回答未完成（输出上限或服务限制），请提高最大输出或缩小问题范围。");
        if (event.type === "response.completed") {
          const response = event.response;
          if (response.status !== "completed") throw new AgentError("模型响应未完成。");
          if (!text) for (const item of response.output) if (item.type === "message") for (const part of item.content) if (part.type === "output_text") addText(part.text);
          final = { text, calls: response.output.flatMap((item) => item.type === "function_call" ? [{ id: item.call_id, name: item.name, arguments: item.arguments }] : []),
            output: response.output.map((item): ResponseInputItem => {
              if (item.type === "message" || item.type === "function_call" || item.type === "reasoning") return item;
              throw new AgentError("API 返回了未启用的工具类型。");
            }), chat: { role: "assistant", content: text }, usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0, cachedInput: response.usage?.input_tokens_details?.cached_tokens ?? 0 } };
        }
      }
      if (!final) throw new AgentError("响应流提前断开，已保留收到的内容，请重试。");
      return final;
    }
    const stream = await client(config).chat.completions.create({ model: config.model, messages: [{ role: "system", content: system }, ...chat], stream: true,
      [config.outputParameter]: config.maxOutputTokens,
      ...(config.temperature === null ? {} : { temperature: config.temperature }),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: "function" as const, function: { ...tool, strict: true } })), tool_choice: "auto" as const } : {}),
    }, { signal: abort.signal });
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finish: string | null = null;
    let reasoning = "";
    let usage = { input: 0, output: 0, cachedInput: 0 };
    progress("模型已连接，等待内容");
    for await (const chunk of stream) {
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, cachedInput: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 };
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta.content) addText(choice.delta.content);
      if (choice.delta.refusal) addText(choice.delta.refusal);
      const reasoningDelta = (choice.delta as { reasoning_content?: string }).reasoning_content;
      if (reasoningDelta) { reasoning += reasoningDelta; progress("模型正在处理问题"); }
      if (reasoning.length > 1_000_000) throw new AgentError("模型思考内容超出安全长度限制。");
      for (const call of choice.delta.tool_calls ?? []) {
        progress("模型正在准备工具调用");
        if (!Number.isInteger(call.index) || call.index < 0 || call.index > 15) throw new AgentError("API 返回不兼容的工具调用格式。");
        const pending = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
        if (call.id) pending.id += call.id;
        if (call.function?.name) pending.name += call.function.name;
        if (call.function?.arguments) pending.arguments += call.function.arguments;
        if (pending.arguments.length > 20000) throw new AgentError("工具参数过长。");
        calls.set(call.index, pending);
      }
    }
    if (!finish) throw new AgentError("响应流提前断开，已保留收到的内容，请重试。");
    if (finish !== "stop" && finish !== "tool_calls") throw new AgentError("回答被截断或受服务限制，请提高输出上限或缩小问题范围。");
    const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const message: ChatCompletionAssistantMessageParam & { reasoning_content?: string } = { role: "assistant", content: text || null,
      ...(completed.length ? { tool_calls: completed.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    };
    return { text, calls: completed, chat: message, output: [], usage };
  } catch (error) {
    if (timedOut) throw new AgentError("API 请求超时，已保留收到的内容；可调整请求超时后重试。");
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", relay); }
}

export async function testConnection(config: AgentConfig, signal: AbortSignal): Promise<void> {
  const c = validateConfig(config);
  const probe: ToolDefinition = { name: "connection_probe", description: "Return connection status.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } };
  const question = { role: "user" as const, content: "Call connection_probe once, then reply OK." };
  const first = await generateTurn(c, "You are testing API connectivity. You must call connection_probe exactly once before answering.", [question], [question], [probe], signal, () => {});
  if (first.calls.length !== 1 || first.calls[0]?.name !== probe.name || !first.calls[0].id) throw new AgentError("端点可连接，但模型未正确执行工具调用，不能用于 Agent 分析。");
  const call = first.calls[0];
  const second = await generateTurn(c, "The connection probe succeeded. Reply OK.", [question, first.chat, { role: "tool", tool_call_id: call.id, content: '{"ok":true}' }],
    [question, ...first.output, { type: "function_call_output", call_id: call.id, output: '{"ok":true}' }], [], signal, () => {});
  if (!second.text.trim() || second.calls.length) throw new AgentError("工具结果已回传，但模型未生成最终回答。");
}
