import { describe, expect, it } from "vitest";
import type { MetricFrame } from "../domain/metric-frames";
import { createWorkDictionary } from "../domain/metric-frames";
import type { AccountFollowerSample, AppSettings, SyncRun, WorkRecord } from "../domain/types";
import { createMetricFrame, encodeWorkDictionary } from "./metric-frame-codec";
import {
  createPreCompactionBackup,
  preCompactionFrameDigest,
  preCompactionFrameIdentity,
  type PreCompactionBackupGenerated,
  type PreCompactionDirectoryHandle,
  type PreCompactionFile,
  type PreCompactionFileHandle,
  type PreCompactionWritable,
} from "./pre-compaction-backup";
import { canonicalJson } from "./portable-backup";
import { verifyPreCompactionBackupText, writeAndVerifyPreCompactionBackup } from "./pre-compaction-backup";

const account = { id: "42", name: "Author", profileUrl: "https://www.pixiv.net/users/42" };
const settings: Partial<AppSettings> = {
  onboardingComplete: true,
  scheduledSyncEnabled: false,
  syncIntervalHours: 1,
  showPixivChips: true,
  theme: "system",
};

const metrics = (views: number, likes = 1) => ({
  likes,
  bookmarks: 2,
  views,
  comments: 0,
  rank: null,
  responses: null,
  illustrations: null,
});

const work = (key: string): WorkRecord => ({
  key,
  id: key.replace("illust-", ""),
  type: "illust",
  title: key,
  seriesTitle: null,
  publishedAt: null,
  wordCount: null,
  pageCount: 1,
  isAi: null,
  isR18: null,
  thumbnailUrl: null,
  workUrl: `https://www.pixiv.net/artworks/${key.replace("illust-", "")}`,
  metrics: metrics(10),
  rawLabels: {},
  missingFields: [],
  parserVersion: 1,
  firstSeenAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-09-01T01:00:00.000Z",
  lastObservedRunId: "run-2",
  absentSince: null,
});

const runs: SyncRun[] = [
  {
    runId: "run-1",
    trigger: "manual",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:00:01.000Z",
    status: "completed",
    pages: 1,
    works: 1,
    changedWorks: 1,
    errorCode: null,
    errorMessage: null,
  },
  {
    runId: "run-2",
    trigger: "manual",
    startedAt: "2026-09-01T01:00:00.000Z",
    finishedAt: "2026-09-01T01:00:01.000Z",
    status: "completed",
    pages: 1,
    works: 1,
    changedWorks: 1,
    errorCode: null,
    errorMessage: null,
  },
  {
    runId: "unselected-run",
    trigger: "scheduled",
    startedAt: "2026-09-01T02:00:00.000Z",
    finishedAt: "2026-09-01T02:00:01.000Z",
    status: "completed",
    pages: 1,
    works: 1,
    changedWorks: 0,
    errorCode: null,
    errorMessage: null,
  },
];

function frameHistory(): { frames: MetricFrame[]; selected: MetricFrame } {
  const first = createMetricFrame({
    runId: "run-1",
    runSeq: 1,
    epochMs: Date.parse("2026-09-01T00:00:01.000Z"),
    scope: "complete",
    parser: 1,
    quality: 1,
    observedOrdinals: [0],
    changes: [{ ordinal: 0, metrics: metrics(10) }],
  });
  const selected = createMetricFrame({
    runId: "run-2",
    runSeq: 2,
    epochMs: Date.parse("2026-09-01T01:00:01.000Z"),
    scope: "complete",
    parser: 1,
    quality: 1,
    observedOrdinals: [0],
    changes: [{ ordinal: 0, metrics: { views: 25 } }],
  });
  return { frames: [first, selected], selected };
}

async function inputForBackup() {
  const { frames, selected } = frameHistory();
  return {
    account,
    settings,
    works: [work("illust-1"), work("illust-unselected")],
    runs,
    accountFollowerSamples: [
      { runId: "run-1", accountId: account.id, collectedAt: runs[0]!.finishedAt!, followers: 100 },
      { runId: "run-2", accountId: account.id, collectedAt: runs[1]!.finishedAt!, followers: 120 },
    ] satisfies AccountFollowerSample[],
    storedDictionary: encodeWorkDictionary(createWorkDictionary([
      { ordinal: 0, workKey: "illust-1" },
      { ordinal: 1, workKey: "illust-unselected" },
    ])),
    allFrames: frames,
    sources: [{
      identity: preCompactionFrameIdentity(selected),
      digest: await preCompactionFrameDigest(selected),
      frame: selected,
    }],
  };
}

interface FakeFileState {
  text: string;
  failWrite?: boolean;
  failClose?: boolean;
  corruptOnWrite?: boolean;
}

class FakeFile implements PreCompactionFile {
  constructor(private readonly state: FakeFileState) {}

  get size(): number {
    return new TextEncoder().encode(this.state.text).byteLength;
  }

  async text(): Promise<string> {
    return this.state.text;
  }
}

class FakeWritable implements PreCompactionWritable {
  constructor(private readonly state: FakeFileState) {}

  write(data: string): void {
    if (this.state.failWrite) throw new Error("permission denied");
    this.state.text = this.state.corruptOnWrite ? `${data}corrupted` : data;
  }

  close(): void {
    if (this.state.failClose) throw new Error("close failed");
  }
}

class FakeFileHandle implements PreCompactionFileHandle {
  constructor(private readonly state: FakeFileState) {}

  async getFile(): Promise<PreCompactionFile> {
    return new FakeFile(this.state);
  }

  async createWritable(): Promise<PreCompactionWritable> {
    return new FakeWritable(this.state);
  }
}

class FakeDirectory implements PreCompactionDirectoryHandle {
  readonly files = new Map<string, FakeFileState>();

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<PreCompactionFileHandle> {
    let state = this.files.get(name);
    if (state === undefined && options.create !== true) throw new Error("file not found");
    if (state === undefined) {
      state = { text: "" };
      this.files.set(name, state);
    }
    return new FakeFileHandle(state);
  }
}

describe("pre-compaction portable backup", () => {
  it("materializes sparse selected frames and excludes unselected records", async () => {
    const generated = await createPreCompactionBackup(await inputForBackup(), "2026-09-02T00:00:00.000Z");
    expect(generated.envelope.formatVersion).toBe(5);
    expect(generated.envelope.payload.runs.map((run) => run.runId)).toEqual(["run-2"]);
    expect(generated.envelope.payload.works.map((value) => value.key)).toEqual(["illust-1"]);
    expect(generated.envelope.payload.samples).toHaveLength(1);
    expect(generated.envelope.payload.samples[0]?.metrics.views).toBe(25);
    expect(generated.envelope.payload.observationBatches.map((batch) => batch.runId)).toEqual(["run-2"]);
    expect(generated.envelope.payload.accountFollowerSamples?.map((sample) => sample.runId)).toEqual(["run-2"]);
    expect(generated.text).toBe(canonicalJson(generated.envelope));
    expect(generated.manifest.canonicalSamples).toBe(canonicalJson(generated.envelope.payload.samples));
    await expect(verifyPreCompactionBackupText(generated.text, generated.manifest)).resolves.toMatchObject({
      native: false,
      checksum: generated.checksum,
      counts: { works: 1, samples: 1, observationBatches: 1, runs: 1, accountFollowerSamples: 1 },
    });
  });

  it("rejects duplicate, missing, and mismatched frame sources", async () => {
    const input = await inputForBackup();
    const source = input.sources[0]!;
    await expect(createPreCompactionBackup({ ...input, sources: [source, source] })).rejects.toThrow(/重复/);
    await expect(createPreCompactionBackup({
      ...input,
      sources: [{ ...source, identity: "missing" }],
    })).rejects.toThrow(/不存在|标识不匹配/);
    await expect(createPreCompactionBackup({
      ...input,
      sources: [{ ...source, digest: "0".repeat(64) }],
    })).rejects.toThrow(/摘要/);
    await expect(createPreCompactionBackup({
      ...input,
      runs: runs.map((run) => run.runId === "run-2" ? { ...run, status: "failed" as const } : run),
    })).rejects.toThrow(/未完成/);
  });

  it("writes, reopens, and verifies a fake File System Access target", async () => {
    const generated = await createPreCompactionBackup(await inputForBackup());
    const directory = new FakeDirectory();
    const result = await writeAndVerifyPreCompactionBackup(directory, "partial.json", generated);
    expect(result.fileName).toBe("partial.json");
    expect(result.text).toBe(generated.text);
    expect(directory.files.get("partial.json")?.text).toBe(generated.text);
    await expect(writeAndVerifyPreCompactionBackup(directory, "partial.json", generated)).resolves.toMatchObject({ fileName: "partial.json" });
  });

  it("refuses unsafe names, different existing content, permission errors, and corruption", async () => {
    const generated = await createPreCompactionBackup(await inputForBackup());
    await expect(writeAndVerifyPreCompactionBackup(new FakeDirectory(), "../partial.json", generated)).rejects.toThrow(/文件名/);

    const mismatch = new FakeDirectory();
    mismatch.files.set("partial.json", { text: "existing content" });
    await expect(writeAndVerifyPreCompactionBackup(mismatch, "partial.json", generated)).rejects.toThrow(/拒绝覆盖/);

    const permission = new FakeDirectory();
    permission.files.set("partial.json", { text: "", failWrite: true });
    await expect(writeAndVerifyPreCompactionBackup(permission, "partial.json", generated)).rejects.toThrow(/permission/);

    const corruption = new FakeDirectory();
    corruption.files.set("partial.json", { text: "", corruptOnWrite: true });
    await expect(writeAndVerifyPreCompactionBackup(corruption, "partial.json", generated)).rejects.toThrow(/JSON|校验|样本|备份/);
  });
});
