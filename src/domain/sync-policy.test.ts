import { describe, expect, it } from "vitest";
import { canStartSync, canStartSyncForTrigger, nextAllowedSyncAt, syncPolicyFor } from "./sync-policy";
import { classifyOwnedTabUrl, isPassiveDashboardUrl, makeTabFallbackPlan, randomizedNavigationDelay, shouldNavigateOnRecovery } from "../../entrypoints/background";
import { clearMemoryStateForTests, getSettings, saveSettings, setMemoryStateForTests, SETTINGS_STORAGE_KEY } from "../data/local-state";
import type { AppSettings } from "./types";

const baseSettings: AppSettings = {
  onboardingComplete: true,
  scheduledSyncEnabled: false,
  syncIntervalHours: 24,
  showPixivChips: false,
  theme: "system",
  lastCompactedAt: null,
  storageWarningBytes: 100,
  nextAllowedSyncAt: null,
  nextAllowedSyncReason: null,
};

describe("sync cooldown policy", () => {
  it("sets the requested backoff windows", () => {
    const now = Date.parse("2026-08-30T00:00:00.000Z");
    expect(Date.parse(nextAllowedSyncAt("completed", now)) - now).toBe(15 * 60_000);
    expect(Date.parse(nextAllowedSyncAt("SCHEMA_DRIFT", now)) - now).toBe(5 * 60_000);
    expect(Date.parse(nextAllowedSyncAt("CHALLENGE", now)) - now).toBe(6 * 60 * 60_000);
  });

  it("rejects an immediate retry after a failed terminal outcome", () => {
    const now = Date.parse("2026-08-30T00:00:00.000Z");
    const policy = syncPolicyFor("SCHEMA_DRIFT", now);
    const settings: AppSettings = {
      ...baseSettings,
      nextAllowedSyncAt: policy.nextAllowedSyncAt,
      nextAllowedSyncReason: policy.reason,
    };
    const gate = canStartSync(settings, now + 1);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toBe("transient-failure");
      expect(gate.message).toContain("同步冷却中");
    }
  });

  it("lets manual runs supersede only normal completion/transient cooldowns", () => {
    const now = Date.parse("2026-08-30T00:00:00.000Z");
    for (const outcome of ["completed", "SCHEMA_DRIFT"] as const) {
      const policy = syncPolicyFor(outcome, now);
      expect(canStartSyncForTrigger({ nextAllowedSyncAt: policy.nextAllowedSyncAt, nextAllowedSyncReason: policy.reason }, "manual", now + 1).allowed).toBe(true);
    }
    for (const outcome of ["in-flight", "CHALLENGE", "RATE_LIMITED"] as const) {
      const policy = outcome === "in-flight"
        ? { nextAllowedSyncAt: nextAllowedSyncAt("in-flight", now), reason: "in-flight" as const }
        : syncPolicyFor(outcome, now);
      expect(canStartSyncForTrigger({ nextAllowedSyncAt: policy.nextAllowedSyncAt, nextAllowedSyncReason: policy.reason }, "manual", now + 1).allowed).toBe(false);
    }
  });

  it("lets fixed scheduled slots ignore only a nearby successful manual cooldown", () => {
    const now = Date.parse("2026-08-30T00:00:00.000Z");
    const completed = syncPolicyFor("completed", now);
    expect(canStartSyncForTrigger({
      nextAllowedSyncAt: completed.nextAllowedSyncAt,
      nextAllowedSyncReason: completed.reason,
    }, "scheduled", now + 1).allowed).toBe(true);

    for (const outcome of ["SCHEMA_DRIFT", "CHALLENGE", "RATE_LIMITED"] as const) {
      const policy = syncPolicyFor(outcome, now);
      expect(canStartSyncForTrigger({
        nextAllowedSyncAt: policy.nextAllowedSyncAt,
        nextAllowedSyncReason: policy.reason,
      }, "scheduled", now + 1).allowed).toBe(false);
    }
  });

  it("keeps dashboard URLs visible to the collector and classifies redirects", () => {
    expect(classifyOwnedTabUrl("https://www.pixiv.net/dashboard/works?p=2&pixivPulseRun=run-1")).toBeNull();
    expect(classifyOwnedTabUrl("https://accounts.pixiv.net/login")).toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(classifyOwnedTabUrl("https://www.pixiv.net/users/1")).toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(classifyOwnedTabUrl("http://www.pixiv.net/dashboard/works")).toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(randomizedNavigationDelay(0)).toBe(3_000);
    expect(randomizedNavigationDelay(0.999)).toBeLessThanOrEqual(5_000);
  });

  it("accepts passive snapshots only on the unmarked dashboard route", () => {
    expect(isPassiveDashboardUrl("https://www.pixiv.net/dashboard/works")).toBe(true);
    expect(isPassiveDashboardUrl("https://www.pixiv.net/dashboard/works?p=2")).toBe(true);
    expect(isPassiveDashboardUrl("https://www.pixiv.net/dashboard/works?p=1&pixivPulseRun=run-1")).toBe(false);
    expect(isPassiveDashboardUrl("http://www.pixiv.net/dashboard/works")).toBe(false);
    expect(isPassiveDashboardUrl("https://www.pixiv.net/dashboard/works/other")).toBe(false);
  });

  it("does not reload a worker-owned tab already at its persisted target", () => {
    const target = "https://www.pixiv.net/dashboard/works?p=1&pixivPulseRun=run-1";
    expect(shouldNavigateOnRecovery(target, target)).toBe(false);
    expect(shouldNavigateOnRecovery("https://www.pixiv.net/dashboard/works?p=2&pixivPulseRun=run-1", target)).toBe(true);
  });

  it("plans fallback navigation from a persisted blank tab", () => {
    const target = "https://www.pixiv.net/dashboard/works?p=1&pixivPulseRun=run-1";
    expect(makeTabFallbackPlan(target)).toEqual({
      initialUrl: "about:blank",
      finalUrl: target,
      active: false,
    });
  });

  it("normalizes schedules to the supported low-frequency intervals", async () => {
    clearMemoryStateForTests();
    await saveSettings({ syncIntervalHours: 0.5 });
    expect((await getSettings()).syncIntervalHours).toBe(0.5);
    await saveSettings({ syncIntervalHours: 3 });
    expect((await getSettings()).syncIntervalHours).toBe(1);
  });

  it("migrates a legacy auth cooldown to the transient backstop", async () => {
    clearMemoryStateForTests();
    const at = new Date(Date.now() + 60_000).toISOString();
    await saveSettings({ nextAllowedSyncAt: at, nextAllowedSyncReason: "auth-required" as never });
    expect((await getSettings()).nextAllowedSyncReason).toBe("transient-failure");
  });

  it("discards the one-time challenge cooldown created by the old page classifier", async () => {
    clearMemoryStateForTests();
    setMemoryStateForTests(SETTINGS_STORAGE_KEY, {
      nextAllowedSyncAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      nextAllowedSyncReason: "challenge",
      pageFailureClassifierVersion: 1,
    });
    const migrated = await getSettings();
    expect(migrated.nextAllowedSyncAt).toBeNull();
    expect(migrated.nextAllowedSyncReason).toBeNull();
    expect(migrated.pageFailureClassifierVersion).toBe(2);
  });
});
