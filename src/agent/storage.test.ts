import "fake-indexeddb/auto";
import { openDB, deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { conversationMarkdown, deleteConversation, listConversations, loadAgentConfig, saveAgentConfig, saveConversation } from "./storage";
import { DEFAULT_AGENT_CONFIG, type Conversation } from "./types";

beforeEach(async () => { sessionStorage.clear(); await deleteDB("pixivpulse-agent"); });
describe("Agent local storage", () => {
  it("does not persist session-only keys, and clears a previously remembered key", async () => {
    await saveAgentConfig({ ...DEFAULT_AGENT_CONFIG, apiKey: "test-secret", rememberKey: true });
    expect((await loadAgentConfig()).apiKey).toBe("test-secret");
    await saveAgentConfig({ ...DEFAULT_AGENT_CONFIG, apiKey: "session-secret", rememberKey: false });
    const db = await openDB("pixivpulse-agent");
    expect((await db.get("config", "connection")).apiKey).toBe(""); db.close();
    expect((await loadAgentConfig()).apiKey).toBe("session-secret");
    sessionStorage.clear();
    expect((await loadAgentConfig()).apiKey).toBe("");
  });
  it("isolates accounts, recovers interrupted runs, exports evidence, and deletes one conversation", async () => {
    const row: Conversation = { id: "c1", accountId: "a", title: "Analysis", updatedAt: new Date().toISOString(), messages: [{ id: "m1", role: "assistant", content: "Partial", at: "now", status: "running", traces: [{ id: "S1", name: "get_overview", arguments: "{}", result: '{"total":42}', at: "now" }] }] };
    await saveConversation(row);
    expect(await listConversations("b")).toEqual([]);
    expect((await listConversations("a"))[0]?.messages[0]?.status).toBe("stopped");
    const exported = conversationMarkdown(row);
    expect(exported).toContain('"total":42'); expect(exported).not.toContain("apiKey");
    await deleteConversation("c1"); expect(await listConversations("a")).toEqual([]);
  });
});
