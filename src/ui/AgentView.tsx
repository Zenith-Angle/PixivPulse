import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
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
import { DEFAULT_AGENT_CONFIG, type AgentConfig, type AgentMessage, type Conversation } from "../agent/types";
import { triggerDownload } from "./helpers";



function RunProgress({ message }: { message: AgentMessage }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (message.status !== "running") return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [message.status]);
  const rows = message.progress ?? [];
  if (!rows.length && message.status !== "running") return null;
  return <div className="agent-progress">
    {message.status === "running" && <p role="status"><span className="agent-progress-dot" />{rows.at(-1)?.label ?? "正在启动"} · 已用时 {Math.max(0, Math.floor((now - Date.parse(message.at)) / 1000))} 秒</p>}
    {!!rows.length && <details><summary>查看执行过程（{rows.length}）</summary><ol>{rows.map((row, index) => <li key={index}><time>{new Date(row.at).toLocaleTimeString()}</time> {row.label}</li>)}</ol></details>}
  </div>;
}

function MessageActions({ message, onEdit, onQuote, onRetry, onExport, onError }: {
  message: AgentMessage; onEdit: () => void; onQuote: () => void; onRetry: () => void; onExport: () => void; onError: (error: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2000); return () => window.clearTimeout(timer); }, [copied]);
  if (message.status === "running") return null;
  return <footer className="agent-message-actions">
    <button type="button" aria-label={copied ? "已复制" : "复制"} title={copied ? "已复制" : "复制"} disabled={!message.content} onClick={async () => { try { await navigator.clipboard.writeText(message.content); setCopied(true); } catch { onError("复制失败，请检查剪贴板权限，或选择文本手动复制。"); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    {message.role === "user" ? <button type="button" aria-label="重新编辑" title="重新编辑" onClick={onEdit}><Pencil size={14} /></button> : <>
      <button type="button" aria-label="引用追问" title="引用追问" disabled={!message.content} onClick={onQuote}><Quote size={14} /></button>
      <button type="button" aria-label="从此处重试" title="从此处重试：保留原对话" onClick={onRetry}><RotateCcw size={14} /></button>
      <button type="button" aria-label="导出本轮" title="导出本轮" onClick={onExport}><Download size={14} /></button>
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
      if (kind === "save") { await onSave(config); setDraft(config); setNotice("连接配置已保存。"); }
      if (kind === "models") { const ids = await listModels(config, controller.signal); setModels(ids); setNotice(`读取到 ${ids.length} 个模型；也可以手动输入模型名。`); }
      if (kind === "test") { await testConnection(config, controller.signal); setNotice("连接验收通过：流式响应、工具调用、结果回传、最终回答均成功。请保存配置。" ); }
    } catch (e) { setError(controller.signal.aborted ? "测试已停止。" : kind === "save" ? "无法保存配置或获取域名权限，请检查浏览器授权与存储空间。" : safeAgentError(e)); }
    finally { setBusy(false); abortRef.current = null; }
  }
  return <section className="agent-settings" aria-label="Agent 连接配置">
    <header><div><p className="eyebrow">MODEL CONNECTION</p><h2>连接你的模型</h2></div><button type="button" className="icon-button" aria-label="关闭连接配置" onClick={onClose}><X size={18} /></button></header>
    <p className="agent-muted">支持 DeepSeek Responses、OpenAI Responses 和 OpenAI 兼容 Chat Completions。问题与保留的对话上下文直接发送至你配置的服务；更换服务前可先新建对话。</p>
    <div className="agent-preset-row"><button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_AGENT_CONFIG, apiKey: "" }); setModels([]); setNotice(""); }}>DeepSeek 官方预设</button><button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_AGENT_CONFIG, baseUrl: "https://api.openai.com/v1", model: "", contextWindow: 32768, apiKey: "" }); setModels([]); setNotice(""); }}>OpenAI Responses</button><button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_AGENT_CONFIG, baseUrl: "http://localhost:11434/v1", model: "", contextWindow: 32768, protocol: "chat", outputParameter: "max_tokens", apiKey: "" }); setModels([]); setNotice(""); }}>本地 / 兼容服务</button></div>
    <form onSubmit={(event) => { event.preventDefault(); void action("save"); }}>
      <fieldset disabled={busy} className="agent-config-grid">
        <label className="agent-wide">Base URL<input value={draft.baseUrl} onChange={(e) => { setDraft((current) => ({ ...current, baseUrl: e.target.value, apiKey: "" })); setModels([]); setNotice(""); }} placeholder="https://api.deepseek.com" autoComplete="off" /><small>保留服务商要求的路径（例如 /v1）；末尾 /responses 或 /chat/completions 会自动规范化。修改地址后请重新输入密钥。</small></label>
        <label>API 协议<select value={draft.protocol} onChange={(e) => update("protocol", e.target.value as AgentConfig["protocol"])}><option value="responses">Responses API</option><option value="chat">Chat Completions（兼容）</option></select></label>
        <label>Model name<input list="agent-model-list" value={draft.model} onChange={(e) => update("model", e.target.value)} placeholder="填写服务商的模型 ID" autoComplete="off" /><datalist id="agent-model-list">{models.map((model) => <option key={model} value={model} />)}</datalist></label>
        <label className="agent-wide">API key<input type="password" value={draft.apiKey} onChange={(e) => update("apiKey", e.target.value)} autoComplete="new-password" spellCheck={false} placeholder="本地无认证服务可留空" /></label>
        <label>上下文窗口（tokens）<input type="number" min={4096} max={2000000} step={1} value={draft.contextWindow} onChange={(e) => update("contextWindow", Number(e.target.value))} /></label>
        <label>最大输出（tokens）<input type="number" min={128} max={128000} value={draft.maxOutputTokens} onChange={(e) => update("maxOutputTokens", Number(e.target.value))} /></label>
        <label>分析侧重<select value={draft.analysisFocus} onChange={(e) => update("analysisFocus", e.target.value as AgentConfig["analysisFocus"])}><option value="auto">自动：按问题选择</option><option value="content">正文优先</option><option value="metrics">指标优先</option></select></label>
        <label>正文阅读深度<select value={draft.readingDepth} onChange={(e) => update("readingDepth", e.target.value as AgentConfig["readingDepth"])}><option value="light">轻量：最多 1,500 字 / 30%</option><option value="standard">标准：最多 3,000 字 / 50%</option><option value="deep">深入：最多 6,000 字 / 70%</option><option value="custom">自定义</option></select><small>每问每篇累计上限；多篇会分配输入预算，不代表阅读全文。</small></label>
        {draft.readingDepth === "custom" && <>
          <label>每篇累计采样字数<input type="number" min={150} max={6000} step={1} value={draft.customReadingChars} onChange={(e) => update("customReadingChars", Number(e.target.value))} /></label>
          <label>每篇累计覆盖上限（%）<input type="number" min={10} max={70} step={1} value={draft.customReadingPercent} onChange={(e) => update("customReadingPercent", Number(e.target.value))} /><small>字数、比例、剩余输入预算取最小值，不读取全文。</small></label>
        </>}
        <label>单次输入预算（保守估算）<input type="number" min={8000} max={200000} value={draft.inputBudget} onChange={(e) => update("inputBudget", Number(e.target.value))} /></label>
        <label>单问累计输入预算（保守估算）<input type="number" min={16000} max={500000} value={draft.totalInputBudget} onChange={(e) => update("totalInputBudget", Number(e.target.value))} /></label>
        <div className="agent-wide"><button type="button" onClick={() => setDraft(current => ({ ...current, inputBudget: DEFAULT_AGENT_CONFIG.inputBudget, totalInputBudget: DEFAULT_AGENT_CONFIG.totalInputBudget }))}>使用推荐输入预算（64,000 / 160,000）</button></div>
        <label>工具调用轮数<input type="number" min={1} max={20} value={draft.maxSteps} onChange={(e) => update("maxSteps", Number(e.target.value))} /></label>
        <label>请求超时（秒）<input type="number" min={10} max={600} value={draft.timeoutSeconds} onChange={(e) => update("timeoutSeconds", Number(e.target.value))} /></label>
        <label>Temperature（可留空）<input type="number" min={0} max={2} step={0.1} value={draft.temperature ?? ""} placeholder="由模型决定" onChange={(e) => update("temperature", e.target.value === "" ? null : Number(e.target.value))} /></label>
        {draft.protocol === "chat" && <label>输出上限参数<select value={draft.outputParameter} onChange={(e) => update("outputParameter", e.target.value as AgentConfig["outputParameter"])}><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens（传统兼容）</option></select></label>}
        <label className="agent-wide">回答偏好<textarea rows={3} maxLength={6000} value={draft.instructions} onChange={(e) => update("instructions", e.target.value)} placeholder="例如：先给结论，再解释依据；侧重 Pixiv 同人小说的人物关系与叙事节奏。" /></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.sampleOriginals} onChange={(e) => update("sampleOriginals", e.target.checked)} /><span>允许按需采样 Pixiv 小说原文<small>仅在数据分享开启时使用。优先复用已打开页面；否则用当前 Pixiv 登录态直接读取小说正文接口，不新建标签页；只保存、发送定点片段，按阅读档位或自定义设置，每问每篇累计最多 6,000 字 / 70%，并受本轮预算约束。每问最多 3 篇次，支持一次调用比较多篇。页面本身可能加载完整正文，但全文不进入 Agent 上下文或缓存。</small></span></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.memoryEnabled} onChange={(e) => update("memoryEnabled", e.target.checked)} /><span>自动复用本地分析证据<small>仅缓存只读工具结果，数据或账号变化即失效，24 小时过期；最多 40 条 / 256 KB，不保存模型推断。关闭数据分享后不会发送这些证据。</small></span></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.rememberKey} onChange={(e) => update("rememberKey", e.target.checked)} /><span>在本机记住 API key<small>默认仅保留在当前标签页。勾选后以未加密形式保存在扩展本地数据库，不进入作品备份或对话导出。</small></span></label>
        <label className="agent-check agent-wide"><input type="checkbox" checked={draft.shareData} onChange={(e) => update("shareData", e.target.checked)} /><span>允许 Agent 查询本地作品和历史数据<small>提问时，模型按需获取作品标题、简介、指标、采样时间及粉丝统计，并发送至上方 API 服务。关闭后仅进行普通对话。</small></span></label>
      </fieldset>
      <p className="agent-muted">输入预算按保守 UTF-8 字节估算（并非账单 token 数）；单问累计预算包含每次重放的上下文，并预留最后一次总结。模型上下文窗口只决定容量，不代表每次都要用满。超长会话逐轮省略较早对话，不修改已保存的记录。模型实际窗口请以服务商为准。</p>
      {error && <p className="agent-error" role="alert">{error}</p>}{notice && <p className="agent-success" role="status"><Check size={15} />{notice}</p>}
      <div className="agent-settings-actions"><button type="submit" className="agent-primary" disabled={busy}>保存配置</button><button type="button" disabled={busy} onClick={() => { void clearAgentMemory().then(() => setNotice("本地证据记忆已清除；进行中的分析结束后仍可能写入新证据。"), () => setError("无法清除记忆，请检查本地存储。")); }}>清除证据记忆</button><button type="button" disabled={busy} onClick={() => void action("test")}>测试连接与工具调用</button><button type="button" disabled={busy} onClick={() => void action("models")}>获取模型列表</button>{busy && <button type="button" onClick={() => abortRef.current?.abort()}>停止测试</button>}</div>
      <p className="agent-muted">测试会向所选模型发送两次简短请求，不发送作品数据，可能产生 API 费用。模型列表接口不可用时仍可手动填写。</p>
    </form>
  </section>;
}

export function AgentView({ data, isPreview, active = true }: { data: DashboardData; isPreview: boolean; active?: boolean }) {
  const accountId = isPreview ? "preview" : data.settings.boundAccount?.id ?? "unbound";
  return <AgentWorkspace key={accountId} data={data} isPreview={isPreview} accountId={accountId} active={active} />;
}

function AgentWorkspace({ data, isPreview, accountId, active }: { data: DashboardData; isPreview: boolean; accountId: string; active: boolean }) {
  const selectionKey = `pixivpulse-agent-selection:${accountId}`;
  const readSelection = () => { try { return localStorage.getItem(selectionKey); } catch { return null; } };
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
      setConfig(loadedConfig); setConversations(rows); setSelectedId(rows.find(row => row.id === readSelection())?.id ?? rows[0]?.id ?? null); setReady(true);
    }).catch(() => { if (active) setError("无法读取 Agent 本地存储，请检查浏览器是否允许 IndexedDB，然后刷新页面。"); });
    return () => { active = false; controllers.current.forEach(controller => controller.abort()); };
  }, [accountId]);

  useEffect(() => {
    if (ready && selectedId) { try { localStorage.setItem(selectionKey, selectedId); } catch { /* Selection can still be kept in this mounted workspace. */ } }
  }, [ready, selectedId, selectionKey]);
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    if (active && !wasActive.current) {
      setSettings(false);
      if (!selectedId) setSelectedId(conversations.find(row => row.id === readSelection())?.id ?? conversations[0]?.id ?? null);
      followOutput.current = true;
      const container = messagesRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }
    wasActive.current = active;
  }, [active, selectedId, conversations]);
  useEffect(() => { followOutput.current = true; }, [selectedId]);
  useEffect(() => {
    const container = messagesRef.current;
    if (active && container && followOutput.current) container.scrollTop = container.scrollHeight;
  }, [active, ready, settings, selectedId, current?.messages.at(-1)?.content, current?.messages.at(-1)?.traces.length]);
  useEffect(() => {
    if (!runningIds.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [runningIds.length]);

  function display(conversation: Conversation) {
    const copy = structuredClone(conversation);
    setConversations((rows) => [copy, ...rows.filter((row) => row.id !== copy.id)]);
  }

  async function submit(retryMessageId?: string) {
    if ((!retryMessageId && selectedId && controllers.current.has(selectedId)) || !ready) return;
    if (controllers.current.size >= 3) { setError("已有 3 个对话同时生成，请先停止其中一个或等待完成。"); return; }
    let checked: AgentConfig;
    try { checked = validateConfig(config); } catch (e) { setError((e as Error).message); setSettings(true); return; }
    if (!checked.apiKey && new URL(checked.baseUrl).protocol === "https:") { setError("请先在连接配置中填写 API key。"); setSettings(true); return; }
    const targetIndex = retryMessageId ? current?.messages.findIndex(message => message.id === retryMessageId && message.role === "assistant" && message.status !== "running") ?? -1 : -1;
    if (retryMessageId && targetIndex < 0) return;
    const userIndex = retryMessageId ? current!.messages.slice(0, targetIndex).findLastIndex(message => message.role === "user") : -1;
    const prompt = retryMessageId ? current?.messages[userIndex]?.content : question.trim();
    if (!prompt) return;
    const conversation: Conversation = current ? structuredClone(current) : { id: crypto.randomUUID(), accountId, title: prompt.slice(0, 40), updatedAt: new Date().toISOString(), messages: [] };
    if (retryMessageId) {
      conversation.id = crypto.randomUUID();
      conversation.title = `${prompt.slice(0, 34)} · 重试`;
      conversation.messages = conversation.messages.slice(0, userIndex);
    }
    const user: AgentMessage = { id: crypto.randomUUID(), role: "user", content: prompt, at: new Date().toISOString(), status: "complete", traces: [] };
    const assistant: AgentMessage = { id: crypto.randomUUID(), role: "assistant", content: "", at: new Date().toISOString(), status: "running", traces: [], model: checked.model };
    conversation.messages.push(user, assistant);
    setError("");
    const abort = new AbortController(); controllers.current.set(conversation.id, abort);
    setRunningIds([...controllers.current.keys()]);
    if (!retryMessageId) setQuestion("");
    setSelectedId(conversation.id); setSettings(false); display(conversation);
    let paintTimer: ReturnType<typeof setTimeout> | undefined;
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
      let lastPaint = 0;
      let lastSave = Date.now();
      try {
        await runAgent(checked, conversation.messages.slice(0, -1), data, isPreview, abort.signal, {
          onText: (chunk) => { assistant.content += chunk; const now = Date.now(); if (now - lastPaint > 40) { clearTimeout(paintTimer); paintTimer = undefined; display(conversation); lastPaint = now; } else if (!paintTimer) { paintTimer = setTimeout(() => { paintTimer = undefined; display(conversation); lastPaint = Date.now(); }, 40); } if (now - lastSave > 1500) { void persist(); lastSave = now; } },
          onProgress: (label) => { const rows = assistant.progress ??= []; if (rows.at(-1)?.label === label) return; rows.push({ label, at: new Date().toISOString() }); if (rows.length > 80) rows.shift(); display(conversation); },
          onTrace: async (trace) => { assistant.traces.push(trace); display(conversation); await persist(); },
          onBudget: (trimmed) => { assistant.trimmedTurns = trimmed; },
          onUsage: (usage) => { assistant.usage = usage; },
        });
        assistant.status = "complete";
      } catch (e) {
        assistant.status = abort.signal.aborted ? "stopped" : "error";
        assistant.error = abort.signal.aborted ? "生成已停止，可重试。" : safeAgentError(e);
      } finally { await persist(); display(conversation); }
    };
    try {
      if (navigator.locks) await navigator.locks.request(`pixivpulse-agent:${conversation.id}`, { ifAvailable: true }, async (lock) => { if (!lock) throw new Error("conversation-locked"); await run(); });
      else await run();
    } catch (e) {
      assistant.status = "error"; assistant.error = "对话未能启动，请查看上方提示。"; display(conversation);
      setError((e as Error).message === "stale-conversation" ? "此对话已在另一标签页更新，请刷新后再继续。" : (e as Error).message === "conversation-locked" ? "此对话正在另一标签页生成，请等待完成后刷新。" : "无法启动对话，请检查本地存储后重试。");
    } finally {
      clearTimeout(paintTimer);
      if (saveFailed) setError("对话保存失败，生成已停止。请立即导出当前对话，并检查本地存储空间。");
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
    } catch { setError("无法删除：该对话可能正在另一标签页使用，或存储不可用。"); }
  }

  if (!ready) return <section className="agent-empty" role="status">{error || "正在读取 Agent 工作区…"}</section>;
  return <div className="agent-workspace">
    <aside className="agent-history" aria-label="对话历史"><button className="agent-new" type="button" onClick={() => { setSelectedId(null); setSettings(false); setError(""); }}><Plus size={16} />新对话</button><p className="eyebrow">本机对话 · 当前账号</p><div className="agent-conversation-list">{conversations.map((conversation) => <div className={`agent-conversation ${selectedId === conversation.id ? "active" : ""}`} key={conversation.id}><button type="button" onClick={() => { setSelectedId(conversation.id); setSettings(false); setError(""); }}><MessageSquare size={14} /><span>{conversation.title}{runningIds.includes(conversation.id) && <small> · 生成中</small>}</span></button><button type="button" disabled={runningIds.includes(conversation.id)} aria-label={`删除对话 ${conversation.title}`} onClick={() => setDeleteId(conversation.id)}><Trash2 size={13} /></button></div>)}</div><p className="agent-muted">记录只保存在此浏览器。切换看板可继续生成；关闭标签页会中断。</p></aside>
    <section className="agent-main" aria-label="Agent 对话">
      <header className="agent-toolbar"><div><Bot size={20} /><span><strong>你的创作分析搭档</strong><small>{config.model || "尚未配置模型"} · {config.protocol === "responses" ? "Responses" : "Chat Completions"}</small></span></div><div><button type="button" onClick={() => setSettings(!settings)}><Settings2 size={16} />连接配置</button><button type="button" disabled={!current} aria-label="导出当前对话" onClick={() => { if (current && !triggerDownload(conversationMarkdown(current), `PixivPulse-chat-${current.id}.md`, "text/markdown;charset=utf-8")) setError("导出失败，请检查浏览器下载权限。"); }}><Download size={16} /></button></div></header>
      {error && <p className="agent-error" role="alert">{error}</p>}
      {settings ? <ConnectionSettings initial={config} onClose={() => setSettings(false)} onSave={async (next) => { await saveAgentConfig(next); setConfig(next); setError(""); }} /> : <>
        <div className="agent-data-banner"><span className={`status-dot ${config.shareData ? "agent-connected" : ""}`} />{config.shareData ? `${isPreview ? "演示数据" : "本地知识"} · ${data.works.length} 件作品 · ${data.samples.length} 条历史样本` : "普通对话 · 本地数据分享未开启"}<span>{config.shareData ? `提问时按需发送 · 原文采样${config.sampleOriginals && !isPreview ? "已开启" : "未开启"}` : "在连接配置中开启数据分析"}</span></div>
        <div className="agent-messages" ref={messagesRef} onScroll={(event) => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} role="log" aria-label="聊天消息" aria-live="off">
          {!current?.messages.length && <div className="agent-welcome"><div className="agent-orb"><Bot size={32} /></div><p className="eyebrow">ASK YOUR DATA</p><h2>从一个问题开始，<br />读懂作品背后的变化。</h2><p>把真实采样变成有依据的分析。Agent 可以检索作品、比较增长、查看粉丝趋势，并展示查询来源。</p><div className="agent-preset-row" aria-label="问题分类">{Object.keys(promptGroups).map(category => <button type="button" key={category} aria-pressed={promptCategory === category} onClick={() => setPromptCategory(category)}>{category}</button>)}</div><div className="agent-suggestions">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}<Send size={14} /></button>)}</div></div>}
          {current?.messages.map((message) => <article key={message.id} className={`agent-message ${message.role}`}><div className="agent-message-meta"><strong>{message.role === "user" ? "你" : "Agent"}</strong><span>{message.model}</span>{message.status === "running" && <span role="status">正在分析…</span>}</div><div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{message.content}</Markdown></div>
            <RunProgress message={message} />
            {message.traces.length > 0 && <details className="agent-sources"><summary>已查询 {message.traces.length} 个来源</summary>{message.traces.map((trace) => <details key={trace.id}><summary>[{trace.id}] {trace.name}{trace.cached ? " · 记忆复用" : ""}</summary><small>{trace.at}</small><pre>{trace.arguments}</pre><pre>{trace.result}</pre></details>)}</details>}
            {!!message.trimmedTurns && <p className="agent-muted">本轮已省略较早的 {message.trimmedTurns} 轮上下文；历史记录仍保留。</p>}
            {message.usage && (message.usage.input > 0 || message.usage.output > 0) && <p className="agent-muted">本轮累计 tokens：输入 {message.usage.input.toLocaleString()} · 输出 {message.usage.output.toLocaleString()}{message.usage.requests !== undefined && <> · {message.usage.requests} 次请求 · 记忆命中 {message.usage.memoryHits ?? 0} 次 · 服务商缓存输入 {message.usage.cachedInput ?? 0}{message.usage.evidenceBytes && <> · 工具证据：正文 {(message.usage.evidenceBytes.content / 1024).toFixed(1)} KB / 统计 {(message.usage.evidenceBytes.statistics / 1024).toFixed(1)} KB（非 token）</>}</>}</p>}
            {message.error && <p className="agent-error" role="alert">{message.error}</p>}
            <MessageActions message={message} onError={setError}
              onEdit={() => { setQuestion(message.content); composerRef.current?.focus(); }}
              onQuote={() => { const excerpt = message.content.slice(0, 1600); setQuestion(`请围绕以下回答继续分析：\n\n${excerpt.split("\n").map(line => `> ${line}`).join("\n")}${message.content.length > 1600 ? "\n> （摘录，已截取）" : ""}\n\n我的追问：`); composerRef.current?.focus(); }}
              onRetry={() => void submit(message.id)}
              onExport={() => { const index = current.messages.findIndex(row => row.id === message.id); const start = current.messages.slice(0, index).findLastIndex(row => row.role === "user"); if (!triggerDownload(conversationMarkdown({ ...current, messages: current.messages.slice(Math.max(0, start), index + 1) }), `PixivPulse-turn-${message.id}.md`, "text/markdown;charset=utf-8")) setError("导出失败，请检查浏览器下载权限。"); }} />
          </article>)}
        </div>
        <div className={`agent-composer-slot ${composerExpanded ? "expanded" : ""}`}><form className="agent-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(); }}><button className="agent-expand" type="button" aria-label={composerExpanded ? "收起输入框" : "向上展开输入框"} title={composerExpanded ? "收起输入框" : "向上展开输入框"} aria-expanded={composerExpanded} aria-controls="agent-question" onClick={() => setComposerExpanded(value => !value)}>{composerExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button><textarea id="agent-question" ref={composerRef} aria-label="向 Agent 提问" value={question} maxLength={30000} rows={2} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void submit(); } }} placeholder="问问作品增长、转化率或创作方向…" disabled={busy} /><div><small>Enter 发送 · Shift + Enter 换行 · 回答可能有误，请核对来源</small>{busy ? <button type="button" className="agent-primary" onClick={() => { if (selectedId) controllers.current.get(selectedId)?.abort(); }}><Square size={14} />停止生成</button> : <span>{current?.messages.at(-1)?.role === "assistant" && <button type="button" onClick={() => void submit(current.messages.at(-1)!.id)}>重新生成</button>}<button type="submit" className="agent-primary" disabled={!question.trim()}><Send size={15} />发送</button></span>}</div></form></div>
      </>}
    </section>
    {deleteId && <div className="agent-confirm" role="dialog" aria-modal="true" aria-label="删除对话确认"><div><h3>删除这段对话？</h3><p>仅删除本机对话记录，不影响作品数据。此操作无法撤销。</p><button type="button" onClick={() => setDeleteId(null)}>取消</button><button type="button" className="danger-button" onClick={() => void removeConversation(deleteId)}>确认删除</button></div></div>}
  </div>;
}
