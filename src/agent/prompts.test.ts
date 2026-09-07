import { expect, it } from "vitest";
import { createDemoData, createEmptyDashboardData } from "../ui/demoData";
import { suggestedQuestions } from "./prompts";

it("adapts suggestions to available evidence without embedding personal titles", () => {
  const empty = suggestedQuestions(createEmptyDashboardData());
  expect(empty["粉丝观察"]).toBeUndefined();
  expect(empty["增长变化"]).toBeUndefined();
  const data = createDemoData();
  data.works[0]!.seriesTitle = "private-series";
  const groups = suggestedQuestions(data);
  expect(groups["增长变化"]!.length).toBeGreaterThan(2);
  expect(groups["内容结构"]!.some(question => question.includes("系列"))).toBe(true);
  expect(JSON.stringify(groups)).not.toContain("private-series");
  expect(Object.values(groups).flat().length).toBeGreaterThan(15);
});
