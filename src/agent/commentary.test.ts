import { describe, expect, it } from "vitest";
import { partialCommentary } from "./commentary";

describe("public commentary argument streaming", () => {
  it("renders incomplete strings without exposing JSON or unfinished escapes", () => {
    expect(partialCommentary('{"message":"先核对')).toBe("先核对");
    expect(partialCommentary('{"message":"先核对\\u4')).toBe("先核对");
    expect(partialCommentary('{"message":"第一行\\n\\"标题\\""}')).toBe('第一行\n"标题"');
    expect(partialCommentary('{"message":"图标\\ud83d')).toBe("图标");
    expect(partialCommentary('{"message":"图标\\ud83d\\ude00"}')).toBe("图标😀");
    expect(partialCommentary('{"reasoning":"private"}')).toBe("");
  });
});
