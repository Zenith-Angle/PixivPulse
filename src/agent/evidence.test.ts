import { describe, expect, it } from "vitest";
import { EvidenceArchive, evidenceBytes, evidenceKey, serializeEvidence } from "./evidence";

function unpack(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (row.$table) {
      const table = row.$table as { columns: string[]; rows: unknown[][] };
      return table.rows.map(values => Object.fromEntries(table.columns.map((key, index) => [key, unpack(values[index])])));
    }
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, unpack(item)]));
  }
  return value;
}

describe("lossless working evidence", () => {
  it("reduces repeated table metadata while preserving exact numbers, nulls, warnings and pagination", () => {
    const original = { source: "S1", data: { rows: Array.from({ length: 100 }, (_, index) => ({ workKey: `novel:${index}`, title: `作品 ${index}`, views: 123456789 + index, bookmarks: index, measuredRate: 0.123456789, missingValue: null, observedAt: "2026-09-12T08:00:00Z" })), nextOffset: 100, limitations: ["Observation is partial; not causal evidence."], definitions: { measuredRate: "bookmarks/views" } } };
    const packed = serializeEvidence(original);
    expect(unpack(JSON.parse(packed))).toEqual(original);
    expect(evidenceBytes(packed)).toBeLessThan(evidenceBytes(JSON.stringify(original)) * 0.7);
  });
  it("preserves heterogeneous rows and nested values", () => {
    const original = [{ a: 1 }, { a: null, b: "😀" }, { nested: [{ count: 0 }, { other: false }] }];
    expect(unpack(JSON.parse(serializeEvidence(original)))).toEqual(original);
  });
  it("reopens every character of an archived source without splitting Unicode or contacting a website", () => {
    const archive = new EvidenceArchive(), original = JSON.stringify({ source: "S2", data: "原文😀𠮷".repeat(100) });
    archive.add("S2", original);
    let text = "", offset: number | null = 0;
    while (offset !== null) {
      const page = archive.retrieve({ sourceId: "S2", offset, limit: 7 });
      text += page.text; offset = page.nextOffset;
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
    expect(text).toBe(original);
    expect(() => archive.retrieve({ sourceId: "missing", offset: 0, limit: 3 })).toThrow();
    expect(() => archive.retrieve({ sourceId: "S2", offset: -1, limit: 3 })).toThrow();
  });
  it("canonicalizes nested arguments but preserves meaningful array ordering", () => {
    expect(evidenceKey("query", { filter: { a: 1, b: 2 } })).toBe(evidenceKey("query", { filter: { b: 2, a: 1 } }));
    expect(evidenceKey("query", { keys: [1, 2] })).not.toBe(evidenceKey("query", { keys: [2, 1] }));
  });
});
