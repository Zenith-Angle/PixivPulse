export type Locale = "zh-CN" | "en";
export type LanguagePreference = "auto" | Locale;
export const LANGUAGE_STORAGE_KEY = "pixivPulse.language";

let preference: LanguagePreference = "auto";
// Initialization happens before UI modules load, including their label constants.
let locale: Locale = "zh-CN";

export function resolveLocale(language: string): Locale {
  return /^zh(?:[-_]|$)/i.test(language) ? "zh-CN" : "en";
}

export function normalizePreference(value: unknown): LanguagePreference {
  return value === "zh-CN" || value === "en" ? value : "auto";
}

export function getLocale(): Locale { return locale; }
export function getLanguagePreference(): LanguagePreference { return preference; }

function browserLanguage(): string {
  if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) return chrome.i18n.getUILanguage();
  return typeof navigator !== "undefined" ? navigator.language : "en";
}

export async function initializeLocale({ updateDocument = true }: { updateDocument?: boolean } = {}): Promise<void> {
  let saved: unknown;
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      saved = (await chrome.storage.local.get(LANGUAGE_STORAGE_KEY))[LANGUAGE_STORAGE_KEY];
    } else if (typeof localStorage !== "undefined") {
      saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    }
  } catch { /* A blocked preference store must not prevent opening the UI. */ }
  preference = normalizePreference(saved);
  locale = preference === "auto" ? resolveLocale(browserLanguage()) : preference;
  if (updateDocument && typeof document !== "undefined") document.documentElement.lang = locale;
}

export async function saveLanguagePreference(value: LanguagePreference): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: value });
  } else {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
  }
  preference = value;
}
