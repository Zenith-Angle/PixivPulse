import type { ToolDefinition } from "./types";

export const COMMENTARY_TOOL: ToolDefinition = {
  name: "report_progress",
  description: "Send a brief public progress update to the user, separate from tool operations and the final answer. State the next action or explain a finding supported by tool results already received. Never reveal private reasoning or claim unexecuted work has finished. Prefer calling alongside the next data tool; do not add an extra request solely to repeat a status.",
  parameters: { type: "object", properties: { message: { type: "string", maxLength: 2000 } }, required: ["message"], additionalProperties: false },
};

// Decode only complete JSON-string tokens; an unfinished escape or surrogate
// remains buffered. Never render raw arguments or provider reasoning content.
export function partialCommentary(args: string): string {
  const prefix = /^\s*\{\s*"message"\s*:\s*"/.exec(args);
  if (!prefix) return "";
  const body = args.slice(prefix[0].length);
  const tokens = /^(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/.exec(body)?.[0] ?? "";
  try { return (JSON.parse('"' + tokens + '"') as string).replace(/[\uD800-\uDBFF]$/, "").slice(0, 2000); } catch { return ""; }
}
