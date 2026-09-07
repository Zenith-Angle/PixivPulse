import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "./types";

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Base URL 必须是完整的 HTTP(S) 地址。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("远程 API 必须使用 HTTPS；HTTP 仅限本机服务。");
  if (url.username || url.password || url.search || url.hash) throw new Error("Base URL 不能包含认证信息、查询参数或片段。");
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses|models)\/?$/, "").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export function validateConfig(config: AgentConfig, requireModel = true): AgentConfig {
  const result = { ...DEFAULT_AGENT_CONFIG, ...config, baseUrl: normalizeBaseUrl(config.baseUrl), model: config.model.trim(), apiKey: config.apiKey.trim() };
  if (requireModel && !result.model) throw new Error("请填写模型名称。");
  if (!["auto", "content", "metrics"].includes(result.analysisFocus) || !["light", "standard", "deep", "custom"].includes(result.readingDepth)) throw new Error("分析侧重或阅读深度无效。");
  if (result.model.length > 200 || /[\r\n]/.test(result.apiKey)) throw new Error("模型名称或 API key 格式无效。");
  if (!["chat", "responses"].includes(result.protocol)) throw new Error("API 协议无效。");
  if (!["max_tokens", "max_completion_tokens"].includes(result.outputParameter)) throw new Error("输出上限参数无效。");
  const integers: [number, number, number, string][] = [
    [result.contextWindow, 4096, 2_000_000, "上下文窗口"],
    [result.maxOutputTokens, 128, 128_000, "最大输出"],
    [result.inputBudget, 8000, 200000, "单次输入预算"],
    [result.totalInputBudget, 16000, 500000, "单问累计输入预算"],
    [result.customReadingChars, 150, 6000, "自定义采样字数"],
    [result.customReadingPercent, 10, 70, "自定义采样比例"],
    [result.maxSteps, 1, 20, "工具轮数"],
    [result.timeoutSeconds, 10, 600, "请求超时"],
  ];
  for (const [value, min, max, label] of integers) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min} 至 ${max} 的整数。`);
  if (result.maxOutputTokens + 2048 >= result.contextWindow) throw new Error("上下文窗口须比最大输出至少多 2048 tokens。");
  if (result.totalInputBudget < result.inputBudget * 2) throw new Error("累计输入预算至少为单次预算的两倍，以预留总结空间。");
  if (result.temperature !== null && (!Number.isFinite(result.temperature) || result.temperature < 0 || result.temperature > 2)) throw new Error("Temperature 须为 0 至 2，或留空。");
  if (result.instructions.length > 6000) throw new Error("附加指令不能超过 6000 字符。");
  return result;
}

export function restoreConfig(value: Partial<AgentConfig> | undefined): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, ...value };
}

// Request only the chosen origin and keep this call directly on a user gesture.
export async function authorizeEndpoint(baseUrl: string): Promise<void> {
  const url = new URL(normalizeBaseUrl(baseUrl));
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
  const origin = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error("未授予此 API 域名的访问权限。");
}

export function readingLimits(config: AgentConfig): { maxChars: number; fraction: number } {
  switch (config.readingDepth) {
    case "light": return { maxChars: 1500, fraction: 0.3 };
    case "deep": return { maxChars: 6000, fraction: 0.7 };
    case "custom": return { maxChars: config.customReadingChars, fraction: config.customReadingPercent / 100 };
    default: return { maxChars: 3000, fraction: 0.5 };
  }
}
