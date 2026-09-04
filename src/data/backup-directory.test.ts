import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_NAME, getDatabase, resetDatabaseConnection } from "./database";
import { getBackupCenterStatus, readBackupDirectoryConfig, requireGrantedBackupDirectory } from "./backup-directory";
import type { BackupDirectoryConfig, BackupDirectoryHandleLike } from "./backup-types";

async function reset(): Promise<void> {
  try { (await getDatabase()).close(); } catch { /* unopened */ }
  resetDatabaseConnection();
  await deleteDB(DATABASE_NAME);
}

describe("backup directory state", () => {
  beforeEach(reset);
  afterEach(reset);

  it("reports an unconfigured directory without claiming permission", async () => {
    await expect(readBackupDirectoryConfig()).resolves.toBeNull();
    await expect(getBackupCenterStatus(3)).resolves.toMatchObject({ configured: false, pendingFrames: 3 });
  });

  it("fails closed when a persisted directory needs a new grant", async () => {
    const config: BackupDirectoryConfig = {
      // fake-indexeddb cannot structured-clone a real FileSystemHandle. A
      // method-free persisted shape exercises the worker's fail-closed path.
      key: "directory", directoryHandle: { kind: "directory", name: "PixivPulseBackups" } as BackupDirectoryHandleLike, directoryName: "PixivPulseBackups",
      configuredAt: new Date().toISOString(), lastSuccessAt: null, lastFileName: null, lastErrorAt: null, lastError: null,
    };
    await (await getDatabase()).put("backupConfig", config);
    await expect(requireGrantedBackupDirectory()).rejects.toThrow(/重新授权/);
    await expect(getBackupCenterStatus()).resolves.toMatchObject({ configured: true, permission: "unknown" });
  });
});
