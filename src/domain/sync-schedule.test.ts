import { describe, expect, it } from "vitest";
import { isBeijingSyncSlot, nextBeijingSyncSlot } from "./sync-schedule";

const iso = (timestampMs: number | null): string | null => (
  timestampMs == null ? null : new Date(timestampMs).toISOString()
);

describe("Beijing sync schedule", () => {
  it("returns the strictly next slot before midnight and across rollover", () => {
    expect(iso(nextBeijingSyncSlot(Date.parse("2026-08-30T15:45:00.000Z"), 30)))
      .toBe("2026-08-30T16:00:00.000Z");
  });

  it.each([
    ["2026-08-29T16:00:00.000Z", 30, "2026-08-29T16:30:00.000Z"],
    ["2026-08-29T16:30:00.000Z", 30, "2026-08-29T17:00:00.000Z"],
    ["2026-08-29T16:07:00.000Z", 30, "2026-08-29T16:30:00.000Z"],
    ["2026-08-29T09:15:00.000Z", 60, "2026-08-29T10:00:00.000Z"],
    ["2026-08-29T16:01:00.000Z", 1_440, "2026-08-30T16:00:00.000Z"],
  ] as const)("advances strictly from %s at %d minutes", (nowIso, intervalMinutes, expectedIso) => {
    expect(iso(nextBeijingSyncSlot(Date.parse(nowIso), intervalMinutes))).toBe(expectedIso);
  });

  it("recognizes only exact millisecond slots", () => {
    expect(isBeijingSyncSlot(Date.parse("2026-08-29T16:00:00.000Z"), 30)).toBe(true);
    expect(isBeijingSyncSlot(Date.parse("2026-08-29T16:30:00.000Z"), 30)).toBe(true);
    expect(isBeijingSyncSlot(Date.parse("2026-08-29T16:30:00.001Z"), 30)).toBe(false);
    expect(isBeijingSyncSlot(Date.parse("2026-08-29T15:59:59.999Z"), 30)).toBe(false);
    expect(isBeijingSyncSlot(Date.parse("2026-08-29T16:00:00.000Z"), 1_440)).toBe(true);
    expect(isBeijingSyncSlot(Date.parse("2026-08-29T16:01:00.000Z"), 1_440)).toBe(false);
  });

  it.each([0, -30, 7, 1.5, 1_441, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid interval %s",
    (intervalMinutes) => {
      const timestampMs = Date.parse("2026-08-29T16:00:00.000Z");
      expect(nextBeijingSyncSlot(timestampMs, intervalMinutes)).toBeNull();
      expect(isBeijingSyncSlot(timestampMs, intervalMinutes)).toBe(false);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or non-safe timestamp %s",
    (timestampMs) => {
      expect(nextBeijingSyncSlot(timestampMs, 30)).toBeNull();
      expect(isBeijingSyncSlot(timestampMs, 30)).toBe(false);
    },
  );
});
