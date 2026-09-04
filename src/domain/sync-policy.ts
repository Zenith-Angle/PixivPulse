import type { AppSettings, SyncErrorCode, SyncPolicyReason } from "./types";

export const SYNC_POLICY_BACKOFF_MS: Record<SyncPolicyReason, number> = {
  "in-flight": 2 * 60_000,
  completed: 15 * 60_000,
  "transient-failure": 5 * 60_000,
  challenge: 6 * 60 * 60 * 1_000,
  "rate-limited": 6 * 60 * 60 * 1_000,
};

export type SyncPolicyOutcome = "in-flight" | "completed" | SyncErrorCode;

export interface SyncPolicyDecision {
  nextAllowedSyncAt: string;
  reason: SyncPolicyReason;
}

export interface SyncGateAllowed {
  allowed: true;
}

export interface SyncGateBlocked {
  allowed: false;
  reason: SyncPolicyReason;
  nextAllowedSyncAt: string;
  message: string;
}

export type SyncGate = SyncGateAllowed | SyncGateBlocked;

export function policyReasonFor(outcome: SyncPolicyOutcome): SyncPolicyReason {
  if (outcome === "in-flight") return "in-flight";
  if (outcome === "completed") return "completed";
  if (outcome === "CHALLENGE") return "challenge";
  if (outcome === "RATE_LIMITED") return "rate-limited";
  return "transient-failure";
}

export function nextAllowedSyncAt(outcome: SyncPolicyOutcome | SyncPolicyReason, now = Date.now()): string {
  const reason = isPolicyReason(outcome) ? outcome : policyReasonFor(outcome);
  return new Date(now + SYNC_POLICY_BACKOFF_MS[reason]).toISOString();
}

export function syncPolicyFor(outcome: SyncPolicyOutcome, now = Date.now()): SyncPolicyDecision {
  const reason = policyReasonFor(outcome);
  return { nextAllowedSyncAt: nextAllowedSyncAt(reason, now), reason };
}

export function policyForOutcome(outcome: SyncPolicyOutcome, now = Date.now()): SyncPolicyDecision {
  return syncPolicyFor(outcome, now);
}

export function isPolicyReason(value: string): value is SyncPolicyReason {
  return value === "in-flight"
    || value === "completed"
    || value === "transient-failure"
    || value === "challenge"
    || value === "rate-limited";
}

function reasonLabel(reason: SyncPolicyReason): string {
  switch (reason) {
    case "completed": return "上次同步已完成";
    case "challenge": return "Pixiv 要求完成验证";
    case "rate-limited": return "Pixiv 请求频率受限";
    case "transient-failure": return "上次同步未完成";
    case "in-flight": return "同步正在进行";
  }
}

function remainingMinutes(value: string, now: number): number {
  const remaining = Math.max(0, Date.parse(value) - now);
  return Math.max(1, Math.ceil(remaining / 60_000));
}

export function syncCooldownMessage(reason: SyncPolicyReason, at: string, now = Date.now()): string {
  if (reason === "in-flight") return "同步正在进行，请稍后再试";
  return `同步冷却中：${reasonLabel(reason)}，约 ${remainingMinutes(at, now)} 分钟后可重试`;
}

export function canStartSync(settings: Pick<AppSettings, "nextAllowedSyncAt" | "nextAllowedSyncReason">, now = Date.now()): SyncGate {
  const at = settings.nextAllowedSyncAt;
  const reason = settings.nextAllowedSyncReason;
  if (!at || !reason || !isPolicyReason(reason)) return { allowed: true };
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp) || timestamp <= now) return { allowed: true };
  return {
    allowed: false,
    reason,
    nextAllowedSyncAt: at,
    message: syncCooldownMessage(reason, at, now),
  };
}

/** Manual runs may explicitly supersede a normal completion/transient cooldown.
 * A fixed scheduled slot may supersede only a normal completion cooldown, so
 * a nearby manual observation cannot move the automatic timetable. Safety
 * backoffs for an active run, failures, challenge, or rate limit always win. */
export function canStartSyncForTrigger(
  settings: Pick<AppSettings, "nextAllowedSyncAt" | "nextAllowedSyncReason">,
  trigger: "manual" | "scheduled" | "recovery",
  now = Date.now(),
): SyncGate {
  const gate = canStartSync(settings, now);
  if (trigger === "manual" && !gate.allowed && (gate.reason === "completed" || gate.reason === "transient-failure")) {
    return { allowed: true };
  }
  if (trigger === "scheduled" && !gate.allowed && gate.reason === "completed") {
    return { allowed: true };
  }
  return gate;
}

export const isSyncCoolingDown = (settings: Pick<AppSettings, "nextAllowedSyncAt" | "nextAllowedSyncReason">, now = Date.now()): boolean => !canStartSync(settings, now).allowed;
