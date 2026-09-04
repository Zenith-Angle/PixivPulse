import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
