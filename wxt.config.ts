import { defineConfig } from "wxt";

export const baseConfig = {
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  manifest: {
    name: "__MSG_extensionName__",
    short_name: "PixivPulse",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    version: "0.5.17",
    minimum_chrome_version: "120",
    permissions: ["storage", "alarms", "unlimitedStorage", "declarativeNetRequestWithHostAccess"],
    host_permissions: ["https://www.pixiv.net/*", "https://i.pximg.net/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: {
      default_title: "__MSG_actionTitle__",
      default_popup: "popup.html"
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png"
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; img-src 'self' blob: https://i.pximg.net data:; connect-src 'self' https: http:"
    }
  },
  vite: () => ({
    build: {
      target: "chrome120"
    }
  })
};

export default defineConfig(baseConfig);
