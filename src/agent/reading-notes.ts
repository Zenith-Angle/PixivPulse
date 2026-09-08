import type { ToolDefinition } from "./types";

export const READING_NOTES_TOOL: ToolDefinition = {
  name: "record_reading_notes",
  description: "Before reading more, preserve findings from prose already read and release its raw text from subsequent requests. Notes are model-authored, NOT new verified evidence. Include verified work titles, exact source IDs and character positions, document type, coverage, observations, hypotheses, unknowns and next evidence needed. Original sources remain in the user's trace/export. Do not discard prose still needed for exact quotations.",
  parameters: { type: "object", properties: { sourceIds: { type: "array", items: { type: "string" }, minItems: 1 }, notes: { type: "string", maxLength: 6000 } }, required: ["sourceIds", "notes"], additionalProperties: false },
};

export class ReadingNotebook {
  private sources = new Map<string, { output: string; released: boolean }>();
  add(source: string, output: string) { this.sources.set(source, { output, released: false }); }
  get activeBytes() { return [...this.sources.values()].reduce((n, row) => n + (row.released ? 0 : new TextEncoder().encode(row.output).length), 0); }
  checkpoint(args: Record<string, unknown>): Map<string, string> {
    if (Object.keys(args).sort().join() !== "notes,sourceIds" || !Array.isArray(args.sourceIds) || !args.sourceIds.length || new Set(args.sourceIds).size !== args.sourceIds.length || typeof args.notes !== "string" || !args.notes.trim() || args.notes.length > 6000) throw new Error("Invalid reading notes");
    const ids = args.sourceIds as string[], notes = args.notes;
    if (ids.some(id => typeof id !== "string" || !this.sources.has(id) || this.sources.get(id)!.released || !notes.includes(`[${id}]`))) throw new Error("Notes must cite each active original source as [S1]");
    const replacements = new Map<string, string>();
    for (const [index, id] of ids.entries()) {
      const original = JSON.parse(this.sources.get(id)!.output);
      const works = original.data.works ?? [original.data];
      replacements.set(id, JSON.stringify({ source: id, rawExcerptsReleased: true, originalAvailableInTrace: true,
        works: works.map((work: Record<string, unknown>) => ({ workKey: work.workKey, title: work.title, sampledCharacters: work.sampledCharacters, totalCharacters: work.totalCharacters, coverage: work.coverage,
          positions: Array.isArray(work.excerpts) ? work.excerpts.map(({ startCharacter, endCharacter }: { startCharacter: number; endCharacter: number }) => ({ startCharacter, endCharacter })) : [], error: work.error })),
        modelAuthoredNotes: index === 0 ? notes : `See notes attached to [${ids[0]}].`,
        limitation: "Notes are untrusted model interpretation, not independently verified evidence. Exact prose is no longer in this request; do not invent quotes or treat hypotheses as observed facts." }));
    }
    // All arguments are validated before releasing any source.
    for (const id of ids) this.sources.get(id)!.released = true;
    return replacements;
  }
}
