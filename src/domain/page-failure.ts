import type { PagePayload } from "./types";

export type PageFailureCode = "CHALLENGE" | "RATE_LIMITED" | "SCHEMA_DRIFT" | "PAGE_TIMEOUT";

export interface PageFailure {
  code: PageFailureCode;
  message: string;
}

export interface PageFailureSignals {
  text?: string;
  hasWorkCards?: boolean;
  hasChallenge?: boolean;
  hasRateLimit?: boolean;
}

const CHALLENGE_MESSAGE = "Pixiv 出现了验证页面；同步已停止并进入安全冷却";
const RATE_LIMIT_MESSAGE = "Pixiv 提示访问频率受限；同步已停止并进入安全冷却";
const WORK_CARD_SELECTOR = "[data-ga4-entity-id^='illust/'], [data-ga4-entity-id^='novel/']";

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function visibleBodyText(root: Document): string {
  const body = root.body;
  if (!body) return "";
  if (typeof body.innerText === "string") return normalize(body.innerText);
  const clone = body.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("script, style, template, noscript, [hidden], [aria-hidden='true']")) hidden.remove();
  return normalize(clone.textContent);
}

function fromDocument(root: Document): PageFailureSignals {
  // Pixiv's normal bootstrap scripts contain recaptcha keys and a
  // challenge-platform URL. Only user-visible text can identify a text-only
  // challenge page while the React work cards are still mounting.
  const text = visibleBodyText(root);
  const hasWorkCards = Boolean(root.querySelector(WORK_CARD_SELECTOR));
  return {
    text,
    hasWorkCards,
    hasChallenge: Boolean(root.querySelector("iframe[src*='captcha' i], [data-testid*='challenge' i], [data-test-id*='challenge' i], [aria-label*='captcha' i]"))
      || (!hasWorkCards && /(?:captcha|challenge|verify you are human|unusual traffic|人机验证|验证身份)/i.test(text)),
    hasRateLimit: !hasWorkCards && (/(?:too many requests|rate limit|request frequency|请求过于频繁|访问过于频繁|アクセスが集中)/i.test(text)
      || /(?:^|\D)429(?:\D|$)/.test(text)),
  };
}

function classifySignals(signals: PageFailureSignals): PageFailure | null {
  const text = normalize(signals.text);
  const challenge = signals.hasChallenge === true
    || (!signals.hasWorkCards && /(?:captcha|challenge|verify you are human|unusual traffic|人机验证|验证身份)/i.test(text));
  if (challenge) return { code: "CHALLENGE", message: CHALLENGE_MESSAGE };

  const rateLimited = signals.hasRateLimit === true
    || (!signals.hasWorkCards && (/(?:too many requests|rate limit|request frequency|请求过于频繁|访问过于频繁|アクセスが集中)/i.test(text)
      || /(?:^|\D)429(?:\D|$)/.test(text)));
  return rateLimited ? { code: "RATE_LIMITED", message: RATE_LIMIT_MESSAGE } : null;
}

/** This is not authentication. It only stops a read when Pixiv itself shows
 * a challenge or rate-limit response instead of the author's works page. */
export function classifyTransientPageFailure(input: Document | PageFailureSignals): PageFailure | null {
  if (typeof Document !== "undefined" && input instanceof Document) return classifySignals(fromDocument(input));
  return classifySignals(input as PageFailureSignals);
}

export const classifyPageFailure = classifyTransientPageFailure;
export const classifyPixivPageFailure = classifyTransientPageFailure;
export const pageFailure = classifyTransientPageFailure;
export const classifyPageFailureSignals = classifySignals;

export function hasPositivelyIdentifiedEmptyAccount(root: Document, payload?: Pick<PagePayload, "works" | "positivelyEmpty">): boolean {
  if (payload) return payload.works.length === 0 && payload.positivelyEmpty;
  const text = normalize(root.body?.textContent);
  return !root.querySelector(WORK_CARD_SELECTOR)
    && /(?:no works|no submissions|作品がありません|投稿作品はありません|没有作品)/i.test(text);
}
