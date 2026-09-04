import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EChartsHost } from "./EChartsHost";

describe("EChartsHost", () => {
  it("renders an accessible visible empty state without requiring canvas in jsdom", () => {
    expect(() => render(<EChartsHost option={{ animation: true }} ariaLabel="作品趋势图" summary="评论共 0 个有效采样点。" hasData={false} emptyMessage="还没有足够样本" />)).not.toThrow();
    expect(screen.getByRole("img", { name: "作品趋势图" })).toBeTruthy();
    expect(screen.getByText("评论共 0 个有效采样点。")).toBeTruthy();
    expect(screen.getByText("还没有足够样本")).toBeTruthy();
  });

  it("keeps the chart host stable when a real chart cannot initialize in jsdom", () => {
    render(<EChartsHost option={{ animation: true }} ariaLabel="日内图" summary="浏览共 2 个有效采样点。" />);
    expect(screen.getByRole("img", { name: "日内图" })).toBeTruthy();
    expect(screen.getByText("浏览共 2 个有效采样点。")).toBeTruthy();
  });
});
