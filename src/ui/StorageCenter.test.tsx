import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StorageCenter, formatStorageBytes, type StorageCenterModel } from "./StorageCenter";

const model: StorageCenterModel = {
  originUsageBytes: 4 * 1024 * 1024,
  originQuotaBytes: 500 * 1024 * 1024,
  logical: { works: 34, samples: 120, observationBatches: 30, coverBytes: 280_000 },
  covers: { ready: 28, pending: 4, failed: 2, total: 34 },
  tiers: [
    { key: "fresh", label: "近三天", description: "完整保留", count: 80 },
    { key: "30m", label: "3–7 天", description: "每 30 分钟", count: 20 },
    { key: "1h", label: "7–30 天", description: "每 1 小时", count: 15 },
    { key: "6h", label: "30 天后", description: "每 6 小时", count: 5 },
  ],
  backup: { configured: true, directoryName: "PixivPulseBackups", permission: "granted", pendingFrames: 2, lastSuccessAt: null, lastFileName: null, lastError: null },
};

describe("StorageCenter", () => {
  it("separates origin, logical, cover, and tier information", () => {
    render(<StorageCenter model={model} onRepairCovers={vi.fn()} onMaintain={vi.fn()} onChooseBackup={vi.fn()} />);
    expect(screen.getByText("本地数据中心")).toBeInTheDocument();
    expect(screen.getByText("4.00 MiB")).toBeInTheDocument();
    expect(screen.getByText("28 / 34")).toBeInTheDocument();
    expect(screen.getByText("PixivPulseBackups")).toBeInTheDocument();
    expect(screen.getByText("前三天完整保留；较早记录按时间层级自动抽稀，全部改动在浏览器本地事务中完成。")).toBeInTheDocument();
  });

  it("routes explicit user actions", () => {
    const repair = vi.fn();
    render(<StorageCenter model={model} onRepairCovers={repair} onMaintain={vi.fn()} onChooseBackup={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /修复缺失封面/ }));
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("routes directory authorization from an explicit button", () => {
    const choose = vi.fn();
    render(<StorageCenter model={model} onRepairCovers={vi.fn()} onMaintain={vi.fn()} onChooseBackup={choose} />);
    fireEvent.click(screen.getByRole("button", { name: /更换目录/ }));
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("formats storage values without pretending an unknown estimate", () => {
    expect(formatStorageBytes(null)).toBe("待检测");
    expect(formatStorageBytes(1536)).toBe("1.5 KiB");
  });
});
