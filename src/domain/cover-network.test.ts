import { describe, expect, it } from "vitest";
import { COVER_REFERRER_RULE_ID, createCoverReferrerRule } from "./cover-network";

describe("cover referrer rule", () => {
  it("is limited to extension-initiated i.pximg.net fetches", () => {
    const rule = createCoverReferrerRule("extension-id");

    expect(rule.id).toBe(COVER_REFERRER_RULE_ID);
    expect(rule.condition).toMatchObject({
      requestDomains: ["i.pximg.net"],
      initiatorDomains: ["extension-id"],
      resourceTypes: ["xmlhttprequest"],
    });
    expect(rule.action.requestHeaders).toEqual([{
      header: "referer",
      operation: "set",
      value: "https://www.pixiv.net/",
    }]);
  });
});
