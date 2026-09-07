import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimatedNumber, numberRollDirection, numericDisplayValue } from "./AnimatedNumber";

const root = () => screen.getByTestId("animated-number");
const rows = () => [...root().querySelectorAll(".animated-number-row")].map((node) => node.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnimatedNumber", () => {
  it("keeps the initial value still, then rolls an increase from old to new", async () => {
    const { rerender } = render(<AnimatedNumber value="1,200" comparisonValue={1200} data-testid="animated-number" />);

    expect(root()).toHaveAttribute("data-current-value", "1,200");
    expect(root()).not.toHaveAttribute("data-roll-direction");

    rerender(<AnimatedNumber value="1,340" comparisonValue={1340} data-testid="animated-number" />);
    expect(root()).toHaveAttribute("data-current-value", "1,340");
    expect(root()).toHaveAttribute("data-roll-direction", "increase");
    expect(rows()).toEqual(["1,200", "1,340"]);
    expect(root()).toHaveAttribute("aria-label", "1,340");

    fireEvent.animationEnd(root().querySelector(".animated-number-viewport")!);
    await waitFor(() => expect(root()).not.toHaveAttribute("data-roll-direction"));
    expect(root().querySelector(".animated-number-value")?.textContent).toBe("1,340");
  });

  it("rolls a decrease downward and uses the last committed target during rapid updates", () => {
    const { rerender } = render(<AnimatedNumber value={100} data-testid="animated-number" />);
    rerender(<AnimatedNumber value={80} data-testid="animated-number" />);
    expect(root()).toHaveAttribute("data-roll-direction", "decrease");
    expect(rows()).toEqual(["80", "100"]);

    rerender(<AnimatedNumber value={95} data-testid="animated-number" />);
    expect(root()).toHaveAttribute("data-roll-direction", "increase");
    expect(rows()).toEqual(["80", "95"]);
  });

  it("replays an unchanged value when the animation signal changes", () => {
    const { rerender } = render(<AnimatedNumber value="42" animationSignal={0} data-testid="animated-number" />);

    expect(root()).not.toHaveAttribute("data-roll-direction");

    rerender(<AnimatedNumber value="42" animationSignal={1} data-testid="animated-number" />);
    expect(root()).toHaveAttribute("data-roll-direction", "change");
    expect(rows()).toEqual(["42", "42"]);
  });

  it("does not replay on initial mount", () => {
    render(<AnimatedNumber value="42" animationSignal={1} data-testid="animated-number" />);

    expect(root()).not.toHaveAttribute("data-roll-direction");
  });

  it("coalesces a value change and signal change into one roll", () => {
    const { rerender } = render(<AnimatedNumber value="42" comparisonValue={42} animationSignal={0} data-testid="animated-number" />);

    rerender(<AnimatedNumber value="50" comparisonValue={50} animationSignal={1} data-testid="animated-number" />);
    expect(root()).toHaveAttribute("data-roll-direction", "increase");
    expect(rows()).toEqual(["42", "50"]);
  });

  it("does not animate placeholder hydration or the first update after loading is enabled", () => {
    const { rerender } = render(<AnimatedNumber value="—" animate={false} data-testid="animated-number" />);
    rerender(<AnimatedNumber value="92" comparisonValue={92} animate data-testid="animated-number" />);
    expect(root()).not.toHaveAttribute("data-roll-direction");

    rerender(<AnimatedNumber value="+97" comparisonValue={97} animate data-testid="animated-number" />);
    expect(root()).toHaveAttribute("data-roll-direction", "increase");
  });

  it("renders only the current value when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const { rerender } = render(<AnimatedNumber value={3} data-testid="animated-number" />);

    rerender(<AnimatedNumber value={4} data-testid="animated-number" />);
    expect(root()).not.toHaveAttribute("data-roll-direction");
    expect(root().querySelector(".animated-number-value")?.textContent).toBe("4");
  });

  it("parses supported formatted numbers and chooses a deterministic direction", () => {
    expect(numericDisplayValue("+1,240")).toBe(1240);
    expect(numericDisplayValue("7.5%")).toBe(7.5);
    expect(numericDisplayValue("—")).toBeNull();
    expect(numberRollDirection(4, 8)).toBe("increase");
    expect(numberRollDirection(8, 4)).toBe("decrease");
    expect(numberRollDirection(null, 4)).toBe("change");
  });

});
