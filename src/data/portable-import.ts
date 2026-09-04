import { getDatabase } from "./database";
import { buildPortableImportPlan } from "./import-planner";
import { AccountMismatchError, clearImportStaging, getDashboardData, getImportStaging, getSettings, saveSettings, stageImportChunk } from "./repository";
import { parsePortableBackupDocument } from "./portable-backup-csv";
import { isNativePortableEnvelope, type NativePortableBackupEnvelope, type PortableDocumentPreview } from "./portable-native";
import { encodeObservationBatch, encodeWorkDocument, encodeWorkSample, encodeWorkState } from "./storage-codec";
import { bumpDataRevision } from "./local-state";
import type { AccountFollowerRecord } from "../domain/types";
import { assignWorkOrdinal, createWorkDictionary } from "../domain/metric-frames";
import {
  createMetricFrame,
  createMetricKeyframe,
  decodeWorkDictionary,
  encodeMetricFrame,
  encodeMetricKeyframe,
  encodeWorkDictionary,
  unpackMetricOrdinals,
} from "./metric-frame-codec";

const IMPORT_CHUNK_CHARACTERS = 256 * 1024;
const IMPORT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface StagedPortableImport {
  sessionId: string;
  chunks: number;
  checksum: string;
}

export interface PortableImportCommitResult {
  works: number;
  samples: number;
  accountFollowerSamples: number;
  observationBatches: number;
  runs: number;
  duplicates: number;
}

function sessionId(): string {
  return `import-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function stagePortableImport(preview: PortableDocumentPreview): Promise<StagedPortableImport> {
  const text = JSON.stringify(preview.envelope);
  const id = sessionId();
  const checksum = preview.envelope.checksum.value;
  const chunks = Math.ceil(text.length / IMPORT_CHUNK_CHARACTERS);
  try {
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      await stageImportChunk({
        sessionId: id,
        chunk,
        payload: text.slice(chunk * IMPORT_CHUNK_CHARACTERS, (chunk + 1) * IMPORT_CHUNK_CHARACTERS),
        createdAt: new Date().toISOString(),
        checksum,
      });
    }
  } catch (error) {
    await clearImportStaging(id).catch(() => undefined);
    throw error;
  }
  return { sessionId: id, chunks, checksum };
}

function importedSampleWithoutId(sample: Parameters<typeof encodeWorkSample>[0]): Parameters<typeof encodeWorkSample>[0] {
  const { id: _id, ...withoutId } = sample;
  return withoutId;
}

async function commitNativePortableImport(
  envelope: NativePortableBackupEnvelope,
  preview: PortableDocumentPreview,
  sessionIdValue: string,
  staged: Awaited<ReturnType<typeof getImportStaging>>,
): Promise<PortableImportCommitResult> {
  const current = await getDashboardData();
  const plan = buildPortableImportPlan({
    works: current.works,
    samples: current.samples,
    accountFollowerSamples: current.accountFollowerSamples ?? [],
    observationBatches: current.observationBatches ?? [],
    runs: current.runs,
  }, preview.logicalPayload);
  if (!plan.canCommit) throw new Error("备份存在同身份但内容不同的历史记录，已停止合并");

  const db = await getDatabase();
  const tx = db.transaction([
    "works", "workStates", "workDictionary", "metricFrames", "metricKeyframes", "analyticsSchemaState",
    "accountFollowerRecords", "syncRuns", "storageMeta", "importStaging",
  ], "readwrite");
  try {
    const followerStore = tx.objectStore("accountFollowerRecords");
    const followerExisting = new Map<string, AccountFollowerRecord | undefined>();
    for (const sample of plan.accountFollowerSamples?.inserts ?? []) {
      const existing = await followerStore.get(sample.runId);
      followerExisting.set(sample.runId, existing);
      if (existing && (existing.accountId !== sample.accountId || existing.status !== "ready"
        || existing.collectedAt !== sample.collectedAt || existing.followers !== sample.followers)) {
        throw new Error("备份存在同身份但内容不同的粉丝样本，已停止合并");
      }
    }

    const incomingDocuments = new Map(envelope.payload.workDocuments.map((value) => [value.key, value]));
    const incomingStates = new Map(envelope.payload.workStates.map((value) => [value.key, value]));
    const workStore = tx.objectStore("works");
    const stateStore = tx.objectStore("workStates");
    for (const work of plan.works.inserts) {
      const document = incomingDocuments.get(work.key);
      const state = incomingStates.get(work.key);
      if (!document || !state) throw new Error(`原生备份缺少作品存储记录：${work.key}`);
      await workStore.put(document, work.key);
      await stateStore.put(state, work.key);
    }

    const dictionaryStore = tx.objectStore("workDictionary");
    const frameStore = tx.objectStore("metricFrames");
    const keyframeStore = tx.objectStore("metricKeyframes");
    const schemaStore = tx.objectStore("analyticsSchemaState");
    const existingDictionaryValue = await dictionaryStore.get("root");
    const existingFrameCount = await frameStore.count();
    const existingWorkCount = await workStore.count();
    const exactRestore = existingFrameCount === 0 && existingWorkCount === plan.works.inserts.length
      && current.samples.length === 0 && (current.observationBatches?.length ?? 0) === 0
      && current.runs.length === 0 && (current.accountFollowerSamples?.length ?? 0) === 0;

    if (exactRestore) {
      await dictionaryStore.put(envelope.payload.workDictionary, "root");
      for (const frame of envelope.payload.metricFrames) await frameStore.put(frame);
      for (const keyframe of envelope.payload.metricKeyframes) await keyframeStore.put(keyframe);
      await schemaStore.put({
        key: "root",
        activeSchema: "frames",
        nextRunSeq: envelope.payload.analytics.nextRunSeq,
        migrationStatus: "ready",
        migrationCursor: null,
        migrationSnapshot: null,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const incomingDictionary = decodeWorkDictionary(envelope.payload.workDictionary);
      let mergedDictionary = existingDictionaryValue == null
        ? createWorkDictionary()
        : decodeWorkDictionary(existingDictionaryValue);
      const localOrdinalByKey = new Map(mergedDictionary.entries.map((entry) => [entry.workKey, entry.ordinal]));
      for (const entry of incomingDictionary.entries) {
        if (localOrdinalByKey.has(entry.workKey)) continue;
        const assigned = assignWorkOrdinal(mergedDictionary, entry.workKey);
        mergedDictionary = assigned.dictionary;
        localOrdinalByKey.set(entry.workKey, assigned.ordinal);
      }
      const incomingKeyByOrdinal = new Map(incomingDictionary.entries.map((entry) => [entry.ordinal, entry.workKey]));
      const remapOrdinal = (ordinal: number): number => {
        const key = incomingKeyByOrdinal.get(ordinal);
        const mapped = key == null ? undefined : localOrdinalByKey.get(key);
        if (mapped == null) throw new Error("原生备份作品字典无法合并");
        return mapped;
      };
      const schema = await schemaStore.get("root");
      let nextRunSeq = schema?.nextRunSeq ?? Math.max(0, ...((await frameStore.getAll()).map((frame) => frame.runSeq + 1)));
      const insertedRunIds = new Set(plan.observationBatches.inserts.map((batch) => batch.runId));
      const runSeqMap = new Map<number, number>();
      const importedFrames = envelope.payload.metricFrames
        .filter((frame) => insertedRunIds.has(frame.runId))
        .sort((left, right) => left.epochMs - right.epochMs || left.runSeq - right.runSeq);
      for (const frame of importedFrames) {
        const runSeq = nextRunSeq++;
        runSeqMap.set(frame.runSeq, runSeq);
        const remapped = createMetricFrame({
          ...frame,
          runSeq,
          observedOrdinals: unpackMetricOrdinals(frame.observed).map(remapOrdinal),
          changes: frame.changes.map((change) => [remapOrdinal(change[0]), change[1], change[2], [...change[3]], change[4], change[5], change[6]]),
        });
        await frameStore.put(encodeMetricFrame(remapped));
      }
      for (const keyframe of envelope.payload.metricKeyframes) {
        const runSeq = runSeqMap.get(keyframe.runSeq);
        if (runSeq == null) continue;
        const remapped = createMetricKeyframe({ ...keyframe, runSeq }, keyframe.states.map((state) => ({
          ...state,
          ordinal: remapOrdinal(state.ordinal),
          lastObserved: state.lastObserved == null ? null : { ...state.lastObserved, runSeq },
        })), keyframe.provenance);
        await keyframeStore.put(encodeMetricKeyframe(remapped));
      }
      await dictionaryStore.put(encodeWorkDictionary(mergedDictionary), "root");
      await schemaStore.put({
        key: "root",
        activeSchema: "frames",
        nextRunSeq,
        migrationStatus: "ready",
        migrationCursor: null,
        migrationSnapshot: null,
        updatedAt: new Date().toISOString(),
      });
    }

    for (const sample of plan.accountFollowerSamples?.inserts ?? []) {
      if (followerExisting.get(sample.runId)) continue;
      await followerStore.add({
        runId: sample.runId,
        accountId: sample.accountId,
        collectedAt: sample.collectedAt,
        status: "ready",
        followers: sample.followers,
        errorCode: null,
      });
    }
    for (const run of plan.runs.inserts) await tx.objectStore("syncRuns").add(run, run.runId);
    const metaStore = tx.objectStore("storageMeta");
    const meta = await metaStore.get("root");
    await metaStore.put({ key: "root", dataRevision: (meta?.dataRevision ?? 0) + 1 });
    const stagingStore = tx.objectStore("importStaging");
    for (const chunk of staged) await stagingStore.delete(chunk.key);
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
  return {
    works: plan.works.inserts.length,
    samples: plan.samples.inserts.length,
    accountFollowerSamples: plan.accountFollowerSamples?.inserts.length ?? 0,
    observationBatches: plan.observationBatches.inserts.length,
    runs: plan.runs.inserts.length,
    duplicates: plan.works.duplicateCount + plan.samples.duplicateCount + (plan.accountFollowerSamples?.duplicateCount ?? 0)
      + plan.observationBatches.duplicateCount + plan.runs.duplicateCount,
  };
}

export async function commitStagedPortableImport(sessionIdValue: string, expectedChecksum: string): Promise<PortableImportCommitResult> {
  const staged = await getImportStaging(sessionIdValue);
  if (staged.length === 0) throw new Error("导入暂存数据不存在或已过期");
  const createdAt = Date.parse(staged[0]?.createdAt ?? "");
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > IMPORT_STAGING_MAX_AGE_MS) {
    await clearImportStaging(sessionIdValue);
    throw new Error("导入预览已过期，请重新选择备份文件");
  }
  const text = staged.map((chunk, index) => {
    if (chunk.chunk !== index || chunk.checksum !== expectedChecksum || typeof chunk.payload !== "string") throw new Error("导入暂存数据不完整");
    return chunk.payload;
  }).join("");

  const current = await getDashboardData();
  const settings = await getSettings();
  const preview = await parsePortableBackupDocument(text, {
    localAccountId: settings.boundAccount?.id ?? null,
    localIsEmpty: current.works.length === 0
      && current.samples.length === 0
      && (current.accountFollowerSamples?.length ?? 0) === 0,
  });
  if (preview.envelope.checksum.value !== expectedChecksum) throw new Error("导入文件校验和与预览不一致");
  if (preview.accountMatch === "mismatch") throw new Error("备份账号与当前 Pixiv 账号不一致");
  if (!settings.boundAccount && current.works.length > 0 && preview.envelope.payload.account) {
    throw new Error("本地数据已有内容但没有可靠账号绑定，已停止合并");
  }
  if (isNativePortableEnvelope(preview.envelope)) {
    const result = await commitNativePortableImport(preview.envelope, preview, sessionIdValue, staged);
    const importedSettings = preview.logicalPayload.settings;
    await saveSettings({ ...settings, ...importedSettings, boundAccount: settings.boundAccount ?? preview.logicalPayload.account });
    await bumpDataRevision();
    return result;
  }
  const plan = buildPortableImportPlan({
    works: current.works,
    samples: current.samples,
    accountFollowerSamples: current.accountFollowerSamples ?? [],
    observationBatches: current.observationBatches ?? [],
    runs: current.runs,
  }, preview.logicalPayload);
  if (!plan.canCommit) throw new Error("备份存在同身份但内容不同的历史记录，已停止合并");

  const db = await getDatabase();
  const tx = db.transaction(["works", "workStates", "samples", "accountFollowerRecords", "observationBatches", "syncRuns", "storageMeta", "importStaging"], "readwrite");
  try {
    const followerStore = tx.objectStore("accountFollowerRecords");
    const followerExisting = new Map<string, AccountFollowerRecord | undefined>();
    // Preflight every follower row before issuing any write. The dashboard
    // only exposes trusted ready rows, so a hidden pending/unavailable row
    // would not have been visible to the planner; fail before works/samples/
    // runs can be partially published.
    for (const sample of plan.accountFollowerSamples?.inserts ?? []) {
      const existing = await followerStore.get(sample.runId);
      followerExisting.set(sample.runId, existing);
      if (existing) {
        // The dashboard-facing planner only sees trusted ready rows. A hidden
        // pending/unavailable or cross-account row must not be overwritten by
        // an import that happens to reuse its run id.
        if (existing.accountId !== sample.accountId) throw new AccountMismatchError();
        if (existing.status !== "ready"
          || existing.collectedAt !== sample.collectedAt
          || existing.followers !== sample.followers) {
          throw new Error("备份存在同身份但内容不同的粉丝样本，已停止合并");
        }
      }
    }
    const workStore = tx.objectStore("works");
    const stateStore = tx.objectStore("workStates");
    for (const work of plan.works.inserts) {
      await workStore.put(encodeWorkDocument(work), work.key);
      await stateStore.put(encodeWorkState(work), work.key);
    }
    for (const sample of plan.samples.inserts) await tx.objectStore("samples").add(encodeWorkSample(importedSampleWithoutId(sample)));
    for (const sample of plan.accountFollowerSamples?.inserts ?? []) {
      if (followerExisting.get(sample.runId)) continue;
      const record: AccountFollowerRecord = {
        runId: sample.runId,
        accountId: sample.accountId,
        collectedAt: sample.collectedAt,
        status: "ready",
        followers: sample.followers,
        errorCode: null,
      };
      await followerStore.add(record);
    }
    for (const batch of plan.observationBatches.inserts) await tx.objectStore("observationBatches").add(encodeObservationBatch(batch));
    for (const run of plan.runs.inserts) await tx.objectStore("syncRuns").add(run, run.runId);
    const metaStore = tx.objectStore("storageMeta");
    const meta = await metaStore.get("root");
    await metaStore.put({ key: "root", dataRevision: (meta?.dataRevision ?? 0) + 1 });
    const stagingStore = tx.objectStore("importStaging");
    for (const chunk of staged) await stagingStore.delete(chunk.key);
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await tx.done.catch(() => undefined);
    throw error;
  }

  const importedSettings = preview.envelope.payload.settings;
  await saveSettings({
    ...settings,
    ...importedSettings,
    boundAccount: settings.boundAccount ?? preview.envelope.payload.account,
  });
  await bumpDataRevision();
  return {
    works: plan.works.inserts.length,
    samples: plan.samples.inserts.length,
    accountFollowerSamples: plan.accountFollowerSamples?.inserts.length ?? 0,
    observationBatches: plan.observationBatches.inserts.length,
    runs: plan.runs.inserts.length,
    duplicates: plan.works.duplicateCount + plan.samples.duplicateCount + (plan.accountFollowerSamples?.duplicateCount ?? 0) + plan.observationBatches.duplicateCount + plan.runs.duplicateCount,
  };
}

export async function discardStagedPortableImport(sessionIdValue: string): Promise<void> {
  await clearImportStaging(sessionIdValue);
}
