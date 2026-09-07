import { openDB, type DBSchema } from "idb";
import { restoreConfig } from "./config";
import type { AgentConfig, Conversation } from "./types";

export interface MemoryEntry { id: string; scope: string; name: string; args: Record<string, unknown>; result: unknown; at: number }

interface AgentDB extends DBSchema {
  memory: { key: string; value: MemoryEntry; indexes: { scope: string } };
  config: { key: string; value: AgentConfig };
  conversations: { key: string; value: Conversation; indexes: { account: string } };
}

// Separate extension-origin database: absent from Pixiv backups and content scripts.
const database = () => openDB<AgentDB>("pixivpulse-agent", 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      db.createObjectStore("config");
      db.createObjectStore("conversations", { keyPath: "id" }).createIndex("account", "accountId");
    }
    if (oldVersion < 2) db.createObjectStore("memory", { keyPath: "id" }).createIndex("scope", "scope");
  },
});
const SESSION_KEY = "pixivpulse-agent-key";

export async function loadAgentConfig(): Promise<AgentConfig> {
  const db = await database();
  try {
    const config = restoreConfig(await db.get("config", "connection"));
    if (!config.rememberKey) {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as { baseUrl: string; key: string } | null;
      config.apiKey = session?.baseUrl === config.baseUrl ? session.key : "";
    }
    return config;
  } finally { db.close(); }
}

export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  const db = await database();
  try {
    await db.put("config", { ...config, apiKey: config.rememberKey ? config.apiKey : "" }, "connection");
    if (config.rememberKey) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify({ baseUrl: config.baseUrl, key: config.apiKey }));
  } finally { db.close(); }
}

export async function listConversations(accountId: string): Promise<Conversation[]> {
  const db = await database();
  try {
    const rows = await db.getAllFromIndex("conversations", "account", accountId);
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((row) => ({ ...row,
      messages: row.messages.map((message) => message.status === "running"
        ? { ...message, status: "stopped" as const, error: "上次生成已中断，可以重试。" } : message),
    }));
  } finally { db.close(); }
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const db = await database();
  try { await db.put("conversations", conversation); } finally { db.close(); }
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await database();
  try { await db.delete("conversations", id); } finally { db.close(); }
}

export function conversationMarkdown(conversation: Conversation): string {
  return `# ${conversation.title}\n\n` + conversation.messages.map((message) =>
    `## ${message.role === "user" ? "用户" : "Agent"} · ${message.at}\n\n${message.content}\n\n` +
    (message.error ? `状态：${message.error}\n\n` : "") +
    message.traces.map((trace) => `### ${trace.id} · ${trace.name}\n\n参数：${trace.arguments}\n\n\`\`\`json\n${trace.result}\n\`\`\`\n`).join("\n")
  ).join("\n");
}

export async function readMemory(scope: string): Promise<MemoryEntry[]> {
  const db = await database();
  try { return (await db.getAllFromIndex("memory", "scope", scope)).filter(row => Date.now() - row.at < 86400000); }
  finally { db.close(); }
}
export async function writeMemory(entry: MemoryEntry): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction("memory", "readwrite");
    await tx.store.put(entry);
    const rows = (await tx.store.getAll()).sort((a, b) => b.at - a.at);
    let bytes = 0;
    for (const [index, row] of rows.entries()) {
      bytes += new TextEncoder().encode(JSON.stringify(row)).length;
      if (index >= 40 || bytes > 256000 || Date.now() - row.at > 86400000) await tx.store.delete(row.id);
    }
    await tx.done;
  } finally { db.close(); }
}
export async function clearAgentMemory(): Promise<void> {
  const db = await database();
  try { await db.clear("memory"); } finally { db.close(); }
}
