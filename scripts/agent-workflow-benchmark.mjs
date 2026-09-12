// Local synthetic benchmark; no credentials, provider requests or user data.
import { createServer } from "vite";
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
try {
  const { createKnowledge, KNOWLEDGE_TOOLS } = await server.ssrLoadModule("/src/agent/knowledge.ts");
  const { createDemoData } = await server.ssrLoadModule("/src/ui/demoData.ts");
  const { initialAnalysisTools, discoveryTool } = await server.ssrLoadModule("/src/agent/workflow.ts");
  const { COMMENTARY_TOOL } = await server.ssrLoadModule("/src/agent/commentary.ts");
  const { READING_NOTES_TOOL } = await server.ssrLoadModule("/src/agent/reading-notes.ts");
  const { serializeEvidence, RETRIEVE_EVIDENCE_TOOL } = await server.ssrLoadModule("/src/agent/evidence.ts");
  const data = createDemoData(), template = data.works[0], start = Date.parse("2026-09-01T00:00:00+08:00");
  data.works = []; data.samples = []; data.observations = []; data.observationBatches = []; data.runs = [];
  for (let work = 0; work < 38; work++) {
    const key = `synthetic-${work}`;
    for (let point = 0; point < 400; point++) {
      const value = point * (work + 1);
      data.samples.push({ workKey: key, collectedAt: new Date(start + point * 900000).toISOString(), runId: `r${point}`, kind: "change", parserVersion: 1, dataQuality: 1, metrics: { ...template.metrics, views: value, bookmarks: value, likes: value } });
    }
    const last = data.samples.at(-1);
    data.works.push({ ...template, key, title: `合成作品${work}`, metrics: last.metrics, lastSeenAt: last.collectedAt });
  }
  const all = [COMMENTARY_TOOL, RETRIEVE_EVIDENCE_TOOL, READING_NOTES_TOOL, ...KNOWLEDGE_TOOLS];
  const focused = [...initialAnalysisTools(all, "temporal", []), discoveryTool(all)];
  const at = performance.now();
  const result = createKnowledge(data).execute("analyze_time_patterns", { dimension: "hour_of_day", metrics: ["views", "bookmarks", "likes"], workKeys: [], from: null, to: null, bucketHours: 1, offset: 0, limit: 24 });
  const elapsedMs = performance.now() - at;
  console.log(JSON.stringify({ synthetic: true, works: data.works.length, samples: data.samples.length, resultSlots: result.rows.length, netViews: result.summary[0].observedNetChange, aggregateWireBytes: Buffer.byteLength(serializeEvidence({ source: "S1", data: result })), fullToolSchemaBytes: Buffer.byteLength(JSON.stringify(all)), focusedToolSchemaBytes: Buffer.byteLength(JSON.stringify(focused)), localQueryMs: Math.round(elapsedMs), note: "UTF-8 bytes and local computation only; not measured model tokens, provider cost, or model-choice quality." }, null, 2));
} finally { await server.close(); }
