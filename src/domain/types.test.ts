import { describe, expect, it } from "vitest";
import { normalizeRankingFields, normalizeRankingStatus } from "./types";

describe("ranking normalization", () => {
  it("maps legacy positive metrics.rank to ranked", () => {
    expect(normalizeRankingFields({ rank: 12 })).toEqual({
      rank: 12,
      rankingStatus: "ranked",
      rankingObservedAt: null,
      rankingSource: null,
    });
    expect(normalizeRankingStatus(undefined, 12)).toBe("ranked");
  });

  it("keeps missing and invalid ranking values unknown", () => {
    expect(normalizeRankingFields({ rank: null })).toMatchObject({ rank: null, rankingStatus: "unknown" });
    expect(normalizeRankingFields({ rank: 0, rankingStatus: "ranked" })).toMatchObject({ rank: null, rankingStatus: "unknown" });
    expect(normalizeRankingFields({ rank: -1, rankingStatus: "unranked" })).toMatchObject({ rank: null, rankingStatus: "unranked" });
  });

  it("enforces null rank for explicit unknown and unranked states", () => {
    expect(normalizeRankingFields({ rank: 9, rankingStatus: "unknown", rankingSource: "api" })).toEqual({
      rank: null,
      rankingStatus: "unknown",
      rankingObservedAt: null,
      rankingSource: null,
    });
    expect(normalizeRankingFields({ rank: 9, rankingStatus: "unranked", rankingObservedAt: "2026-08-30T00:00:00.000Z", rankingSource: "page" })).toEqual({
      rank: null,
      rankingStatus: "unranked",
      rankingObservedAt: "2026-08-30T00:00:00.000Z",
      rankingSource: "page",
    });
  });
});
