import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  }));
  return nestedFiles.flat();
}

async function readReachableJavaScript(entryPath, rootDirectory) {
  const rootPrefix = `${path.resolve(rootDirectory)}${path.sep}`;
  const pending = [path.resolve(entryPath)];
  const sources = new Map();
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || sources.has(filePath)) continue;
    const source = await readFile(filePath, "utf8");
    sources.set(filePath, source);
    for (const match of source.matchAll(/["'`]((?:\/|\.\.?\/|chunks\/)[^"'`]+\.js)["'`]/g)) {
      const reference = match[1];
      const resolved = reference.startsWith("/") || reference.startsWith("chunks/")
        ? path.resolve(rootDirectory, reference.replace(/^\//, ""))
        : path.resolve(path.dirname(filePath), reference);
      if (resolved.startsWith(rootPrefix) && !sources.has(resolved)) pending.push(resolved);
    }
  }
  return [...sources.values()];
}

const installRoot = path.resolve(".extension-dev", "chrome-mv3");
const [popupHtml, manifestText, dashboardHtml, packageText] = await Promise.all([
  readFile(path.join(installRoot, "popup.html"), "utf8"),
  readFile(path.join(installRoot, "manifest.json"), "utf8"),
  readFile(path.join(installRoot, "dashboard.html"), "utf8"),
  readFile(path.resolve("package.json"), "utf8"),
]);

const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(packageText);
const remoteScript = popupHtml.match(/<script\b[^>]*\bsrc=["']https?:\/\//i);
const localhostReference = `${popupHtml}\n${manifestText}`.match(/(?:localhost|127\.0\.0\.1)(?::\d+)?/i);
const localModuleScript = popupHtml.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/(?:chunks\/)?[^"']+\.js["']/i)
  ?? popupHtml.match(/<script\b[^>]*\bsrc=["']\/(?:chunks\/)?[^"']+\.js["'][^>]*\btype=["']module["']/i);

if (remoteScript) throw new Error(`Installed Popup contains a remote script: ${remoteScript[0]}`);
if (localhostReference) throw new Error(`Installed extension depends on ${localhostReference[0]}`);
if (!localModuleScript) throw new Error("Installed Popup does not contain a bundled local module script");
if (manifest.action?.default_popup !== "popup.html") throw new Error("Installed manifest does not point to popup.html");
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error(`Invalid semantic version: ${packageJson.version}`);
if (manifest.version !== packageJson.version) throw new Error(`Manifest version ${manifest.version} does not match package version ${packageJson.version}`);
if (!manifest.optional_host_permissions?.includes("https://*/*") || !manifest.optional_host_permissions?.includes("http://*/*")) throw new Error("Agent optional API origin permissions are missing");
if (manifest.host_permissions?.some((origin) => origin === "<all_urls>" || origin === "https://*/*" || origin === "http://*/*")) throw new Error("Agent API access must remain optional, not automatically granted");

const dashboardScriptPath = dashboardHtml.match(/<script\b[^>]*\bsrc=["'](\/[^"']+\.js)["']/i)?.[1];
if (!dashboardScriptPath) throw new Error("Installed dashboard does not contain a bundled local module script");
const javaScriptPaths = await listJavaScriptFiles(installRoot);
const javaScriptSources = await Promise.all(javaScriptPaths.map((filePath) => readFile(filePath, "utf8")));
const dashboardSources = await readReachableJavaScript(
  path.join(installRoot, dashboardScriptPath.slice(1)),
  installRoot,
);
const bundledVersionLabels = new Set(
  javaScriptSources.flatMap((source) => source.match(/PixivPulse \d+\.\d+\.\d+/g) ?? []),
);
const expectedVersionLabel = `PixivPulse ${packageJson.version}`;
if (!dashboardSources.some((source) => source.includes(expectedVersionLabel))) {
  throw new Error(`Dashboard version label does not match package version ${packageJson.version}`);
}
const staleVersionLabels = [...bundledVersionLabels].filter((label) => label !== expectedVersionLabel);
if (staleVersionLabels.length > 0) {
  throw new Error(`Installed extension contains stale version labels: ${staleVersionLabels.join(", ")}`);
}

// Check hashed JS/CSS dependencies, not just entry scripts and version labels.
for (const source of [...javaScriptSources, dashboardHtml, popupHtml]) {
  for (const match of source.matchAll(/["'`]\/?((?:assets|chunks)\/[^"'`\s]+\.(?:css|js))["'`]/g)) {
    const asset = path.resolve(installRoot, match[1]);
    if (!asset.startsWith(installRoot + path.sep)) throw new Error("Asset path escaped the install root");
    await readFile(asset);
  }
}
const cssFiles = [...dashboardHtml.matchAll(/href=["']\/(assets\/[^"']+\.css)["']/g)].map(match => match[1]);
const initialStyles = await Promise.all(cssFiles.map(file => readFile(path.join(installRoot, file), "utf8")));
if (!initialStyles.some(css => css.includes(".agent-workspace"))) throw new Error("Agent styles must load with the dashboard entry");
if (javaScriptSources.some(source => /assets\/AgentView-[^"'`]+\.css/.test(source))) throw new Error("Agent CSS must not depend on a lazy preload");

console.log(`Installed extension ${packageJson.version} is self-contained, version-aligned, and bundled locally.`);
