import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkDictionary } from "../domain/metric-frames";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { encodeWorkDictionary } from "./metric-frame-codec";
import {
  buildMetricFrame,
  buildMetricFrameCompactionPlan,
  countStoredRetentionTiers,
  decodePublicFrameHistory,
  metricFrameDigest,
  metricFrameIdentity,
} from "./frame-storage";

async function reset(): Promise<void> {
  try { (await getDatabase()).close(); } catch { /* unopened */ }
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
}

const full = (views: number, likes: number) => ({
  likes, bookmarks: 1, views, comments: 0, rank: null, responses: 0, illustrations: 1,
});

async function projectedHistory(db: Awaited<ReturnType<typeof getDatabase>>, now: string) {
  const [dictionary, frames] = await Promise.all([
    db.get("workDictionary", "root"),
    db.getAll("metricFrames"),
  ]);
  const plan = buildMetricFrameCompactionPlan(frames, now);
  const deleted = new Set(plan.deletes.map((entry) => entry.sourceIdentity));
  const rewritten = new Map(plan.rewrites.map((entry) => [entry.sourceIdentity, entry.frame]));
  const projected = frames
    .filter((frame) => !deleted.has(metricFrameIdentity(frame)))
    .map((frame) => rewritten.get(metricFrameIdentity(frame)) ?? frame);
  return { plan, history: decodePublicFrameHistory(dictionary, projected) };
}

describe("metric frame storage", () => {
  beforeEach(reset);
  afterEach(reset);

  it("compacts staggered work and field changes independently", async () => {
    const db = await getDatabase();
    await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([
      { ordinal: 0, workKey: "illust-1" },
      { ordinal: 1, workKey: "illust-2" },
    ])), "root");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const frames = [
      buildMetricFrame({ runId: "base", runSeq: 0, collectedAt: new Date(base).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [
        { ordinal: 0, metrics: full(10, 1) }, { ordinal: 1, metrics: full(20, 2) },
      ] }),
      buildMetricFrame({ runId: "views", runSeq: 1, collectedAt: new Date(base + 10 * 60_000).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [
        { ordinal: 0, metrics: { views: 11 } },
      ] }),
      buildMetricFrame({ runId: "likes", runSeq: 2, collectedAt: new Date(base + 20 * 60_000).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [
        { ordinal: 1, metrics: { likes: 3 } },
      ] }),
    ];
    for (const frame of frames) await db.put("metricFrames", frame);

    const { plan, history } = await projectedHistory(db, "2026-08-10T00:00:00.000Z");
    expect(plan.considered).toBe(3);
    expect(history.samples.some((sample) => sample.workKey === "illust-1" && sample.metrics.views === 11)).toBe(true);
    expect(history.samples.some((sample) => sample.workKey === "illust-2" && sample.metrics.likes === 3)).toBe(true);
    expect(history.samples.at(-1)?.metrics).toBeDefined();
  });

  it("uses one shared frame row instead of per-work sample and batch rows", async () => {
    const db = await getDatabase();
    const dictionary = createWorkDictionary(Array.from({ length: 50 }, (_, ordinal) => ({ ordinal, workKey: `illust-${ordinal + 1}` })));
    await db.put("workDictionary", encodeWorkDictionary(dictionary), "root");
    const changes = dictionary.entries.map(({ ordinal }) => ({ ordinal, metrics: full(100 + ordinal, ordinal) }));
    const frame = buildMetricFrame({
      runId: "run", runSeq: 0, collectedAt: "2026-09-01T00:00:00.000Z", scope: "complete",
      parser: 1, quality: 1, observedOrdinals: dictionary.entries.map((entry) => entry.ordinal), changes,
    });
    await db.put("metricFrames", frame);
    expect(await db.count("metricFrames")).toBe(1);
    expect(await db.count("samples")).toBe(0);
    expect(await db.count("observationBatches")).toBe(0);
    expect(JSON.stringify(frame).length).toBeLessThan(JSON.stringify({
      samples: changes.map((change) => ({ runId: "run", collectedAt: "2026-09-01T00:00:00.000Z", workKey: `illust-${change.ordinal + 1}`, metrics: change.metrics, parserVersion: 1, dataQuality: 1 })),
      batch: { runId: "run", observedAt: "2026-09-01T00:00:00.000Z", workKeys: dictionary.entries.map((entry) => entry.workKey) },
    }).length * 0.6);
  });

  it("retains complete-frame absence and reappearance transitions during compaction", async () => {
    const db = await getDatabase();
    await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([
      { ordinal: 0, workKey: "illust-1" }, { ordinal: 1, workKey: "illust-2" },
    ])), "root");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const frames = [
      buildMetricFrame({ runId: "present", runSeq: 0, collectedAt: new Date(base).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [
        { ordinal: 0, metrics: full(1, 1) }, { ordinal: 1, metrics: full(2, 2) },
      ] }),
      buildMetricFrame({ runId: "absent", runSeq: 1, collectedAt: new Date(base + 10 * 60_000).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0], changes: [] }),
      buildMetricFrame({ runId: "returned", runSeq: 2, collectedAt: new Date(base + 20 * 60_000).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [] }),
    ];
    for (const frame of frames) await db.put("metricFrames", frame);
    const { history } = await projectedHistory(db, "2026-08-10T00:00:00.000Z");
    expect(history.observationBatches.map((batch) => [batch.runId, batch.workKeys])).toEqual([
      ["present", ["illust-1", "illust-2"]],
      ["absent", ["illust-1"]],
      ["returned", ["illust-1", "illust-2"]],
    ]);
  });

  it("retains partial observations when a work reappears without a metric change", async () => {
    const db = await getDatabase();
    await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([
      { ordinal: 0, workKey: "illust-1" }, { ordinal: 1, workKey: "illust-2" },
    ])), "root");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const frames = [
      buildMetricFrame({ runId: "base", runSeq: 0, collectedAt: new Date(base).toISOString(), scope: "complete", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [
        { ordinal: 0, metrics: full(1, 1) }, { ordinal: 1, metrics: full(2, 2) },
      ] }),
      buildMetricFrame({ runId: "partial-one", runSeq: 1, collectedAt: new Date(base + 10 * 60_000).toISOString(), scope: "partial", parser: 1, quality: 1, observedOrdinals: [0], changes: [] }),
      buildMetricFrame({ runId: "partial-return", runSeq: 2, collectedAt: new Date(base + 20 * 60_000).toISOString(), scope: "partial", parser: 1, quality: 1, observedOrdinals: [0, 1], changes: [] }),
    ];
    for (const frame of frames) await db.put("metricFrames", frame);

    const { history } = await projectedHistory(db, "2026-08-10T00:00:00.000Z");

    expect(history.observationBatches.map((batch) => [batch.runId, batch.workKeys])).toEqual([
      ["base", ["illust-1", "illust-2"]],
      ["partial-one", ["illust-1"]],
      ["partial-return", ["illust-1", "illust-2"]],
    ]);
  });

  it("retains an empty complete frame as the all-works-absent transition", async () => {
    const db = await getDatabase();
    await db.put("workDictionary", encodeWorkDictionary(createWorkDictionary([
      { ordinal: 0, workKey: "illust-1" },
    ])), "root");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    await db.put("metricFrames", buildMetricFrame({
      runId: "present",
      runSeq: 0,
      collectedAt: new Date(base).toISOString(),
      scope: "complete",
      parser: 1,
      quality: 1,
      observedOrdinals: [0],
      changes: [{ ordinal: 0, metrics: full(1, 1) }],
    }));
    await db.put("metricFrames", buildMetricFrame({
      runId: "all-absent",
      runSeq: 1,
      collectedAt: new Date(base + 10 * 60_000).toISOString(),
      scope: "complete",
      parser: 1,
      quality: 1,
      observedOrdinals: [],
      changes: [],
    }));

    const { history } = await projectedHistory(db, "2026-08-10T00:00:00.000Z");

    expect(history.observationBatches.map((batch) => [batch.runId, batch.workKeys])).toEqual([
      ["present", ["illust-1"]],
      ["all-absent", []],
    ]);
  });

  it("starts frame thinning at exactly 72 hours", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const frames = [24, 48, 72].map((hours, index) => buildMetricFrame({
      runId: `age-${hours}`,
      runSeq: index,
      collectedAt: new Date(now - hours * 3_600_000).toISOString(),
      scope: "complete",
      parser: 1,
      quality: 1,
      observedOrdinals: [],
      changes: [],
    }));

    const plan = buildMetricFrameCompactionPlan(frames, now);

    expect(plan.considered).toBe(1);
    expect(plan.rewrites.map((rewrite) => rewrite.sourceIdentity)).toEqual([metricFrameIdentity(frames[2]!)]);
    expect(plan.rewrites[0]?.frame.kind).toBe("compacted");
    expect(plan.rewrites.map((rewrite) => rewrite.sourceIdentity)).not.toContain(metricFrameIdentity(frames[0]!));
    expect(plan.rewrites.map((rewrite) => rewrite.sourceIdentity)).not.toContain(metricFrameIdentity(frames[1]!));
  });

  it("reports lossy sources and produces an idempotent pure plan", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const frames = [
      buildMetricFrame({
        runId: "base",
        runSeq: 0,
        collectedAt: "2026-08-06T00:00:00.000Z",
        scope: "complete",
        parser: 1,
        quality: 1,
        observedOrdinals: [0],
        changes: [{ ordinal: 0, metrics: full(10, 1) }],
      }),
      buildMetricFrame({
        runId: "superseded",
        runSeq: 1,
        collectedAt: "2026-08-06T00:10:00.000Z",
        scope: "complete",
        parser: 1,
        quality: 1,
        observedOrdinals: [0],
        changes: [{ ordinal: 0, metrics: { views: 11 } }],
      }),
      buildMetricFrame({
        runId: "winner",
        runSeq: 2,
        collectedAt: "2026-08-06T00:20:00.000Z",
        scope: "complete",
        parser: 1,
        quality: 1,
        observedOrdinals: [0],
        changes: [{ ordinal: 0, metrics: { views: 12 } }],
      }),
    ];

    const plan = buildMetricFrameCompactionPlan(frames, now);
    expect(plan.lossySources).toEqual([frames[1]]);
    expect(plan.rewrites.find((rewrite) => rewrite.sourceIdentity === metricFrameIdentity(frames[0]!))?.sourceDigest)
      .toBe(metricFrameDigest(frames[0]!));

    const compacted = frames.map((frame) => plan.rewrites.find((rewrite) => rewrite.sourceIdentity === metricFrameIdentity(frame))?.frame ?? frame);
    const secondPlan = buildMetricFrameCompactionPlan(compacted, now);
    expect(secondPlan).toEqual({ considered: 3, rewrites: [], deletes: [], lossySources: [] });
  });

  it("counts legacy samples and frame changes at exact retention boundaries", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const legacySamples = [
      { collectedAt: new Date(now - 3_600_000).toISOString() },
      { collectedAt: new Date(now - 72 * 3_600_000).toISOString() },
      { collectedAt: new Date(now - 7 * 86_400_000).toISOString() },
      { collectedAt: new Date(now - 30 * 86_400_000).toISOString() },
      { collectedAt: new Date(now - 90 * 86_400_000).toISOString() },
      { collectedAt: new Date(now + 3_600_000).toISOString() },
      { collectedAt: "malformed" },
    ];
    const frameAt = (ageMs: number, runId: string, changeCount = 1) => buildMetricFrame({
      runId,
      runSeq: 0,
      collectedAt: new Date(now - ageMs).toISOString(),
      scope: "complete",
      parser: 1,
      quality: 1,
      observedOrdinals: Array.from({ length: changeCount }, (_, ordinal) => ordinal),
      changes: Array.from({ length: changeCount }, (_, ordinal) => ({ ordinal, metrics: full(10 + ordinal, ordinal) })),
    });
    const frames = [
      frameAt(3_600_000, "frame-lossless"),
      frameAt(72 * 3_600_000, "frame-2h", 2),
      frameAt(7 * 86_400_000, "frame-6h"),
      frameAt(30 * 86_400_000, "frame-day"),
      frameAt(90 * 86_400_000, "frame-daily"),
    ];

    const counts = countStoredRetentionTiers(legacySamples, frames, now);

    expect(counts).toEqual({ lossless: 3, "30m": 3, "1h": 2, "6h": 4 });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(legacySamples.length - 1 + frames.reduce((sum, frame) => sum + frame.changes.length, 0));
  });
});
