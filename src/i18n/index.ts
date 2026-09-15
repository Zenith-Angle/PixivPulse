import agent from "./agent.en.json";
import dashboard from "./dashboard.en.json";
import secondary from "./secondary.en.json";
import common from "./common.en.json";
import backend from "./backend.en.json";
import { getLocale } from "./locale";
export * from "./locale";

const english: Record<string, string> = Object.assign(Object.create(null), backend, common, secondary, dashboard, agent);
// Persisted backend messages predate i18n. Translate only complete known messages,
// never arbitrary substrings of user titles, file names, or provider responses.
const templates = Object.entries(english).filter(([key]) => /\{\w+\}/.test(key)).map(([key, value]) => {
  const names: string[] = [];
  const pattern = key.split(/(\{\w+\})/).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return { pattern: new RegExp(`^${pattern}$`), names, value, specificity: key.length - names.reduce((n, name) => n + name.length + 2, 0) };
}).sort((a, b) => b.specificity - a.specificity);

/** Translate authored UI messages only; never pass user text through this function. */
export function t(message: string, values: Record<string, string | number> = {}): string {
  let translated = message;
  if (getLocale() === "en") {
    translated = english[message] ?? message;
    if (!(message in english) && /[\u3400-\u9fff]/.test(message)) {
      for (const template of templates) {
        const match = template.pattern.exec(message);
        if (!match) continue;
        translated = template.value;
        values = Object.fromEntries(template.names.map((name, index) => [name, english[match[index + 1] ?? ""] ?? match[index + 1] ?? ""]));
        break;
      }
    }
  }
  return translated.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder);
}
