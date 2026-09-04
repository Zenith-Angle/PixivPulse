import type { AccountFollowerSample, ObservationBatch, SyncRun, WorkRecord, WorkSample } from "../domain/types";
import { canonicalJson, type PortableBackupPayload } from "./portable-backup";

export interface ImportCollectionPlan<T> {
  inserts: T[];
  duplicateCount: number;
  conflictKeys: string[];
}

export interface PortableImportPlan {
  works: ImportCollectionPlan<WorkRecord> & { keptLocalCount: number };
  samples: ImportCollectionPlan<WorkSample>;
  /** Optional for UI/import fixtures authored before v5 follower support. */
  accountFollowerSamples?: ImportCollectionPlan<AccountFollowerSample>;
  observationBatches: ImportCollectionPlan<ObservationBatch>;
  runs: ImportCollectionPlan<SyncRun>;
  canCommit: boolean;
}

function withoutId<T extends { id?: number }>(value: T): Omit<T, "id"> {
  const { id: _id, ...rest } = value;
  return rest;
}

export function sampleStableIdentity(sample: WorkSample): string {
  return [sample.workKey, sample.collectedAt, sample.kind, sample.runId].join("\u0000");
}

/** One account-level follower sample is reserved per sync generation. */
export function accountFollowerSampleStableIdentity(sample: AccountFollowerSample): string {
  return sample.runId;
}

function planByKey<T>(
  local: readonly T[],
  incoming: readonly T[],
  keyOf: (value: T) => string,
  canonicalOf: (value: T) => string = canonicalJson,
): ImportCollectionPlan<T> {
  const localByKey = new Map<string, string>();
  for (const value of local) localByKey.set(keyOf(value), canonicalOf(value));
  const inserts: T[] = [];
  const conflictKeys: string[] = [];
  let duplicateCount = 0;
  const incomingSeen = new Map<string, string>();
  for (const value of incoming) {
    const key = keyOf(value);
    const canonical = canonicalOf(value);
    const sameIncoming = incomingSeen.get(key);
    if (sameIncoming !== undefined) {
      if (sameIncoming === canonical) duplicateCount += 1;
      else conflictKeys.push(key);
      continue;
    }
    incomingSeen.set(key, canonical);
    const current = localByKey.get(key);
    if (current === undefined) inserts.push(value);
    else if (current === canonical) duplicateCount += 1;
    else conflictKeys.push(key);
  }
  return { inserts, duplicateCount, conflictKeys: [...new Set(conflictKeys)].sort() };
}

export function buildPortableImportPlan(
  local: Pick<PortableBackupPayload, "works" | "samples" | "observationBatches" | "runs"> & { accountFollowerSamples?: AccountFollowerSample[] },
  incoming: PortableBackupPayload,
): PortableImportPlan {
  const worksBase = planByKey(local.works, incoming.works, (work) => work.key);
  // A live local work remains authoritative. Historical samples and runs can
  // still be merged without replacing its current metrics or metadata.
  const localWorkKeys = new Set(local.works.map((work) => work.key));
  const works = {
    inserts: worksBase.inserts,
    duplicateCount: worksBase.duplicateCount,
    conflictKeys: [] as string[],
    keptLocalCount: worksBase.conflictKeys.filter((key) => localWorkKeys.has(key)).length,
  };
  const samples = planByKey(
    local.samples,
    incoming.samples,
    sampleStableIdentity,
    (sample) => canonicalJson(withoutId(sample)),
  );
  const accountFollowerSamples = planByKey(
    local.accountFollowerSamples ?? [],
    incoming.accountFollowerSamples ?? [],
    accountFollowerSampleStableIdentity,
    (sample) => canonicalJson(sample),
  );
  const observationBatches = planByKey(
    local.observationBatches,
    incoming.observationBatches,
    (batch) => batch.runId,
  );
  const runs = planByKey(local.runs, incoming.runs, (run) => run.runId);
  return {
    works,
    samples,
    accountFollowerSamples,
    observationBatches,
    runs,
    canCommit: samples.conflictKeys.length === 0
      && accountFollowerSamples.conflictKeys.length === 0
      && observationBatches.conflictKeys.length === 0
      && runs.conflictKeys.length === 0,
  };
}
