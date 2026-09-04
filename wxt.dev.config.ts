import { defineConfig } from "wxt";
import { baseConfig } from "./wxt.config";

export default defineConfig({
  ...baseConfig,
  outDir: ".extension-dev",
  outDirTemplate: "chrome-mv3",
  webExt: {
    disabled: true,
  },
});
