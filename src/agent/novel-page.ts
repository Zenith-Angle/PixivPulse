import { sampleNovelText, type ReadingLimits, type SamplingFocus } from "./novel-sampling";

const GATE_KEY = "pixivpulse.agent.originalRequestAfter";
let nextAt = 0;
let tail: Promise<unknown> = Promise.resolve();
function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function readGate() {
  if (chrome.storage?.local) {
    const value = (await chrome.storage.local.get(GATE_KEY))[GATE_KEY];
    if (typeof value === "number" && Number.isFinite(value)) nextAt = Math.max(nextAt, value);
  }
}
async function setGate(value: number) {
  nextAt = value;
  if (chrome.storage?.local) await chrome.storage.local.set({ [GATE_KEY]: value });
}
async function fetchNovelResource(url: string, signal: AbortSignal): Promise<string> {
  const target = new URL(url);
  if (target.origin !== "https://www.pixiv.net" || (!/^\/ajax\/novel\/\d+$/.test(target.pathname) || !!target.search) || target.hash || target.username || target.password) throw new Error("原文地址不在允许范围内。");
  const task = async () => {
    await readGate();
    const wait = nextAt - Date.now();
    if (wait > 6000) throw new Error(`应用的正文读取冷却尚未结束，约剩 ${Math.ceil(wait / 60000)} 分钟。这不是新的 Pixiv 限流响应；本问应停止读取，不要换工具、等待重试或通过新对话绕过。`);
    if (wait > 0) await delay(wait, signal);
    signal.throwIfAborted();
    await setGate(Date.now() + 5000);
    const timeout = AbortSignal.timeout(25000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(url, { method: "GET", credentials: "include", redirect: "error", signal: combined, headers: { Accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel();
        const retryHeader = response.headers.get("retry-after");
        const seconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : retryHeader ? Math.max(0, Date.parse(retryHeader) - Date.now()) : 0;
        const cooldown = response.status === 429 ? Math.max(900000, Number.isFinite(seconds) ? seconds : 0) : [401,403].includes(response.status) ? 3600000 : 60000;
        await setGate(Date.now() + cooldown);
        throw new Error(`Pixiv 正文读取失败（HTTP ${response.status}），已暂停后续直接读取。请检查登录状态或网站访问提示。`);
      }
      if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error("Pixiv 返回了不符合预期的响应格式，停止读取；这不代表作品未开放正文。");
      if (Number(response.headers.get("content-length")) > 4000000) throw new Error("原文页面超过读取大小上限。");
      if (!response.body) throw new Error("原文页面为空。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder(); let bytes = 0, html = "";
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4000000) throw new Error("原文页面超过读取大小上限。");
          html += decoder.decode(chunk.value, { stream: true });
        }
        return html + decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (!signal.aborted) await setGate(Math.max(nextAt, Date.now() + 60000));
      if (timeout.aborted && !signal.aborted) throw new Error("正文读取超时，已暂停连续请求，请稍后重试。");
      throw error;
    }
  };
  if (navigator.locks) return navigator.locks.request("pixivpulse-original-network", { signal }, task);
  const running = tail.catch(() => {}).then(task); tail = running;
  return running;
}

export async function pauseNovelReading() {
  const pause = async () => { await readGate(); await setGate(Math.max(nextAt, Date.now() + 60000)); };
  if (navigator.locks) await navigator.locks.request("pixivpulse-original-network", pause);
  else await pause();
}

export function sampleNovelDetail(value: unknown, id: string, focus: SamplingFocus, keyword: string, limits: ReadingLimits) {
  const envelope = value as { error?: unknown; body?: { id?: unknown; content?: unknown; title?: unknown; seriesNavData?: { title?: unknown } } } | null;
  if (!envelope || envelope.error !== false || !envelope.body || typeof envelope.body !== "object") throw new Error("Pixiv 小说详情接口未返回有效正文数据；可能是访问状态或接口格式问题，不能据此断定作品未开放正文。");
  const body = envelope.body;
  if (String(body.id) !== id) throw new Error("正文响应的作品 ID 与请求不一致，已停止读取。");
  if (typeof body.content !== "string" || !body.content.trim()) throw new Error("小说详情接口未返回 content 正文；未读取到内容，不能据此推断作品体裁或访问权限。");
  const text = body.content.replace(/\[newpage\]/g, "\n\n").replace(/\[chapter:([^\]]+)\]/g, "\n$1\n");
  return { ...sampleNovelText(text, focus, keyword, limits), title: typeof body.title === "string" ? body.title : "", seriesTitle: typeof body.seriesNavData?.title === "string" ? body.seriesNavData.title : null, transport: "pixiv-web-api", sampledAt: new Date().toISOString(), contentScope: "当前作品接口正文的定点采样，不是系列全文；覆盖率按规范化字符计数。" };
}

export async function readNovelDetail(id: string, focus: SamplingFocus, keyword: string, limits: ReadingLimits, signal: AbortSignal) {
  if (!/^\d+$/.test(id)) throw new Error("无效作品 ID。");
  const text = await fetchNovelResource(`https://www.pixiv.net/ajax/novel/${id}`, signal);
  try { return sampleNovelDetail(JSON.parse(text), id, focus, keyword, limits); }
  catch (error) { await pauseNovelReading(); if (error instanceof SyntaxError) throw new Error("Pixiv 正文接口返回了无法解析的 JSON；已停止读取。"); throw error; }
}
