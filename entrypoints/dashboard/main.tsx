import { primeDashboardDataRequest } from "../../src/ui/dashboardDataRequest";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("PixivPulse dashboard root is missing");
}

const bootstrapRequest = primeDashboardDataRequest();

void Promise.all([
  import("react"),
  import("react-dom/client"),
  import("./App"),
]).then(([{ createElement, StrictMode }, { createRoot }, { App }]) => {
  createRoot(root).render(createElement(StrictMode, null, createElement(App, { bootstrapRequest })));
});
