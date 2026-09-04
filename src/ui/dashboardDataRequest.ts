import type { RuntimeMessage, RuntimeResponse } from "../domain/messages";

export type DashboardDataRequest = Promise<RuntimeResponse | null>;

const hasRuntime = (): boolean =>
  typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";

export async function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse | null> {
  if (!hasRuntime()) return null;
  try {
    return await chrome.runtime.sendMessage(message) as RuntimeResponse;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "扩展后台暂时不可用" };
  }
}

export function primeDashboardDataRequest(): DashboardDataRequest | null {
  return hasRuntime() ? sendRuntimeMessage({ type: "GET_DASHBOARD_DATA" }) : null;
}
