import { expect, it } from "vitest";
import { createDemoData } from "../ui/demoData";
import { DEFAULT_AGENT_CONFIG, type AgentMessage } from "./types";
import { analysisMode, compactStatistics, readingCandidates } from "./strategy";
import { sampleNovelText } from "./novel-sampling";

const message = (content: string): AgentMessage => ({ id: "u", role: "user", content, status: "complete", at: "now", traces: [] });
it("routes content questions and followups without overriding explicit metrics intent", () => {
  expect(analysisMode(DEFAULT_AGENT_CONFIG, [message("比较人物和正文写法，结合收藏率")])).toBe("content");
  expect(analysisMode(DEFAULT_AGENT_CONFIG, [message("分析正文"), message("再详细一点")])).toBe("content");
  expect(analysisMode(DEFAULT_AGENT_CONFIG, [message("分析正文"), message("只看粉丝增长")])).toBe("metrics");
  expect(analysisMode({ ...DEFAULT_AGENT_CONFIG, analysisFocus: "metrics" }, [message("分析正文")])).toBe("metrics");
});
it("selects diverse candidates independently of popularity and does not send descriptions", () => {
  const data = createDemoData(), base = data.works.find(work => work.type === "novel")!;
  data.works = [
    { ...base, key: "a", seriesTitle: "series A", wordCount: 20000, publishedAt: "2026-09-07" },
    { ...base, key: "b", seriesTitle: "series A", wordCount: 20000, publishedAt: "2026-09-06" },
    { ...base, key: "c", seriesTitle: "series B", wordCount: 6000, publishedAt: "2026-09-05" },
    { ...base, key: "d", seriesTitle: null, wordCount: 1000, publishedAt: "2026-09-04", description: "private body" },
  ];
  const result = readingCandidates(data, "", 3);
  expect(result.selected.map(work => work.key)).toEqual(["a", "c", "d"]);
  expect(JSON.stringify(result)).not.toContain("private body");
  expect(readingCandidates(data, "series B").selected.map(work => work.key)).toEqual(["c"]);
  expect(JSON.stringify(data)).toContain("private body");
});
it("compacts redundant metadata while retaining metrics, missing values and measured endpoints", () => {
  const original = { definitions: "repeated", rows: [{ key: "a", metrics: { views: null, bookmarks: 4 }, publishedAt: "old", lastObservedAt: "now", interval: { fromAt: "a", toAt: "b", delta: { views: -5 } } }] };
  expect(compactStatistics("rank_growth", original)).toEqual({ rows: [{ key: "a", metrics: { views: null, bookmarks: 4 }, lastObservedAt: "now", interval: { fromAt: "a", toAt: "b", delta: { views: -5 } } }] });
  expect(original.rows[0]!.publishedAt).toBe("old");
});
it("deep sampling expands useful prose within hard limits and does not return the whole article", () => {
  const text = "长文甲乙".repeat(5000);
  const standard = sampleNovelText(text, "balanced", "");
  const deep = sampleNovelText(text, "balanced", "", { maxChars: 6000, fraction: 0.7 });
  expect(standard.sampledCharacters).toBe(3000);
  expect(deep.sampledCharacters).toBe(6000);
  const short = sampleNovelText("字".repeat(1000), "balanced", "", { maxChars: 6000, fraction: 1 });
  expect(short.coverage).toBeLessThanOrEqual(0.7);
  expect(() => sampleNovelText(text, "balanced", "", { maxChars: NaN, fraction: 0.7 })).toThrow();
});
