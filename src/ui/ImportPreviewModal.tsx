import { AlertTriangle, CheckCircle2, FileArchive, ShieldCheck, X } from "lucide-react";
import type { PortableImportPlan } from "../data/import-planner";
import type { PortableDocumentPreview } from "../data/portable-native";

export interface ImportPreviewModalProps {
  fileName: string;
  preview: PortableDocumentPreview;
  plan: PortableImportPlan;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ImportPreviewModal({ fileName, preview, plan, busy, error, onCancel, onConfirm }: ImportPreviewModalProps) {
  const accountBlocked = preview.accountMatch === "mismatch";
  const blocked = accountBlocked || !plan.canCommit;
  const inserts = plan.works.inserts.length + plan.samples.inserts.length + plan.observationBatches.inserts.length + plan.runs.inserts.length;
  const duplicates = plan.works.duplicateCount + plan.samples.duplicateCount + plan.observationBatches.duplicateCount + plan.runs.duplicateCount;
  const conflicts = plan.samples.conflictKeys.length + plan.observationBatches.conflictKeys.length + plan.runs.conflictKeys.length;
  return (
    <div className="modal-layer" role="presentation">
      <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-preview-title">
        <div className="modal-topline"><span className="modal-mark"><FileArchive size={21} aria-hidden="true" /></span><button type="button" className="icon-button" aria-label="关闭导入预览" onClick={onCancel} disabled={busy}><X size={19} /></button></div>
        <p className="eyebrow">VERIFIED IMPORT</p>
        <h2 id="import-preview-title">确认导入这份本地备份</h2>
        <p className="modal-lead"><strong>{fileName}</strong> 已完成结构和校验和检查。导入会合并历史，不会覆盖当前作品状态。</p>
        <div className="import-preview-grid">
          <div><span>作品</span><strong>{preview.counts.works.toLocaleString("zh-CN")}</strong></div>
          <div><span>样本</span><strong>{preview.counts.samples.toLocaleString("zh-CN")}</strong></div>
          <div><span>观察批次</span><strong>{preview.counts.observationBatches.toLocaleString("zh-CN")}</strong></div>
          <div><span>同步记录</span><strong>{preview.counts.runs.toLocaleString("zh-CN")}</strong></div>
        </div>
        <div className="import-plan-summary">
          <p><CheckCircle2 size={15} aria-hidden="true" /><span>将新增 <strong>{inserts.toLocaleString("zh-CN")}</strong> 条，跳过 <strong>{duplicates.toLocaleString("zh-CN")}</strong> 条重复记录。</span></p>
          {plan.works.keptLocalCount > 0 && <p><ShieldCheck size={15} aria-hidden="true" /><span>{plan.works.keptLocalCount} 件作品使用当前本地元数据，历史样本仍会合并。</span></p>}
          {preview.warnings.map((warning) => <p key={warning}><AlertTriangle size={15} aria-hidden="true" /><span>{warning}</span></p>)}
        </div>
        {accountBlocked && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />这份备份属于另一个 Pixiv 账号。当前数据库非空，不能混合导入。</p>}
        {conflicts > 0 && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />发现 {conflicts} 条同身份但内容不同的记录，已停止导入。</p>}
        {error && <p className="modal-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="primary-button" onClick={onConfirm} disabled={busy || blocked}>{busy ? "正在原子导入…" : "确认合并导入"}</button></div>
      </section>
    </div>
  );
}
