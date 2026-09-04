import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * The media database is deliberately independent from the work-data
 * database.  A work snapshot can be replaced while a cover worker is still
 * running, so media writes use their own compare-and-set identity.
 */
export const MEDIA_DATABASE_NAME = "pixiv-pulse-media";
export const MEDIA_DATABASE_VERSION = 1;

export const MEDIA_STORE_NAMES = [
  "coverManifest",
  "coverBlobs",
  "coverJobs",
  "mediaMeta",
] as const;

export type MediaStoreName = (typeof MEDIA_STORE_NAMES)[number];

export type CoverManifestStatus = "pending" | "ready" | "failed" | "skipped-capacity";

export interface CoverIdentity {
  workKey: string;
  sourceUrl: string;
  pipelineVersion: number;
  revision: number;
  fingerprint: string;
}
/** A Blob-free current cover index row. */
export interface CoverManifest extends CoverIdentity {
  key: string;
  blobKey: string | null;
  status: CoverManifestStatus;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  lastAttemptRunId: string | null;
  attemptedAt: string;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
}

export type CoverJobStatus =
  | "pending"
  | "claimed"
  | "fetching"
  | "validating"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled";

/** A durable, JSON-safe job row. It intentionally has no Blob field. */
export interface CoverJob extends CoverIdentity {
  key: string;
  status: CoverJobStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export type MediaJsonPrimitive = string | number | boolean | null;
export type MediaJsonValue =
  | MediaJsonPrimitive
  | readonly MediaJsonValue[]
  | { readonly [key: string]: MediaJsonValue };

export type MigrationStatus = "pending" | "running" | "completed" | "failed";

export interface MigrationJournalRecord {
  key: string;
  kind: "migration-journal";
  migrationId: string;
  migrationVersion: number;
  status: MigrationStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  details: MediaJsonValue | null;
}

export interface MigrationCheckpointRecord {
  key: string;
  kind: "migration-checkpoint";
  migrationId: string;
  migrationVersion: number;
  sequence: number;
  cursor: string | null;
  state: MediaJsonValue | null;
  updatedAt: string;
}

export interface MediaValueRecord {
  key: string;
  kind: "value";
  value: MediaJsonValue;
  updatedAt: string;
}

export type MediaMetaRecord = MigrationJournalRecord | MigrationCheckpointRecord | MediaValueRecord;

export interface MediaDatabaseSchema extends DBSchema {
  coverManifest: {
    key: string;
    value: CoverManifest;
    indexes: {
      "by-work-key": string;
      "by-source-url": string;
      "by-status": CoverManifestStatus;
      "by-pipeline-version": number;
      "by-revision": number;
      "by-updated-at": string;
    };
  };
  coverBlobs: {
    key: string;
    value: Blob;
  };
  coverJobs: {
    key: string;
    value: CoverJob;
    indexes: {
      "by-work-key": string;
      "by-status": CoverJobStatus;
      "by-pipeline-version": number;
      "by-revision": number;
      "by-next-attempt-at": string;
      "by-updated-at": string;
    };
  };
  mediaMeta: {
    key: string;
    value: MediaMetaRecord;
  };
}

let databasePromise: Promise<IDBPDatabase<MediaDatabaseSchema>> | undefined;

function createSchema(database: IDBPDatabase<MediaDatabaseSchema>): void {
  if (!database.objectStoreNames.contains("coverManifest")) {
    const store = database.createObjectStore("coverManifest", { keyPath: "key" });
    store.createIndex("by-work-key", "workKey");
    store.createIndex("by-source-url", "sourceUrl");
    store.createIndex("by-status", "status");
    store.createIndex("by-pipeline-version", "pipelineVersion");
    store.createIndex("by-revision", "revision");
    store.createIndex("by-updated-at", "updatedAt");
  }
  if (!database.objectStoreNames.contains("coverBlobs")) database.createObjectStore("coverBlobs");
  if (!database.objectStoreNames.contains("coverJobs")) {
    const store = database.createObjectStore("coverJobs", { keyPath: "key" });
    store.createIndex("by-work-key", "workKey");
    store.createIndex("by-status", "status");
    store.createIndex("by-pipeline-version", "pipelineVersion");
    store.createIndex("by-revision", "revision");
    store.createIndex("by-next-attempt-at", "nextAttemptAt");
    store.createIndex("by-updated-at", "updatedAt");
  }
  if (!database.objectStoreNames.contains("mediaMeta")) database.createObjectStore("mediaMeta", { keyPath: "key" });
}

/** Open the independent media database, creating only its four owned stores. */
export function getMediaDatabase(): Promise<IDBPDatabase<MediaDatabaseSchema>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this context"));
  }
  if (databasePromise) return databasePromise;

  const opening = openDB<MediaDatabaseSchema>(MEDIA_DATABASE_NAME, MEDIA_DATABASE_VERSION, {
    upgrade(database) {
      createSchema(database);
    },
    blocking(_currentVersion, _blockedVersion, event) {
      (event.target as IDBDatabase | null)?.close();
      databasePromise = undefined;
    },
    terminated() {
      databasePromise = undefined;
    },
  });
  databasePromise = opening;
  opening.catch(() => {
    if (databasePromise === opening) databasePromise = undefined;
  });
  return opening;
}

export function resetMediaDatabaseConnection(): void {
  databasePromise = undefined;
}

/** Close and delete only the media database. */
export async function deleteMediaDatabase(): Promise<void> {
  const connection = databasePromise;
  databasePromise = undefined;
  if (connection) {
    try {
      (await connection).close();
    } catch {
      // A failed open has no connection to close.
    }
  }
  await deleteDB(MEDIA_DATABASE_NAME);
}

export const openMediaDatabase = getMediaDatabase;
export const clearMediaDatabase = deleteMediaDatabase;
