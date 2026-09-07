import type { DashboardData, WorkRecord } from "../domain/types";
import type { AgentConfig, AgentMessage } from "./types";

export function analysisMode(config: AgentConfig, messages: AgentMessage[]): "content" | "metrics" {
  if (config.analysisFocus !== "auto") return config.analysisFocus;
  const questions = messages.filter(row => row.role === "user").slice(-3).reverse();
  for (const { content } of questions) {
    if (/正文|原文|题材|角色|人物|玩法|叙事|情节|写法|创作建议|内容分析|采样|文风|prose|character|narrative|excerpt/i.test(content)) return "content";
    if (/增长|浏览|收藏|粉丝|指标|数据质量|总数|数量|转化率|统计|followers|metrics|growth|views/i.test(content)) return "metrics";
  }
  return config.sampleOriginals ? "content" : "metrics";
}

export function compactWork(work: WorkRecord, metrics = false) {
  return { key: work.key, title: work.title.slice(0, 160), type: work.contentType ?? work.type,
    series: work.seriesTitle?.slice(0, 80) ?? null, reportedWordCount: work.wordCount,
    ...(metrics ? { views: work.metrics.views, bookmarks: work.metrics.bookmarks, observedAt: work.lastSeenAt } : {}),
  };
}

// Deterministic diversity over metadata, not a claim about a work's actual themes.
export function readingCandidates(data: DashboardData, query: string, limit = 4) {
  const terms = query.trim().toLocaleLowerCase();
  const candidates = data.works.filter(work => work.type === "novel" && (!terms || [work.title, work.id, work.seriesTitle].some(value => value?.toLocaleLowerCase().includes(terms))));
  const byRecency = [...candidates].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.key.localeCompare(b.key));
  const selected: WorkRecord[] = [];
  const groups = new Set<string>();
  const lengths = new Set<number>();
  while (selected.length < limit && selected.length < candidates.length) {
    const ranked = byRecency.filter(work => !selected.includes(work)).map(work => {
      const group = work.seriesTitle || "standalone";
      const length = work.wordCount == null ? -1 : work.wordCount < 3000 ? 0 : work.wordCount < 15000 ? 1 : 2;
      return { work, group, length, score: Number(!groups.has(group)) * 2 + Number(!lengths.has(length)) };
    }).sort((a, b) => b.score - a.score);
    const next = ranked[0]!; selected.push(next.work); groups.add(next.group); lengths.add(next.length);
  }
  return { totalMatches: candidates.length, selected: selected.map(work => compactWork(work)),
    method: "Recent first, then different series/standalone and length bands. Metadata-selected candidates, NOT representative proof. Verify actual document type and themes from excerpts; reported word counts differ from visible character counts." };
}

export function compactStatistics(name: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(row => compactStatistics(name, row));
  const row = value as Record<string, unknown>;
  const { definitions: _definitions, limitations: _limitations, sampleCountMeaning: _meaning, requestedRange: _range, ...rest } = row;
  if (Array.isArray(rest.rows)) rest.rows = rest.rows.map(item => compactStatistics(name, item));
  if (rest.metrics && typeof rest.metrics === "object") {
    delete rest.series; delete rest.publishedAt; delete rest.absentSince; delete rest.likeRate;
  }
  for (const key of ["growth", "followers", "quality", "content"]) if (rest[key]) rest[key] = compactStatistics(name, rest[key]);
  return rest;
}
