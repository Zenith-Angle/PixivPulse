import { describe, expect, it } from "vitest";
import type { WorkSample } from "../domain/types";
import { analyzeWork } from "./helpers";
import { createDemoData } from "./demoData";
import {
  buildRankingEntries,
  normalizeRankingStatus,
  rankingHistoryForWork,
  rankingEntryForAnalysis,
  rankingMovement,
  rankingSourceLabel,
} from "./rankings";

const rankingSample = (sample: WorkSample, fields: Record<string, unknown>): WorkSample => ({ ...sample, ...fields }) as WorkSample;

describe("ranking semantics", () => {
  it("normalizes legacy positive ranks while keeping missing values unknown", () => {
    expect(normalizeRankingStatus(undefined, 8)).toBe("ranked");
    expect(normalizeRankingStatus(undefined, 0)).toBe("unknown");
    expect(normalizeRankingStatus("unknown", 8)).toBe("unknown");
    expect(normalizeRankingStatus("unranked", null)).toBe("unranked");
  });

  it("ignores unknown samples and deduplicates explicit rankingObservedAt values", () => {
    const data = createDemoData();
    const work = data.works[0]!;
    const template = data.samples[0]!;
    const samples = [
      rankingSample(template, { workKey: work.key, collectedAt: "2026-08-01T01:00:00.000Z", metrics: { ...template.metrics, rank: 9 }, rankingStatus: "ranked", rankingObservedAt: "2026-08-01T01:00:00.000Z", rankingSource: "creator-page" }),
      rankingSample(template, { workKey: work.key, collectedAt: "2026-08-02T01:00:00.000Z", metrics: { ...template.metrics, rank: null } }),
      rankingSample(template, { workKey: work.key, collectedAt: "2026-08-03T01:00:00.000Z", metrics: { ...template.metrics, rank: 6 }, rankingStatus: "ranked", rankingObservedAt: "2026-08-03T01:00:00.000Z", rankingSource: "api" }),
      rankingSample(template, { workKey: work.key, collectedAt: "2026-08-03T02:00:00.000Z", metrics: { ...template.metrics, rank: 5 }, rankingStatus: "ranked", rankingObservedAt: "2026-08-03T01:00:00.000Z", rankingSource: "api" }),
    ];
    const history = rankingHistoryForWork(work, samples);
    expect(history.map((item) => item.rank)).toEqual([9, 5]);
    expect(history[1]?.source).toBe("api");
  });

  it("uses lower-is-better movement and preserves an unranked transition", () => {
    const data = createDemoData();
    const work = data.works[0]!;
    const template = data.samples[0]!;
    const samples = [
      rankingSample(template, { workKey: work.key, collectedAt: "2026-08-01T01:00:00.000Z", metrics: { ...template.metrics, rank: 9 }, rankingStatus: "ranked", rankingObservedAt: "2026-08-01T01:00:00.000Z" }),
      rankingSample(template, { workKey: work.key, collectedAt: "2026-08-03T01:00:00.000Z", metrics: { ...template.metrics, rank: null }, rankingStatus: "unranked", rankingObservedAt: "2026-08-03T01:00:00.000Z" }),
    ];
    const history = rankingHistoryForWork(work, samples);
    expect(rankingMovement(5, 9)).toBe(4);
    expect(history.at(-1)?.status).toBe("unranked");
    expect(rankingEntryForAnalysis(analyzeWork(work, samples))).toBeNull();
    expect(buildRankingEntries([analyzeWork(work, samples)], samples)).toEqual([]);
  });

  it("sorts current ranked entries ascending and labels provenance", () => {
    const data = createDemoData();
    const works = data.works.slice(0, 2).map((work, index) => ({ ...work, metrics: { ...work.metrics, rank: index === 0 ? 12 : 3 } }));
    const samples = data.samples.filter((sample) => works.some((work) => work.key === sample.workKey)).map((sample) => ({ ...sample, metrics: { ...sample.metrics, rank: works.find((work) => work.key === sample.workKey)?.metrics.rank ?? null } }));
    const entries = buildRankingEntries(works.map((work) => analyzeWork(work, samples)), samples);
    expect(entries.map((entry) => entry.rank)).toEqual([3, 12]);
    expect(rankingSourceLabel("api")).toBe("Pixiv API");
    expect(rankingSourceLabel("creator-page")).toBe("Pixiv作品页");
  });
});
