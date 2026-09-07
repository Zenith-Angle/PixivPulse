import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "design/icon.png"));
const output = resolve(root, "public/icon");
const publicRoot = resolve(root, "public");
const thirdPartyOutput = resolve(publicRoot, "third-party-licenses");

await mkdir(output, { recursive: true });
await mkdir(thirdPartyOutput, { recursive: true });

await Promise.all(
  [16, 32, 48, 128].map(async (size) => {
    const target = resolve(output, `${size}.png`);
    const next = await sharp(source)
      .resize(size, size)
      .png()
      .toBuffer();
    const current = await readFile(target).catch(() => null);
    if (!current?.equals(next)) await writeFile(target, next);
  }),
);

const licenseCopies = [
  ["node_modules/echarts/LICENSE", "Apache-2.0.txt"],
  ["node_modules/echarts/NOTICE", "ECharts-NOTICE.txt"],
  ["node_modules/zrender/LICENSE", "zrender-BSD-3-Clause.txt"],
  ["node_modules/idb/LICENSE", "idb-ISC.txt"],
  ["node_modules/lucide-react/LICENSE", "lucide-react-ISC.txt"],
  ["node_modules/react/LICENSE", "react-MIT.txt"],
  ["node_modules/react-dom/LICENSE", "react-dom-MIT.txt"],
  ["node_modules/scheduler/LICENSE", "scheduler-MIT.txt"],
];

await Promise.all([
  copyFile(resolve(root, "LICENSE"), resolve(publicRoot, "LICENSE.txt")),
  ...licenseCopies.map(([source, target]) => copyFile(
    resolve(root, source),
    resolve(thirdPartyOutput, target),
  )),
]);

// Include licenses for the Agent's transitive Markdown and protocol runtime too.
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const notices = [];
for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location.startsWith("node_modules/") || metadata.dev) continue;
  const directory = resolve(root, location);
  const entries = await readdir(directory).catch(() => []);
  const licenses = entries.filter((name) => /^(license|licence|copying|notice)(\.|$)/i.test(name));
  if (!licenses.length) continue;
  const pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  const prefix = location.replaceAll(/[\\/]/g, "_");
  for (const name of licenses) await copyFile(resolve(directory, name), resolve(thirdPartyOutput, `${prefix}-${name}`));
  notices.push({ name: pkg.name, version: pkg.version, license: pkg.license, files: licenses.map((name) => `${prefix}-${name}`) });
}
await writeFile(resolve(thirdPartyOutput, "runtime-manifest.json"), JSON.stringify(notices, null, 2));
