import { describe, expect, it } from "vitest";
import { classifyPageFailure, classifyTransientPageFailure } from "./page-failure";

function documentFrom(body: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, "text/html");
}

describe("Pixiv page failure classification", () => {
  it("does not classify an authenticated dashboard with logout text as auth failure", () => {
    const cards = Array.from({ length: 33 }, (_, index) =>
      `<article data-ga4-entity-id="illust/${index + 1}"><h2>Work ${index + 1}</h2></article>`,
    ).join("");
    const document = documentFrom(`
      <nav><a href="/dashboard/works">作品管理</a><button>退出登录</button></nav>
      ${cards}
      <a href="/login">Login help</a>
    `);
    expect(classifyPageFailure(document)).toBeNull();
  });

  it("ignores login and logout text because Pixiv owns the browser session", () => {
    const document = documentFrom(`<form action="/login"><input type="password"></form><button>退出登录</button><a href="/login">登录帮助</a>`);
    expect(classifyPageFailure(document)).toBeNull();
  });

  it("does not treat work titles as challenge or rate-limit pages", () => {
    const document = documentFrom(`
      <article data-ga4-entity-id="novel/9"><h2>429 次人机验证之后</h2></article>
    `);
    expect(classifyPageFailure(document)).toBeNull();
  });

  it("ignores Pixiv bootstrap scripts that mention captcha before work cards mount", () => {
    const document = documentFrom(`
      <nav><a href="/dashboard/works">作品管理</a></nav>
      <script>
        window.__PIXIV_CONTEXT__ = { grecaptcha: { siteKey: "public-key" } };
        var src = "/cdn-cgi/challenge-platform/scripts/precursor/main.js";
      </script>
      <main aria-busy="true">正在读取作品</main>
    `);
    expect(classifyPageFailure(document)).toBeNull();
  });

  it("gives challenge precedence over rate limiting", () => {
    expect(classifyPageFailure({ hasChallenge: true, hasRateLimit: true })?.code).toBe("CHALLENGE");
    expect(classifyPageFailure({ hasRateLimit: true })?.code).toBe("RATE_LIMITED");
    expect(classifyPageFailure({ text: "captcha page" })?.code).toBe("CHALLENGE");
  });

  it("keeps authentication out of active readiness while preserving transient failures", () => {
    const document = documentFrom(`<article data-ga4-entity-id="illust/1">Work</article><button>退出登录</button>`);
    expect(classifyTransientPageFailure(document)).toBeNull();
    const challenged = documentFrom(`<div data-testid="challenge">captcha</div>`);
    expect(classifyTransientPageFailure(challenged)?.code).toBe("CHALLENGE");
  });
});
