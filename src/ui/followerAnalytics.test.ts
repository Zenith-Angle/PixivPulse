import { describe, expect, it } from "vitest";
import { buildFollowerAnalytics, normalizeFollowerSamples, type AccountFollowerSample } from "./followerAnalytics";

const sample = (runId: string, collectedAt: string, followers: number, accountId = "account-a"): AccountFollowerSample => ({
  runId,
  accountId,
  collectedAt,
  followers,
});

describe("account follower analytics", () => {
  it("sorts by real timestamp, filters accounts, and keeps the latest duplicate run", () => {
    const normalized = normalizeFollowerSamples([
      sample("run-b", "2026-08-31T01:00:00+08:00", 120),
      sample("run-a", "2026-08-30T23:00:00+08:00", 100),
      sample("run-b", "2026-08-31T02:00:00+08:00", 125),
      sample("other-account", "2026-08-31T03:00:00+08:00", 900, "account-b"),
    ], "account-a");

    expect(normalized.map((item) => [item.runId, item.followers])).toEqual([
      ["run-a", 100],
      ["run-b", 125],
    ]);
    expect(normalized.map((item) => item.timestamp)).toEqual([
      Date.parse("2026-08-30T23:00:00+08:00"),
      Date.parse("2026-08-31T02:00:00+08:00"),
    ]);
  });

  it("uses the latest pre-range sample as an exact range and Beijing-today baseline", () => {
    const now = "2026-08-31T12:00:00+08:00";
    const analytics = buildFollowerAnalytics([
      sample("before-range", "2026-08-30T11:00:00+08:00", 90),
      sample("before-day", "2026-08-30T23:00:00+08:00", 100),
      sample("today-early", "2026-08-31T01:00:00+08:00", 110),
      sample("today-latest", "2026-08-31T11:00:00+08:00", 130),
    ], { accountId: "account-a", range: { preset: "today", now }, now });

    expect(analytics.current).toBe(130);
    expect(analytics.rangeDelta).toBe(30);
    expect(analytics.rangeConfidence).toBe("exact");
    expect(analytics.recordIntegrity).toBe("complete");
    expect(analytics.rangeBaseline?.followers).toBe(100);
    expect(analytics.todayDelta).toBe(30);
    expect(analytics.todayConfidence).toBe("exact");
  });

  it("marks an in-range first-to-last delta approximate when no prior baseline exists", () => {
    const analytics = buildFollowerAnalytics([
      sample("first", "2026-08-31T04:00:00+08:00", 200),
      sample("last", "2026-08-31T10:00:00+08:00", 217),
    ], {
      range: { preset: "custom", start: "2026-08-31T00:00", end: "2026-08-31T23:59" },
      now: "2026-08-31T12:00:00+08:00",
    });

    expect(analytics.rangeDelta).toBe(17);
    expect(analytics.rangeConfidence).toBe("approximate");
    expect(analytics.recordIntegrity).toBe("approximate");
    expect(analytics.rangeBaseline).toBeNull();
  });

  it("does not manufacture zero growth from one point", () => {
    const analytics = buildFollowerAnalytics([
      sample("only", "2026-08-31T10:00:00+08:00", 217),
    ], {
      range: { preset: "today", now: "2026-08-31T12:00:00+08:00" },
      now: "2026-08-31T12:00:00+08:00",
    });

    expect(analytics.rangeSamples).toHaveLength(1);
    expect(analytics.rangeDelta).toBeNull();
    expect(analytics.rangeConfidence).toBe("insufficient");
    expect(analytics.recordIntegrity).toBe("baseline");
    expect(analytics.todayDelta).toBeNull();
  });

  it("uses today's first sample as an approximate baseline when no pre-midnight sample exists", () => {
    const analytics = buildFollowerAnalytics([
      sample("today-a", "2026-08-31T01:00:00+08:00", 200),
      sample("today-b", "2026-08-31T11:00:00+08:00", 217),
    ], { now: "2026-08-31T12:00:00+08:00" });

    expect(analytics.todayDelta).toBe(17);
    expect(analytics.todayConfidence).toBe("approximate");
    expect(analytics.today.baseline?.runId).toBe("today-a");
    expect(analytics.today.current?.runId).toBe("today-b");
  });

  it("keeps existing points visible when a preset has no points in its nominal window", () => {
    const analytics = buildFollowerAnalytics([
      sample("old-a", "2020-01-01T00:00:00Z", 50),
      sample("old-b", "2020-01-02T00:00:00Z", 55),
    ], { range: { preset: "24h", now: "2026-08-31T12:00:00+08:00" } });

    expect(analytics.rangeSamples).toHaveLength(0);
    expect(analytics.chartSamples.map((item) => item.followers)).toEqual([50, 55]);
    expect(analytics.rangeDelta).toBeNull();
  });
});
