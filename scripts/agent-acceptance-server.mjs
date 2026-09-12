// Deterministic protocol fixture for browser acceptance; this is NOT a model.
// Serves the production bundle and validates the real client tool round trip.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve(".output/chrome-mv3");
let count = 0;
const temporalArgs = { dimension: "hour_of_day", metrics: ["views", "bookmarks", "likes"], workKeys: [], from: null, to: null, bucketHours: 1, offset: 0, limit: 24 };
function unpack(value) {
  if (Array.isArray(value)) return value.map(unpack);
  if (!value || typeof value !== "object") return value;
  if (value.$table) return value.$table.rows.map(row => Object.fromEntries(value.$table.columns.map((key, i) => [key, unpack(row[i])])));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4175");
  if (url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "acceptance-fixture", object: "model" }] })); return;
  }
  if (url.pathname === "/v1/responses" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const last = input.input.at(-1);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const finish = (output) => { emit({ type: "response.completed", response: { id: `fixture-${++count}`, object: "response", status: "completed", output, usage: { input_tokens: 100, output_tokens: 20 } } }); res.end(); };
    const progressAndQuery = async (message, args) => {
      const id = `progress-${count}`, argumentsText = JSON.stringify({ message });
      const item = { id, type: "function_call", call_id: id, name: "report_progress", arguments: "" };
      emit({ type: "response.output_item.added", output_index: 0, item });
      for (const delta of argumentsText.match(/.{1,6}/gu) ?? []) {
        await new Promise(resolve => setTimeout(resolve, 60));
        if (res.destroyed) return;
        emit({ type: "response.function_call_arguments.delta", output_index: 0, item_id: id, delta });
      }
      finish([{ ...item, arguments: argumentsText }, { id: `query-${count}`, type: "function_call", call_id: `query-${count}`, name: "analyze_time_patterns", arguments: JSON.stringify(args) }]);
    };
    if (input.tools?.length && last?.type !== "function_call_output") {
      if (input.tools.some(tool => tool.name === "analyze_time_patterns") && !input.tools.some(tool => tool.name === "get_overview")) {
        await progressAndQuery("我会比较一天中浏览、收藏和点赞的增量，并核对哪些时段有足够观测。", temporalArgs); return;
      }
      const name = input.tools.find(tool => tool.name === "get_overview")?.name ?? input.tools.find(tool => tool.name === "select_reading_samples")?.name ?? input.tools[0].name;
      const args = name === "select_reading_samples" ? { query: "", limit: 3 } : {};
      finish([{ id: "fc1", type: "function_call", call_id: "fixture-call", name, arguments: JSON.stringify(args) }]); return;
    }
    let answer;
    if (last?.type === "function_call_output") {
      const result = unpack(JSON.parse(last.output));
      if (result.data?.dimension) {
        const coverage = result.data.coverage;
        if (result.data.bucketHours === 1 && coverage.excludedCoarse > 0) {
          await progressAndQuery("部分采样间隔超过一小时，我会再按更宽的时段比较，避免把缺测误判为低谷。", { ...temporalArgs, dimension: coverage.suggestedDimension, bucketHours: coverage.suggestedBucketHours === 24 ? 1 : coverage.suggestedBucketHours }); return;
        }
        answer = `## 时段比较\n\n**示例数据的一小时观测并不完整，不能直接据此判断每天的高峰与低谷。**\n\n已按更宽的时间范围比较浏览、收藏和点赞的增量；${coverage.accepted ? "可以参考覆盖到的变化，但尚不能把它当作稳定的日内规律。" : "现有采样仍不足以支持稳定的时段判断。"} [${result.source}]\n\n这是确定性协议验收，非真实模型回答。`;
      } else {
      const count = result.data?.workCount ?? result.data?.totalMatches ?? (result.data?.reusedSource === "S1" ? Number(input.instructions.match(/"workCount":(\d+)/)?.[1]) : undefined);
      answer = result.ok ? "OK：连接工具回传成功。" : `## 本地协议验收\n\n工具返回 **${count} 件作品**，来源 [S1]。\n\n这是确定性测试服务，非真实大模型回答。\n\n| 检查 | 结果 |\n| --- | --- |\n| 工具回传 | 成功 |\n| 会话上下文 | ${input.input.length} 条 |`;
      }
    } else answer = "普通对话协议验收成功（确定性测试服务）。";
    const parts = answer.match(/.{1,12}|\n/g) ?? [answer];
    let index = 0;
    const timer = setInterval(() => {
      if (index < parts.length) emit({ type: "response.output_text.delta", delta: parts[index++] });
      else { clearInterval(timer); finish([{ id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }]); }
    }, 60);
    res.on("close", () => clearInterval(timer)); return;
  }
  try {
    const target = resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/dashboard.html" : url.pathname)}`);
    if (!target.startsWith(root + sep)) throw new Error("path");
    const content = await readFile(target);
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[extname(target)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime }); res.end(content);
  } catch { res.writeHead(404); res.end("not found"); }
});
server.listen(4175, "127.0.0.1", () => console.log("Agent acceptance fixture: http://127.0.0.1:4175/dashboard.html"));
