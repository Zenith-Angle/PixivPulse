import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTransferSection } from "./DataTransferSection";

describe("DataTransferSection", () => {
  it("keeps JSON export, CSV export, and import in one section", () => {
    const exportJson = vi.fn();
    const exportCsv = vi.fn();
    render(<DataTransferSection onExportJson={exportJson} onExportCsv={exportCsv} onImportFile={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "数据导入与导出" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出 JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(exportJson).toHaveBeenCalledTimes(1);
    expect(exportCsv).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "导入 JSON / CSV" })).toBeEnabled();
    expect(screen.getByText(/明文、不加密/)).toBeInTheDocument();
  });

  it("accepts both JSON and CSV files through the shared input", () => {
    const onImportFile = vi.fn();
    const { container } = render(<DataTransferSection onExportJson={vi.fn()} onExportCsv={vi.fn()} onImportFile={onImportFile} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain(".json");
    expect(input.accept).toContain(".csv");
    const file = new File(["sample"], "backup.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onImportFile).toHaveBeenCalledWith(file);
  });
});
