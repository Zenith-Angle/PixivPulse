export const COVER_REFERRER_RULE_ID = 9_401;

/**
 * Pixiv's image CDN requires a Pixiv referrer. Scope the rule to extension-
 * initiated cover downloads only so normal browsing traffic is untouched.
 */
export function createCoverReferrerRule(extensionId: string): chrome.declarativeNetRequest.Rule {
  return {
    id: COVER_REFERRER_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [{
        header: "referer",
        operation: "set" as chrome.declarativeNetRequest.HeaderOperation.SET,
        value: "https://www.pixiv.net/",
      }],
    },
    condition: {
      requestDomains: ["i.pximg.net"],
      initiatorDomains: [extensionId],
      resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
    },
  };
}
