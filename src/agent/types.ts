export interface AgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  protocol: "chat" | "responses";
  contextWindow: number;
  maxOutputTokens: number;
  maxSteps: number;
  inputBudget: number;
  totalInputBudget: number;
  memoryEnabled: boolean;
  sampleOriginals: boolean;
  analysisFocus: "auto" | "content" | "metrics";
  readingDepth: "auto" | "light" | "standard" | "deep" | "custom";
  customReadingChars: number;
  customReadingPercent: number;
  temperature: number | null;
  outputParameter: "max_tokens" | "max_completion_tokens";
  timeoutSeconds: number;
  rememberKey: boolean;
  shareData: boolean;
  instructions: string;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: "", protocol: "responses",
  contextWindow: 1000000, maxOutputTokens: 8192, maxSteps: 0, temperature: null,
  outputParameter: "max_completion_tokens", timeoutSeconds: 120,
  inputBudget: 0, totalInputBudget: 0, memoryEnabled: true, sampleOriginals: false, analysisFocus: "auto", readingDepth: "auto", customReadingChars: 4500, customReadingPercent: 60,
  rememberKey: false, shareData: false, instructions: "例如：我在 Pixiv 创作同人小说。请先给结论，再结合已读正文分析人物关系、角色塑造和叙事节奏，给出两三条具体建议。区分原作设定与本篇证据，不确定时说明；称呼作品时优先用标题或系列与章节。",
};

export interface AgentUsage { input: number; output: number; requests?: number; memoryHits?: number; cachedInput?: number; evidenceBytes?: { content: number; statistics: number } }

export interface ToolTrace {
  cached?: boolean;
  id: string;
  name: string;
  arguments: string;
  result: string;
  at: string;
}

export interface ReadingProgress {
  key: string;
  title: string;
  status: "queued" | "reading" | "complete" | "cached" | "error" | "skipped";
  detail?: string;
  characters?: number | undefined;
  coverage?: number | undefined;
}

export interface AgentActivity {
  id: string;
  kind: "commentary" | "operation";
  text: string;
  at: string;
  status?: "running" | "complete" | "error" | "stopped";
  sourceId?: string;
  reading?: ReadingProgress[];
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  status: "complete" | "running" | "error" | "stopped";
  traces: ToolTrace[];
  error?: string;
  model?: string;
  usage?: AgentUsage;
  trimmedTurns?: number;
  progress?: { label: string; at: string; detail?: string }[];
  phase?: "working" | "answering";
  reading?: ReadingProgress[];
  activity?: AgentActivity[];
}

export interface Conversation {
  id: string;
  accountId: string;
  title: string;
  updatedAt: string;
  messages: AgentMessage[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
