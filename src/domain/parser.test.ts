import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getPageFingerprint, parseLocalizedNumber, parsePage } from "./parser";

function fixture(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), "tests", "fixtures", name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("Pixiv dashboard parser", () => {
  it("parses illustration cards and pagination", () => {
    const payload = parsePage(fixture("illustration-dashboard.html"), "run-illustration");
    expect(payload.runId).toBe("run-illustration");
    expect(payload.page).toBe(1);
    expect(payload.pageCount).toBe(2);
    expect(payload.hasNext).toBe(true);
    expect(payload.account).toEqual({
      id: "24680",
      name: "Aurora Author",
      profileUrl: "https://www.pixiv.net/users/24680",
    });
    expect(payload.works).toHaveLength(1);
    expect(payload.works[0]).toMatchObject({
      id: "123456",
      type: "illust",
      contentType: "unknown",
      title: "Aurora Station",
      workUrl: "https://www.pixiv.net/artworks/123456",
      publishedAt: "2026-08-01T12:30:00.000Z",
    });
    expect(payload.works[0]?.metrics).toMatchObject({ likes: 1234, bookmarks: 567, views: 12345, comments: 89, rank: 12 });
    expect(payload.works[0]).toMatchObject({
      rankingStatus: "ranked",
      rankingSource: "page",
    });
    expect(Date.parse(payload.works[0]?.rankingObservedAt ?? "")).not.toBeNaN();
  });

  it("parses novel links, units, and nullable metrics", () => {
    const payload = parsePage(fixture("novel-dashboard.html"), "run-novel");
    const work = payload.works[0];
    expect(work).toBeDefined();
    expect(work).toMatchObject({
      id: "987654",
      type: "novel",
      contentType: "novel",
      title: "The Last Harbor",
      workUrl: "https://www.pixiv.net/novel/show.php?id=987654",
      wordCount: 6789,
      isR18: true,
    });
    expect(work?.metrics.bookmarks).toBe(12000);
    expect(work?.metrics.views).toBe(2345);
    expect(work?.metrics.likes).toBeNull();
    expect(work?.metrics.responses).toBe(7);
    expect(work?.missingFields).toEqual(expect.arrayContaining(["likes", "comments", "rank", "illustrations"]));
  });

  it("extracts an account only from a stable numeric profile link", () => {
    const document = new DOMParser().parseFromString(`
      <a href="/users/not-a-number">ignored</a>
      <a href="/users/13579/works">not canonical</a>
      <a href="/users/13579" aria-label="Updated name">Visible name</a>
    `, "text/html");
    expect(parsePage(document, "account-run").account).toEqual({
      id: "13579",
      name: "Updated name",
      profileUrl: "https://www.pixiv.net/users/13579",
    });
  });

  it("accepts localized number separators", () => {
    expect(parseLocalizedNumber("１，２３４")).toBe(1234);
    expect(parseLocalizedNumber("1 234")).toBe(1234);
    expect(parseLocalizedNumber("1.234")).toBe(1234);
    expect(parseLocalizedNumber("1.2万")).toBe(12000);
    expect(parseLocalizedNumber("2.5K")).toBe(2500);
  });

  it("keeps page fingerprints stable when titles and metrics change", () => {
    const document = fixture("illustration-dashboard.html");
    const first = parsePage(document, "run-a");
    const title = document.querySelector("[data-testid='work-title']");
    const likes = document.querySelector("[data-testid='like-count']");
    if (!title || !likes) throw new Error("fixture hooks missing");
    title.textContent = "Renamed after collection";
    likes.textContent = "9,999,999";
    likes.setAttribute("aria-label", "いいね 9,999,999");
    const second = parsePage(document, "run-b");
    expect(getPageFingerprint(first)).toBe(getPageFingerprint(second));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("parses the current Pixiv card shape where labels and values live on different nodes", () => {
    const payload = parsePage(fixture("live-shape-dashboard.html"), "run-live-shape");
    expect(payload.works).toHaveLength(2);
    expect(payload.works[0]).toMatchObject({
      id: "149033062",
      title: "一瓣春天",
      publishedAt: "2026-08-28T16:00:00.000Z",
      metrics: { likes: 7, bookmarks: 11, views: 76, comments: 0, rank: null, responses: 0, illustrations: 0 },
    });
    expect(payload.works[1]).toMatchObject({
      id: "28984473",
      title: "关于这次长篇连载的一些说明",
      seriesTitle: "流萤·春日手信",
      wordCount: 2108,
      metrics: { likes: 8, bookmarks: 12, views: 166, comments: 1, rank: null, responses: 0 },
      rankingStatus: "unranked",
      rankingSource: "page",
    });
  });

  it("interprets timezone-less Pixiv datetimes as Beijing civil time", () => {
    const document = new DOMParser().parseFromString(`
      <article data-ga4-entity-id="illust/123">
        <a href="/artworks/123">Timezone-less</a>
        <time datetime="2026-08-30T01:02:03.456"></time>
      </article>
    `, "text/html");
    expect(parsePage(document, "timezone-less").works[0]?.publishedAt).toBe("2026-08-29T17:02:03.456Z");
  });

  it("keeps explicit Pixiv offsets as absolute instants", () => {
    const document = new DOMParser().parseFromString(`
      <article data-ga4-entity-id="illust/124">
        <a href="/artworks/124">Offset</a>
        <time datetime="2026-08-30T01:02:03+09:00"></time>
      </article>
    `, "text/html");
    expect(parsePage(document, "offset").works[0]?.publishedAt).toBe("2026-08-29T16:02:03.000Z");
  });

  it("uses only explicit illustration content markers and never infers from page count", () => {
    const document = new DOMParser().parseFromString(`
      <article data-ga4-entity-id="illust/1">
        <a href="/artworks/1">One</a><span data-testid="page-count">20</span>
      </article>
      <article data-ga4-entity-id="illust/2" data-illust-type="1">
        <a href="/artworks/2">Two</a>
      </article>
      <article data-ga4-entity-id="illust/3" data-content-type="ugoira">
        <a href="/artworks/3">Three</a>
      </article>
    `, "text/html");
    const works = parsePage(document, "content-type").works;
    expect(works.map((work) => work.contentType)).toEqual(["unknown", "manga", "ugoira"]);
  });

  it("reads and bounds a description from an existing semantic card hook", () => {
    const document = new DOMParser().parseFromString(`
      <article data-ga4-entity-id="illust/4">
        <a href="/artworks/4">Four</a>
        <p data-testid="work-description">A description\nwith spacing</p>
      </article>
    `, "text/html");
    expect(parsePage(document, "description").works[0]?.description).toBe("A description with spacing");
  });

  it("keeps an ambiguous or missing rank unknown", () => {
    const document = new DOMParser().parseFromString(`
      <article data-ga4-entity-id="illust/5">
        <a href="/artworks/5">Five</a>
        <span data-testid="rank-count">not available</span>
      </article>
      <article data-ga4-entity-id="illust/6">
        <a href="/artworks/6">Six</a>
      </article>
    `, "text/html");
    expect(parsePage(document, "ranking-unknown").works.map((work) => work.rankingStatus)).toEqual(["unknown", "unknown"]);
    expect(parsePage(document, "ranking-unknown").works.every((work) => work.metrics.rank === null
      && work.rankingObservedAt === null && work.rankingSource === null)).toBe(true);
  });
});
