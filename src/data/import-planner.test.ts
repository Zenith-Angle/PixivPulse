import { describe, expect, it } from "vitest";
import { accountFollowerSampleStableIdentity, buildPortableImportPlan, sampleStableIdentity } from "./import-planner";
import type { PortableBackupPayload } from "./portable-backup";
import type { SyncRun, WorkRecord, WorkSample } from "../domain/types";

const run = (id: string): SyncRun => ({
  runId: id, trigger: "manual", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:01.000Z",
  status: "completed", pages: 1, works: 1, changedWorks: 1, errorCode: null, errorMessage: null,
});
const work = (title = "One"): WorkRecord => ({
  key: "illust-1", id: "1", type: "illust", title, seriesTitle: null, publishedAt: null, wordCount: null, pageCount: 1,
  isAi: null, isR18: null, thumbnailUrl: null, workUrl: "https://www.pixiv.net/artworks/1",
  metrics: { likes: 1, bookmarks: 1, views: 10, comments: 0, rank: null, responses: null, illustrations: null },
  rawLabels: {}, missingFields: [], parserVersion: 1, firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:01.000Z", lastObservedRunId: "run-1", absentSince: null,
});
const sample = (views = 10, id?: number): WorkSample => ({
  ...(id === undefined ? {} : { id }), workKey: "illust-1", runId: "run-1", collectedAt: "2026-09-01T00:00:01.000Z",
  metrics: { likes: 1, bookmarks: 1, views, comments: 0, rank: null, responses: null, illustrations: null }, parserVersion: 1, dataQuality: 1, kind: "change",
});
const followerSample = (followers = 10, runId = "run-1") => ({
  runId, accountId: "24680", collectedAt: "2026-09-01T00:00:01.000Z", followers,
});
const payload = (values: Partial<PortableBackupPayload> = {}): PortableBackupPayload => ({
  kind: "full", account: null,
  settings: { onboardingComplete: true, scheduledSyncEnabled: true, syncIntervalHours: 1, showPixivChips: true, theme: "system" },
  works: [work()], samples: [sample()], observationBatches: [{ runId: "run-1", observedAt: "2026-09-01T00:00:01.000Z", workKeys: ["illust-1"], changedWorkKeys: ["illust-1"], scope: "complete" }],
  runs: [run("run-1")], cachePolicy: "regenerate-covers", ...values,
});

describe("portable import planner", () => {
  it("deduplicates samples independently of auto-increment ids", () => {
    expect(sampleStableIdentity(sample(10, 1))).toBe(sampleStableIdentity(sample(10, 99)));
    const plan = buildPortableImportPlan(payload({ samples: [sample(10, 1)] }), payload({ samples: [sample(10, 99)] }));
    expect(plan.samples).toMatchObject({ inserts: [], duplicateCount: 1, conflictKeys: [] });
    expect(plan.canCommit).toBe(true);
  });

  it("fails closed when the same stable sample identity has different data", () => {
    const plan = buildPortableImportPlan(payload({ samples: [sample(10)] }), payload({ samples: [sample(11)] }));
    expect(plan.samples.conflictKeys).toEqual([sampleStableIdentity(sample(10))]);
    expect(plan.canCommit).toBe(false);
  });

  it("keeps current local work metadata while inserting new history", () => {
    const local = payload({ works: [work("Current")], samples: [], observationBatches: [], runs: [] });
    const incoming = payload({ works: [work("Older backup")] });
    const plan = buildPortableImportPlan(local, incoming);
    expect(plan.works.inserts).toEqual([]);
    expect(plan.works.keptLocalCount).toBe(1);
    expect(plan.samples.inserts).toHaveLength(1);
    expect(plan.canCommit).toBe(true);
  });

  it("deduplicates and conflicts follower samples by run id", () => {
    expect(accountFollowerSampleStableIdentity(followerSample(10))).toBe("run-1");
    const duplicate = buildPortableImportPlan(
      payload({ accountFollowerSamples: [followerSample(10)] }),
      payload({ accountFollowerSamples: [followerSample(10)] }),
    );
    expect(duplicate.accountFollowerSamples).toMatchObject({ inserts: [], duplicateCount: 1, conflictKeys: [] });
    expect(duplicate.canCommit).toBe(true);

    const conflict = buildPortableImportPlan(
      payload({ accountFollowerSamples: [followerSample(10)] }),
      payload({ accountFollowerSamples: [followerSample(11)] }),
    );
    expect(conflict.accountFollowerSamples?.conflictKeys).toEqual(["run-1"]);
    expect(conflict.canCommit).toBe(false);
  });
});
