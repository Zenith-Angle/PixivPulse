import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { beforeEach, expect, it } from "vitest";
import { createDemoData } from "../ui/demoData";
import { openKnowledgeMemory } from "./memory";
import { clearAgentMemory, listConversations, readMemory, writeMemory } from "./storage";

beforeEach(async () => { await deleteDB("pixivpulse-agent"); });
it("reuses facts across runs, invalidates actual corrections and isolates demo and accounts", async () => {
  const data = createDemoData();
  const first = await openKnowledgeMemory(data, false, true);
  expect((await first.execute("get_overview", {})).cached).toBe(false);
  const second = await openKnowledgeMemory(structuredClone(data), false, true);
  expect((await second.execute("get_overview", {})).cached).toBe(true);
  data.works[0]!.metrics.views!++;
  expect((await (await openKnowledgeMemory(data, false, true)).execute("get_overview", {})).cached).toBe(false);
  expect((await (await openKnowledgeMemory(data, true, true)).execute("get_overview", {})).cached).toBe(false);
  data.settings.boundAccount = { ...data.settings.boundAccount!, id: "different-account" };
  expect((await (await openKnowledgeMemory(data, false, true)).execute("get_overview", {})).cached).toBe(false);
  await clearAgentMemory();
  expect((await (await openKnowledgeMemory(data, false, true)).execute("get_overview", {})).cached).toBe(false);
  expect((await (await openKnowledgeMemory(data, false, false)).execute("get_overview", {})).cached).toBe(false);
});
it("bounds storage and rejects expired evidence", async () => {
  for (let n = 0; n < 45; n++) await writeMemory({ id: String(n), scope: "scope", name: "test", args: {}, result: n, at: Date.now() + n });
  expect(await readMemory("scope")).toHaveLength(40);
  await writeMemory({ id: "expired", scope: "scope", name: "test", args: {}, result: 0, at: Date.now() - 86400001 });
  expect((await readMemory("scope")).some(row => row.id === "expired")).toBe(false);
});
it("adds memory without losing version 1 conversations", async () => {
  const db = await openDB("pixivpulse-agent", 1, { upgrade(db) {
    db.createObjectStore("config");
    db.createObjectStore("conversations", { keyPath: "id" }).createIndex("account", "accountId");
  } });
  await db.put("conversations", { id: "old", accountId: "a", title: "kept", updatedAt: "now", messages: [] });
  db.close();
  expect((await listConversations("a"))[0]?.title).toBe("kept");
  await clearAgentMemory();
  expect((await listConversations("a"))[0]?.title).toBe("kept");
});
