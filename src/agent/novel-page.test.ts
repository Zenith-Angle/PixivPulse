import { afterEach, expect, it, vi } from "vitest";
import { sampleNovelDetail } from "./novel-page";
const limits = { maxChars: 3000, fraction: 0.5 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("honors Retry-After and blocks follow-up network calls after rate limiting", async () => {
  vi.resetModules();
  const { readNovelDetail } = await import("./novel-page");
  vi.stubGlobal("chrome", {});
  const fetch = vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "1800" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(readNovelDetail("12", "balanced", "", limits, new AbortController().signal)).rejects.toThrow("429");
  await expect(readNovelDetail("13", "balanced", "", limits, new AbortController().signal)).rejects.toThrow("30 分钟");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("serializes reads with spacing and sends only a credentialed GET", async () => {
  vi.resetModules(); vi.useFakeTimers();
  const { readNovelDetail } = await import("./novel-page");
  vi.stubGlobal("chrome", {});
  const fetch = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify({ error: false, body: { id: url.split("/").at(-1), title: "示例", content: "正文".repeat(100) } }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await readNovelDetail("12", "balanced", "", limits, signal);
  const progress = vi.fn();
  const second = readNovelDetail("13", "balanced", "", limits, signal, progress);
  await vi.advanceTimersByTimeAsync(4999); expect(fetch).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith("等待请求间隔，约 5 秒");
  await vi.advanceTimersByTimeAsync(1); await second;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "include", redirect: "error" });
});

it("uses the novel detail content field with validated identity and bounded sampling", async () => {
  vi.resetModules(); const { readNovelDetail } = await import("./novel-page");
  vi.stubGlobal("chrome", {});
  const payload = { error: false, body: { id: "12", title: "示例作品", content: "正文".repeat(2000), seriesNavData: { title: "示例系列" } } };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
  const result = await readNovelDetail("12", "balanced", "", limits, new AbortController().signal);
  expect(fetch).toHaveBeenCalledWith("https://www.pixiv.net/ajax/novel/12", expect.objectContaining({ credentials: "include", method: "GET", headers: { Accept: "application/json" } }));
  expect(result).toMatchObject({ transport: "pixiv-web-api", title: "示例作品", seriesTitle: "示例系列", totalCharacters: 4000 });
  expect(result.coverage).toBeLessThanOrEqual(0.5);
  expect(() => sampleNovelDetail(payload, "13", "balanced", "", limits)).toThrow("ID");
  expect(() => sampleNovelDetail({ error: false, body: { id: "12" } }, "12", "balanced", "", limits)).toThrow("content");
  expect(() => sampleNovelDetail({ error: true, body: payload.body }, "12", "balanced", "", limits)).toThrow("有效正文");
});
