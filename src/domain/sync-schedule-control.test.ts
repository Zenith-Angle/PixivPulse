import { describe, expect, it } from "vitest";
import {
  advanceSyncScheduleControl,
  clearPendingSyncSlot,
  hasMatchingOneShotAlarm,
  normalizeSyncScheduleControl,
  pendingScheduledDisposition,
  syncAlarmGeneration,
  type SyncScheduleControl,
} from "../../entrypoints/background";
import { createApiSyncState, reduceSyncState } from "../data/sync-machine";

const slot = (value: string): number => Date.parse(value);

const control = (overrides: Partial<SyncScheduleControl> = {}): SyncScheduleControl => ({
  version: 1,
  generation: "generation-1234",
  intervalMinutes: 30,
  nextAt: slot("2026-09-01T16:30:00.000Z"),
  pendingSlotAt: null,
  ...overrides,
});

describe("durable fixed sync schedule control", () => {
  it("accepts only aligned, generation-qualified state", () => {
    expect(normalizeSyncScheduleControl(control())).toEqual(control());
    expect(normalizeSyncScheduleControl(control({ nextAt: slot("2026-09-01T16:31:00.000Z") }))).toBeNull();
    expect(syncAlarmGeneration("pixiv-pulse-sync:generation-1234")).toBe("generation-1234");
    expect(syncAlarmGeneration("pixiv-pulse-sync")).toBeNull();
  });

  it("advances a delivered slot from wall-clock time and coalesces pending slots", () => {
    const delivered = control({ pendingSlotAt: slot("2026-09-01T16:00:00.000Z") });
    expect(advanceSyncScheduleControl(
      delivered,
      "pixiv-pulse-sync:generation-1234",
      delivered.nextAt,
      slot("2026-09-01T16:31:15.000Z"),
    )).toEqual(control({
      nextAt: slot("2026-09-01T17:00:00.000Z"),
      pendingSlotAt: slot("2026-09-01T16:30:00.000Z"),
    }));
  });

  it("rejects stale generations and duplicate delivered-slot tokens", () => {
    const current = control();
    expect(advanceSyncScheduleControl(current, "pixiv-pulse-sync:old-generation", current.nextAt, current.nextAt)).toBeNull();
    expect(advanceSyncScheduleControl(current, "pixiv-pulse-sync:generation-1234", current.nextAt - 30 * 60_000, current.nextAt)).toBeNull();
  });

  it("preserves an exact one-shot alarm even when its time is already overdue", () => {
    const current = control();
    expect(hasMatchingOneShotAlarm(current, [{
      name: "pixiv-pulse-sync:generation-1234",
      scheduledTime: current.nextAt,
    }])).toBe(true);
    expect(hasMatchingOneShotAlarm(current, [{
      name: "pixiv-pulse-sync:generation-1234",
      scheduledTime: current.nextAt,
      periodInMinutes: 30,
    }])).toBe(false);
    expect(hasMatchingOneShotAlarm(current, [{
      name: "pixiv-pulse-sync:other-generation",
      scheduledTime: current.nextAt,
    }])).toBe(false);
  });

  it("compare-clears only the claimed pending token", () => {
    const newer = control({ pendingSlotAt: slot("2026-09-01T17:00:00.000Z"), nextAt: slot("2026-09-01T17:30:00.000Z") });
    expect(clearPendingSyncSlot(newer, newer.generation, slot("2026-09-01T16:30:00.000Z"))).toBe(newer);
    expect(clearPendingSyncSlot(newer, "different-generation", newer.pendingSlotAt!)).toBe(newer);
    expect(clearPendingSyncSlot(newer, newer.generation, newer.pendingSlotAt!)).toEqual({ ...newer, pendingSlotAt: null });
  });

  it("retains slots behind manual runs but drops slots covered by automatic runs", () => {
    const at = slot("2026-09-01T16:30:00.000Z");
    const manual = createApiSyncState("manual", "manual", at - 1_000);
    const scheduled = createApiSyncState("scheduled", "scheduled", at - 1_000);
    expect(pendingScheduledDisposition(manual, at, at + 1_000)).toBe("retain");
    expect(pendingScheduledDisposition(scheduled, at, at + 1_000)).toBe("drop");
    expect(pendingScheduledDisposition(reduceSyncState(manual, { type: "COMPLETED", now: at + 2_000 }), at, at + 2_000)).toBe("start");
    expect(pendingScheduledDisposition(reduceSyncState(scheduled, { type: "COMPLETED", now: at + 2_000 }), at, at + 2_000)).toBe("drop");
  });
});
