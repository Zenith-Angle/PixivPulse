import { expect, it } from "vitest";
import { ReadingNotebook } from "./reading-notes";

it("releases raw prose only after valid source-linked notes, preserving exact positions and provenance", () => {
  const notebook = new ReadingNotebook();
  const original = JSON.stringify({ source: "S1", data: { workKey: "novel-1", title: "作品甲", sampledCharacters: 3000, totalCharacters: 20000, excerpts: [{ startCharacter: 0, endCharacter: 3000, text: "原文".repeat(1500) }] } });
  notebook.add("S1", original);
  const bytes = notebook.activeBytes;
  expect(() => notebook.checkpoint({ sourceIds: ["S1", "S99"], notes: "[S1] [S99]" })).toThrow();
  expect(() => notebook.checkpoint({ sourceIds: ["S1"], notes: "没有来源" })).toThrow();
  expect(notebook.activeBytes).toBe(bytes);
  const output = notebook.checkpoint({ sourceIds: ["S1"], notes: "[S1] 作品甲 0–3000：已观察到对话，关系性质未知，需补读。" }).get("S1")!;
  expect(output).not.toContain("原文原文");
  expect(JSON.parse(output)).toMatchObject({ rawExcerptsReleased: true, originalAvailableInTrace: true, works: [{ title: "作品甲", positions: [{ startCharacter: 0, endCharacter: 3000 }] }] });
  expect(notebook.activeBytes).toBe(0);
  expect(original).toContain("原文原文");
  expect(() => notebook.checkpoint({ sourceIds: ["S1"], notes: "[S1]" })).toThrow();
});
