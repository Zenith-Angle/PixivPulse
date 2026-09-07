// Usage: node scripts/verify-agent-live.mjs <local-key-file>
// The key stays in process memory. Only labeled demo data is sent to the model.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const path = process.argv[2];
if (!path) { console.error("Provide a local API key file path; do not pass the key itself."); process.exit(1); }
const raw = (await readFile(path, "utf8")).trim().replace(/^\uFEFF/, "");
let apiKey;
try {
  const value = JSON.parse(raw);
  apiKey = typeof value === "string" ? value : value.api_key ?? value.apiKey ?? value.API_KEY ?? value.key;
} catch { apiKey = raw; }
if (typeof apiKey !== "string" || !apiKey.trim() || /[\s{}]/.test(apiKey.trim())) { console.error("Key file must contain a plain key, JSON string, or api_key/apiKey/key property."); process.exit(1); }
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { DEFAULT_AGENT_CONFIG } = await server.ssrLoadModule("/src/agent/types.ts");
  const { testConnection, safeAgentError } = await server.ssrLoadModule("/src/agent/provider.ts");
  const { runAgent } = await server.ssrLoadModule("/src/agent/runner.ts");
  const { createDemoData } = await server.ssrLoadModule("/src/ui/demoData.ts");
  const config = { ...DEFAULT_AGENT_CONFIG, apiKey: apiKey.trim(), shareData: true, timeoutSeconds: 240 };
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const report = { at: new Date().toISOString(), baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, data: "labeled demo data only", connection: false, turns: [] };
  try {
    console.log("Testing live DeepSeek Responses tool round trip (no portfolio data)...");
    await testConnection(config, signal); report.connection = true;
    console.log("Connection and tool result round trip passed. Running live data analysis...");
    const data = createDemoData();
    const history = [];
    for (const question of [
      "请调用 get_overview、rank_growth（from 和 to 均为 null，按 views 排序，offset 0，limit 3）、get_data_quality。用中文简洁说明演示作品总数、总浏览量、增长最快作品和实际采样范围，并引用来源，不要编造数字。",
      "基于刚才的分析，再查询 get_followers（from 和 to 均为 null，offset 0，limit 5），解释粉丝变化；明确哪些因果关系不能从这些数据中得出。请简洁回答并引用来源。",
    ]) {
      const id = crypto.randomUUID();
      history.push({ id, role: "user", content: question, at: new Date().toISOString(), status: "complete", traces: [] });
      const answer = { id: crypto.randomUUID(), role: "assistant", content: "", at: new Date().toISOString(), status: "complete", traces: [] };
      await runAgent(config, history, data, true, signal, {
        onText(chunk) { answer.content += chunk; },
        onTrace(trace) { answer.traces.push(trace); console.log(`Tool ${trace.id}: ${trace.name}`); },
        onBudget(trimmed) { answer.trimmedTurns = trimmed; },
        onUsage(usage) { answer.usage = usage; },
      });
      if (!answer.content.trim() || !answer.traces.length || !/\[S\d+\]/.test(answer.content)) throw new Error("Live answer did not include tools and source citations");
      const traceErrors = answer.traces.filter((trace) => JSON.parse(trace.result).error);
      if (traceErrors.length) throw new Error("Live model used invalid tool arguments");
      const normalizedAnswer = answer.content.replace(/[,，\s]/g, "");
      if (report.turns.length === 0) {
        const overview = answer.traces.find((trace) => trace.name === "get_overview");
        const ranking = answer.traces.find((trace) => trace.name === "rank_growth");
        if (!overview || !ranking) throw new Error("Required analysis tools missing");
        const total = JSON.parse(overview.result).data.totals.views.value;
        const growth = JSON.parse(ranking.result).data.rows[0].interval.delta.views;
        if (!normalizedAnswer.includes(String(total)) || !normalizedAnswer.includes(String(growth)) || !answer.content.includes("演示")) throw new Error("Live numeric evidence mismatch");
      } else {
        const follower = answer.traces.find((trace) => trace.name === "get_followers");
        if (!follower || !normalizedAnswer.includes(String(JSON.parse(follower.result).data.delta))) throw new Error("Follower evidence mismatch");
      }
      history.push(answer);
      report.turns.push({ question, ...answer });
      console.log(`Live turn ${report.turns.length} passed; ${answer.traces.length} tools, ${answer.content.length} answer characters.`);
    }
    await mkdir("output", { recursive: true });
    const safe = JSON.stringify(report, null, 2);
    if (safe.includes(apiKey.trim())) throw new Error("Unexpected credential in report");
    await writeFile("output/agent-live-acceptance.json", safe);
    console.log("PASS: live connection, streaming, tool execution, numeric evidence and continuous conversation. Report: output/agent-live-acceptance.json");
  } catch (error) {
    console.error("Live acceptance failed: " + safeAgentError(error));
    const detail = typeof error?.error?.message === "string" ? error.error.message : "";
    if (detail) console.error("Provider diagnostic (redacted): " + detail.replaceAll(apiKey.trim(), "[REDACTED]").replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 1000));
    process.exitCode = 1;
  }
} finally { await server.close(); }
