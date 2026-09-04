import { getDatabase } from "./database";
import type {
  BackupCenterStatus,
  BackupDirectoryConfig,
  BackupDirectoryHandleLike,
  BackupPermissionState,
} from "./backup-types";

const DIRECTORY_KEY = "directory" as const;
const PERMISSION = { mode: "readwrite" } as const;

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: "documents" | string;
  }) => Promise<BackupDirectoryHandleLike>;
}

function isoNow(): string {
  return new Date().toISOString();
}

export function directoryPickerSupported(): boolean {
  return typeof window !== "undefined"
    && typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === "function";
}

async function permissionFor(handle: BackupDirectoryHandleLike): Promise<BackupPermissionState | "unknown"> {
  if (typeof handle.queryPermission !== "function") return "unknown";
  try {
    return await handle.queryPermission(PERMISSION);
  } catch {
    return "unknown";
  }
}

export async function readBackupDirectoryConfig(): Promise<BackupDirectoryConfig | null> {
  return (await getDatabase()).get("backupConfig", DIRECTORY_KEY).then((value) => value ?? null);
}

export async function chooseBackupDirectory(): Promise<BackupDirectoryConfig> {
  const picker = typeof window === "undefined"
    ? undefined
    : (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (typeof picker !== "function") throw new Error("当前 Chrome 不支持目录授权");
  const handle = await picker({ id: "pixiv-pulse-backups", mode: "readwrite", startIn: "documents" });
  if (!handle || handle.kind !== "directory" || !handle.name) throw new Error("没有选择有效的备份目录");
  const permission = typeof handle.requestPermission === "function"
    ? await handle.requestPermission(PERMISSION)
    : await permissionFor(handle);
  if (permission !== "granted") throw new Error("未获得备份目录的读写权限");
  const previous = await readBackupDirectoryConfig();
  const config: BackupDirectoryConfig = {
    key: DIRECTORY_KEY,
    directoryHandle: handle,
    directoryName: handle.name,
    configuredAt: isoNow(),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFileName: previous?.lastFileName ?? null,
    lastErrorAt: null,
    lastError: null,
  };
  await (await getDatabase()).put("backupConfig", config);
  return config;
}

export async function requireGrantedBackupDirectory(): Promise<BackupDirectoryConfig> {
  const config = await readBackupDirectoryConfig();
  if (!config) throw new Error("尚未选择抽稀前备份目录");
  const permission = await permissionFor(config.directoryHandle);
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "备份目录权限已被拒绝，请在数据中心重新选择目录"
      : "备份目录需要重新授权，请在数据中心重新选择目录");
  }
  return config;
}

export async function recordBackupSuccess(fileName: string, at = isoNow()): Promise<void> {
  const db = await getDatabase();
  const config = await db.get("backupConfig", DIRECTORY_KEY);
  if (!config) return;
  await db.put("backupConfig", {
    ...config,
    lastSuccessAt: at,
    lastFileName: fileName,
    lastErrorAt: null,
    lastError: null,
  });
}

export async function recordBackupError(error: unknown, at = isoNow()): Promise<void> {
  const db = await getDatabase();
  const config = await db.get("backupConfig", DIRECTORY_KEY);
  if (!config) return;
  await db.put("backupConfig", {
    ...config,
    lastErrorAt: at,
    lastError: error instanceof Error ? error.message : "抽稀前备份失败",
  });
}

export async function getBackupCenterStatus(pendingFrames = 0): Promise<BackupCenterStatus> {
  const config = await readBackupDirectoryConfig();
  if (!config) {
    return {
      configured: false,
      directoryName: null,
      permission: directoryPickerSupported() || typeof window === "undefined" ? "unknown" : "unsupported",
      pendingFrames,
      lastSuccessAt: null,
      lastFileName: null,
      lastError: null,
    };
  }
  return {
    configured: true,
    directoryName: config.directoryName,
    permission: await permissionFor(config.directoryHandle),
    pendingFrames,
    lastSuccessAt: config.lastSuccessAt,
    lastFileName: config.lastFileName,
    lastError: config.lastError,
  };
}
