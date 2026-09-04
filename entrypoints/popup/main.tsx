import { primeDashboardDataRequest } from "../../src/ui/dashboardDataRequest";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("PixivPulse popup root is missing");

const bootstrapRequest = primeDashboardDataRequest();

void Promise.all([
  import("react"),
  import("react-dom/client"),
  import("../../src/ui/PopupApp"),
]).then(([{ createElement, StrictMode }, { createRoot }, { PopupApp }]) => {
  createRoot(root).render(createElement(StrictMode, null, createElement(PopupApp, { bootstrapRequest })));
});
