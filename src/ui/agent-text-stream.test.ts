import { afterEach, expect, it, vi } from "vitest";
import { createTextStream } from "./agent-text-stream";
afterEach(() => vi.useRealTimers());
it("shows a received burst immediately, progressively and within 600ms, including after network completion", async () => {
  vi.useFakeTimers(); const paint = vi.fn(); const stream = createTextStream(paint);
  const answer = "正文🌸".repeat(1000); stream.push(answer);
  expect(paint.mock.lastCall![0].length).toBeGreaterThan(0);
  expect(paint.mock.lastCall![0].length).toBeLessThan(answer.length);
  let done = false; const drain = stream.drain().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(200); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(440); await drain;
  expect(paint.mock.lastCall![0]).toBe(answer);
  expect(paint.mock.calls.every(([value]) => !/[\uD800-\uDBFF]$/.test(value))).toBe(true);
});
it("does not leak an earlier tool preamble after reset and preserves received text on stop", async () => {
  vi.useFakeTimers(); const paint = vi.fn(); const stream = createTextStream(paint);
  stream.push("先检索".repeat(100)); stream.reset(); stream.push("最终回答".repeat(100)); stream.flush();
  await vi.advanceTimersByTimeAsync(1000);
  expect(paint.mock.lastCall![0]).toBe("最终回答".repeat(100));
});
it("renders ordinary deltas immediately and honors reduced motion", () => {
  const paint = vi.fn(); const stream = createTextStream(paint);
  stream.push("第一段"); expect(paint).toHaveBeenLastCalledWith("第一段");
  stream.push("第二段"); expect(paint).toHaveBeenLastCalledWith("第一段第二段");
  const reduced = createTextStream(paint, true); reduced.push("文".repeat(10000));
  expect(paint).toHaveBeenLastCalledWith("文".repeat(10000));
});
