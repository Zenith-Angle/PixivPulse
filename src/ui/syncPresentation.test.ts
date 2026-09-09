import { describe, expect, it } from "vitest";
import { createDemoData, createEmptyDashboardData } from "./demoData";
import { displayedSyncError, displayedSyncStatus, latestSyncResultAt, latestSyncRun } from "./syncPresentation";

describe("shared sync presentation", () => {
  const fixture = () => {
    const data = createDemoData();
    data.syncState = { ...data.syncState!, status: "completed", updatedAt: "2026-09-09T16:30:00.000Z" };
    data.runs = [{ ...data.runs[0]!, trigger: "passive", status: "completed", changedWorks: 0, finishedAt: "2026-09-09T16:40:00.000Z" }];
    return data;
  };

  it("uses the newest committed run even when metrics have not changed", () => {
    const data = fixture();
    data.runs.unshift({ ...data.runs[0]!, finishedAt: "2026-09-09T16:20:00.000Z" });
    expect(latestSyncResultAt(data)).toBe("2026-09-09T16:40:00.000Z");
    expect(latestSyncRun(data)?.changedWorks).toBe(0);
    expect(displayedSyncStatus(data)).toBe("completed");
  });

  it("keeps active progress separate from the last stored result", () => {
    const data = fixture();
    data.syncState = { ...data.syncState!, status: "collecting", updatedAt: "2026-09-09T16:50:00.000Z" };
    expect(displayedSyncStatus(data)).toBe("collecting");
    expect(latestSyncResultAt(data)).toBe("2026-09-09T16:40:00.000Z");
  });

  it("replaces a stale failure with a newer passive success but preserves a newer failure", () => {
    const data = fixture();
    data.syncState = { ...data.syncState!, status: "failed", errorMessage: "old failure" };
    expect(displayedSyncStatus(data)).toBe("completed");
    expect(displayedSyncError(data)).toBeNull();
    data.syncState.updatedAt = "2026-09-09T16:50:00.000Z";
    expect(displayedSyncStatus(data)).toBe("failed");
    expect(displayedSyncError(data)).toBe("old failure");
  });

  it("does not invent a sampling time from sync progress when no run has committed", () => {
    const data = createEmptyDashboardData();
    expect(latestSyncResultAt(data)).toBeNull();
    expect(displayedSyncStatus(data)).toBe("idle");
  });
});
