import { useRef, type ChangeEvent } from "react";
import { CheckCircle2, Download, FileJson, FileSpreadsheet, Upload } from "lucide-react";

export interface DataTransferSectionProps {
  importDisabled?: boolean;
  importing?: boolean;
  isPreview?: boolean;
  onExportJson: () => void;
  onExportCsv: () => void;
  onImportFile: (file: File) => void;
}

export function DataTransferSection({
  importDisabled = false,
  importing = false,
  isPreview = false,
  onExportJson,
  onExportCsv,
  onImportFile,
}: DataTransferSectionProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) onImportFile(file);
  };

  return (
    <section className="setting-section data-transfer-section" aria-labelledby="data-transfer-title">
      <div className="section-heading">
        <div><p className="eyebrow">DATA TRANSFER</p><h2 id="data-transfer-title">数据导入与导出</h2></div>
        <Download size={19} aria-hidden="true" />
      </div>
      <p className="section-description">JSON 和 CSV 都包含可恢复的作品、历史样本、观察批次、同步记录和粉丝样本，并使用同一套预览与合并导入流程。</p>
      <div className="data-transfer-actions">
        <button type="button" className="secondary-button" onClick={onExportJson} disabled={importing}><FileJson size={16} aria-hidden="true" />导出 JSON</button>
        <button type="button" className="secondary-button" onClick={onExportCsv} disabled={importing}><FileSpreadsheet size={16} aria-hidden="true" />导出 CSV</button>
        <button type="button" className="primary-button" onClick={() => fileInput.current?.click()} disabled={importDisabled || importing}><Upload size={16} aria-hidden="true" />{importing ? "正在读取…" : "导入 JSON / CSV"}</button>
        <input ref={fileInput} className="sr-only" type="file" accept="application/json,text/csv,.json,.csv" onChange={handleFile} />
      </div>
      <p className="setting-note"><CheckCircle2 size={14} aria-hidden="true" />导出文件为明文、不加密；SHA-256 只用于发现文件损坏或意外修改。</p>
      {isPreview && <p className="setting-note">当前导出的是预览数据，仅用于体验界面。</p>}
    </section>
  );
}
