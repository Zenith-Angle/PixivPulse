import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, initializeLocale, LANGUAGE_STORAGE_KEY, normalizePreference, resolveLocale, saveLanguagePreference, t } from "./index";
import agent from "./agent.en.json";
import dashboard from "./dashboard.en.json";
import secondary from "./secondary.en.json";
import backend from "./backend.en.json";
import common from "./common.en.json";

beforeEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
  await initializeLocale();
});

describe("locale selection and translation", () => {
  it("maps Chinese variants and falls back to English", () => {
    for (const language of ["zh-CN", "zh_TW", "zh-HK", "ZH"]) expect(resolveLocale(language)).toBe("zh-CN");
    for (const language of ["en-US", "ja", "fr"]) expect(resolveLocale(language)).toBe("en");
    expect(normalizePreference("unsupported")).toBe("auto");
  });
  it("preserves Chinese messages and interpolates zero", () => {
    expect(t("共 {count} 件", { count: 0 })).toBe("共 0 件");
    expect(t("未知 {value}")).toBe("未知 {value}");
  });
  it("persists an explicit language and translates authored messages", async () => {
    await saveLanguagePreference("en");
    await initializeLocale();
    expect(getLocale()).toBe("en");
    expect(t("界面语言")).toBe("Interface language");
    expect(t("我的作品《星海》")).toBe("我的作品《星海》");
    expect(t("__proto__")).toBe("__proto__");
  });
  it("reads extension preferences without modifying a host page language", async () => {
    document.documentElement.lang = "ja";
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({ [LANGUAGE_STORAGE_KEY]: "auto" }) } }, i18n: { getUILanguage: () => "en-GB" } });
    await initializeLocale({ updateDocument: false });
    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("ja");
  });
  it("can open when preference storage is unavailable", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => { throw new Error("unavailable"); } } }, i18n: { getUILanguage: () => "zh-CN" } });
    await expect(initializeLocale()).resolves.toBeUndefined();
    expect(getLocale()).toBe("zh-CN");
  });
  it("translates persisted templates while preserving unknown filenames", async () => {
    await saveLanguagePreference("en");
    await initializeLocale();
    expect(t("CSV 备份第 17 行的数据不是有效 JSON")).toBe("CSV backup row 17 does not contain valid JSON.");
    expect(t("备份缺少my-file.json")).toBe("The backup is missing my-file.json.");
    expect(t("unrecognized error: 我的文件.json")).toBe("unrecognized error: 我的文件.json");
  });
  it("has complete, nonempty translations with matching placeholders", () => {
    for (const catalog of [agent, dashboard, secondary, backend, common]) {
      for (const [source, target] of Object.entries(catalog)) {
        expect(target.trim(), source).not.toBe("");
        const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
        expect(placeholders(target), source).toEqual(placeholders(source));
      }
    }
  });
});
