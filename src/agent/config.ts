import { t } from "../i18n";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "./types";

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(t("Base URL 必须是完整的 HTTP(S) 地址。")); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error(t("远程 API 必须使用 HTTPS；HTTP 仅限本机服务。"));
  if (url.username || url.password || url.search || url.hash) throw new Error(t("Base URL 不能包含认证信息、查询参数或片段。"));
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses|models)\/?$/, "").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export function validateConfig(config: AgentConfig, requireModel = true): AgentConfig {
  const result = { ...restoreConfig(config), baseUrl: normalizeBaseUrl(config.baseUrl), model: config.model.trim(), apiKey: config.apiKey.trim() };
  if (requireModel && !result.model) throw new Error(t("请填写模型名称。"));
  if (!["auto", "content", "metrics"].includes(result.analysisFocus) || !["auto", "light", "standard", "deep", "custom"].includes(result.readingDepth)) throw new Error(t("分析侧重或阅读深度无效。"));
  if (result.model.length > 200 || /[\r\n]/.test(result.apiKey)) throw new Error(t("模型名称或 API key 格式无效。"));
  if (!["chat", "responses"].includes(result.protocol)) throw new Error(t("API 协议无效。"));
  const integers: [number, number, number, string][] = [
    [result.customReadingChars, 150, Number.MAX_SAFE_INTEGER, t("自定义采样字数")],
    [result.customReadingPercent, 1, 100, t("自定义采样比例")],
    [result.maxSteps, 0, Number.MAX_SAFE_INTEGER, t("工具轮数")],
    [result.timeoutSeconds, 10, 86400, t("请求超时")],
  ];
  for (const [value, min, max, label] of integers) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(t("{value1}须为 {value2} 至 {value3} 的整数。", { value1: label, value2: min, value3: max }));
  if (result.temperature !== null && (!Number.isFinite(result.temperature) || result.temperature < 0 || result.temperature > 2)) throw new Error(t("Temperature 须为 0 至 2，或留空。"));
  if (result.instructions.length > 6000) throw new Error(t("附加指令不能超过 6000 字符。"));
  return result;
}

export function restoreConfig(value: Partial<AgentConfig> | undefined): AgentConfig {
  // Whitelist current fields: old budgets disappear on load/save, while keys,
  // permissions and user preferences retain their existing behavior.
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_CONFIG).map(([key, fallback]) => [key, value?.[key as keyof AgentConfig] ?? fallback])) as unknown as AgentConfig;
}

// Request only the chosen origin and keep this call directly on a user gesture.
export async function authorizeEndpoint(baseUrl: string): Promise<void> {
  const url = new URL(normalizeBaseUrl(baseUrl));
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
  const origin = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(t("未授予此 API 域名的访问权限。"));
}

export function readingLimits(config: AgentConfig): { maxChars: number; fraction: number } {
  switch (config.readingDepth) {
    case "auto": return { maxChars: Number.MAX_SAFE_INTEGER, fraction: 1 };
    case "light": return { maxChars: 1500, fraction: 0.3 };
    case "deep": return { maxChars: 6000, fraction: 0.7 };
    case "custom": return { maxChars: config.customReadingChars, fraction: config.customReadingPercent / 100 };
    default: return { maxChars: 3000, fraction: 0.5 };
  }
}
