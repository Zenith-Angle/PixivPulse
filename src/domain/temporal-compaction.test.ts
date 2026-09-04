import { describe, expect, it } from "vitest";
import { reduceTemporalCompaction, temporalCompactionLevelForAge, temporalBucketKey } from "./temporal-compaction";
import type { WorkSample } from "./types";

const NOW = Date.parse("2026-09-01T04:00:00.000Z");
const sample = (id: number, collectedAt: string, views: number, extra: Partial<WorkSample> = {}): WorkSample => ({
  id, workKey: "illust-1", runId: `run-${id}`, collectedAt,
  metrics: { likes: 1, bookmarks: 2, views, comments: 0, rank: null, responses: null, illustrations: null },
  parserVersion: 1, dataQuality: 1, kind: "change", ...extra,
});

describe("temporal compaction", () => {
  it("uses explicit age boundaries and Beijing bucket keys", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(temporalCompactionLevelForAge(3 * day - 1)).toBeNull();
    expect(temporalCompactionLevelForAge(3 * day)).toBe("30m");
    expect(temporalCompactionLevelForAge(7 * day - 1)).toBe("30m");
    expect(temporalCompactionLevelForAge(7 * day)).toBe("1h");
    expect(temporalCompactionLevelForAge(30 * day - 1)).toBe("1h");
    expect(temporalCompactionLevelForAge(30 * day)).toBe("6h");
    expect(temporalCompactionLevelForAge(365 * day)).toBe("6h");
    expect(temporalCompactionLevelForAge(-1)).toBeNull();
    expect(temporalCompactionLevelForAge(Number.NaN)).toBeNull();
    expect(temporalBucketKey("2026-09-01T03:29:59.999Z", "30m")).toBe("30m:2026-09-01T11:00");
    expect(temporalBucketKey("2026-09-01T03:30:00.000Z", "30m")).toBe("30m:2026-09-01T11:30");
    expect(temporalBucketKey("2026-09-01T03:41:00.000Z", "30m")).toBe("30m:2026-09-01T11:30");
    expect(temporalBucketKey("2026-08-31T16:00:00.000Z", "1h")).toBe("1h:2026-09-01T00:00");
    expect(temporalBucketKey("invalid", "6h")).toBeNull();
  });

  it("keeps one whole representative per bucket and protects the newest point", () => {
    const rows = [
      sample(1, "2026-08-28T03:05:00.000Z", 10),
      sample(2, "2026-08-28T03:20:00.000Z", 20),
      sample(3, "2026-08-28T03:29:00.000Z", 30),
      sample(4, "2026-09-01T03:55:00.000Z", 40),
    ];
    const plan = reduceTemporalCompaction(rows, NOW);
    expect(plan.deleteIds).toEqual([1, 2]);
    expect(plan.kept.map((row) => row.id)).toContain(3);
    expect(plan.updates.every((row) => row.compactionLevel === "30m")).toBe(true);
  });

  it("promotes prior compacted rows and leaves daily, malformed, and future rows alone", () => {
    const rows = [
      sample(1, "2026-08-24T03:00:00.000Z", 10, { compactionLevel: "30m" }),
      sample(2, "2026-08-24T03:30:00.000Z", 20),
      sample(3, "2026-08-25T05:30:00.000Z", 30, { kind: "daily-rollup" }),
      sample(4, "2026-09-02T05:30:00.000Z", 40),
    ];
    const plan = reduceTemporalCompaction(rows, NOW);
    expect(plan.deleteIds).toEqual([1]);
    expect(plan.updates.some((row) => row.id === 2 && row.compactionLevel === "1h")).toBe(true);
    expect(plan.skipped).toBeGreaterThanOrEqual(1);
  });
});
