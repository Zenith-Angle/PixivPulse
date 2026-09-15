import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const root = new URL("../.output/chrome-mv3/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.ok(!Object.hasOwn(manifest, "key"), "Store package must not contain the local development key");
assert.equal(manifest.version, pkg.version, "Store manifest version must match package.json");
assert.equal(manifest.default_locale, "en");
for (const locale of ["en", "zh_CN"]) {
  const messages = JSON.parse(await readFile(new URL(`_locales/${locale}/messages.json`, root), "utf8"));
  for (const value of [manifest.name, manifest.description, manifest.action.default_title]) {
    const key = /^__MSG_(\w+)__$/.exec(value)?.[1];
    assert.ok(key && messages[key]?.message, `Missing ${locale} manifest translation for ${value}`);
  }
}
console.log(`Store build ${manifest.version}: no development key; localized metadata verified.`);
