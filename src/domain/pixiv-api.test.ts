import { describe, expect, it } from "vitest";
import {
  collectPixivDashboardPage,
  collectPixivFollowerCount,
  parsePixivFollowerCount,
  parsePixivSelfAccount,
  PixivApiError,
  validatePixivFetchRanges,
} from "./pixiv-api";
import { normalizeWorkContentType } from "./types";

function jsonResponse(value: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("Pixiv API collector", () => {
  it("collects one follower total with a fixed, low-frequency request", async () => {
    const requests: string[] = [];
    const sleeps: number[] = [];
    const initValues: RequestInit[] = [];
    const result = await collectPixivFollowerCount("127955737", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}${url.search}`);
        if (init) initValues.push(init);
        return jsonResponse({ error: false, body: { total: 834, users: [{ id: "must-not-leak" }] } });
      },
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0,
      now: () => Date.parse("2026-08-30T02:00:00.000Z"),
    });

    expect(requests).toEqual(["/ajax/user/127955737/followers?offset=0&limit=24&lang=zh"]);
    expect(sleeps).toEqual([400]);
    expect(initValues).toHaveLength(1);
    expect(initValues[0]).toMatchObject({
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    expect(result).toEqual({
      accountId: "127955737",
      followers: 834,
      collectedAt: "2026-08-30T02:00:00.000Z",
    });
    expect(result).not.toHaveProperty("users");
  });

  it("requires a numeric account id and a safe non-negative follower total", async () => {
    await expect(collectPixivFollowerCount("12/account", {
      fetch: async () => jsonResponse({ error: false, body: { total: 1 } }),
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(parsePixivFollowerCount({ error: false, body: { total: 0, users: [] } })).toBe(0);
    expect(() => parsePixivFollowerCount({ error: false, body: { total: -1 } })).toThrow(PixivApiError);
    expect(() => parsePixivFollowerCount({ error: false, body: { total: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(PixivApiError);
    expect(() => parsePixivFollowerCount({ error: false, body: { data: { total: 1 } } })).toThrow(PixivApiError);
  });

  it("maps only explicit illustration subtypes and keeps unknown values conservative", () => {
    expect(normalizeWorkContentType(0, "illust")).toBe("illustration");
    expect(normalizeWorkContentType(1, "illust")).toBe("manga");
    expect(normalizeWorkContentType(2, "illust")).toBe("ugoira");
    expect(normalizeWorkContentType(9, "illust")).toBe("unknown");
    expect(normalizeWorkContentType(undefined, "illust")).toBe("unknown");
    expect(normalizeWorkContentType(0, "novel")).toBe("novel");
  });

  it("collects self, strategies, ranges, and thumbnail metadata into one page", async () => {
    const requests: string[] = [];
    const initValues: RequestInit[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      if (init) initValues.push(init);
      if (url.pathname === "/ajax/user/self") {
        return jsonResponse({
          error: false,
          userData: { id: "127955737", name: "ZENOVA", profileImg: "https://i.pximg.net/avatar.jpg" },
          token: "must-not-be-read",
        });
      }
      if (url.pathname === "/ajax/dashboard/works/illust/request_strategy") {
        return jsonResponse({ body: { error: false, data: {
          works: [{ workId: "101", workType: "illust", viewCount: 10, bookmarkCount: 3 }],
          fetchRanges: [[0, 2]],
        }, thumbnails: [{ workId: "101", workType: "illust", title: "Illustration", description: "A short caption", createDate: "2026-08-30T01:02:03.000Z", url: "https://i.pximg.net/img.jpg", pageCount: 2, aiType: 1, illustType: 0 }] } });
      }
      if (url.pathname === "/ajax/dashboard/works/novel/request_strategy") {
        return jsonResponse({ body: { error: false, data: {
          works: [{ workId: "202", workType: "novel", title: "Novel from strategy" }],
          fetchRanges: [[0, 1]],
          thumbnails: [{ workId: "202", workType: "novel", title: "Novel title", createDate: "2026-08-29T01:02:03", wordCount: 88 }],
        } } });
      }
      if (url.pathname === "/ajax/dashboard/works/illust") {
        expect(url.search).toBe("?offset=0&limit=2");
        return jsonResponse({ body: { error: false, data: {
          works: [{ workId: "101", workType: "illust", viewCount: 12, ratingCount: 4, bookmarkCount: 5, commentCount: 1, rankingPosition: 6 }],
        } } });
      }
      if (url.pathname === "/ajax/dashboard/works/novel") {
        expect(url.search).toBe("?offset=0&limit=1");
        return jsonResponse({ body: { error: false, data: { works: [{ workId: "202", workType: "novel", viewCount: 7, bookmarkCount: 2 }] } } });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const payload = await collectPixivDashboardPage("run-api", {
      fetch: fetcher,
      sleep: async () => undefined,
      random: () => 0,
      now: () => Date.parse("2026-08-30T02:00:00.000Z"),
    });

    expect(requests).toEqual([
      "/ajax/user/self",
      "/ajax/dashboard/works/illust/request_strategy",
      "/ajax/dashboard/works/novel/request_strategy",
      "/ajax/dashboard/works/illust?offset=0&limit=2",
      "/ajax/dashboard/works/novel?offset=0&limit=1",
    ]);
    expect(initValues.every((init) => init.method === "GET"
      && init.credentials === "include"
      && init.cache === "no-store"
      && init.redirect === "error"
      && new Headers(init.headers).get("accept") === "application/json")).toBe(true);
    expect(payload).toMatchObject({
      runId: "run-api",
      page: 1,
      pageCount: 1,
      hasNext: false,
      positivelyEmpty: false,
      account: { id: "127955737", name: "ZENOVA", profileUrl: "https://www.pixiv.net/users/127955737" },
      quality: { totalCards: 2, validCards: 2 },
    });
    expect(payload.works).toHaveLength(2);
    expect(payload.works[0]).toMatchObject({
      id: "101",
      type: "illust",
      title: "Illustration",
      contentType: "illustration",
      description: "A short caption",
      publishedAt: "2026-08-30T01:02:03.000Z",
      pageCount: 2,
      isAi: true,
      thumbnailUrl: "https://i.pximg.net/img.jpg",
      metrics: { views: 12, likes: 4, bookmarks: 5, comments: 1, rank: 6 },
      rankingStatus: "ranked",
      rankingSource: "api",
    });
    expect(payload.works.find((work) => work.type === "novel")).toMatchObject({
      id: "202",
      title: "Novel title",
      contentType: "novel",
      publishedAt: "2026-08-28T17:02:03.000Z",
      wordCount: 88,
      metrics: { views: 7, bookmarks: 2, rank: null },
      rankingStatus: "unknown",
      rankingSource: null,
    });
    expect(payload.fingerprint).toContain("illust:101");
  });

  it("extracts only the safe self-account fields", () => {
    expect(parsePixivSelfAccount({
      userData: { id: 127955737, name: "ZENOVA", profileImg: "https://i.pximg.net/avatar.jpg" },
      token: "secret",
      accessToken: "secret-too",
    })).toEqual({
      id: "127955737",
      name: "ZENOVA",
      profileUrl: "https://www.pixiv.net/users/127955737",
    });
  });

  it("rejects gaps, overlaps, and duplicate strategy works", async () => {
    expect(() => validatePixivFetchRanges([[0, 2], [3, 1]])).toThrow(PixivApiError);
    expect(() => validatePixivFetchRanges([[0, 2], [1, 1]])).toThrow(PixivApiError);

    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/ajax/user/self") return jsonResponse({ userData: { id: "1", name: "A" } });
      if (path.endsWith("/request_strategy")) {
        return jsonResponse({ body: { data: {
          works: [{ workId: "1", workType: path.includes("illust") ? "illust" : "novel" }, { workId: "1", workType: path.includes("illust") ? "illust" : "novel" }],
          fetchRanges: [],
        } } });
      }
      throw new Error("unexpected request");
    };
    await expect(collectPixivDashboardPage("duplicate", { fetch: fetcher, sleep: async () => undefined })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });

  it.each([
    [401, "application/json", "AUTH_REQUIRED"],
    [403, "text/html", "CHALLENGE"],
    [429, "application/json", "RATE_LIMITED"],
  ] as const)("maps HTTP %s to %s", async (status, contentType, code) => {
    const fetcher = async (): Promise<Response> => new Response("<html>challenge</html>", { status, headers: { "content-type": contentType } });
    await expect(collectPixivDashboardPage("http-error", { fetch: fetcher, sleep: async () => undefined })).rejects.toMatchObject({ code });
  });

  it("fails closed for HTML, envelope errors, timeout, and oversized responses", async () => {
    const htmlFetcher = async (): Promise<Response> => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    await expect(collectPixivDashboardPage("html", { fetch: htmlFetcher, sleep: async () => undefined })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });

    const errorFetcher = async (): Promise<Response> => jsonResponse({ error: true, message: "nope" });
    await expect(collectPixivDashboardPage("envelope", { fetch: errorFetcher, sleep: async () => undefined })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });

    const timeoutFetcher = async (): Promise<Response> => { throw new DOMException("aborted", "AbortError"); };
    await expect(collectPixivDashboardPage("timeout", { fetch: timeoutFetcher, sleep: async () => undefined })).rejects.toMatchObject({ code: "PAGE_TIMEOUT" });

    const oversizedFetcher = async (): Promise<Response> => new Response(JSON.stringify({ userData: { id: "1", name: "A" } }), {
      headers: { "content-type": "application/json", "content-length": "999" },
    });
    await expect(collectPixivDashboardPage("oversized", { fetch: oversizedFetcher, maxResponseBytes: 100, sleep: async () => undefined })).rejects.toMatchObject({ code: "STORAGE_LIMIT" });
  });
});
