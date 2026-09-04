import { isPolicyReason } from "../domain/sync-policy";
import { DEFAULT_SYNC_INTERVAL_HOURS, PAGE_FAILURE_CLASSIFIER_VERSION, SUPPORTED_SYNC_INTERVAL_HOURS } from "../domain/constants";
import type { AppSettings, PixivAccount, SyncPolicyReason, SyncState } from "../domain/types";

export const SETTINGS_STORAGE_KEY = "pixivPulse.settings";
export const SYNC_STATE_STORAGE_KEY = "pixivPulse.syncState";
export const DATA_REVISION_STORAGE_KEY = "pixivPulse.dataRevision";
let revisionSequence = 0;

export const DEFAULT_SETTINGS: AppSettings = {
  onboardingComplete: false,
  scheduledSyncEnabled: true,
  syncIntervalHours: DEFAULT_SYNC_INTERVAL_HOURS,
  showPixivChips: true,
  theme: "system",
  lastCompactedAt: null,
  storageWarningBytes: 100 * 1024 * 1024,
  boundAccount: null,
  nextAllowedSyncAt: null,
  nextAllowedSyncReason: null,
  pageFailureClassifierVersion: PAGE_FAILURE_CLASSIFIER_VERSION,
};

type StorageItems = Record<string, unknown>;
interface LocalStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<StorageItems>;
  set(items: StorageItems): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

interface ChromeLike {
  storage?: { local?: LocalStorageArea };
}

const memoryStore = new Map<string, unknown>();
let settingsWriteMutation: Promise<void> = Promise.resolve();

function localStorageArea(): LocalStorageArea | null {
  const chromeApi = (globalThis as { chrome?: ChromeLike }).chrome;
  return chromeApi?.storage?.local ?? null;
}

async function read(key: string): Promise<unknown> {
  const area = localStorageArea();
  if (area) {
    const result = await area.get(key);
    return result[key];
  }
  return memoryStore.get(key);
}

async function write(key: string, value: unknown): Promise<void> {
  const area = localStorageArea();
  if (area) {
    await area.set({ [key]: value });
    return;
  }
  memoryStore.set(key, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAccount(value: unknown): PixivAccount | null {
  if (!isRecord(value) || typeof value.id !== "string" || !/^\d+$/.test(value.id)) return null;
  const id = value.id;
  let profileUrl: URL;
  try {
    profileUrl = new URL(typeof value.profileUrl === "string" ? value.profileUrl : `https://www.pixiv.net/users/${id}`);
  } catch {
    return null;
  }
  if (profileUrl.protocol !== "https:" || profileUrl.hostname !== "www.pixiv.net" || profileUrl.pathname !== `/users/${id}`) return null;
  const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { id, name, profileUrl: `https://www.pixiv.net/users/${id}` };
}

export function normalizeSyncIntervalHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.syncIntervalHours;
  return SUPPORTED_SYNC_INTERVAL_HOURS.includes(value as (typeof SUPPORTED_SYNC_INTERVAL_HOURS)[number])
    ? value
    : DEFAULT_SETTINGS.syncIntervalHours;
}

function normalizeSettings(value: unknown): AppSettings {
  const source = isRecord(value) ? value : {};
  const theme = source.theme === "light" || source.theme === "dark" || source.theme === "system" ? source.theme : DEFAULT_SETTINGS.theme;
  const interval = normalizeSyncIntervalHours(source.syncIntervalHours);
  const warningBytes = typeof source.storageWarningBytes === "number" && Number.isFinite(source.storageWarningBytes) && source.storageWarningBytes >= 0
    ? Math.round(source.storageWarningBytes)
    : DEFAULT_SETTINGS.storageWarningBytes;
  const storedNextAllowedSyncAt = typeof source.nextAllowedSyncAt === "string" && Number.isFinite(Date.parse(source.nextAllowedSyncAt))
    ? source.nextAllowedSyncAt
    : null;
  const persistedReason = typeof source.nextAllowedSyncReason === "string" ? source.nextAllowedSyncReason : null;
  const legacyFalseChallenge = persistedReason === "challenge"
    && source.pageFailureClassifierVersion !== PAGE_FAILURE_CLASSIFIER_VERSION;
  const nextAllowedSyncAt = legacyFalseChallenge ? null : storedNextAllowedSyncAt;
  // Migrate the pre-single-account auth cooldown into the generic transient
  // backstop; active runs never use an auth-specific policy reason.
  const nextAllowedSyncReason: SyncPolicyReason | null = nextAllowedSyncAt != null
    ? persistedReason === "auth-required"
      ? "transient-failure"
      : persistedReason != null && isPolicyReason(persistedReason)
        ? persistedReason
        : null
    : null;
  const boundAccount = normalizeAccount(source.boundAccount);
  return {
    onboardingComplete: source.onboardingComplete === true,
    scheduledSyncEnabled: source.scheduledSyncEnabled === true,
    syncIntervalHours: interval,
    showPixivChips: source.showPixivChips !== false,
    theme,
    lastCompactedAt: typeof source.lastCompactedAt === "string" ? source.lastCompactedAt : null,
    storageWarningBytes: warningBytes,
    boundAccount,
    nextAllowedSyncAt,
    nextAllowedSyncReason,
    pageFailureClassifierVersion: PAGE_FAILURE_CLASSIFIER_VERSION,
  };
}

export async function getSettings(): Promise<AppSettings> {
  return normalizeSettings(await read(SETTINGS_STORAGE_KEY));
}

export async function saveSettings(next: Partial<AppSettings> | AppSettings): Promise<AppSettings> {
  const operation = settingsWriteMutation.then(async () => {
    const settings = { ...(await getSettings()), ...next };
    const normalized = normalizeSettings(settings);
    await write(SETTINGS_STORAGE_KEY, normalized);
    return normalized;
  });
  settingsWriteMutation = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getSyncState(): Promise<SyncState | null> {
  const value = await read(SYNC_STATE_STORAGE_KEY);
  return isRecord(value) && typeof value.runId === "string" && typeof value.status === "string"
    ? value as unknown as SyncState
    : null;
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await write(SYNC_STATE_STORAGE_KEY, state);
}

export async function bumpDataRevision(): Promise<string> {
  revisionSequence += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const revision = `${Date.now()}-${revisionSequence}-${random}`;
  await write(DATA_REVISION_STORAGE_KEY, revision);
  return revision;
}

export async function clearSyncState(): Promise<void> {
  const area = localStorageArea();
  if (area?.remove) {
    await area.remove(SYNC_STATE_STORAGE_KEY);
  } else {
    memoryStore.delete(SYNC_STATE_STORAGE_KEY);
  }
}

export async function clearSettings(): Promise<void> {
  const operation = settingsWriteMutation.then(async () => {
    const area = localStorageArea();
    if (area?.remove) {
      await area.remove([SETTINGS_STORAGE_KEY, DATA_REVISION_STORAGE_KEY]);
    } else {
      memoryStore.delete(SETTINGS_STORAGE_KEY);
      memoryStore.delete(DATA_REVISION_STORAGE_KEY);
    }
  });
  settingsWriteMutation = operation.then(() => undefined, () => undefined);
  return operation;
}

export function clearMemoryStateForTests(): void {
  memoryStore.clear();
  revisionSequence = 0;
  settingsWriteMutation = Promise.resolve();
}

export function setMemoryStateForTests(key: string, value: unknown): void {
  memoryStore.set(key, value);
}
