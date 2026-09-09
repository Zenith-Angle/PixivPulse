import type { DashboardData, SyncRun, SyncState } from "../domain/types";

const timestamp = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

export const latestSyncRun = (data: DashboardData): SyncRun | null => data.runs.reduce<SyncRun | null>(
  (latest, run) => !latest || timestamp(run.finishedAt ?? run.startedAt) > timestamp(latest.finishedAt ?? latest.startedAt) ? run : latest,
  null,
);

// Passive observations commit runs without replacing the active sync machine.
// Progress belongs to that machine; the latest result belongs to the run log.
const displayedSyncResult = (data: DashboardData): SyncState | SyncRun | null => {
  const state = data.syncState;
  if (state && ["opening", "collecting", "rechecking", "committing"].includes(state.status)) return state;
  const run = latestSyncRun(data);
  if (run && (!state || timestamp(run.finishedAt ?? run.startedAt) >= timestamp(state.updatedAt))) return run;
  return state ?? run;
};

export const displayedSyncStatus = (data: DashboardData): SyncState["status"] => displayedSyncResult(data)?.status ?? "idle";
export const displayedSyncError = (data: DashboardData): string | null => displayedSyncResult(data)?.errorMessage ?? null;

export const latestSyncResultAt = (data: DashboardData): string | null => {
  const run = latestSyncRun(data);
  return run ? run.finishedAt ?? run.startedAt : null;
};
