export type SamplingFocus = "balanced" | "opening" | "middle" | "ending" | "keyword";
export const SAMPLING_FOCI = ["balanced", "opening", "middle", "ending", "keyword"] as const;

export interface ReadingLimits { maxChars: number; fraction: number }
export const DEFAULT_READING_LIMITS: ReadingLimits = { maxChars: 3000, fraction: 0.5 };

export function sampleNovelText(text: string, focus: SamplingFocus, keyword: string, limits: ReadingLimits = DEFAULT_READING_LIMITS) {
  text = text.replace(/\r\n?/g, "\n").trim();
  const chars = Array.from(text);
  if (chars.length < 30) throw new Error("可见原文过短，无法形成可靠采样。");
  // Limits come from the application budget, never from text inside the page.
  const maxChars = Math.max(30, Math.min(6000, Math.floor(limits.maxChars)));
  const fraction = Math.max(0.1, Math.min(0.7, limits.fraction));
  if (!Number.isFinite(maxChars) || !Number.isFinite(fraction)) throw new Error("Invalid reading budget");
  const totalBudget = Math.min(maxChars, Math.floor(chars.length * fraction));
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
