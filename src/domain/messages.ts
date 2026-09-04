import type { CoverCacheSummary, DashboardData, PagePayload, PixivAccount, SyncState } from "./types";
import type { BackupCenterStatus } from "../data/backup-types";

export type RuntimeMessage =
  | { type: "START_SYNC"; trigger?: "manual" | "scheduled" }
  | { type: "GET_DASHBOARD_DATA" }
  | { type: "GET_SYNC_STATE" }
  | { type: "GET_COVER_CACHE_SUMMARY" }
  | { type: "PAGE_READY"; payload: PagePayload }
  | { type: "PASSIVE_PAGE_SNAPSHOT"; payload: PagePayload }
  | { type: "PAGE_FAILED"; runId: string; code: string; message: string }
  | { type: "OPEN_DASHBOARD" }
  | { type: "SET_SCHEDULED_SYNC"; enabled: boolean; intervalHours: number }
  | { type: "SET_SHOW_CHIPS"; enabled: boolean }
  | { type: "SET_ONBOARDING_COMPLETE"; complete: boolean }
  | { type: "CLEAR_LOCAL_DATA"; rebindAccount?: PixivAccount | null }
  | { type: "MAINTAIN_LOCAL_DATA" }
  | { type: "GET_STORAGE_CENTER" }
  | { type: "REPAIR_COVERS" };

export interface MaintenanceResult {
  rewrittenBatches: number;
  retainedSamples: number;
  skippedLegacyObservations: number;
  cleanedCovers: number;
  cleanedStagedPages: number;
  deletedSamples?: number;
  deletedBatches?: number;
  pendingReason?: string | null;
}

export interface StorageCenterInfo {
  originUsageBytes: number | null;
  originQuotaBytes: number | null;
  logical: { works: number; samples: number; observationBatches: number; coverBytes: number };
  tiers: { lossless: number; "30m": number; "1h": number; "6h": number };
  backup: BackupCenterStatus;
}

export type RuntimeResponse =
  | { ok: true; data?: DashboardData; syncState?: SyncState | null; coverCache?: CoverCacheSummary; maintenance?: MaintenanceResult; storageCenter?: StorageCenterInfo; message?: string }
  | { ok: false; error: string };
