import { deleteDB, openDB, unwrap, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import { DB_VERSION } from "../domain/constants";
import type {
  CoverRecord,
  AccountFollowerRecord,
  ImportStagingRecord,
  MaintenanceState,
  PagePayload,
  StorageMeta,
  SyncRun,
  WorkObservation,
  WorkDocument,
  WorkSample,
  WorkState,
} from "../domain/types";
import type { MetricFrame, MetricKeyframe } from "../domain/metric-frames";
import type { StoredWorkDictionary } from "./metric-frame-codec";
import type { BackupDirectoryConfig, BackupReceipt } from "./backup-types";

export interface AnalyticsSchemaState {
  key: "root";
  activeSchema: "legacy" | "frames";
  nextRunSeq: number;
  migrationStatus: "pending" | "running" | "ready" | "failed";
  migrationCursor: number | null;
  migrationSnapshot: AnalyticsMigrationSnapshot | null;
  updatedAt: string;
}

export interface AnalyticsMigrationSampleSource {
  id: number | null;
  identity: string;
  hash: string;
}

export interface AnalyticsMigrationBatchSource {
  runId: string;
  identity: string;
  hash: string;
}

export interface AnalyticsMigrationSnapshot {
  dataRevision: number;
  samples: AnalyticsMigrationSampleSource[];
  batches: AnalyticsMigrationBatchSource[];
}
import {
  decodeWorkDocument,
  decodeWorkSample,
  encodeObservationBatch,
  decodeObservationBatch,
  encodeWorkSample,
  encodeWorkState,
  type StoredObservationBatch,
  type StoredWorkSample,
} from "./storage-codec";

export interface StagedPage {
  key: string;
  runId: string;
  page: number;
  payload: PagePayload;
  stagedAt: string;
}

export interface PixivPulseSchema extends DBSchema {
  works: {
    key: string;
    value: WorkDocument;
    indexes: {
      "by-type": string;
      /** Present only while upgrading v3 records; removed by the v4 upgrade. */
      "by-last-seen": string;
      "by-absent": string;
    };
  };
  workStates: {
    key: string;
    value: WorkState;
  };
  covers: {
    key: string;
    value: CoverRecord;
    indexes: {
      "by-work-key": string;
      "by-source-url": string;
      "by-status": string;
      "by-last-attempt-run-id": string;
    };
  };
  samples: {
    key: number;
    // v4 full rows and v5 compact rows coexist only during/opening migration;
    // the repository codec is the runtime type boundary.
    value: any;
    indexes: {
      "by-work-key": string;
      "by-collected-at": string;
      "by-run-id": string;
      "by-work-key-collected-at": [string, string];
      "by-kind-collected-at": [number, string];
      "by-stable-identity": string;
    };
  };
  observations: {
    key: number;
    value: WorkObservation;
    indexes: {
      "by-work-key": string;
      "by-observed-at": string;
      "by-run-id": string;
    };
  };
  observationBatches: {
    key: string;
    value: StoredObservationBatch;
    indexes: {
      "by-observed-at": string;
    };
  };
  stagedPages: {
    key: string;
    value: StagedPage;
    indexes: {
      "by-run-id": string;
      "by-page": number;
    };
  };
  syncRuns: {
    key: string;
    value: SyncRun;
    indexes: {
      "by-started-at": string;
      "by-status": string;
    };
  };
  storageMeta: {
    key: string;
    value: StorageMeta;
  };
  importStaging: {
    key: string;
    value: ImportStagingRecord;
    indexes: {
      "by-session": string;
      "by-created-at": string;
    };
  };
  maintenanceState: {
    key: string;
    value: MaintenanceState;
  };
  accountFollowerRecords: {
    key: string;
    value: AccountFollowerRecord;
    indexes: {
      "by-account-collected-at": [string, string];
      "by-collected-at": string;
      "by-status": string;
    };
  };
  workDictionary: {
    key: string;
    value: StoredWorkDictionary;
  };
  metricFrames: {
    key: [number, number, string];
    value: MetricFrame;
    indexes: {
      "by-time": [number, number];
      "by-run-id": string;
    };
  };
  metricKeyframes: {
    key: [number, number, string];
    value: MetricKeyframe;
    indexes: {
      "by-time": [number, number];
    };
  };
  analyticsSchemaState: {
    key: string;
    value: AnalyticsSchemaState;
  };
  backupConfig: {
    key: string;
    value: BackupDirectoryConfig;
  };
  backupReceipts: {
    key: string;
    value: BackupReceipt;
    indexes: {
      "by-file-name": string;
    };
  };
}

export const DATABASE_NAME = "pixiv-pulse";

let databasePromise: Promise<IDBPDatabase<PixivPulseSchema>> | undefined;

/**
 * Migrate the v2 per-work observations into one compact record per run. This
 * deliberately uses the native versionchange transaction: the idb wrapper's
 * promise callback is not awaited by openDB, while native requests keep the
 * upgrade transaction alive until all writes (including clearing the legacy
 * store) have completed.
 */
function migrateLegacyObservations(
  transaction: IDBPTransaction<PixivPulseSchema, any, "versionchange">,
  onComplete: () => void,
): void {
  const rawTransaction = unwrap(transaction);
  const observationsStore = rawTransaction.objectStore("observations");
  const batchesStore = rawTransaction.objectStore("observationBatches");
  const runsStore = rawTransaction.objectStore("syncRuns");
  const observationsRequest = observationsStore.getAll();
  const runsRequest = runsStore.getAll();

  let observations: WorkObservation[] | undefined;
  let runs: SyncRun[] | undefined;

  const migrate = (): void => {
    if (observations === undefined || runs === undefined) return;
    const passiveRuns = new Set(runs.filter((run) => run.trigger === "passive").map((run) => run.runId));
    const grouped = new Map<string, {
      runId: string;
      observedAt: string;
      workKeys: Set<string>;
      changedWorkKeys: Set<string>;
    }>();

    for (const observation of observations) {
      if (!observation || typeof observation.runId !== "string" || !observation.runId
        || typeof observation.workKey !== "string" || !observation.workKey
        || typeof observation.observedAt !== "string" || !observation.observedAt) continue;
      const current = grouped.get(observation.runId) ?? {
        runId: observation.runId,
        observedAt: observation.observedAt,
        workKeys: new Set<string>(),
        changedWorkKeys: new Set<string>(),
      };
      if (observation.observedAt > current.observedAt) current.observedAt = observation.observedAt;
      current.workKeys.add(observation.workKey);
      if (observation.metricsChanged === true) current.changedWorkKeys.add(observation.workKey);
      grouped.set(observation.runId, current);
    }

    for (const item of grouped.values()) {
      const batch = encodeObservationBatch({
        runId: item.runId,
        observedAt: item.observedAt,
        workKeys: [...item.workKeys].sort(),
        changedWorkKeys: [...item.changedWorkKeys].sort(),
        scope: passiveRuns.has(item.runId) ? "partial" : "complete",
      });
      batchesStore.put(batch);
    }
    // Keep the migration atomic: if any batch write fails, this clear is part
    // of the same versionchange transaction and the whole upgrade aborts.
    const clearRequest = observationsStore.clear();
    clearRequest.addEventListener("success", onComplete);
  };

  observationsRequest.addEventListener("success", () => {
    observations = observationsRequest.result as WorkObservation[];
    migrate();
  });
  runsRequest.addEventListener("success", () => {
    runs = runsRequest.result as SyncRun[];
    migrate();
  });
}

function abortUpgrade(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be aborting because a request failed.
  }
}

/** Rewrite v3's full WorkRecord rows into the document/state split. Native
 * requests are intentionally chained cursor -> state put -> document update
 * -> cursor continue, so a failed request aborts the one versionchange
 * transaction and leaves the v3 database untouched. */
function migrateWorkRecords(
  transaction: IDBPTransaction<PixivPulseSchema, any, "versionchange">,
  onComplete?: () => void,
): void {
  const rawTransaction = unwrap(transaction);
  const worksStore = rawTransaction.objectStore("works");
  const statesStore = rawTransaction.objectStore("workStates");
  const cursorRequest = worksStore.openCursor();
  cursorRequest.addEventListener("error", () => {
    // Do not preventDefault: IndexedDB request errors abort the upgrade.
  });
  cursorRequest.addEventListener("success", () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      onComplete?.();
      return;
    }
    try {
      const record = cursor.value;
      const document = decodeWorkDocument(record);
      const state = encodeWorkState(record);
      const putRequest = statesStore.put(state, state.key);
      putRequest.addEventListener("error", () => {
        // The request error is allowed to abort the transaction.
      });
      putRequest.addEventListener("success", () => {
        const updateRequest = cursor.update(document);
        updateRequest.addEventListener("error", () => {
          // The request error is allowed to abort the transaction.
        });
        updateRequest.addEventListener("success", () => cursor.continue());
      });
    } catch {
      abortUpgrade(rawTransaction);
    }
  });
}

/** Rewrite v3/plain or already-tagged batches through the sole codec seam. */
function migrateObservationBatches(
  transaction: IDBPTransaction<PixivPulseSchema, any, "versionchange">,
  onComplete?: () => void,
): void {
  const rawTransaction = unwrap(transaction);
  const store = rawTransaction.objectStore("observationBatches");
  const cursorRequest = store.openCursor();
  cursorRequest.addEventListener("error", () => {
    // The native request error aborts the versionchange transaction.
  });
  cursorRequest.addEventListener("success", () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      onComplete?.();
      return;
    }
    try {
      const stored = encodeObservationBatch(decodeObservationBatch(cursor.value));
      const updateRequest = cursor.update(stored);
      updateRequest.addEventListener("error", () => {
        // The native request error aborts the versionchange transaction.
      });
      updateRequest.addEventListener("success", () => cursor.continue());
    } catch {
      abortUpgrade(rawTransaction);
    }
  });
}

/** Rewrite full v4 samples through the v5 codec. The cursor update keeps the
 * existing inline auto-increment key, while the encoded `k` identity is
 * independent of that key. Any codec failure aborts the versionchange so a
 * later open can retry against the untouched v4 data. */
function migrateSamplesV5(
  transaction: IDBPTransaction<PixivPulseSchema, any, "versionchange">,
  onComplete?: () => void,
): void {
  const rawTransaction = unwrap(transaction);
  const store = rawTransaction.objectStore("samples");
  const cursorRequest = store.openCursor();
  cursorRequest.addEventListener("error", () => {
    // The native request error aborts the versionchange transaction.
  });
  cursorRequest.addEventListener("success", () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      onComplete?.();
      return;
    }
    try {
      const publicSample = decodeWorkSample(cursor.value);
      const primaryKey = cursor.primaryKey;
      if (typeof primaryKey !== "number" || !Number.isSafeInteger(primaryKey) || primaryKey < 1) {
        abortUpgrade(rawTransaction);
        return;
      }
      const stored = encodeWorkSample({ ...publicSample, id: publicSample.id ?? primaryKey });
      const updateRequest = cursor.update(stored);
      updateRequest.addEventListener("error", () => {
        // The request error is allowed to abort the transaction.
      });
      updateRequest.addEventListener("success", () => cursor.continue());
    } catch {
      abortUpgrade(rawTransaction);
    }
  });
}

function prepareCompactSampleIndexes(
  transaction: IDBPTransaction<PixivPulseSchema, any, "versionchange">,
): void {
  const store = unwrap(transaction).objectStore("samples");
  const indexes: Array<[string, string | string[]]> = [
    ["by-work-key", "w"],
    ["by-collected-at", "t"],
    ["by-run-id", "r"],
    ["by-work-key-collected-at", ["w", "t"]],
    ["by-kind-collected-at", ["y", "t"]],
    ["by-stable-identity", "k"],
  ];
  for (const [name] of indexes) if (store.indexNames.contains(name)) store.deleteIndex(name);
  for (const [name, keyPath] of indexes) store.createIndex(name, keyPath);
}

function runUpgradeMigrations(
  oldVersion: number,
  transaction: IDBPTransaction<PixivPulseSchema, any, "versionchange">,
): void {
  const migrateV5 = (): void => migrateSamplesV5(transaction, () => migrateObservationBatches(transaction));
  // A direct v2 -> v4 open must finish observation aggregation before the v4
  // cursor rewrites begin; both still run in this same native transaction.
  if (oldVersion < 3) {
    migrateLegacyObservations(transaction, () => {
      migrateWorkRecords(transaction, () => migrateObservationBatches(transaction, migrateV5));
    });
    return;
  }
  if (oldVersion < 4) {
    migrateWorkRecords(transaction, () => migrateObservationBatches(transaction, migrateV5));
    return;
  }
  migrateV5();
}

export function getDatabase(): Promise<IDBPDatabase<PixivPulseSchema>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this context"));
  }
  if (databasePromise) return databasePromise;
  const opening = openDB<PixivPulseSchema>(DATABASE_NAME, DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      // The native migration helpers intentionally abort on codec corruption.
      // Observe the idb wrapper's transaction promise here so an expected
      // fail-closed upgrade does not surface as an unhandled rejection while
      // the open request reports the actual error to its caller.
      void transaction.done.catch(() => undefined);
      if (!database.objectStoreNames.contains("works")) {
        const store = database.createObjectStore("works");
        store.createIndex("by-type", "type");
      }
      if (!database.objectStoreNames.contains("workStates")) database.createObjectStore("workStates");
      if (!database.objectStoreNames.contains("covers")) {
        const store = database.createObjectStore("covers");
        store.createIndex("by-work-key", "workKey");
        store.createIndex("by-source-url", "sourceUrl");
        store.createIndex("by-status", "status");
        store.createIndex("by-last-attempt-run-id", "lastAttemptRunId");
      }
      if (!database.objectStoreNames.contains("samples")) {
        const store = database.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        store.createIndex("by-work-key", "w");
        store.createIndex("by-collected-at", "t");
        store.createIndex("by-run-id", "r");
        store.createIndex("by-work-key-collected-at", ["w", "t"]);
        store.createIndex("by-kind-collected-at", ["y", "t"]);
        store.createIndex("by-stable-identity", "k");
      } else {
        const store = transaction.objectStore("samples");
        if (!store.indexNames.contains("by-work-key")) store.createIndex("by-work-key", "workKey");
        if (!store.indexNames.contains("by-collected-at")) store.createIndex("by-collected-at", "collectedAt");
        if (!store.indexNames.contains("by-run-id")) store.createIndex("by-run-id", "runId");
        if (!store.indexNames.contains("by-work-key-collected-at")) {
          store.createIndex("by-work-key-collected-at", ["workKey", "collectedAt"]);
        }
        if (!store.indexNames.contains("by-kind-collected-at")) {
          store.createIndex("by-kind-collected-at", ["kind", "collectedAt"]);
        }
        if (oldVersion >= 5 && !store.indexNames.contains("by-stable-identity")) store.createIndex("by-stable-identity", "k");
      }
      if (!database.objectStoreNames.contains("observations")) {
        const store = database.createObjectStore("observations", { keyPath: "id", autoIncrement: true });
        store.createIndex("by-work-key", "workKey");
        store.createIndex("by-observed-at", "observedAt");
        store.createIndex("by-run-id", "runId");
      }
      if (!database.objectStoreNames.contains("stagedPages")) {
        const store = database.createObjectStore("stagedPages");
        store.createIndex("by-run-id", "runId");
        store.createIndex("by-page", "page");
      }
      if (!database.objectStoreNames.contains("syncRuns")) {
        const store = database.createObjectStore("syncRuns");
        store.createIndex("by-started-at", "startedAt");
        store.createIndex("by-status", "status");
      }
      if (!database.objectStoreNames.contains("observationBatches")) {
        const store = database.createObjectStore("observationBatches", { keyPath: "runId" });
        store.createIndex("by-observed-at", "observedAt");
      }
      if (!database.objectStoreNames.contains("storageMeta")) {
        database.createObjectStore("storageMeta", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("importStaging")) {
        const store = database.createObjectStore("importStaging", { keyPath: "key" });
        store.createIndex("by-session", "sessionId");
        store.createIndex("by-created-at", "createdAt");
      }
      if (!database.objectStoreNames.contains("maintenanceState")) {
        database.createObjectStore("maintenanceState", { keyPath: "key" });
      }
      // Account follower state is deliberately independent from the work
      // commit path. A v5 -> v6 upgrade only creates this store: no existing
      // records or indexes are rewritten.
      if (!database.objectStoreNames.contains("accountFollowerRecords")) {
        const store = database.createObjectStore("accountFollowerRecords", { keyPath: "runId" });
        store.createIndex("by-account-collected-at", ["accountId", "collectedAt"]);
        store.createIndex("by-collected-at", "collectedAt");
        store.createIndex("by-status", "status");
      }
      // v7 only creates the frame stores. Historical conversion is an
      // application-level, checkpointed operation; never scan large history
      // inside a versionchange transaction.
      if (!database.objectStoreNames.contains("workDictionary")) database.createObjectStore("workDictionary");
      if (!database.objectStoreNames.contains("metricFrames")) {
        const store = database.createObjectStore("metricFrames", { keyPath: ["epochMs", "runSeq", "runId"] });
        store.createIndex("by-time", ["epochMs", "runSeq"]);
        store.createIndex("by-run-id", "runId", { unique: true });
      }
      if (!database.objectStoreNames.contains("metricKeyframes")) {
        const store = database.createObjectStore("metricKeyframes", { keyPath: ["epochMs", "runSeq", "runId"] });
        store.createIndex("by-time", ["epochMs", "runSeq"]);
      }
      if (!database.objectStoreNames.contains("analyticsSchemaState")) {
        database.createObjectStore("analyticsSchemaState", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("backupConfig")) {
        database.createObjectStore("backupConfig", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("backupReceipts")) {
        const store = database.createObjectStore("backupReceipts", { keyPath: "key" });
        store.createIndex("by-file-name", "fileName");
      }
      if (oldVersion < 7) {
        unwrap(transaction).objectStore("analyticsSchemaState").put({
          key: "root",
          activeSchema: "legacy",
          nextRunSeq: 0,
        migrationStatus: "pending",
        migrationCursor: null,
          migrationSnapshot: null,
          updatedAt: new Date().toISOString(),
        } satisfies AnalyticsSchemaState);
      }
      if (oldVersion < 4 && database.objectStoreNames.contains("works")) {
        const store = unwrap(transaction).objectStore("works");
        if (store.indexNames.contains("by-last-seen")) store.deleteIndex("by-last-seen");
        if (store.indexNames.contains("by-absent")) store.deleteIndex("by-absent");
      }
      if (oldVersion < 5) {
        const rawTransaction = unwrap(transaction);
        prepareCompactSampleIndexes(transaction);
        rawTransaction.objectStore("storageMeta").put({ key: "root", dataRevision: 0 } satisfies StorageMeta);
      }
      if (oldVersion < 4 || oldVersion < 5) runUpgradeMigrations(oldVersion, transaction);
    },
    blocking(_currentVersion, _blockedVersion, event) {
      // Another extension context is upgrading or deleting the database.
      // Close this context's raw connection immediately so that operation
      // cannot remain blocked by an open dashboard tab.
      (event.target as IDBDatabase | null)?.close();
      databasePromise = undefined;
    },
    terminated() {
      databasePromise = undefined;
    },
  });
  databasePromise = opening;
  // A failed open (including an aborted migration) must not poison the cache;
  // the next caller should be able to retry after the underlying issue is
  // gone. Keep this identity check so a newer open cannot be cleared by an
  // older rejection.
  opening.catch(() => {
    if (databasePromise === opening) databasePromise = undefined;
  });
  return opening;
}

export function stagedPageKey(runId: string, page: number): string {
  return `${runId}:${page}`;
}

export function resetDatabaseConnection(): void {
  databasePromise = undefined;
}

/** Delete every extension-owned record. Callers should only invoke this from
 * an explicit local-data reset/rebind action. */
export async function clearDatabase(): Promise<void> {
  const connection = databasePromise;
  databasePromise = undefined;
  if (connection) {
    try {
      (await connection).close();
    } catch {
      // A failed/opening connection is still safe to hand to deleteDB.
    }
  }
  await deleteDB(DATABASE_NAME);
}
