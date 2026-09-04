import { describe, expect, it } from "vitest";
import {
  BUSINESS_TIME_ZONE,
  BUSINESS_TIME_ZONE_LABEL,
  beijingDateKey,
  beijingDayEndIso,
  beijingDayRange,
  beijingExportDate,
  formatBeijingTimestamp,
  nextBeijingMidnight,
  normalizePixivDateTime,
  parseInstant,
} from "./time";

describe("business time", () => {
  it("exposes the fixed Beijing business timezone", () => {
    expect(BUSINESS_TIME_ZONE).toBe("Asia/Shanghai");
    expect(BUSINESS_TIME_ZONE_LABEL).toBe("北京时间（UTC+8）");
  });

  it("parses valid instants and fails closed for invalid values", () => {
    const instant = "2026-08-30T01:02:03.456Z";
    expect(parseInstant(instant)).toBe(Date.parse(instant));
    expect(parseInstant(new Date(instant))).toBe(Date.parse(instant));
    expect(parseInstant(Date.parse(instant))).toBe(Date.parse(instant));
    expect(parseInstant(new Date("invalid"))).toBeNull();
    expect(parseInstant(Number.NaN)).toBeNull();
    expect(parseInstant("not a timestamp")).toBeNull();
    expect(parseInstant(null)).toBeNull();
  });

  it("normalizes Pixiv date entries without depending on the host timezone", () => {
    expect(normalizePixivDateTime("2026-08-30")).toBe("2026-08-29T16:00:00.000Z");
    expect(normalizePixivDateTime("2026-08-30T01:02:03")).toBe("2026-08-29T17:02:03.000Z");
    expect(normalizePixivDateTime("2026-08-30T01:02:03.456")).toBe("2026-08-29T17:02:03.456Z");
    expect(normalizePixivDateTime("2026-08-30 01:02:03")).toBe("2026-08-29T17:02:03.000Z");
    expect(normalizePixivDateTime("2026-08-30T01:02:03+09:00")).toBe("2026-08-29T16:02:03.000Z");
    expect(normalizePixivDateTime("2026-08-30T01:02:03.456Z")).toBe("2026-08-30T01:02:03.456Z");
  });

  it("rejects malformed and impossible Pixiv dates", () => {
    expect(normalizePixivDateTime("2026-02-29")).toBeNull();
    expect(normalizePixivDateTime("2026-02-30T01:02:03Z")).toBeNull();
    expect(normalizePixivDateTime("2026-08-30T24:00:00")).toBeNull();
    expect(normalizePixivDateTime("2026-08-30T01:02:03+24:00")).toBeNull();
    expect(normalizePixivDateTime("2026-08-30T01:02:03Z trailing")).toBeNull();
    expect(normalizePixivDateTime(undefined)).toBeNull();
  });

  it("uses Beijing midnight boundaries while keeping UTC milliseconds", () => {
    const before = beijingDayRange("2026-08-29");
    expect(before).toEqual({
      date: "2026-08-29",
      startMs: Date.parse("2026-08-28T16:00:00.000Z"),
      endMs: Date.parse("2026-08-29T16:00:00.000Z"),
    });
    expect(beijingDateKey("2026-08-29T15:59:59.999Z")).toBe("2026-08-29");
    expect(beijingDateKey("2026-08-29T16:00:00.000Z")).toBe("2026-08-30");
    expect(beijingDayEndIso("2026-08-29")).toBe("2026-08-29T15:59:59.999Z");
    expect(nextBeijingMidnight("2026-08-29T16:00:00.000Z")).toBe(Date.parse("2026-08-30T16:00:00.000Z"));
    expect(beijingDayRange("2026-02-30")).toBeNull();
    expect(beijingDayEndIso("bad-date")).toBeNull();
    expect(nextBeijingMidnight("not a timestamp")).toBeNull();
    expect(nextBeijingMidnight(undefined)).toBeNull();
  });

  it("formats display and export dates in Beijing", () => {
    expect(formatBeijingTimestamp("2026-08-29T16:02:03.000Z")).toBe("8/30 00:02");
    expect(beijingExportDate("2026-08-29T16:02:03.000Z")).toBe("2026-08-30");
    expect(formatBeijingTimestamp(null)).toBeNull();
    expect(beijingExportDate("invalid")).toBeNull();
  });
});
