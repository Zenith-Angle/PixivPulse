import { describe, expect, it } from "vitest";
import { canonicalJson, createPortableBackup, parsePortableBackupText, portableSettings, sha256Hex } from "./portable-backup";
import { parsePortableBackupDocument } from "./portable-backup-csv";
import type { SyncRun, WorkRecord, WorkSample } from "../domain/types";

const run: SyncRun = {
  runId: "run-1", trigger: "manual", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:01.000Z",
  status: "completed", pages: 1, works: 1, changedWorks: 1, errorCode: null, errorMessage: null,
};
const work: WorkRecord = {
  key: "illust-1", id: "1", type: "illust", title: "One", seriesTitle: null, publishedAt: null,
  wordCount: null, pageCount: 1, isAi: null, isR18: null, thumbnailUrl: null, workUrl: "https://www.pixiv.net/artworks/1",
  metrics: { likes: 1, bookmarks: 1, views: 10, comments: 0, rank: null, responses: null, illustrations: null },
  rawLabels: {}, missingFields: [], parserVersion: 1, firstSeenAt: run.startedAt, lastSeenAt: run.finishedAt!, lastObservedRunId: run.runId, absentSince: null,
};
const sample: WorkSample = {
  workKey: work.key, runId: run.runId, collectedAt: run.finishedAt!, metrics: work.metrics,
  parserVersion: 1, dataQuality: 1, kind: "change",
};

describe("portable backup", () => {
  it("round-trips a checksum-protected portable bundle", async () => {
    const envelope = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: { onboardingComplete: true, scheduledSyncEnabled: true, syncIntervalHours: 1, showPixivChips: true, theme: "system" },
      works: [work], samples: [sample], observationBatches: [{ runId: run.runId, observedAt: run.finishedAt!, workKeys: [work.key], changedWorkKeys: [work.key], scope: "complete" }], runs: [run],
    }, "2026-09-01T01:00:00.000Z");
    const preview = await parsePortableBackupText(JSON.stringify(envelope), { localAccountId: "42" });
    expect(preview.accountMatch).toBe("same");
    expect(preview.counts).toEqual({ works: 1, samples: 1, observationBatches: 1, runs: 1, accountFollowerSamples: 0 });
    expect(preview.envelope.payload.cachePolicy).toBe("regenerate-covers");
  });

  it("auto-detects legacy JSON through the unified document parser", async () => {
    const envelope = await createPortableBackup({
      kind: "full", account: null, settings: portableSettings(null), works: [work], samples: [sample], observationBatches: [], runs: [run],
    });
    await expect(parsePortableBackupDocument(JSON.stringify(envelope))).resolves.toMatchObject({ counts: { works: 1, samples: 1 } });
  });

  it("rejects tampering and unresolved backup references", async () => {
    const envelope = await createPortableBackup({
      kind: "full", account: null, settings: portableSettings(null), works: [work], samples: [sample], observationBatches: [], runs: [run],
    });
    const tampered = JSON.stringify(envelope).replace('"views":10', '"views":11');
    await expect(parsePortableBackupText(tampered)).rejects.toThrow(/校验失败/);

    const unresolved = await createPortableBackup({
      kind: "full", account: null, settings: portableSettings(null), works: [], samples: [sample], observationBatches: [], runs: [run],
    });
    await expect(parsePortableBackupText(JSON.stringify(unresolved))).rejects.toThrow(/不存在的作品/);
  });

  it("whitelists portable settings and reports account mismatch", async () => {
    const settings = portableSettings({
      onboardingComplete: true, scheduledSyncEnabled: true, syncIntervalHours: 2, showPixivChips: false, theme: "dark",
      lastCompactedAt: "machine-local", storageWarningBytes: 123,
    });
    expect(settings).toEqual({ onboardingComplete: true, scheduledSyncEnabled: true, syncIntervalHours: 2, showPixivChips: false, theme: "dark" });
    const envelope = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings, works: [work], samples: [sample], observationBatches: [], runs: [run],
    });
    expect((envelope.payload.settings as unknown as Record<string, unknown>).lastCompactedAt).toBeUndefined();
    expect((await parsePortableBackupText(JSON.stringify(envelope), { localAccountId: "99" })).accountMatch).toBe("mismatch");
  });

  it("verifies and upgrades an original v4 checksum while defaulting followers to empty", async () => {
    const current = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: portableSettings(null), works: [work], samples: [sample], observationBatches: [], runs: [run],
    });
    const legacy = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    legacy.formatVersion = 4;
    const payload = legacy.payload as Record<string, unknown>;
    delete payload.accountFollowerSamples;
    const { checksum: _checksum, ...unsigned } = legacy;
    legacy.checksum = { algorithm: "SHA-256", value: await sha256Hex(canonicalJson(unsigned)) };

    const preview = await parsePortableBackupText(JSON.stringify(legacy), { localAccountId: "42" });
    expect(preview.envelope.formatVersion).toBe(5);
    expect(preview.envelope.payload.accountFollowerSamples).toEqual([]);
    expect(preview.counts.accountFollowerSamples).toBe(0);
    expect(preview.warnings).toContain("旧版备份会在导入时升级为当前格式");

    legacy.checksum = { algorithm: "SHA-256", value: "0".repeat(64) };
    await expect(parsePortableBackupText(JSON.stringify(legacy))).rejects.toThrow(/校验失败/);
  });

  it("strictly validates v5 follower values, account identity, and completed-run references", async () => {
    const valid = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: portableSettings(null), works: [work], samples: [sample], observationBatches: [], runs: [run],
      accountFollowerSamples: [{ runId: run.runId, accountId: "42", collectedAt: run.finishedAt!, followers: 123 }],
    });
    await expect(parsePortableBackupText(JSON.stringify(valid), { localAccountId: "42" })).resolves.toMatchObject({
      counts: { accountFollowerSamples: 1 },
    });

    const invalidFollowers = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: portableSettings(null), works: [work], samples: [sample], observationBatches: [], runs: [run],
      accountFollowerSamples: [{ runId: run.runId, accountId: "42", collectedAt: run.finishedAt!, followers: -1 }],
    });
    await expect(parsePortableBackupText(JSON.stringify(invalidFollowers))).rejects.toThrow(/粉丝样本字段无效/);

    const wrongAccount = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: portableSettings(null), works: [work], samples: [sample], observationBatches: [], runs: [run],
      accountFollowerSamples: [{ runId: run.runId, accountId: "99", collectedAt: run.finishedAt!, followers: 1 }],
    });
    await expect(parsePortableBackupText(JSON.stringify(wrongAccount))).rejects.toThrow(/账号不一致/);

    const failedRun = { ...run, status: "failed" as const };
    const unresolved = await createPortableBackup({
      kind: "full", account: { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" },
      settings: portableSettings(null), works: [work], samples: [], observationBatches: [], runs: [failedRun],
      accountFollowerSamples: [{ runId: failedRun.runId, accountId: "42", collectedAt: run.finishedAt!, followers: 1 }],
    });
    await expect(parsePortableBackupText(JSON.stringify(unresolved))).rejects.toThrow(/未完成/);
  });
});
