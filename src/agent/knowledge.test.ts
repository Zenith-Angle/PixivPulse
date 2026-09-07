import { describe, expect, it } from "vitest";
import { createDemoData, createEmptyDashboardData } from "../ui/demoData";
import { createKnowledge } from "./knowledge";

describe("Agent read-only knowledge", () => {
  it("ranks across all works and computes weighted conversion on known pairs", () => {
    const data = createDemoData();
    const base = data.works[0]!;
    data.works = [
      { ...base, key: "a", seriesTitle: "series", metrics: { ...base.metrics, views: 1000, bookmarks: 100 } },
      { ...base, key: "b", seriesTitle: "series", metrics: { ...base.metrics, views: 10, bookmarks: 9 } },
      { ...base, key: "c", seriesTitle: "series", metrics: { ...base.metrics, views: null, bookmarks: 999 } },
    ];
    const knowledge = createKnowledge(data);
    expect(knowledge.execute("rank_works", { metric: "bookmarkRate", minViews: 500, offset: 0, limit: 5 })).toMatchObject({ total: 1, excludedWorks: 2, rows: [{ key: "a", bookmarkRate: 0.1 }] });
    expect(knowledge.execute("summarize_groups", { by: "series", offset: 0, limit: 5 })).toMatchObject({ rows: [{ works: 3, knownPairs: 2, views: 1010, bookmarks: 109, bookmarkRate: 109 / 1010 }] });
    expect(() => knowledge.execute("get_analysis_brief", { from: "invalid", to: null })).toThrow();
    expect(knowledge.execute("get_analysis_brief", { from: null, to: null })).toHaveProperty("growth");
  });
  it("preserves unknown totals, coverage and demo identity", () => {
    const empty = createKnowledge(createEmptyDashboardData());
    expect(empty.execute("get_overview", {})).toMatchObject({ workCount: 0, totals: { views: { value: null, knownWorks: 0 } } });
    expect(createKnowledge(createDemoData(), true).coverage.isPreview).toBe(true);
  });

  it("paginates all works and never serializes cookies, settings, or thumbnail URLs", () => {
    const data = createDemoData();
    const before = JSON.stringify(data);
    const knowledge = createKnowledge(data);
    const first = knowledge.execute("search_works", { query: "", offset: 0, limit: 1 });
    expect(first).toMatchObject({ total: data.works.length, nextOffset: 1 });
    expect(JSON.stringify(first)).not.toContain("thumbnailUrl");
    expect(JSON.stringify(knowledge.execute("get_overview", {}))).not.toContain("boundAccount");
    expect(JSON.stringify(data)).toBe(before);
    expect(() => knowledge.execute("delete_works", {})).toThrow();
    expect(() => knowledge.execute("search_works", { query: "", offset: -1, limit: 1 })).toThrow();
    expect(() => knowledge.execute("search_works", { query: "", offset: 0, limit: 999 })).toThrow();
  });

  it("uses true observed endpoints, retains decreases, excludes unknown baselines", () => {
    const data = createDemoData();
    const work = data.works[0]!;
    data.works = [{ ...work, lastSeenAt: "2026-09-07T12:00:00Z", metrics: { ...work.metrics, views: 80 } }];
    data.samples = [
      { workKey: work.key, runId: "first", collectedAt: "2026-09-05T12:00:00Z", metrics: { ...work.metrics, views: 100 }, parserVersion: 1, dataQuality: 1, kind: "change" },
    ];
    const knowledge = createKnowledge(data);
    expect(knowledge.execute("rank_growth", { from: "2026-09-06T12:00:00Z", to: null, metric: "views", offset: 0, limit: 5 })).toMatchObject({ total: 1, rows: [{ interval: { fromAt: "2026-09-05T20:00:00.000+08:00", toAt: "2026-09-07T20:00:00.000+08:00", elapsedHours: 48, delta: { views: -20 } } }] });
    expect(knowledge.execute("rank_growth", { from: "2026-09-01T12:00:00Z", to: null, metric: "views", offset: 0, limit: 5 })).toMatchObject({ total: 0, excludedWorks: 1 });
    expect(() => knowledge.execute("get_work_history", { workKey: work.key, from: "2026-09-06", to: null, offset: 0, limit: 5 })).toThrow(/timezone/);
  });

  it("rejects reversed ranges and unknown work keys", () => {
    const knowledge = createKnowledge(createDemoData());
    expect(() => knowledge.execute("compare_works", { workKeys: ["missing"], from: null, to: null })).toThrow(/Unknown work/);
    expect(() => knowledge.execute("get_followers", { from: "2026-09-07T00:00:00Z", to: "2026-09-01T00:00:00Z", offset: 0, limit: 5 })).toThrow(/from/);
  });
});
