export interface BackupPermissionDescriptor {
  mode: "readwrite";
}

export type BackupPermissionState = "granted" | "denied" | "prompt";

export interface BackupFileLike {
  size: number;
  text(): Promise<string>;
}

export interface BackupWritableLike {
  write(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface BackupFileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<BackupFileLike>;
  createWritable(): Promise<BackupWritableLike>;
}

export interface BackupDirectoryHandleLike {
  kind: "directory";
  name: string;
  queryPermission?(descriptor: BackupPermissionDescriptor): Promise<BackupPermissionState>;
  requestPermission?(descriptor: BackupPermissionDescriptor): Promise<BackupPermissionState>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BackupFileHandleLike>;
}

export interface BackupDirectoryConfig {
  key: "directory";
  directoryHandle: BackupDirectoryHandleLike;
  directoryName: string;
  configuredAt: string;
  lastSuccessAt: string | null;
  lastFileName: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface BackupReceipt {
  key: string;
  frameIdentity: string;
  frameDigest: string;
  runId: string;
  fileName: string;
  fileChecksum: string;
  backedAt: string;
}

export interface BackupCenterStatus {
  configured: boolean;
  directoryName: string | null;
  permission: BackupPermissionState | "unsupported" | "unknown";
  pendingFrames: number;
  lastSuccessAt: string | null;
  lastFileName: string | null;
  lastError: string | null;
}
