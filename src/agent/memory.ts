import type { DashboardData } from "../domain/types";
import { createKnowledge } from "./knowledge";
import { readMemory, writeMemory, type MemoryEntry } from "./storage";

const canonical = (args: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
export async function openKnowledgeMemory(data: DashboardData, preview: boolean, enabled: boolean) {
  // Hash the actual evidence, not counts or sync IDs: imports/corrections must invalidate caches too.
  const bytes = new TextEncoder().encode(JSON.stringify(["knowledge-v3", preview, data.settings.boundAccount?.id, data.works, data.samples, data.runs, data.accountFollowerSamples]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const scope = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
  const entries = new Map<string, MemoryEntry>();
  if (enabled) {
    try { for (const row of await readMemory(scope)) entries.set(`${row.name}:${canonical(row.args)}`, row); }
    catch { /* Cache availability never blocks fresh analysis. */ }
  }
  let knowledge: ReturnType<typeof createKnowledge> | undefined;
  return {
    async execute(name: string, args: Record<string, unknown>) {
      const key = `${name}:${canonical(args)}`;
      const cached = entries.get(key);
      if (cached) return { result: cached.result, cached: true };
      knowledge ??= createKnowledge(data, preview);
      const result = knowledge.execute(name, args);
      const entry: MemoryEntry = { id: `${scope}:${key}`, scope, name, args, result, at: Date.now() };
      // Per-run deduplication works even with persistent memory disabled.
      entries.set(key, entry);
      if (enabled && new TextEncoder().encode(JSON.stringify(entry)).length <= 16000) {
        try { await writeMemory(entry); } catch { /* A cache failure must not discard valid evidence. */ }
      }
      return { result, cached: false };
    },
  };
}
