import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createDemoData } from "../ui/demoData";
import { sampleNovelText } from "./novel-sampling";
import * as pageReader from "./novel-page";
import { readNovelSample } from "./novel";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("samples distinct beginning, middle and ending, never whole text, without splitting emoji", () => {
  const text = "甲😀乙丙".repeat(1000);
  const result = sampleNovelText(text, "balanced", "");
  expect(result.sampledCharacters).toBe(1998);
  expect(result.coverage).toBeLessThanOrEqual(0.5);
  expect(result.excerpts).toHaveLength(3);
  expect(result.excerpts[0]!.startCharacter).toBe(0);
  expect(result.excerpts.at(-1)!.endCharacter).toBe(Array.from(text).length);
  expect(result.excerpts.every(row => !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row.text))).toBe(true);
  expect(sampleNovelText("短".repeat(60), "opening", "").sampledCharacters).toBe(30);
});
it("targets an exact keyword and reports absent keywords without inventing a passage", () => {
  const text = "序".repeat(2000) + "目标段落" + "尾".repeat(2000);
  expect(sampleNovelText(text, "keyword", "目标").excerpts[0]!.text).toContain("目标段落");
  expect(sampleNovelText(text, "keyword", "不存在")).toMatchObject({ keywordFound: false, sampledCharacters: 0, excerpts: [] });
});
it("reads a known novel directly without opening tabs and caches only snippets", async () => {
  const data = createDemoData(), work = data.works.find(work => work.type === "novel")!;
  const tabs = { query: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("chrome", { runtime: { id: "test-extension" }, tabs });
  const fetch = vi.spyOn(pageReader, "readNovelDetail").mockResolvedValue(pageReader.sampleNovelDetail({ error: false, body: { id: work.id, title: work.title, content: "正文".repeat(2000) } }, work.id, "balanced", "", { maxChars: 3000, fraction: 0.5 }));
  const args = { workKey: work.key, focus: "balanced", keyword: "", refresh: false };
  const signal = new AbortController().signal;
  await expect(readNovelSample(data, { ...args, workKey: "wrong" }, signal, true)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const first = await readNovelSample(data, args, signal, true);
  expect(first.result).toMatchObject({ transport: "pixiv-web-api", title: work.title });
  expect(first.result.sampledCharacters).toBeLessThan(4000);
  expect((await readNovelSample(data, args, signal, true)).cached).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(tabs.create).not.toHaveBeenCalled(); expect(tabs.remove).not.toHaveBeenCalled();
});
it("does not make a network/page request for a canceled sample", async () => {
  const data = createDemoData();
  const work = data.works.find(work => work.type === "novel")!;
  const abort = new AbortController(); abort.abort();
  await expect(readNovelSample(data, { workKey: work.key, focus: "balanced", keyword: "", refresh: false }, abort.signal, false)).rejects.toThrow();
});
it("reuses an existing page without a network request or disturbing the user's tab", async () => {
  const data = createDemoData(), work = data.works.find(work => work.type === "novel")!;
  const tabs = { query: vi.fn().mockResolvedValue([{ id: 9, url: `https://www.pixiv.net/novel/show.php?id=${work.id}` }]), create: vi.fn(), remove: vi.fn(), sendMessage: vi.fn().mockResolvedValue({ data: sampleNovelText("原文".repeat(1000), "opening", "") }) };
  vi.stubGlobal("chrome", { runtime: { id: "test-extension" }, tabs });
  const fetch = vi.spyOn(pageReader, "readNovelDetail");
  await readNovelSample(data, { workKey: work.key, focus: "opening", keyword: "", refresh: true }, new AbortController().signal, false);
  expect(fetch).not.toHaveBeenCalled(); expect(tabs.create).not.toHaveBeenCalled(); expect(tabs.remove).not.toHaveBeenCalled();
});
