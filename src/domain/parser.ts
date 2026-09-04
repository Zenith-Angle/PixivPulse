import { PARSER_VERSION, PIXIV_WORKS_URL } from "./constants";
import { normalizePixivDateTime } from "./time";
import { normalizeRankingFields, normalizeWorkContentType } from "./types";
import type { PagePayload, ParsedWork, PixivAccount, WorkContentType, WorkMetrics, WorkType } from "./types";

type DomRoot = Document | Element;

const METRIC_ALIASES: Record<keyof WorkMetrics, string[]> = {
  likes: ["like", "likes", "likes-count", "赞", "いいね", "좋아요"],
  bookmarks: ["bookmark", "bookmarks", "收藏", "ブックマーク", "북마크"],
  views: ["view", "views", "閲覧", "浏览", "조회", "pv"],
  comments: ["comment", "comments", "评论", "コメント", "댓글"],
  rank: ["rank", "ranking", "排名", "ランキング", "순위"],
  responses: ["response", "responses", "回复", "返事", "返信"],
  illustrations: ["illustration", "illustrations", "作品数", "作品", "イラスト数"],
};

const METRIC_KEYS = Object.keys(METRIC_ALIASES) as Array<keyof WorkMetrics>;

const METRIC_SELECTORS: Record<keyof WorkMetrics, string[]> = {
  likes: [
    "a[href*='/dashboard/report/artworks'][href*='section=rating']",
    "a[href*='/dashboard/report/novels'][href*='section=rating']",
    "[title*='赞' i]", "[title*='いいね' i]", "[title*='like' i]",
  ],
  bookmarks: [
    "a[href*='bookmark_detail']",
    "[title*='收藏' i]", "[title*='ブックマーク' i]", "[title*='bookmark' i]",
  ],
  views: [
    "button[aria-label*='閲覧数' i]", "button[aria-label*='浏览' i]", "button[aria-label*='view' i]",
    "[title*='浏览' i] button", "[title*='閲覧' i] button", "[title*='view' i] button",
  ],
  comments: [
    "a[href$='#comment']", "[title*='评论' i]", "[title*='コメント' i]", "[title*='comment' i]",
  ],
  rank: [
    "a[href*='/dashboard/report/ranking']", "[title*='排名' i]", "[title*='ランキング' i]", "[title*='rank' i]",
  ],
  responses: [
    "a[href*='/response.php']", "[title*='响应关联作品' i]", "[title*='イメージレスポンス' i]", "[title*='response' i]",
  ],
  illustrations: [
    "a[href*='/quotation.php']", "[title*='添加插图' i]", "[title*='挿絵' i]", "[title*='illustration' i]",
  ],
};

const EMPTY_METRICS: WorkMetrics = {
  likes: null,
  bookmarks: null,
  views: null,
  comments: null,
  rank: null,
  responses: null,
  illustrations: null,
};

const WORK_ID_PATTERN = /(?:illust|novel)\/(\d+)/i;
const ARTWORK_HREF_PATTERN = /\/artworks\/(\d+)/i;
const NOVEL_HREF_PATTERN = /\/novel\/(?:show\.php\?id=)?(\d+)/i;

function asElement(value: Element | null): Element | null {
  return value;
}

function normalizeSpace(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value: string | null | undefined): string {
  return normalizeSpace(value).toLocaleLowerCase();
}

/** Parse Pixiv counts such as `1,234`, `１，２３４`, `1.2万`, and `2.5K`. */
export function parseLocalizedNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const normalized = value.normalize("NFKC").replace(/[\u00a0\u202f\u2009\s'_]/g, "");
  const match = normalized.match(/[-+]?\d[\d,._]*(?:\.\d+)?(?:[万億千]|[kKmMbB])?/);
  if (!match) return null;

  let token = match[0];
  let multiplier = 1;
  const suffix = token.at(-1);
  const hasUnitSuffix = Boolean(suffix && /[万億千kKmMbB]/.test(suffix));
  if (hasUnitSuffix && suffix) {
    token = token.slice(0, -1);
    multiplier =
      suffix === "万" ? 10_000 :
      suffix === "億" ? 100_000_000 :
      suffix === "千" ? 1_000 :
      /k/i.test(suffix) ? 1_000 :
      /m/i.test(suffix) ? 1_000_000 :
      /b/i.test(suffix) ? 1_000_000_000 : 1;
  }

  // Metric values are integer counts. A dot between digit groups is a locale
  // thousands separator; a single dot followed by one or two digits is decimal.
  const commaGroups = token.split(",");
  if (commaGroups.length > 1 && commaGroups.every((part) => /^\d+$/.test(part))) {
    const first = commaGroups[0] ?? "";
    const second = commaGroups[1] ?? "";
    token = commaGroups.length === 2 && second.length < 3
      ? `${first}.${second}`
      : commaGroups.join("");
  } else {
    const dotGroups = token.split(".");
    if (dotGroups.length > 2 && dotGroups.every((part) => /^\d+$/.test(part))) {
      token = dotGroups.join("");
    } else if (dotGroups.length === 2 && (dotGroups[1]?.length ?? 0) === 3 && !hasUnitSuffix && dotGroups.every((part) => /^\d+$/.test(part))) {
      token = dotGroups.join("");
    } else {
      token = token.replace(/,/g, "");
    }
  }

  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed * multiplier));
}

function textOf(element: Element | null): string {
  if (!element) return "";
  const values = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-value"),
    element.getAttribute("data-count"),
    element.textContent,
  ];
  return normalizeSpace(values.find((value) => normalizeSpace(value)));
}

function findFirst(root: Element, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const candidate = root.querySelector(selector);
    if (candidate) return candidate;
  }
  return null;
}

function findSemanticText(root: Element, names: string[]): string | null {
  const selectors = names.flatMap((name) => [
    `[data-testid*="${name}" i]`,
    `[data-test-id*="${name}" i]`,
    `[aria-label*="${name}" i]`,
    `[title*="${name}" i]`,
    `[class*="${name}" i]`,
  ]);
  const direct = findFirst(root, selectors);
  if (direct) return textOf(direct);

  const elements = root.querySelectorAll("*");
  for (const element of elements) {
    const hook = normalizeComparable([
      element.getAttribute("data-testid"),
      element.getAttribute("data-test-id"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("class"),
    ].filter(Boolean).join(" "));
    if (names.some((name) => hook.includes(normalizeComparable(name)))) return textOf(element);
  }
  return null;
}

function closestCard(node: Element): Element {
  const direct = node.closest("article, li, [role='article']");
  if (direct) return direct;

  let current: Element = node;
  for (let depth = 0; depth < 6 && current.parentElement; depth += 1) {
    const parent = current.parentElement;
    const workLinks = parent.querySelectorAll("a[href]");
    if (workLinks.length <= 2 && (parent.querySelector("img, h1, h2, h3, h4, h5, h6") || parent === node.parentElement)) {
      current = parent;
    } else {
      break;
    }
  }
  return current;
}

function parseEntityId(node: Element): { id: string; type: WorkType } | null {
  const raw = node.getAttribute("data-ga4-entity-id") ?? "";
  const match = raw.match(WORK_ID_PATTERN);
  if (!match?.[1]) return null;
  const type = raw.toLocaleLowerCase().startsWith("novel/") ? "novel" : "illust";
  return { id: match[1], type };
}

function parseWorkHref(card: Element, id: string, type: WorkType): string {
  const anchors = card.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const parsed = safeUrl(href);
    const pathname = parsed?.pathname ?? href;
    if ((type === "illust" && ARTWORK_HREF_PATTERN.test(pathname)) || (type === "novel" && NOVEL_HREF_PATTERN.test(`${pathname}${parsed?.search ?? ""}`))) {
      return parsed?.toString() ?? new URL(href, PIXIV_WORKS_URL).toString();
    }
  }
  return `${PIXIV_WORKS_URL.replace("/dashboard/works", type === "novel" ? "/novel/show.php?id=" : "/artworks/")}${id}`;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value, PIXIV_WORKS_URL);
  } catch {
    return null;
  }
}

/** Extract the signed-in account from a canonical profile link, never from
 * arbitrary visible login text or the mutable work-card content. */
export function extractAccount(root: DomRoot): PixivAccount | null {
  let cardAccount: PixivAccount | null = null;
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const url = safeUrl(href);
    if (!url || (url.hostname !== "www.pixiv.net" && url.hostname !== "pixiv.net")) continue;
    const match = url.pathname.match(/^\/users\/(\d+)\/?$/);
    if (!match?.[1]) continue;
    const id = match[1];
    const name = normalizeSpace([
      anchor.getAttribute("aria-label"),
      anchor.getAttribute("title"),
      anchor.textContent,
      anchor.querySelector("img[alt]")?.getAttribute("alt"),
    ].find((value) => normalizeSpace(value)));
    const account = {
      id,
      name,
      profileUrl: `https://www.pixiv.net/users/${id}`,
    };
    if (anchor.closest("[data-ga4-entity-id^='illust/'], [data-ga4-entity-id^='novel/']")) {
      cardAccount ??= account;
      continue;
    }
    return account;
  }
  return cardAccount;
}

function parseTitle(card: Element, type: WorkType, id: string): string {
  for (const anchor of card.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const url = safeUrl(href);
    const target = `${url?.pathname ?? href}${url?.search ?? ""}`;
    const match = type === "illust" ? target.match(ARTWORK_HREF_PATTERN) : target.match(NOVEL_HREF_PATTERN);
    const text = normalizeSpace(anchor.textContent);
    if (match?.[1] === id && text) return text;
  }

  const imageTitle = normalizeSpace(card.querySelector("img[alt]")?.getAttribute("alt"));
  if (imageTitle) return imageTitle;

  const semantic = findSemanticText(card, ["title", "work-title", type === "novel" ? "novel-name" : "illust-name"]);
  if (semantic) {
    const cleaned = semantic.replace(/^(title|作品名|タイトル)\s*[:：]?\s*/i, "").trim();
    if (cleaned && !parseLocalizedNumber(cleaned)) return cleaned;
  }

  const heading = findFirst(card, ["h1", "h2", "h3", "h4", "h5", "h6"]);
  if (heading && normalizeSpace(heading.textContent)) return normalizeSpace(heading.textContent);

  for (const anchor of card.querySelectorAll("a[href]")) {
    const text = normalizeSpace(anchor.textContent);
    if (text && !/^\d[\d,.\s]*$/.test(text) && !/^(?:AI生成|AI-generated|R-18)$/i.test(text)) return text;
  }
  return "";
}

function parseDate(card: Element): string | null {
  const semantic = findFirst(card, [
    "time[datetime]",
    "[data-testid*='date' i]",
    "[data-test-id*='date' i]",
    "[class*='date' i]",
  ]);
  const candidates = [
    semantic?.getAttribute("datetime"),
    semantic ? textOf(semantic) : null,
    ...Array.from(card.querySelectorAll("time")).map((element) => element.getAttribute("datetime") ?? textOf(element)),
    normalizeSpace(card.textContent),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/);
    const normalized = normalizePixivDateTime(candidate)
      ?? (match
        ? normalizePixivDateTime(`${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`)
        : null);
    if (normalized) return normalized;
  }
  return null;
}

function parseSuffixNumber(card: Element, suffixes: string[]): number | null {
  const text = normalizeSpace(card.textContent).normalize("NFKC");
  for (const suffix of suffixes) {
    const match = text.match(new RegExp(`([-+]?\\d[\\d,._，．\\s]*)\\s*${escapeRegExp(suffix)}`, "i"));
    const value = parseLocalizedNumber(match?.[1]);
    if (value != null) return value;
  }
  return null;
}

function parseBoolean(card: Element, names: string[]): boolean | null {
  const hook = findSemanticText(card, names);
  const allText = normalizeComparable(`${hook ?? ""} ${card.textContent ?? ""}`);
  if (names.some((name) => allText.includes(normalizeComparable(name)))) return true;
  return null;
}

function cleanDescription(value: string | null | undefined): string | null {
  const cleaned = normalizeSpace(value);
  return cleaned ? cleaned.slice(0, 2_000) : null;
}

export function parseWorkContentType(card: Element, type: WorkType): WorkContentType {
  if (type === "novel") return "novel";
  const explicit = [
    card.getAttribute("data-illust-type"),
    card.getAttribute("data-illusttype"),
    card.getAttribute("data-content-type"),
    card.getAttribute("data-work-content-type"),
  ];
  for (const value of explicit) {
    const normalized = normalizeWorkContentType(value, type);
    if (normalized !== "unknown") return normalized;
  }
  const hooks = [
    card.getAttribute("aria-label"),
    card.getAttribute("title"),
    card.getAttribute("class"),
    ...Array.from(card.querySelectorAll("[data-testid], [data-test-id], [aria-label], [title]"))
      .flatMap((element) => [
        element.getAttribute("data-testid"),
        element.getAttribute("data-test-id"),
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
      ]),
  ].filter((value): value is string => value != null).join(" ").toLocaleLowerCase();
  if (/ugoira|动图|动画像/.test(hooks)) return "ugoira";
  if (/manga|漫画|マンガ/.test(hooks)) return "manga";
  if (/illustration|illust|插画|イラスト/.test(hooks)) return "illustration";
  return "unknown";
}

function parseDescription(card: Element): string | null {
  const semantic = findFirst(card, [
    "[data-testid*='description' i]",
    "[data-test-id*='description' i]",
    "[data-testid*='caption' i]",
    "[data-test-id*='caption' i]",
    "[data-testid*='简介' i]",
    "[data-test-id*='简介' i]",
    "[data-description]",
    "[data-caption]",
    "[aria-label*='description' i]",
    "[title*='description' i]",
  ]);
  if (!semantic) return null;
  return cleanDescription([
    semantic.textContent,
    semantic.getAttribute("data-description"),
    semantic.getAttribute("data-caption"),
    semantic.getAttribute("data-value"),
    semantic.getAttribute("aria-label"),
    semantic.getAttribute("title"),
  ].find((value) => normalizeSpace(value)));
}

function parseLabeledNumber(card: Element, labels: string[]): number | null {
  const semantic = findSemanticText(card, labels);
  const semanticValue = parseLocalizedNumber(semantic);
  if (semanticValue != null) return semanticValue;

  const text = normalizeSpace(card.textContent);
  for (const label of labels) {
    const expression = new RegExp(`${escapeRegExp(label)}[^\\d０-９]{0,16}([-+]?\\d[\\d,._，．\u00a0\u202f ]*(?:[万億千kKmMbB])?)`, "i");
    const match = text.match(expression);
    const parsed = parseLocalizedNumber(match?.[1]);
    if (parsed != null) return parsed;
  }
  return null;
}

function rankDashOnly(value: string): boolean {
  const normalized = normalizeSpace(value).normalize("NFKC")
    .replace(/rank(?:ing)?/gi, "")
    .replace(/排名|ランキング|순위/gi, "")
    .replace(/[\s:：#]/g, "");
  return /^[-\u2012\u2013\u2014\u2212]+$/.test(normalized);
}

function rankNumber(value: string): number | null {
  const normalized = normalizeSpace(value).normalize("NFKC");
  if (/^[+]?\d[\d,._，．\s]*$/.test(normalized)) return parseLocalizedNumber(normalized);
  const labels = METRIC_ALIASES.rank.map(escapeRegExp).join("|");
  const match = normalized.match(new RegExp(`(?:${labels})[^\\d０-９+\\-\\u2012\\u2013\\u2014\\u2212]{0,16}([+]?\\d[\\d,._，．\\s]*)`, "i"));
  return parseLocalizedNumber(match?.[1]);
}

function parseRanking(card: Element): {
  rank: number | null;
  rankingStatus: "unknown" | "ranked" | "unranked";
  raw: string;
} {
  const candidates: string[] = [];
  for (const selector of METRIC_SELECTORS.rank) {
    const element = card.querySelector(selector);
    if (!element) continue;
    const raw = normalizeSpace([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-value"),
      element.getAttribute("data-count"),
      element.textContent,
    ].filter(Boolean).join(" "));
    if (raw) candidates.push(raw);
  }
  const semantic = findSemanticText(card, METRIC_ALIASES.rank);
  if (semantic) candidates.push(semantic);

  for (const raw of candidates) {
    const rank = rankNumber(raw);
    if (rank != null && rank > 0) return { rank, rankingStatus: "ranked", raw };
  }

  const text = normalizeSpace(card.textContent).normalize("NFKC");
  const labels = METRIC_ALIASES.rank.map(escapeRegExp).join("|");
  const dashMatch = text.match(new RegExp(`(?:${labels})[^\\d０-９-\\u2012\\u2013\\u2014\\u2212]{0,16}[-\\u2012\\u2013\\u2014\\u2212]+(?:\\s|$)`, "i"));
  if (dashMatch?.[0]) return { rank: null, rankingStatus: "unranked", raw: dashMatch[0] };
  for (const raw of candidates) {
    if (rankDashOnly(raw)) return { rank: null, rankingStatus: "unranked", raw };
  }
  return { rank: null, rankingStatus: "unknown", raw: candidates[0] ?? "" };
}

function parseMetrics(card: Element): {
  metrics: WorkMetrics;
  rawLabels: Record<string, string>;
  missingFields: string[];
  rankingStatus: "unknown" | "ranked" | "unranked";
} {
  const metrics: WorkMetrics = { ...EMPTY_METRICS };
  const rawLabels: Record<string, string> = {};
  const missingFields: string[] = [];
  const ranking = parseRanking(card);
  for (const key of METRIC_KEYS) {
    if (key === "rank") {
      metrics.rank = ranking.rank;
      if (ranking.raw) rawLabels.rank = ranking.raw;
      if (ranking.rank == null) missingFields.push(key);
      continue;
    }
    let raw = "";
    let value: number | null = null;
    for (const selector of METRIC_SELECTORS[key]) {
      const element = card.querySelector(selector);
      if (!element) continue;
      raw = normalizeSpace([
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-value"),
        element.getAttribute("data-count"),
        element.textContent,
      ].filter(Boolean).join(" "));
      value = parseLocalizedNumber(raw);
      if (value != null) break;
    }
    if (!raw) raw = findSemanticText(card, METRIC_ALIASES[key]) ?? "";
    value ??= parseLocalizedNumber(raw) ?? parseLabeledNumber(card, METRIC_ALIASES[key]);
    metrics[key] = value;
    if (raw) rawLabels[key] = raw;
    if (value == null) missingFields.push(key);
  }
  return { metrics, rawLabels, missingFields, rankingStatus: ranking.rankingStatus };
}

function parseCard(node: Element, collectedAt: string): ParsedWork | null {
  const entity = parseEntityId(node);
  if (!entity) return null;
  const card = closestCard(node);
  const href = parseWorkHref(card, entity.id, entity.type);
  const title = parseTitle(card, entity.type, entity.id);
  const metricResult = parseMetrics(card);
  const ranking = normalizeRankingFields({
    rank: metricResult.metrics.rank,
    rankingStatus: metricResult.rankingStatus,
    rankingObservedAt: metricResult.rankingStatus === "unknown" ? null : collectedAt,
    rankingSource: metricResult.rankingStatus === "unknown" ? null : "page",
  });
  const missingFields = [...metricResult.missingFields];
  if (!title) missingFields.push("title");

  const thumbnail = card.querySelector("img[src]")?.getAttribute("src") ?? null;
  const work: ParsedWork = {
    id: entity.id,
    type: entity.type,
    contentType: parseWorkContentType(card, entity.type),
    description: parseDescription(card),
    title,
    seriesTitle: normalizeSpace(card.querySelector("a[href*='/novel/series/'], a[href*='/series/']")?.textContent)
      || findSemanticText(card, ["series", "series-title"]) || null,
    publishedAt: parseDate(card),
    wordCount: parseLabeledNumber(card, ["word", "words", "字数", "文字数"])
      ?? parseSuffixNumber(card, ["字", "文字", "words?"]),
    pageCount: parseLabeledNumber(card, ["page", "pages", "ページ"]),
    isAi: parseBoolean(card, ["ai-generated", "ai", "AI生成"]),
    isR18: parseBoolean(card, ["r18", "R-18"]),
    thumbnailUrl: thumbnail ? safeUrl(thumbnail)?.toString() ?? null : null,
    workUrl: href,
    metrics: metricResult.metrics,
    rankingStatus: ranking.rankingStatus,
    rankingObservedAt: ranking.rankingObservedAt,
    rankingSource: ranking.rankingSource,
    rawLabels: metricResult.rawLabels,
    missingFields,
    parserVersion: PARSER_VERSION,
  };
  return work;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePageNumber(root: DomRoot): number {
  const query = (typeof Document !== "undefined" && root instanceof Document)
    ? root.location?.search
    : root.ownerDocument?.location?.search;
  const fromQuery = query ? Number(new URLSearchParams(query).get("p")) : NaN;
  if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery;
  const current = root.querySelector("[aria-current='page'], .is-active, [data-current-page]");
  const fromCurrent = parseLocalizedNumber(textOf(current));
  return fromCurrent && fromCurrent > 0 ? fromCurrent : 1;
}

function parsePageCount(root: DomRoot): number {
  const links = Array.from(root.querySelectorAll("a[href], button, [role='button']"));
  let highest = 1;
  for (const element of links) {
    const href = element.getAttribute("href") ?? "";
    const match = href.match(/[?&]p=(\d+)/i);
    if (match?.[1]) highest = Math.max(highest, Number(match[1]));
    const label = normalizeComparable(`${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`);
    const pageMatch = label.match(/(?:page|ページ|页)\s*(\d+)/i);
    if (pageMatch?.[1]) highest = Math.max(highest, Number(pageMatch[1]));
  }
  const explicit = root.querySelector("[data-page-count], [data-total-pages], [aria-setsize]");
  const explicitCount = parseLocalizedNumber(explicit?.getAttribute("data-page-count") ?? explicit?.getAttribute("data-total-pages") ?? explicit?.getAttribute("aria-setsize"));
  if (explicitCount && explicitCount > highest) highest = explicitCount;
  return highest;
}

function parseHasNext(root: DomRoot, page: number, pageCount: number): boolean {
  const next = root.querySelector("a[rel='next'], button[aria-label*='next' i], [role='button'][aria-label*='next' i]");
  if (next) {
    if (next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true") return false;
    return true;
  }
  return page < pageCount;
}

function positiveEmpty(root: DomRoot): boolean {
  const explicit = root.querySelector([
    "[data-testid*='empty' i]",
    "[data-test-id*='empty' i]",
    "[class*='empty' i]",
    "[aria-label*='no works' i]",
  ].join(","));
  if (explicit) return true;
  const text = normalizeComparable(root.textContent);
  return ["no works", "no submissions", "作品がありません", "投稿作品はありません", "作品はありません", "没有作品"].some((marker) => text.includes(marker));
}

/** Fingerprint only stable work order and pagination identity. */
export function computePageFingerprint(input: {
  workIds: string[];
  page: number;
  pageCount: number;
  hasNext: boolean;
}): string {
  return JSON.stringify({
    page: input.page,
    pageCount: input.pageCount,
    hasNext: input.hasNext,
    workIds: [...input.workIds],
  });
}

export function getPageFingerprint(payload: Pick<PagePayload, "page" | "pageCount" | "hasNext" | "works">): string {
  return computePageFingerprint({
    page: payload.page,
    pageCount: payload.pageCount,
    hasNext: payload.hasNext,
    workIds: payload.works.map((work) => `${work.type}:${work.id}`),
  });
}

export function parsePage(root: DomRoot, runId = ""): PagePayload {
  const nodes = Array.from(root.querySelectorAll("[data-ga4-entity-id^='illust/'], [data-ga4-entity-id^='novel/']"));
  const collectedAt = new Date().toISOString();
  const works: ParsedWork[] = [];
  const seen = new Set<string>();
  let missingRequired = 0;
  let missingMetricFields = 0;
  for (const node of nodes) {
    const work = parseCard(node, collectedAt);
    const entity = parseEntityId(node);
    if (!work || !entity) {
      missingRequired += 1;
      continue;
    }
    const key = `${work.type}:${work.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    works.push(work);
    missingMetricFields += work.missingFields.filter((field) => METRIC_KEYS.includes(field as keyof WorkMetrics)).length;
    if (!work.title || !work.workUrl) missingRequired += 1;
  }

  const page = parsePageNumber(root);
  const pageCount = Math.max(page, parsePageCount(root));
  const hasNext = parseHasNext(root, page, pageCount);
  const payload: PagePayload = {
    runId,
    page,
    pageCount,
    hasNext,
    positivelyEmpty: works.length === 0 && positiveEmpty(root),
    fingerprint: "",
    works,
    account: extractAccount(root),
    parserVersion: PARSER_VERSION,
    collectedAt,
    quality: {
      totalCards: nodes.length,
      validCards: works.length,
      missingRequired,
      missingMetricFields,
    },
  };
  payload.fingerprint = getPageFingerprint(payload);
  return payload;
}

export const parseDashboardPage = parsePage;
export const parsePixivDashboard = parsePage;
export const parseDashboardWorks = parsePage;
export const fingerprintPage = getPageFingerprint;
