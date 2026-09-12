import type { AgentMessage, ToolDefinition } from "./types";

export type AnalysisIntent = "temporal" | "ranking" | "comparison" | "quality" | "content" | "general";

// Hints select the initial capability set, not the answer or query parameters.
// The model can expand the set whenever the user's actual question requires it.
export function analysisIntent(messages: AgentMessage[]): AnalysisIntent {
  for (const { content } of messages.filter(message => message.role === "user").slice(-3).reverse()) {
    if (/时段|日内|一天[里中内]|每天.*[多少高低峰分布]|小时|几点|白天|夜间|周几|星期|周末|工作日|逐日|每日.*[变化趋势增长]|time.of.day|hourly|weekday|daily trend/i.test(content)) return "temporal";
    if (/正文|原文|人物|角色|情节|叙事|文风|prose|narrative/i.test(content)) return "content";
    if (/缺失|完整性|数据质量|可靠|data quality/i.test(content)) return "quality";
    if (/比较|对比|差异|compare/i.test(content)) return "comparison";
    if (/排行|排名|前[一二三四五六七八九十\d]|top\s*\d|最[好高多]/i.test(content)) return "ranking";
    if (/总数|总量|总浏览|作品集|概览|overview|portfolio/i.test(content)) return "general";
  }
  return "general";
}

export const SERVICE_STATUS: Record<AnalysisIntent, string> = {
  temporal: "正在比较不同时间的变化", ranking: "正在找出表现突出的作品", comparison: "正在核对比较对象与差异",
  quality: "正在检查数据能支持哪些判断", content: "正在梳理作品内容与分析重点", general: "正在梳理问题与分析依据",
};

export const WORKFLOW_GUIDANCE = `Work as a service analyst, not a data-fetch loop.
1. Identify the requested decision, population, measures, time dimension and what evidence would answer it. For substantial tasks, report_progress in ONE natural sentence explains what you are investigating and how it will help; call it alongside the first relevant query, not as an extra planning-only turn.
2. Choose the aggregate that directly answers the question. Time-of-day/weekday/daily distributions -> analyze_time_patterns over ALL requested works and metrics together. Whole-range growth ranking -> rank_growth. Current totals -> get_overview. Current ranking -> rank_works. Group composition -> summarize_groups. Selected comparison -> compare_works. Broad health check only -> get_analysis_brief. Specific data failure -> get_data_quality. Original literary questions -> locate and sample originals. Do not run a standard overview/ranking/quality checklist for every question.
3. Read the result AND its coverage. Before another query, identify an unanswered part or alternative explanation and choose the smallest aggregate that resolves it. Never sample top works to answer a whole-portfolio distribution, infer activity from record counts, or page raw histories to perform an aggregate the application already provides.
4. At a meaningful discovery or change of direction, report_progress with a short public sentence: what the evidence indicates, what remains uncertain, and the next useful action. Do NOT narrate tool names, source IDs, row counts, cache reuse, note compression or request completion. No update per tool. Do not fabricate conclusions or expose private reasoning. Progress is part of serving the user's question, not an execution log.
5. When the requested dimensions are covered, answer. Do not continue collecting merely because more data exists. If evidence is insufficient, explain the specific gap or request the relevant drilldown via request_analysis_tools (state the unresolved question). This is capability discovery, not a budget. Preserve source-linked notes for long investigations and retrieve original evidence when exact detail is needed.`;

export function initialAnalysisTools(all: ToolDefinition[], intent: AnalysisIntent, messages: AgentMessage[]): ToolDefinition[] {
  const latest = messages.filter(message => message.role === "user").at(-1)?.content ?? "";
  const explicitRaw = /原始|明细|逐条|raw|全部.*记录/i.test(latest);
  if (explicitRaw) return all;
  const focused: Partial<Record<AnalysisIntent, string[]>> = {
    temporal: ["analyze_time_patterns", "search_works"],
    ranking: ["rank_works", "rank_growth", "summarize_groups", "search_works"],
    comparison: ["compare_works", "summarize_groups", "rank_growth", "search_works"],
    quality: ["get_data_quality", "get_overview", "search_works"],
  };
  if (focused[intent]) return all.filter(tool => [...focused[intent]!, "report_progress", "record_reading_notes", "retrieve_evidence"].includes(tool.name));
  return all.filter(tool => tool.name !== "get_work_history");
}

export function discoveryTool(all: ToolDefinition[]): ToolDefinition {
  return { name: "request_analysis_tools", description: "Expand analytical capabilities for a concrete unresolved question. Aggregate tools are preferred initially; raw history is available for exact-record inspection, anomalies or export requests. Name the needed tools and explain why existing results cannot answer that question. This grants access for the rest of the analysis; do not request tools already available.",
    parameters: { type: "object", properties: {
      tools: { type: "array", items: { type: "string", enum: all.map(tool => tool.name) }, minItems: 1 },
      question: { type: "string", description: "The specific user-relevant question still unresolved." },
      reason: { type: "string", description: "Why available aggregate evidence is insufficient, and what these tools will verify." },
    }, required: ["tools", "question", "reason"], additionalProperties: false } };
}
