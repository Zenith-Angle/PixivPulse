export type SamplingFocus = "balanced" | "opening" | "middle" | "ending" | "keyword";
export const SAMPLING_FOCI = ["balanced", "opening", "middle", "ending", "keyword"] as const;

export interface ReadingLimits { maxChars: number; fraction: number; exclude?: { startCharacter: number; endCharacter: number }[] }
export const DEFAULT_READING_LIMITS: ReadingLimits = { maxChars: 3000, fraction: 0.5 };

export function sampleNovelText(text: string, focus: SamplingFocus, keyword: string, limits: ReadingLimits = DEFAULT_READING_LIMITS) {
  text = text.replace(/\r\n?/g, "\n").trim();
  const chars = Array.from(text);
  if (chars.length < 30) throw new Error("可见原文过短，无法形成可靠采样。");
  // Limits come from the application budget, never from text inside the page.
  if (!Number.isSafeInteger(limits.maxChars) || limits.maxChars < 30 || !Number.isFinite(limits.fraction) || limits.fraction <= 0 || limits.fraction > 1) throw new Error("Invalid reading budget");
  const maxChars = Math.min(chars.length, limits.maxChars);
  const fraction = limits.fraction;
  const totalBudget = Math.min(maxChars, Math.floor(chars.length * fraction));
  if (limits.exclude?.length) {
    if (limits.exclude.some(r => !Number.isSafeInteger(r.startCharacter) || !Number.isSafeInteger(r.endCharacter) || r.startCharacter < 0 || r.endCharacter <= r.startCharacter || r.endCharacter > chars.length)) throw new Error("Invalid previous reading positions");
    let gaps = [{ startCharacter: 0, endCharacter: chars.length }];
    for (const used of limits.exclude) gaps = gaps.flatMap(gap => {
      if (used.endCharacter <= gap.startCharacter || used.startCharacter >= gap.endCharacter) return [gap];
      return [{ startCharacter: gap.startCharacter, endCharacter: Math.min(gap.endCharacter, used.startCharacter) }, { startCharacter: Math.max(gap.startCharacter, used.endCharacter), endCharacter: gap.endCharacter }].filter(r => r.endCharacter > r.startCharacter);
    });
    const keywordIndex = focus === "keyword" ? text.indexOf(keyword) : -1;
    if (focus === "keyword" && (!keyword || keywordIndex < 0)) return { totalCharacters: chars.length, sampledCharacters: 0, coverage: 0, excerpts: [], keywordFound: false };
    const target = focus === "keyword" ? Array.from(text.slice(0, keywordIndex)).length : focus === "ending" ? chars.length : focus === "middle" ? Math.floor(chars.length / 2) : 0;
    if (focus !== "balanced") gaps.sort((a, b) => Math.max(a.startCharacter - target, target - a.endCharacter, 0) - Math.max(b.startCharacter - target, target - b.endCharacter, 0));
    let left = totalBudget;
    const excerpts = gaps.flatMap(gap => {
      const width = Math.min(left, gap.endCharacter - gap.startCharacter);
      if (!width) return [];
      const start = focus === "balanced" ? gap.startCharacter : Math.max(gap.startCharacter, Math.min(gap.endCharacter - width, target - Math.floor(width / 2)));
      left -= width;
      return [{ startCharacter: start, endCharacter: start + width, position: Number((start / chars.length).toFixed(3)), text: chars.slice(start, start + width).join("") }];
    });
    return { totalCharacters: chars.length, sampledCharacters: totalBudget - left, coverage: (totalBudget - left) / chars.length, excerpts };
  }
  const width = focus === "balanced" ? Math.floor(totalBudget / 3) : totalBudget;
  let centers: number[];
  if (focus === "keyword") {
    const index = text.indexOf(keyword);
    if (!keyword || index < 0) return { totalCharacters: chars.length, sampledCharacters: 0, coverage: 0, excerpts: [], keywordFound: false };
    centers = [Array.from(text.slice(0, index)).length];
  } else centers = focus === "balanced" ? [0, Math.floor(chars.length / 2), chars.length] : [focus === "opening" ? 0 : focus === "middle" ? Math.floor(chars.length / 2) : chars.length];
  const excerpts = centers.map(center => {
    const start = Math.max(0, Math.min(chars.length - width, center - Math.floor(width / 2)));
    return { startCharacter: start, endCharacter: start + width, position: Number((start / chars.length).toFixed(3)), text: chars.slice(start, start + width).join("") };
  });
  const sampledCharacters = excerpts.reduce((n, excerpt) => n + excerpt.endCharacter - excerpt.startCharacter, 0);
  return { totalCharacters: chars.length, sampledCharacters, coverage: sampledCharacters / chars.length, excerpts };
}
