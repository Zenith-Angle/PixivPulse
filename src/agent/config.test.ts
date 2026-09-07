import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeEndpoint, normalizeBaseUrl, validateConfig, restoreConfig, readingLimits } from "./config";
import { DEFAULT_AGENT_CONFIG } from "./types";

afterEach(() => vi.unstubAllGlobals());
describe("Agent API configuration", () => {
  it("restores older settings without overwriting preferences and resolves all reading modes", () => {
    expect(validateConfig(DEFAULT_AGENT_CONFIG)).toMatchObject({ inputBudget: 0, totalInputBudget: 0, readingDepth: "auto", maxSteps: 0 });
    expect(restoreConfig({ inputBudget: 24000, instructions: "" })).toMatchObject({ inputBudget: 24000, instructions: "", customReadingChars: 4500 });
    for (const [depth, chars, fraction] of [["light",1500,0.3],["standard",3000,0.5],["deep",6000,0.7],["custom",2100,0.4]] as const) {
      expect(readingLimits(validateConfig({ ...DEFAULT_AGENT_CONFIG, readingDepth: depth, customReadingChars: 2100, customReadingPercent: 40 }))).toEqual({ maxChars: chars, fraction });
    }
    expect(validateConfig({ ...DEFAULT_AGENT_CONFIG, readingDepth: "custom", customReadingPercent: 100, customReadingChars: 50000 }).customReadingChars).toBe(50000);
    expect(readingLimits(DEFAULT_AGENT_CONFIG)).toEqual({ maxChars: Number.MAX_SAFE_INTEGER, fraction: 1 });
    expect(validateConfig({ ...DEFAULT_AGENT_CONFIG, inputBudget: 900000, totalInputBudget: 0, contextWindow: 3000000 }).inputBudget).toBe(900000);
    expect(() => validateConfig({ ...DEFAULT_AGENT_CONFIG, customReadingChars: NaN })).toThrow();
  });
  it("normalizes full endpoints without discarding gateway paths", () => {
    expect(normalizeBaseUrl("https://example.com/gateway/v1/chat/completions/")).toBe("https://example.com/gateway/v1");
    expect(normalizeBaseUrl("https://api.deepseek.com/responses")).toBe("https://api.deepseek.com");
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });
  it.each(["http://remote.test/v1", "https://u:secret@example.com/v1", "https://example.com?key=secret", "file:///secret", "javascript:alert(1)"])("rejects unsafe URL %s", (url) => expect(() => normalizeBaseUrl(url)).toThrow());
  it("validates finite integer budgets and output reservation", () => {
    expect(() => validateConfig({ ...DEFAULT_AGENT_CONFIG, contextWindow: NaN })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_AGENT_CONFIG, contextWindow: 8192, maxOutputTokens: 8192 })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_AGENT_CONFIG, model: " " })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_AGENT_CONFIG, temperature: NaN })).toThrow();
  });
  it("requests the configured host only and respects denial", async () => {
    const request = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("chrome", { runtime: { id: "extension" }, permissions: { request } });
    await expect(authorizeEndpoint("https://api.deepseek.com")).rejects.toThrow("未授予");
    expect(request).toHaveBeenCalledWith({ origins: ["https://api.deepseek.com/*"] });
  });
});
