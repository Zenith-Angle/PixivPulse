import {
  CheckCircle2,
  Database,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { BackupCenterStatus } from "../data/backup-types";

export interface StorageTierCount {
  key: "fresh" | "30m" | "1h" | "6h";
  label: string;
  description: string;
  count: number;
}

export interface StorageCenterModel {
  originUsageBytes: number | null;
  originQuotaBytes: number | null;
  logical: { works: number; samples: number; observationBatches: number; coverBytes: number };
  covers: { ready: number; pending: number; failed: number; total: number };
  tiers: StorageTierCount[];
  backup: BackupCenterStatus;
}

export interface StorageCenterProps {
  model: StorageCenterModel;
  disabled?: boolean;
  busyAction?: "covers" | "maintenance" | "import" | "backup" | null;
  onRepairCovers: () => void;
  onMaintain: () => void;
  onChooseBackup: () => void;
}

export function formatStorageBytes(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "待检测";
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

export function StorageCenter({
  model,
  disabled = false,
  busyAction = null,
  onRepairCovers,
  onMaintain,
  onChooseBackup,
}: StorageCenterProps) {
  const usagePercent = model.originUsageBytes != null && model.originQuotaBytes != null && model.originQuotaBytes > 0
    ? Math.min(100, model.originUsageBytes / model.originQuotaBytes * 100)
    : 0;

  return (
    <section className="setting-section storage-center" aria-labelledby="storage-center-title">
      <div className="section-heading storage-center-heading">
        <div><p className="eyebrow">LOCAL DATA LIFECYCLE</p><h2 id="storage-center-title">本地数据中心</h2></div>
        <Database size={19} aria-hidden="true" />
      </div>

      <div className="storage-summary-grid">
        <div><span><HardDrive size={15} aria-hidden="true" />浏览器占用</span><strong>{formatStorageBytes(model.originUsageBytes)}</strong><small>{model.originQuotaBytes == null ? "浏览器尚未返回配额" : `配额 ${formatStorageBytes(model.originQuotaBytes)}`}</small></div>
        <div><span><Database size={15} aria-hidden="true" />历史样本</span><strong>{model.logical.samples.toLocaleString("zh-CN")}</strong><small>{model.logical.observationBatches.toLocaleString("zh-CN")} 个观察批次</small></div>
        <div><span><ImageIcon size={15} aria-hidden="true" />本地封面</span><strong>{model.covers.ready} / {model.covers.total}</strong><small>{formatStorageBytes(model.logical.coverBytes)} · 待处理 {model.covers.pending}</small></div>
      </div>
      <div className="storage-meter" aria-label={`浏览器配额使用 ${usagePercent.toFixed(1)}%`}><span style={{ width: `${Math.max(usagePercent > 0 ? 2 : 0, usagePercent)}%` }} /></div>

      <div className="retention-policy" aria-label="历史数据保留策略">
        {model.tiers.map((tier) => <div key={tier.key} data-tier={tier.key}><span>{tier.label}</span><strong>{tier.count.toLocaleString("zh-CN")}</strong><small>{tier.description}</small></div>)}
      </div>
      <p className="storage-safety-note"><ShieldCheck size={15} aria-hidden="true" />前三天完整保留；较早记录按时间层级自动抽稀，全部改动在浏览器本地事务中完成。</p>

      <div className="backup-directory-row" aria-label="抽稀前备份目录">
        <div>
          <span><FolderOpen size={15} aria-hidden="true" />抽稀前备份</span>
          <strong>{model.backup.directoryName ?? "未选择目录"}</strong>
          <small>{model.backup.configured
            ? model.backup.permission === "granted"
              ? `${model.backup.pendingFrames} 批待备份${model.backup.lastFileName ? ` · 最近 ${model.backup.lastFileName}` : ""}`
              : "目录需要重新授权，抽稀已暂停"
            : "建议在个人文档目录中创建 PixivPulseBackups 文件夹"}</small>
          {model.backup.lastError && <small className="backup-error" role="status">{model.backup.lastError}</small>}
        </div>
        <button type="button" className="secondary-button" onClick={onChooseBackup} disabled={disabled || busyAction !== null}>
          <FolderOpen size={16} aria-hidden="true" />{busyAction === "backup" ? "正在授权…" : model.backup.configured ? "更换目录" : "选择目录"}
        </button>
      </div>

      <div className="storage-action-bar">
        <button type="button" className="secondary-button" onClick={onRepairCovers} disabled={disabled || busyAction !== null}><RefreshCw size={16} aria-hidden="true" />{busyAction === "covers" ? "正在检查…" : "修复缺失封面"}</button>
        <button type="button" className="secondary-button" onClick={onMaintain} disabled={disabled || busyAction !== null}><CheckCircle2 size={16} aria-hidden="true" />{busyAction === "maintenance" ? "正在整理…" : "整理已有数据"}</button>
      </div>
    </section>
  );
}
