import { describe, expect, it } from "vitest";
import {
  filterChartTimePoints,
  filterTimestamped,
  isInChartTimeRange,
  resolveChartTimeRange,
} from "./chartTimeRange";

const utc = (value: string): string => new Date(value).toISOString();

describe("chart time ranges", () => {
  it("resolves the default rolling 24-hour window independently of the Beijing day", () => {
    expect(resolveChartTimeRange({ preset: "24h", now: "2026-08-31T01:00:00+08:00" })).toEqual({
      preset: "24h",
      startMs: Date.parse("2026-08-29T17:00:00.000Z"),
      endMs: Date.parse("2026-08-30T17:00:00.000Z"),
    });
  });
  it("defaults to the current Beijing day and stops at the injected now", () => {
    const range = resolveChartTimeRange({ now: "2026-08-30T12:34:00+08:00" });
    expect(range).toEqual({
      preset: "today",
      startMs: Date.parse("2026-08-29T16:00:00.000Z"),
      endMs: Date.parse("2026-08-30T04:34:00.000Z"),
    });

    const points = [
      { at: utc("2026-08-29T15:59:59.999Z"), value: 1 },
      { at: utc("2026-08-29T16:00:00.000Z"), value: 2 },
      { at: utc("2026-08-30T04:34:00.000Z"), value: 3 },
      { at: utc("2026-08-30T04:34:00.001Z"), value: 4 },
    ];
    expect(filterChartTimePoints(points, { now: "2026-08-30T12:34:00+08:00" }).map((point) => point.value)).toEqual([2, 3]);
  });

  it("leaves all valid timestamped values available for the all preset", () => {
    const points = [
      { at: utc("2020-01-01T00:00:00.000Z"), value: 1 },
      { at: utc("2030-01-01T00:00:00.000Z"), value: 2 },
    ];
    expect(filterChartTimePoints(points, { preset: "all" })).toEqual(points);
    expect(resolveChartTimeRange({ preset: "all" })).toEqual({ preset: "all", startMs: null, endMs: null });
  });

  it.each([
    ["3d", "2026-08-27T16:00:00.000Z"],
    ["7d", "2026-08-23T16:00:00.000Z"],
    ["30d", "2026-07-31T16:00:00.000Z"],
    ["3m", "2026-06-01T16:00:00.000Z"],
  ] as const)("resolves the %s shortcut from Beijing midnight", (preset, expectedStart) => {
    expect(resolveChartTimeRange({ preset, now: "2026-08-30T12:34:00+08:00" })).toEqual({
      preset,
      startMs: Date.parse(expectedStart),
      endMs: Date.parse("2026-08-30T04:34:00.000Z"),
    });
  });

  it("includes a custom end date through the final Beijing millisecond", () => {
    const range = resolveChartTimeRange({
      preset: "custom",
      start: "2026-08-29",
      end: "2026-08-30",
    });
    expect(range).toEqual({
      preset: "custom",
      startMs: Date.parse("2026-08-28T16:00:00.000Z"),
      endMs: Date.parse("2026-08-30T15:59:59.999Z"),
    });

    const points = [
      { at: utc("2026-08-30T15:59:59.999Z"), value: 1 },
      { at: utc("2026-08-30T16:00:00.000Z"), value: 2 },
    ];
    expect(filterChartTimePoints(points, range ?? { preset: "all" }).map((point) => point.value)).toEqual([1]);
  });

  it("includes the whole minute when a custom datetime end has minute precision", () => {
    const range = resolveChartTimeRange({
      preset: "custom",
      start: "2026-08-30T15:29",
      end: "2026-08-30T15:30",
    });
    expect(range).toEqual({
      preset: "custom",
      startMs: Date.parse("2026-08-30T07:29:00.000Z"),
      endMs: Date.parse("2026-08-30T07:30:59.999Z"),
    });

    const points = [
      { at: utc("2026-08-30T07:29:00.000Z"), value: 1 },
      { at: utc("2026-08-30T07:30:59.999Z"), value: 2 },
      { at: utc("2026-08-30T07:31:00.000Z"), value: 3 },
    ];
    expect(filterChartTimePoints(points, range ?? { preset: "all" }).map((point) => point.value)).toEqual([1, 2]);
  });

  it("supports domain records through an accessor and rejects invalid ranges", () => {
    const records = [
      { observedAt: "2026-08-30T00:00:00+08:00", value: 1 },
      { observedAt: "2026-08-31T00:00:00+08:00", value: 2 },
      { observedAt: "not-a-time", value: 3 },
    ];
    expect(filterTimestamped(
      records,
      { preset: "custom", start: "2026-08-30", end: "2026-08-30" },
      (record) => record.observedAt,
    ).map((record) => record.value)).toEqual([1]);
    expect(resolveChartTimeRange({ preset: "custom", start: "2026-08-31", end: "2026-08-30" })).toBeNull();
    expect(resolveChartTimeRange({ preset: "custom", start: "bad", end: "2026-08-30" })).toBeNull();
    expect(isInChartTimeRange("2026-08-30T15:59:59.999Z", { preset: "custom", start: "2026-08-30", end: "2026-08-30" })).toBe(true);
  });
});
