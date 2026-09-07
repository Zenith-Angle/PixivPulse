import { SAMPLING_FOCI, sampleNovelText, type SamplingFocus } from "../src/agent/novel-sampling";
import { novelParagraphs } from "../src/agent/novel-dom";

export default defineContentScript({
  matches: ["https://www.pixiv.net/novel/show.php*"],
  runAt: "document_idle",
  main() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || message?.type !== "AGENT_SAMPLE_NOVEL") return;
      const id = new URL(location.href).searchParams.get("id");
      if (id !== message.id || !SAMPLING_FOCI.includes(message.focus) || typeof message.keyword !== "string" || message.keyword.length > 80 || !Number.isInteger(message.maxChars) || message.maxChars < 30 || message.maxChars > 6000 || !Number.isFinite(message.fraction) || message.fraction < 0.1 || message.fraction > 0.7) {
        sendResponse({ error: "采样参数无效。" }); return;
      }
      // Read only the rendered novel body, never descriptions, recommendations, scripts or hidden state.
      const paragraphs = novelParagraphs(document);
      if (!paragraphs.length) { sendResponse({ pending: true }); return; }
      try {
        const result = sampleNovelText(paragraphs.map(p => p.innerText).join("\n"), message.focus as SamplingFocus, message.keyword, { maxChars: message.maxChars, fraction: message.fraction });
        sendResponse({ data: { ...result, loadedBodyOnly: true, title: document.querySelector("h1")?.textContent?.slice(0, 300) ?? "", pageUrl: location.href, sampledAt: new Date().toISOString(), method: message.focus } });
      } catch { sendResponse({ error: "当前页面原文不足，或页面结构已变化。" }); }
    });
  },
});
