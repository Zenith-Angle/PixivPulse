import { t, getLocale } from "../i18n";
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, ChevronUp, ChevronDown, Check, Copy, Pencil, Quote, RotateCcw, Download, MessageSquare, Plus, Send, Settings2, Square, Trash2, X } from "lucide-react";
import type { DashboardData } from "../domain/types";
import { authorizeEndpoint, validateConfig } from "../agent/config";
import { listModels, safeAgentError, testConnection } from "../agent/provider";
import { suggestedQuestions } from "../agent/prompts";
import { clearAgentMemory } from "../agent/storage";
import { runAgent } from "../agent/runner";
import { conversationMarkdown, deleteConversation, listConversations, loadAgentConfig, saveAgentConfig, saveConversation } from "../agent/storage";
import { DEFAULT_AGENT_CONFIG, type AgentConfig, type AgentMessage, type ReadingProgress, type Conversation } from "../agent/types";
import { createTextStream } from "./agent-text-stream";
import { triggerDownload } from "./helpers";



const AgentMarkdown = memo(function AgentMarkdown({ content }: { content: string }) {
  return <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{content}</Markdown></div>;
});

function ReadingQueue({ reading }: { reading: ReadingProgress[] }) {
  const readingRef = useRef<HTMLDivElement>(null);
  const completed = reading.filter(item => item.status === "complete" || item.status === "cached").length;
  const currentReading = reading.findIndex(item => item.status === "reading");
  useEffect(() => { const list = readingRef.current; const item = list?.children[currentReading] as HTMLElement | undefined; if (list && item) list.scrollTop = Math.max(0, item.offsetTop - list.clientHeight / 2); }, [currentReading]);
  return <div className="agent-reading"><strong>{t("正文采样 · 已完成 {completed}/{total}", { completed, total: reading.length })}</strong><div className="agent-reading-list" role="list" aria-label={t("正文读取队列")} ref={readingRef}>{reading.map((item, index) => <div role="listitem" className={`agent-reading-item ${item.status}`} key={item.key}><span className="agent-reading-index">{index + 1}</span><div><span>{item.title}</span><small>{({ queued: t("排队"), reading: t("读取中"), complete: t("已采样"), cached: t("缓存复用"), error: t("读取失败"), skipped: t("已跳过") })[item.status]}{item.detail ? ` · ${t(item.detail)}` : ""}{item.characters !== undefined ? t(" · {value1} 字符", { value1: item.characters.toLocaleString(getLocale()) }) : ""}{item.coverage !== undefined ? t(" · 覆盖 {value1}%", { value1: (item.coverage * 100).toFixed(1) }) : ""}</small></div></div>)}</div></div>;
}

function RunProgress({ message }: { message: AgentMessage }) {
  const running = message.status === "running";
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [running]);
  const rows = message.progress ?? [];
  const publicRows = (message.activity ?? []).filter(item => item.kind === "commentary" && !item.id.startsWith("milestone:"));
  const operations = (message.activity ?? []).filter(item => item.kind === "operation");
  if (!running && !rows.length && !message.traces.length && !message.activity?.length && !message.reading?.length && !message.usage) return null;
  const label = running ? t(message.statusLabel ?? "正在分析你的问题") : message.status === "complete" ? t("分析完成") : message.status === "stopped" ? t("分析已停止") : t("分析遇到问题");
  return <section className="agent-progress conversational" aria-label={t("Agent 执行过程")}>
    <div className="agent-progress-header">
      <span className={`agent-progress-dot ${running ? "running" : ""}`} />
      <span className="agent-progress-label" role={running ? "status" : undefined}>{label}{running && t(" · 已用时 {value1} 秒", { value1: Math.max(0, Math.floor((now - Date.parse(message.at)) / 1000)) })}</span>
      <button type="button" className="agent-process-toggle" aria-label={open ? t("收起执行过程") : t("展开执行过程")} title={t("执行详情")} aria-expanded={open} aria-controls={`process-${message.id}`} onClick={() => setOpen(value => !value)}>{t("执行详情")}{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
    </div>
    {!!publicRows.length && <div className="agent-service-feed">{publicRows.map(item => <div className="agent-commentary" key={item.id}><AgentMarkdown content={item.text} /></div>)}</div>}
    <div id={`process-${message.id}`} hidden={!open} className="agent-technical-details">
      {operations.map(item => <details className={`agent-operation ${item.status ?? "complete"}`} key={item.id}>
        <summary><span className="agent-tool-icon" aria-hidden="true">›_</span><span>{t(item.text)}</span><small>{item.status === "running" ? t("执行中") : item.status === "error" ? t("失败") : item.status === "stopped" ? t("已停止") : t("完成")}{item.sourceId ? ` · [${item.sourceId}]` : ""}</small><ChevronDown size={13} /></summary>
        {!!item.reading?.length && <ReadingQueue reading={item.reading} />}
      </details>)}
      {!operations.length && !!message.reading?.length && <ReadingQueue reading={message.reading} />}
      <ol>{rows.map((row, index) => <li key={index}><time>{new Date(row.at).toLocaleTimeString()}</time><div><span>{t(row.label)}</span>{row.detail && <p>{row.detail}</p>}</div></li>)}</ol>
      {message.traces.map(trace => <details className="agent-operation-evidence" key={trace.id}><summary>[{trace.id}] {trace.name}{trace.cached ? t(" · 缓存复用") : ""}</summary><small>{trace.at}</small><pre>{trace.arguments}</pre><pre>{trace.result}</pre></details>)}
      {message.usage && <p className="agent-muted">{t("本轮累计 tokens：输入 {input} · 输出 {output} · {requests} 次请求 · 缓存命中 {hits} 次 · 服务商缓存输入 {cached}", { input: message.usage.input.toLocaleString(getLocale()), output: message.usage.output.toLocaleString(getLocale()), requests: message.usage.requests ?? 0, hits: message.usage.memoryHits ?? 0, cached: message.usage.cachedInput ?? 0 })}{message.usage.evidenceBytes && <>{t(" · 工具证据：正文 {content} KB / 统计 {statistics} KB（非 token）", { content: (message.usage.evidenceBytes.content / 1024).toFixed(1), statistics: (message.usage.evidenceBytes.statistics / 1024).toFixed(1) })}</>}{message.usage.compactedBytes ? t(" · 无损编码减少 {value1} KB（非 token）", { value1: (message.usage.compactedBytes / 1024).toFixed(1) }) : ""}</p>}
    </div>
  </section>;
}

function MessageActions({ message, onEdit, onQuote, onRetry, onExport, onError }: {
  message: AgentMessage; onEdit: () => void; onQuote: () => void; onRetry: () => void; onExport: () => void; onError: (error: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2000); return () => window.clearTimeout(timer); }, [copied]);
  if (message.status === "running") return null;
  return <footer className="agent-message-actions">
    <button type="button" aria-label={copied ? t("已复制") : t("复制")} title={copied ? t("已复制") : t("复制")} disabled={!message.content} onClick={async () => { try { await navigator.clipboard.writeText(message.content); setCopied(true); } catch { onError(t("复制失败，请检查剪贴板权限，或选择文本手动复制。")); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    {message.role === "user" ? <button type="button" aria-label={t("重新编辑")} title={t("重新编辑")} onClick={onEdit}><Pencil size={14} /></button> : <>
      <button type="button" aria-label={t("引用追问")} title={t("引用追问")} disabled={!message.content} onClick={onQuote}><Quote size={14} /></button>
      <button type="button" aria-label={t("从此处重试")} title={t("从此处重试：保留原对话")} onClick={onRetry}><RotateCcw size={14} /></button>
      <button type="button" aria-label={t("导出本轮")} title={t("导出本轮")} onClick={onExport}><Download size={14} /></button>
    </>}
  </footer>;
}

function ConnectionSettings({ initial, onSave, onClose }: { initial: AgentConfig; onSave: (config: AgentConfig) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const update = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => { setDraft((current) => ({ ...current, [key]: value })); setNotice(""); };
  async function action(kind: "save" | "models" | "test") {
    setError(""); setNotice("");
    let config: AgentConfig;
    try { config = validateConfig(draft, kind !== "models"); } catch (e) { setError((e as Error).message); return; }
    setBusy(true);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      // Keep permission request on this click's activation, before any storage await.
      await authorizeEndpoint(config.baseUrl);
      if (kind === "save") { await onSave(config); setDraft(config); setNotice(t("连接配置已保存。")); }
      if (kind === "models") { const ids = await listModels(config, controller.signal); setModels(ids); setNotice(t("读取到 {value1} 个模型；也可以手动输入模型名。", { value1: ids.length })); }
      if (kind === "test") { await testConnection(config, controller.signal); setNotice(t("连接验收通过：流式响应、工具调用、结果回传、最终回答均成功。请保存配置。") ); }
    } catch (e) { setError(controller.signal.aborted ? t("测试已停止。") : kind === "save" ? t("无法保存配置或获取域名权限，请检查浏览器授权与存储空间。") : safeAgentError(e)); }
    finally { setBusy(false); abortRef.current = null; }
  }
  return <section className="agent-settings" aria-label={t("Agent 连接配置")}>
    <header><div><p className="eyebrow">MODEL CONNECTION</p><h2>{t("连接你的模型")}</h2></div><button type="button" className="icon-button" aria-label={t("关闭连接配置")} onClick={onClose}><X size={18} /></button></header>
    <p className="agent-muted">{t("支持 DeepSeek Responses、OpenAI Responses 和 OpenAI 兼容 Chat Completions。问题与保留的对话上下文直接发送至你配置的服务；更换服务前可先新建对话。")}</p>
    <div className="agent-preset-row"><button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_AGENT_CONFIG, apiKey: "" }); setModels([]); setNotice(""); }}>{t("DeepSeek 官方预设")}</button><button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_AGENT_CONFIG, baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" }); setModels([]); setNotice(""); }}>OpenAI Responses</button><button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_AGENT_CONFIG, baseUrl: "http://localhost:11434/v1", model: "", protocol: "chat", apiKey: "" }); setModels([]); setNotice(""); }}>{t("本地 / 兼容服务")}</button></div>
    <form onSubmit={(event) => { event.preventDefault(); void action("save"); }}>
      <p className="agent-muted">{t("不设置输入、累计用量或输出预算。通过渐进采样、无损数据编码和可回查笔记减少重复传输；实际用量仍会显示。")}</p>
      <fieldset disabled={busy} className="agent-config-grid">
        <label className="agent-wide">Base URL<input value={draft.baseUrl} onChange={(e) => { setDraft((current) => ({ ...current, baseUrl: e.target.value, apiKey: "" })); setModels([]); setNotice(""); }} placeholder="https://api.deepseek.com" autoComplete="off" /><small>{t("保留服务商要求的路径（例如 /v1）；末尾 /responses 或 /chat/completions 会自动规范化。修改地址后请重新输入密钥。")}</small></label>
        <label>{t("API 协议")}<select value={draft.protocol} onChange={(e) => update("protocol", e.target.value as AgentConfig["protocol"])}><option value="responses">Responses API</option><option value="chat">{t("Chat Completions（兼容）")}</option></select></label>
        <label>Model name<input list="agent-model-list" value={draft.model} onChange={(e) => update("model", e.target.value)} placeholder={t("填写服务商的模型 ID")} autoComplete="off" /><datalist id="agent-model-list">{models.map((model) => <option key={model} value={model} />)}</datalist></label>
        <label className="agent-wide">API key<input type="password" value={draft.apiKey} onChange={(e) => update("apiKey", e.target.value)} autoComplete="new-password" spellCheck={false} placeholder={t("本地无认证服务可留空")} /></label>
        <label>{t("分析侧重")}<select value={draft.analysisFocus} onChange={(e) => update("analysisFocus", e.target.value as AgentConfig["analysisFocus"])}><option value="auto">{t("自动：按问题选择")}</option><option value="content">{t("正文优先")}</option><option value="metrics">{t("指标优先")}</option></select></label>
        <label>{t("正文阅读深度")}<select value={draft.readingDepth} onChange={(e) => update("readingDepth", e.target.value as AgentConfig["readingDepth"])}><option value="auto">{t("自动：少量采样，按需补读")}</option><option value="light">{t("轻量：最多 1,500 字 / 30%")}</option><option value="standard">{t("标准：最多 3,000 字 / 50%")}</option><option value="deep">{t("深入：最多 6,000 字 / 70%")}</option><option value="custom">{t("自定义")}</option></select><small>{t("自动档每次每篇最多约 3,000 字符，按需补读未读位置；整理阅读笔记后释放旧正文，完整来源仍可查看。")}</small></label>
        {draft.readingDepth === "custom" && <>
          <label>{t("每篇累计采样字数")}<input type="number" min={150}  step={1} value={draft.customReadingChars} onChange={(e) => update("customReadingChars", Number(e.target.value))} /></label>
          <label>{t("每篇累计覆盖上限（%）")}<input type="number" min={1} max={100} step={1} value={draft.customReadingPercent} onChange={(e) => update("customReadingPercent", Number(e.target.value))} /><small>{t("按所选字数和比例采样；可设置至 100%。")}</small></label>
        </>}
        <label>{t("工具调用轮数")}<input type="number" min={0} value={draft.maxSteps} onChange={(e) => update("maxSteps", Number(e.target.value))} /><small>{t("0 = 自动继续；连续重复查询没有新证据时结束，也可随时停止。")}</small></label>
        <label>{t("无响应超时（秒）")}<input type="number" min={10} max={86400} value={draft.timeoutSeconds} onChange={(e) => update("timeoutSeconds", Number(e.target.value))} /></label>
        <label>{t("Temperature（可留空）")}<input type="number" min={0} max={2} step={0.1} value={draft.temperature ?? ""} placeholder={t("由模型决定")} onChange={(e) => update("temperature", e.target.value === "" ? null : Number(e.target.value))} /></label>
        <label className="agent-wide">{t("回答偏好")}<textarea rows={3} maxLength={6000} value={draft.instructions} onChange={(e) => update("instructions", e.target.value)} placeholder={t("例如：先给结论，再解释依据；侧重 Pixiv 同人小说的人物关系与叙事节奏。")} /></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.sampleOriginals} onChange={(e) => update("sampleOriginals", e.target.checked)} /><span>{t("允许按需采样 Pixiv 小说原文")}<small>{t("仅在数据分享开启时使用。优先复用片段缓存；渐进阅读用当前 Pixiv 登录态读取同一正文接口，不新建标签页；按问题要求读取多篇作品，逐篇展示队列与状态。自动档少量多次采样，不设每问固定篇数或累计覆盖比例上限；短篇可能覆盖全文。读取过程遵守网站请求间隔与冷却，片段按配置缓存。")}</small></span></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.memoryEnabled} onChange={(e) => update("memoryEnabled", e.target.checked)} /><span>{t("自动复用本地分析证据")}<small>{t("仅缓存只读工具结果，数据或账号变化即失效，24 小时过期；最多 40 条 / 256 KB，不保存模型推断。关闭数据分享后不会发送这些证据。")}</small></span></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.rememberKey} onChange={(e) => update("rememberKey", e.target.checked)} /><span>{t("在本机记住 API key")}<small>{t("默认仅保留在当前标签页。勾选后以未加密形式保存在扩展本地数据库，不进入作品备份或对话导出。")}</small></span></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.shareData} onChange={(e) => update("shareData", e.target.checked)} /><span>{t("允许 Agent 查询本地作品和历史数据")}<small>{t("提问时，模型按需获取作品标题、简介、指标、采样时间及粉丝统计，并发送至上方 API 服务。关闭后仅进行普通对话。")}</small></span></label>
      </fieldset>
      <p className="agent-muted">{t("实际用量用于展示，不参与拦截。服务商仍有自己的上下文容量和默认输出上限；无响应超时只在长时间收不到新内容时停止请求。")}</p>
      {error && <p className="agent-error" role="alert">{error}</p>}{notice && <p className="agent-success" role="status"><Check size={15} />{notice}</p>}
      <div className="agent-settings-actions"><button type="submit" className="agent-primary" disabled={busy}>{t("保存配置")}</button><button type="button" disabled={busy} onClick={() => { void clearAgentMemory().then(() => setNotice(t("本地证据记忆已清除；进行中的分析结束后仍可能写入新证据。")), () => setError(t("无法清除记忆，请检查本地存储。"))); }}>{t("清除证据记忆")}</button><button type="button" disabled={busy} onClick={() => void action("test")}>{t("测试连接与工具调用")}</button><button type="button" disabled={busy} onClick={() => void action("models")}>{t("获取模型列表")}</button>{busy && <button type="button" onClick={() => abortRef.current?.abort()}>{t("停止测试")}</button>}</div>
      <p className="agent-muted">{t("测试会向所选模型发送两次简短请求，不发送作品数据，可能产生 API 费用。模型列表接口不可用时仍可手动填写。")}</p>
    </form>
  </section>;
}

export function AgentView({ data, isPreview, active = true }: { data: DashboardData; isPreview: boolean; active?: boolean }) {
  const accountId = isPreview ? "preview" : data.settings.boundAccount?.id ?? "unbound";
  return <AgentWorkspace key={accountId} data={data} isPreview={isPreview} accountId={accountId} active={active} />;
}

function AgentWorkspace({ data, isPreview, accountId, active }: { data: DashboardData; isPreview: boolean; accountId: string; active: boolean }) {
  const [config, setConfig] = useState(DEFAULT_AGENT_CONFIG);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const question = drafts[selectedId ?? "new"] ?? "";
  const setQuestion = (value: string) => setDrafts(rows => ({ ...rows, [selectedId ?? "new"]: value }));
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const busy = selectedId !== null && runningIds.includes(selectedId);
  const [error, setError] = useState("");
  const promptGroups = suggestedQuestions(data);
  const [promptCategory, setPromptCategory] = useState("快速判断");
  const prompts = promptGroups[promptCategory] ?? promptGroups["快速判断"]!;
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const current = conversations.find((conversation) => conversation.id === selectedId);

  useEffect(() => {
    let active = true;
    Promise.all([loadAgentConfig(), listConversations(accountId)]).then(([loadedConfig, rows]) => {
      if (!active) return;
      setConfig(loadedConfig); setConversations(rows); setSelectedId(null); setReady(true);
    }).catch(() => { if (active) setError(t("无法读取 Agent 本地存储，请检查浏览器是否允许 IndexedDB，然后刷新页面。")); });
    return () => { active = false; controllers.current.forEach(controller => controller.abort()); };
  }, [accountId]);

  const wasActive = useRef(active);
  useLayoutEffect(() => {
    if (active && !wasActive.current) {
      setSettings(false);
      setSelectedId(null);
      setDrafts(rows => ({ ...rows, new: "" }));
      setError("");
      followOutput.current = true;
      const container = messagesRef.current;
      if (container) container.scrollTop = 0;
    }
    wasActive.current = active;
  }, [active, selectedId, conversations]);
  useEffect(() => { followOutput.current = true; }, [selectedId]);
  useEffect(() => {
    const container = messagesRef.current;
    if (active && container && followOutput.current) container.scrollTop = current?.messages.length ? container.scrollHeight : 0;
  }, [active, ready, settings, selectedId, current?.messages.at(-1)?.content, current?.messages.at(-1)?.traces.length, current?.messages.at(-1)?.progress?.length, current?.messages.at(-1)?.activity?.at(-1)?.text, current?.messages.at(-1)?.activity?.length, current?.messages.at(-1)?.phase]);
  useEffect(() => {
    if (!runningIds.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [runningIds.length]);

  function display(conversation: Conversation, streamedText?: string) {
    // Snapshot only mutable UI containers. Large, immutable source strings and
    // completed messages can be shared instead of cloned on every token delta.
    const copy = { ...conversation, messages: conversation.messages.map((message, index) => index < conversation.messages.length - 1 ? message : {
      ...message, traces: [...message.traces], progress: message.progress?.slice() ?? [], reading: message.reading?.slice() ?? [],
      activity: message.activity?.map(item => ({ ...item, reading: item.reading?.slice() ?? [] })) ?? [],
    }) };
    if (streamedText !== undefined) copy.messages.at(-1)!.content = streamedText;
    setConversations((rows) => [copy, ...rows.filter((row) => row.id !== copy.id)]);
  }

  async function submit(retryMessageId?: string) {
    if ((!retryMessageId && selectedId && controllers.current.has(selectedId)) || !ready) return;
    if (controllers.current.size >= 3) { setError(t("已有 3 个对话同时生成，请先停止其中一个或等待完成。")); return; }
    let checked: AgentConfig;
    try { checked = validateConfig(config); } catch (e) { setError((e as Error).message); setSettings(true); return; }
    if (!checked.apiKey && new URL(checked.baseUrl).protocol === "https:") { setError(t("请先在连接配置中填写 API key。")); setSettings(true); return; }
    const targetIndex = retryMessageId ? current?.messages.findIndex(message => message.id === retryMessageId && message.role === "assistant" && message.status !== "running") ?? -1 : -1;
    if (retryMessageId && targetIndex < 0) return;
    const userIndex = retryMessageId ? current!.messages.slice(0, targetIndex).findLastIndex(message => message.role === "user") : -1;
    const prompt = retryMessageId ? current?.messages[userIndex]?.content : question.trim();
    if (!prompt) return;
    const conversation: Conversation = current ? structuredClone(current) : { id: crypto.randomUUID(), accountId, title: prompt.slice(0, 40), updatedAt: new Date().toISOString(), messages: [] };
    if (retryMessageId) {
      conversation.id = crypto.randomUUID();
      conversation.title = t("{value1} · 重试", { value1: prompt.slice(0, 34) });
      conversation.messages = conversation.messages.slice(0, userIndex);
    }
    const user: AgentMessage = { id: crypto.randomUUID(), role: "user", content: prompt, at: new Date().toISOString(), status: "complete", traces: [] };
    const assistant: AgentMessage = { id: crypto.randomUUID(), role: "assistant", content: "", at: new Date().toISOString(), status: "running", traces: [], model: checked.model, progress: [{ label: t("正在启动分析，准备检查数据与连接"), at: new Date().toISOString() }] };
    conversation.messages.push(user, assistant);
    setError("");
    const abort = new AbortController(); controllers.current.set(conversation.id, abort);
    setRunningIds([...controllers.current.keys()]);
    if (!retryMessageId) setQuestion("");
    setSelectedId(conversation.id); setSettings(false); display(conversation);
    let visibleContent = "";
    let paintTimer: ReturnType<typeof setTimeout> | undefined;
    const paint = () => { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = undefined; display(conversation, visibleContent); }, 40); };
    const stream = createTextStream(text => { visibleContent = text; paint(); }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    let saveQueue = Promise.resolve();
    let saveFailed = false;
    const persist = () => {
      conversation.updatedAt = new Date().toISOString();
      const copy = structuredClone(conversation);
      saveQueue = saveQueue.then(() => saveConversation(copy)).catch(() => { saveFailed = true; abort.abort(); });
      return saveQueue;
    };
    const run = async () => {
      // Reload under the per-conversation lock so stale tabs cannot overwrite newer turns.
      const stored = (await listConversations(accountId)).find((row) => row.id === conversation.id);
      if (stored && stored.updatedAt !== current?.updatedAt) throw new Error("stale-conversation");
      await persist();
      if (saveFailed) throw new Error("storage-failed");
      display(conversation);
      let lastSave = Date.now();
      try {
        await runAgent(checked, conversation.messages.slice(0, -1), data, isPreview, abort.signal, {
          onText: (chunk) => {
            // A text delta may precede a tool call. Keep the existing process open
            // until the turn is classified; never fold/unfold on an assumed final answer.
            assistant.content += chunk; stream.push(chunk);
            if (Date.now() - lastSave > 1500) { void persist(); lastSave = Date.now(); }
          },
          onToolTurn: (text) => {
            assistant.phase = "working"; assistant.content = "";
            if (text.trim()) { const activity = assistant.activity ??= []; activity.push({ id: `legacy:${activity.length}`, kind: "commentary", text: text.slice(0, 6000), at: new Date().toISOString() }); const rows = assistant.progress ??= []; rows.push({ label: t("模型执行说明"), detail: text.slice(0, 6000), at: new Date().toISOString() }); if (rows.length > 80) rows.shift(); }
            stream.reset(); void persist();
          },
          onStatus: (status) => { assistant.statusLabel = status; paint(); },
          onProgress: (label) => { const rows = assistant.progress ??= []; if (rows.at(-1)?.label === label) return; rows.push({ label, at: new Date().toISOString() }); if (rows.length > 80) rows.shift(); paint(); },
          onCommentary: (id, text) => {
            if (!assistant.content) assistant.phase = "working";
            const rows = assistant.activity ??= []; const item = rows.find(row => row.id === id);
            if (item?.text === text) return;
            if (item) item.text = text; else rows.push({ id, kind: "commentary", text, at: new Date().toISOString() });
            paint();
            if (Date.now() - lastSave > 1500) { void persist(); lastSave = Date.now(); }
          },
          onOperation: (event) => {
            if (event.status === "running") assistant.phase = "working";
            const rows = assistant.activity ??= []; const index = rows.findIndex(row => row.id === event.id);
            if (index < 0) rows.push(event); else rows[index] = { ...rows[index], ...event };
            paint();
          },
          onReading: (event) => {
            assistant.phase = "working";
            const rows = assistant.reading ??= []; const index = rows.findIndex(row => row.key === event.key);
            if (index < 0) rows.push(event); else rows[index] = event;
            const operation = assistant.activity?.findLast(item => item.kind === "operation" && item.status === "running");
            if (operation) { const items = operation.reading ??= []; const index = items.findIndex(item => item.key === event.key); if (index < 0) items.push(event); else items[index] = event; }
            paint();
            if (["complete", "cached", "error", "skipped"].includes(event.status)) void persist();
          },
          onTrace: async (trace) => { assistant.traces.push(trace); paint(); await persist(); },
          onUsage: (usage) => { assistant.usage = usage; },
        });
        await stream.drain();
        abort.signal.throwIfAborted();
        assistant.status = "complete";
      } catch (e) {
        assistant.status = abort.signal.aborted ? "stopped" : "error";
        assistant.error = abort.signal.aborted ? t("生成已停止，可重试。") : safeAgentError(e);
        assistant.activity = assistant.activity?.map(item => item.status === "running" ? { ...item, status: "stopped", reading: item.reading?.map(row => row.status === "queued" || row.status === "reading" ? { ...row, status: "skipped", detail: t("本轮已中断") } : row) ?? [] } : item) ?? [];
        assistant.reading = assistant.reading?.map(item => item.status === "queued" || item.status === "reading" ? { ...item, status: "skipped", detail: abort.signal.aborted ? t("生成已停止，未完成读取") : t("本轮已中断，未完成读取") } : item) ?? [];
      } finally { stream.flush(); await persist(); display(conversation); }
    };
    try {
      if (navigator.locks) await navigator.locks.request(`pixivpulse-agent:${conversation.id}`, { ifAvailable: true }, async (lock) => { if (!lock) throw new Error("conversation-locked"); await run(); });
      else await run();
    } catch (e) {
      assistant.status = "error"; assistant.error = t("对话未能启动，请查看上方提示。"); display(conversation);
      setError((e as Error).message === "stale-conversation" ? t("此对话已在另一标签页更新，请刷新后再继续。") : (e as Error).message === "conversation-locked" ? t("此对话正在另一标签页生成，请等待完成后刷新。") : t("无法启动对话，请检查本地存储后重试。"));
    } finally {
      stream.dispose(); clearTimeout(paintTimer);
      if (saveFailed) setError(t("对话保存失败，生成已停止。请立即导出当前对话，并检查本地存储空间。"));
      controllers.current.delete(conversation.id); setRunningIds([...controllers.current.keys()]);
    }
  }

  async function removeConversation(id: string) {
    if (controllers.current.has(id)) return;
    try {
      if (navigator.locks) await navigator.locks.request(`pixivpulse-agent:${id}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("locked");
        await deleteConversation(id);
      });
      else await deleteConversation(id);
      setConversations((rows) => rows.filter((row) => row.id !== id)); if (selectedId === id) setSelectedId(null); setDeleteId(null);
    } catch { setError(t("无法删除：该对话可能正在另一标签页使用，或存储不可用。")); }
  }

  if (!ready) return <section className="agent-empty" role="status">{error || t("正在读取 Agent 工作区…")}</section>;
  return <div className="agent-workspace">
    <aside className="agent-history" aria-label={t("对话历史")}><button className="agent-new" type="button" onClick={() => { setSelectedId(null); setDrafts(rows => ({ ...rows, new: "" })); setSettings(false); setError(""); }}><Plus size={16} />{t("新对话")}</button><p className="eyebrow">{t("本机对话 · 当前账号")}</p><div className="agent-conversation-list">{conversations.map((conversation) => <div className={`agent-conversation ${selectedId === conversation.id ? "active" : ""}`} key={conversation.id}><button type="button" onClick={() => { setSelectedId(conversation.id); setSettings(false); setError(""); }}><MessageSquare size={14} /><span>{conversation.title}{runningIds.includes(conversation.id) && <small>{t("· 生成中")}</small>}</span></button><button type="button" disabled={runningIds.includes(conversation.id)} aria-label={t("删除对话 {value1}", { value1: conversation.title })} onClick={() => setDeleteId(conversation.id)}><Trash2 size={13} /></button></div>)}</div><p className="agent-muted">{t("记录只保存在此浏览器。切换看板可继续生成；关闭标签页会中断。")}</p></aside>
    <section className="agent-main" aria-label={t("Agent 对话")}>
      <header className="agent-toolbar"><div><Bot size={20} /><span><strong>{t("你的创作分析搭档")}</strong><small>{config.model || t("尚未配置模型")} · {config.protocol === "responses" ? "Responses" : "Chat Completions"}</small></span></div><div><button type="button" onClick={() => setSettings(!settings)}><Settings2 size={16} />{t("连接配置")}</button><button type="button" disabled={!current} aria-label={t("导出当前对话")} onClick={() => { if (current && !triggerDownload(conversationMarkdown(current), `PixivPulse-chat-${current.id}.md`, "text/markdown;charset=utf-8")) setError(t("导出失败，请检查浏览器下载权限。")); }}><Download size={16} /></button></div></header>
      {error && <p className="agent-error" role="alert">{error}</p>}
      {settings ? <ConnectionSettings initial={config} onClose={() => setSettings(false)} onSave={async (next) => { await saveAgentConfig(next); setConfig(next); setError(""); }} /> : <>
        <div className="agent-data-banner"><span className={`status-dot ${config.shareData ? "agent-connected" : ""}`} />{config.shareData ? t("{value1} · {value2} 件作品 · {value3} 条历史样本", { value1: isPreview ? t("演示数据") : t("本地知识"), value2: data.works.length, value3: data.samples.length }) : t("普通对话 · 本地数据分享未开启")}<span>{config.shareData ? t("提问时按需发送 · 原文采样{value1}", { value1: config.sampleOriginals && !isPreview ? t("已开启") : t("未开启") }) : t("在连接配置中开启数据分析")}</span></div>
        <div className="agent-messages" ref={messagesRef} onScroll={(event) => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} role="log" aria-label={t("聊天消息")} aria-live="off">
          {!current?.messages.length && <div className="agent-welcome"><div className="agent-orb"><Bot size={32} /></div><p className="eyebrow">ASK YOUR DATA</p><h2>{t("从一个问题开始，")}<br />{t("读懂作品背后的变化。")}</h2><p>{t("把真实采样变成有依据的分析。Agent 可以检索作品、比较增长、查看粉丝趋势，并展示查询来源。")}</p><div className="agent-preset-row" aria-label={t("问题分类")}>{Object.keys(promptGroups).map(category => <button type="button" key={category} aria-pressed={promptCategory === category} onClick={() => setPromptCategory(category)}>{t(category)}</button>)}</div><div className="agent-suggestions">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}<Send size={14} /></button>)}</div></div>}
          {current?.messages.map((message) => <article key={message.id} className={`agent-message ${message.role}`}><div className="agent-message-meta"><strong>{message.role === "user" ? t("你") : "Agent"}</strong><span>{message.model}</span>{message.status === "running" && <span role="status">{t("正在分析…")}</span>}</div><RunProgress message={message} /><div className={`agent-answer ${message.status === "running" ? "agent-live-message" : ""}`}><AgentMarkdown content={message.content} /></div>
            {!!message.trimmedTurns && <p className="agent-muted">{t("本轮已省略较早的 {count} 轮上下文；历史记录仍保留。", { count: message.trimmedTurns })}</p>}
            {message.error && <p className="agent-error" role="alert">{t(message.error)}</p>}
            <MessageActions message={message} onError={setError}
              onEdit={() => { setQuestion(message.content); composerRef.current?.focus(); }}
              onQuote={() => { const excerpt = message.content.slice(0, 1600); setQuestion(t("请围绕以下回答继续分析：\n\n{value1}{value2}\n\n我的追问：", { value1: excerpt.split("\n").map(line => `> ${line}`).join("\n"), value2: message.content.length > 1600 ? t("\n> （摘录，已截取）") : "" })); composerRef.current?.focus(); }}
              onRetry={() => void submit(message.id)}
              onExport={() => { const index = current.messages.findIndex(row => row.id === message.id); const start = current.messages.slice(0, index).findLastIndex(row => row.role === "user"); if (!triggerDownload(conversationMarkdown({ ...current, messages: current.messages.slice(Math.max(0, start), index + 1) }), `PixivPulse-turn-${message.id}.md`, "text/markdown;charset=utf-8")) setError(t("导出失败，请检查浏览器下载权限。")); }} />
          </article>)}
        </div>
        <div className={`agent-composer-slot ${composerExpanded ? "expanded" : ""}`}><form className="agent-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(); }}><button className="agent-expand" type="button" aria-label={composerExpanded ? t("收起输入框") : t("向上展开输入框")} title={composerExpanded ? t("收起输入框") : t("向上展开输入框")} aria-expanded={composerExpanded} aria-controls="agent-question" onClick={() => setComposerExpanded(value => !value)}>{composerExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button><textarea id="agent-question" ref={composerRef} aria-label={t("向 Agent 提问")} value={question} rows={2} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void submit(); } }} placeholder={t("问问作品增长、转化率或创作方向…")} disabled={busy} /><div><small>{t("Enter 发送 · Shift + Enter 换行 · 回答可能有误，请核对来源")}</small>{busy ? <button type="button" className="agent-primary" onClick={() => { if (selectedId) controllers.current.get(selectedId)?.abort(); }}><Square size={14} />{t("停止生成")}</button> : <span>{current?.messages.at(-1)?.role === "assistant" && <button type="button" onClick={() => void submit(current.messages.at(-1)!.id)}>{t("重新生成")}</button>}<button type="submit" className="agent-primary" disabled={!question.trim()}><Send size={15} />{t("发送")}</button></span>}</div></form></div>
      </>}
    </section>
    {deleteId && <div className="agent-confirm" role="dialog" aria-modal="true" aria-label={t("删除对话确认")}><div><h3>{t("删除这段对话？")}</h3><p>{t("仅删除本机对话记录，不影响作品数据。此操作无法撤销。")}</p><button type="button" onClick={() => setDeleteId(null)}>{t("取消")}</button><button type="button" className="danger-button" onClick={() => void removeConversation(deleteId)}>{t("确认删除")}</button></div></div>}
  </div>;
}
