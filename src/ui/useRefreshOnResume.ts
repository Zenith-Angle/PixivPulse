import { useEffect } from "react";

/** Reconcile missed background notifications without requesting a Pixiv sync. */
export function useRefreshOnResume(refresh: () => Promise<void>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const resume = () => {
      if (document.visibilityState === "hidden" || timer !== undefined) return;
      // Switching tabs can deliver focus, pageshow and visibilitychange together.
      timer = window.setTimeout(() => {
        timer = undefined;
        if (document.visibilityState !== "hidden") void refresh();
      }, 80);
    };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [enabled, refresh]);
}
