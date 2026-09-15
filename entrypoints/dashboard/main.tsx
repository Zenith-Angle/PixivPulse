import { initializeLocale } from "../../src/i18n/locale";
import { primeDashboardDataRequest } from "../../src/ui/dashboardDataRequest";
import "./styles.css";
import "../../src/ui/agent.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("PixivPulse dashboard root is missing");
}

const bootstrapRequest = primeDashboardDataRequest();

void initializeLocale().then(() => {
  document.title = document.documentElement.lang === "en" ? "PixivPulse · Creator Growth Tracker" : "PixivPulse · 作者增长追踪";
  return Promise.all([
  import("react"),
  import("react-dom/client"),
  import("./App"),
]);
}).then(([{ createElement, StrictMode }, { createRoot }, { App }]) => {
  createRoot(root).render(createElement(StrictMode, null, createElement(App, { bootstrapRequest })));
});
