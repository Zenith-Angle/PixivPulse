import { defineConfig } from "wxt";

export const baseConfig = {
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  manifest: {
    name: "PixivPulse - 作者增长追踪",
    short_name: "PixivPulse",
    description: "记录 Pixiv 全部作品的增长快照，在本地生成趋势、转化率与自动洞察。",
    version: "0.4.18",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArbovwgWIWrzTtNVjoRkSUgwC7XZb0CmnrnZjdivAejn1TopaU9odQCIRiokMplE6lWY2qP28RR+aVmKxDVKqVOPFX1w6Bioj37szNNB6T946e4dpcrTS+RQAALf2q1115n0DpCIf+cz9gPlgFxmVpyNQSzqgophKP2NfJ6lIjwcYQelLb50dxll+1puamcVZghmKb4aMu1FZFhoSM5Vll2IY1jntHSRj08z7ARolco8jkFrybxDhZHZiZIrFLJIE1JrOWKksDD0XAdqv1NNg1Kj4WLOePIoheCfoU83eQf56VrCCC5vS7h09OhVyBnXlQjDYRfzvmUtKhS+Dnz77AQIDAQAB",
    minimum_chrome_version: "120",
    permissions: ["storage", "alarms", "unlimitedStorage", "declarativeNetRequestWithHostAccess"],
    host_permissions: ["https://www.pixiv.net/*", "https://i.pximg.net/*"],
    action: {
      default_title: "打开 PixivPulse 面板",
      default_popup: "popup.html"
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png"
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; img-src 'self' blob: https://i.pximg.net data:; connect-src 'self' https://www.pixiv.net https://i.pximg.net"
    }
  },
  vite: () => ({
    build: {
      target: "chrome120"
    }
  })
};

export default defineConfig(baseConfig);
