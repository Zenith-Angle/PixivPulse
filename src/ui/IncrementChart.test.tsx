import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncrementPreview } from "./IncrementChart";
import { buildPortfolioTimeline, buildWorkTimeline } from "../domain/timeline";
import { createDemoData } from "./demoData";
import { buildCompareBuckets } from "./compareBuckets";

afterEach(cleanup);
const start = Date.parse("2026-09-08T00:00:00+08:00");
const range = { preset: "today" as const, startMs: start, endMs: start + 6 * 3_600_000 };
const pointsFor = (values: Array<number | null>) => values.map((value, index) => ({ at: new Date(start + index * 3_600_000).toISOString(), value }));

describe("work increment preview", () => {
  it("preserves the preceding observation when reusing a range-clipped timeline", () => {
    const original = createDemoData().samples[0]!;
    const samples = [-1, 1, 2].map((hour, index) => ({ ...original, runId: `run-${index}`, collectedAt: new Date(start + hour * 3_600_000).toISOString(), metrics: { ...original.metrics, views: [100, 125, 120][index]! } }));
    const work = buildWorkTimeline(original.workKey, samples, [], range);
    const portfolio = buildPortfolioTimeline([original.workKey], samples, [], range);
    for (const timeline of [work, portfolio]) {
      const points = timeline.map((point) => ({ at: point.at, value: point.metrics.views }));
      expect(buildCompareBuckets(points, range.startMs, range.endMs, 1).map((bucket) => bucket.value)).toEqual([25, -5, null, null, null, null]);
    }
  });
  it("keeps zero, negative changes and gaps visible and opens the work", () => {
    const onOpen = vi.fn();
    const { container } = render(<IncrementPreview points={pointsFor([10, 10, 30, null, 25, 20])} range={range} name="作品 A" onOpen={onOpen} />);
    expect([...container.querySelectorAll("circle title")].map((item) => item.textContent?.split("：").at(-1))).toEqual(["0", "+20", "-5"]);
    // One zero baseline and only one connected segment; never join across nulls.
    expect(container.querySelectorAll("line")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "查看作品 A增量详情" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows a baseline state instead of inventing a zero curve", () => {
    const { container } = render(<IncrementPreview points={pointsFor([10])} range={range} name="作品 A" onOpen={vi.fn()} />);
    expect(screen.getByText("等待两次有效观察")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });
});
