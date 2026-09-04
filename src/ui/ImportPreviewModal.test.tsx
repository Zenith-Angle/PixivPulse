import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportPreviewModal } from "./ImportPreviewModal";
import type { PortableDocumentPreview } from "../data/portable-native";
import type { PortableImportPlan } from "../data/import-planner";

const preview = { accountMatch: "same", counts: { works: 2, samples: 3, observationBatches: 1, runs: 1 }, warnings: ["缩略图将在下次同步时重新生成"] } as unknown as PortableDocumentPreview;
const plan: PortableImportPlan = {
  works: { inserts: [], duplicateCount: 1, conflictKeys: [], keptLocalCount: 1 },
  samples: { inserts: [{} as never, {} as never], duplicateCount: 1, conflictKeys: [] },
  observationBatches: { inserts: [], duplicateCount: 0, conflictKeys: [] },
  runs: { inserts: [], duplicateCount: 0, conflictKeys: [] },
  canCommit: true,
};

describe("ImportPreviewModal", () => {
  it("shows merge counts and confirms a verified same-account import", () => {
    const confirm = vi.fn();
    render(<ImportPreviewModal fileName="backup.json" preview={preview} plan={plan} busy={false} error={null} onCancel={vi.fn()} onConfirm={confirm} />);
    expect(screen.getByText("确认导入这份本地备份")).toBeInTheDocument();
    expect(screen.getByText(/将新增/)).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: "确认合并导入" }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("blocks a cross-account import", () => {
    render(<ImportPreviewModal fileName="backup.json" preview={{ ...preview, accountMatch: "mismatch" }} plan={plan} busy={false} error={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("另一个 Pixiv 账号");
    expect(screen.getByRole("button", { name: "确认合并导入" })).toBeDisabled();
  });
});
