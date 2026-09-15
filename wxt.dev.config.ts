import { defineConfig } from "wxt";
import { baseConfig } from "./wxt.config";

export default defineConfig({
  ...baseConfig,
  // Preserve the local development ID; never include this key in store uploads.
  manifest: {
    ...baseConfig.manifest,
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArbovwgWIWrzTtNVjoRkSUgwC7XZb0CmnrnZjdivAejn1TopaU9odQCIRiokMplE6lWY2qP28RR+aVmKxDVKqVOPFX1w6Bioj37szNNB6T946e4dpcrTS+RQAALf2q1115n0DpCIf+cz9gPlgFxmVpyNQSzqgophKP2NfJ6lIjwcYQelLb50dxll+1puamcVZghmKb4aMu1FZFhoSM5Vll2IY1jntHSRj08z7ARolco8jkFrybxDhZHZiZIrFLJIE1JrOWKksDD0XAdqv1NNg1Kj4WLOePIoheCfoU83eQf56VrCCC5vS7h09OhVyBnXlQjDYRfzvmUtKhS+Dnz77AQIDAQAB",
  },
  outDir: ".extension-dev",
  outDirTemplate: "chrome-mv3",
  webExt: {
    disabled: true,
  },
});
