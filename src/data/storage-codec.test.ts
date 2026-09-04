import { describe, expect, it } from "vitest";
import type { ObservationBatch, WorkRecord, WorkSample } from "../domain/types";
import {
  DataIntegrityError,
  canonicalObservationBatch,
  canonicalWorkSample,
  canonicalMetadataEqual,
  decodeObservationBatch,
  decodeWorkSample,
  decodeWorkState,
  encodeWorkSample,
  encodeObservationBatch,
  encodeWorkDocument,
  encodeWorkState,
  materializeWorkRecord,
  sampleCanonicalHash,
  sampleIdentityFor,
} from "./storage-codec";

const record = (overrides: Partial<WorkRecord> = {}): WorkRecord => ({
  key: "illust-12345678901234567890",
  id: "12345678901234567890",
  type: "illust",
  contentType: "illustration",
  description: "A long description that belongs in the static document.",
  title: "Codec fixture",
  seriesTitle: null,
  publishedAt: "2026-08-01T00:00:00.000Z",
  wordCount: null,
  pageCount: 1,
  isAi: false,
  isR18: false,
  thumbnailUrl: "https://i.pximg.net/thumb.jpg",
  workUrl: "https://www.pixiv.net/artworks/12345678901234567890",
  metrics: { likes: 10, bookmarks: 20, views: 30, comments: 2, rank: 7, responses: 1, illustrations: 1 },
  rankingStatus: "ranked",
  rankingObservedAt: "2026-08-30T10:00:00.000Z",
  rankingSource: "api",
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-30T10:00:00.000Z",
  lastObservedRunId: "run-1",
  absentSince: null,
  rawLabels: { z: "last", a: "first" },
  missingFields: ["rank", "responses"],
  parserVersion: 1,
  ...overrides,
});

const batch = (overrides: Partial<ObservationBatch> = {}): ObservationBatch => ({
  runId: "run-1",
  observedAt: "2026-08-30T10:00:00.000Z",
  workKeys: ["novel-99999999999999999999", "illust-12345678901234567890", "creator-custom-key"],
  changedWorkKeys: ["creator-custom-key", "illust-12345678901234567890"],
  scope: "complete",
  ...overrides,
});

const sample = (id?: number): WorkSample => ({
  ...(id === undefined ? {} : { id }),
  workKey: "illust-12345678901234567890",
  runId: "run-1",
  collectedAt: "2026-08-30T10:00:00.000Z",
  metrics: { likes: 10000, bookmarks: 2000, views: 90000, comments: 300, rank: 7, responses: 12, illustrations: 1 },
  rankingStatus: "ranked",
  rankingObservedAt: "2026-08-30T10:00:00.000Z",
  rankingSource: "api",
  parserVersion: 1,
  dataQuality: 1,
  kind: "change",
});

describe("v4 storage codec", () => {
  it("round-trips work document/state field by field without undefined values", () => {
    const source = record();
    const document = encodeWorkDocument(source);
    const state = encodeWorkState(source);
    expect(document).not.toHaveProperty("metrics");
    expect(document).not.toHaveProperty("lastSeenAt");
    expect(state.values).toHaveLength(13);
    expect(state.values.every((value) => value !== undefined)).toBe(true);
    expect(materializeWorkRecord(document, state)).toEqual(source);
  });

  it("compares metadata canonically despite object and missing-field order", () => {
    const left = record({ rawLabels: { a: "first", z: "last" }, missingFields: ["responses", "rank"] });
    const right = record({ rawLabels: { z: "last", a: "first" }, missingFields: ["rank", "responses"] });
    expect(canonicalMetadataEqual(encodeWorkDocument(left), encodeWorkDocument(right))).toBe(true);
  });

  it("packs decimal IDs as strings, preserves legacy keys, and keeps changed keys a subset", () => {
    const stored = encodeObservationBatch(batch());
    expect(stored).toMatchObject({ codec: "packed-v1", codecVersion: 1 });
    expect(stored.workKeys).toEqual({
      illust: ["12345678901234567890"],
      novel: ["99999999999999999999"],
      legacy: ["creator-custom-key"],
    });
    expect(typeof stored.workKeys.illust[0]).toBe("string");
    const decoded = decodeObservationBatch(stored);
    expect(decoded).toEqual({
      ...batch(),
      workKeys: ["creator-custom-key", "illust-12345678901234567890", "novel-99999999999999999999"],
      changedWorkKeys: ["creator-custom-key", "illust-12345678901234567890"],
    });
    expect(decoded.changedWorkKeys.every((key) => decoded.workKeys.includes(key))).toBe(true);
  });

  it("is deterministic and decodes v3 plain legacy batches", () => {
    const first = encodeObservationBatch(batch({ workKeys: ["novel-2", "illust-10", "illust-2"], changedWorkKeys: ["illust-2"] }));
    const second = encodeObservationBatch(batch({ workKeys: ["illust-2", "novel-2", "illust-10"], changedWorkKeys: ["illust-2"] }));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(decodeObservationBatch({
      runId: "legacy",
      observedAt: "2026-08-30T10:00:00.000Z",
      workKeys: ["illust-2"],
      changedWorkKeys: [],
      scope: "partial",
    })).toEqual({
      runId: "legacy",
      observedAt: "2026-08-30T10:00:00.000Z",
      workKeys: ["illust-2"],
      changedWorkKeys: [],
      scope: "partial",
    });
  });

  it("fails closed for corrupt tuples, packed fields, unknown versions, and subset violations", () => {
    expect(() => decodeWorkState({ key: "illust-1", version: 99, values: [] })).toThrow(DataIntegrityError);
    expect(() => decodeWorkState({ key: "illust-1", version: 1, values: [null, null, null] })).toThrow(DataIntegrityError);
    expect(() => decodeObservationBatch({ ...encodeObservationBatch(batch()), codecVersion: 99 })).toThrow(DataIntegrityError);
    expect(() => decodeObservationBatch({ ...encodeObservationBatch(batch()), workKeys: { illust: ["not-a-number"], novel: [], legacy: [] } })).toThrow(DataIntegrityError);
    expect(() => decodeObservationBatch({ ...batch(), changedWorkKeys: ["novel-1"] })).toThrow(DataIntegrityError);
  });

  it("encodes samples compactly while preserving public equality and stable identity", () => {
    const source = sample(17);
    const stored = encodeWorkSample(source);
    const sourceBytes = JSON.stringify(source).length;
    const storedBytes = JSON.stringify(stored).length;
    expect(storedBytes).toBeLessThanOrEqual(Math.floor(sourceBytes * 0.7));
    expect(decodeWorkSample(stored)).toEqual(source);
    expect(sampleIdentityFor(source)).toBe(sampleIdentityFor(sample(99)));
    expect(sampleCanonicalHash(source)).toBe(sampleCanonicalHash(sample(99)));
    expect(canonicalWorkSample(source)).toBe(canonicalWorkSample(sample(99)));
  });

  it("round-trips the new tier and every historical compaction marker", () => {
    const levels = ["30m", "1h", "2h", "6h", "day", "daily"] as const;
    for (const compactionLevel of levels) {
      const source = { ...sample(), compactionLevel };
      expect(decodeWorkSample(encodeWorkSample(source))).toEqual(source);
    }
  });

  it("fails closed for corrupt compact samples and canonicalizes packed batches", () => {
    const stored = encodeWorkSample(sample());
    expect(() => decodeWorkSample({ ...stored, codecVersion: 99 })).toThrow(DataIntegrityError);
    expect(() => decodeWorkSample({ ...stored, k: "wrong" })).toThrow(DataIntegrityError);
    expect(() => decodeWorkSample({ ...stored, m: [1, 2] })).toThrow(DataIntegrityError);
    const left = batch({ workKeys: ["illust-2", "illust-1"], changedWorkKeys: ["illust-1"] });
    const right = batch({ workKeys: ["illust-1", "illust-2"], changedWorkKeys: ["illust-1"] });
    expect(canonicalObservationBatch(left)).toBe(canonicalObservationBatch(right));
  });

  it("shows material storage reduction for state and packed batches", () => {
    const source = record();
    const stateBytes = JSON.stringify(encodeWorkState(source)).length;
    const fullBytes = JSON.stringify(source).length;
    const workKeys = Array.from({ length: 17 }, (_, index) => `illust-${10000000000000000000n + BigInt(index)}`)
      .concat(Array.from({ length: 17 }, (_, index) => `novel-${20000000000000000000n + BigInt(index)}`));
    const representativeBatch = batch({ workKeys, changedWorkKeys: workKeys.slice(0, 8) });
    const packedBytes = JSON.stringify(encodeObservationBatch(representativeBatch)).length;
    const oldBatchBytes = JSON.stringify(representativeBatch).length;
    expect(stateBytes).toBeLessThan(fullBytes);
    expect(packedBytes).toBeLessThan(oldBatchBytes);
  });
});
