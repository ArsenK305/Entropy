import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AppSnapshot, type ChatMessage, type Conversation, type Role, type Task, type TaskEvent, type TaskStatus, type Workspace } from "./api";
import ArgusDashboard from "./ArgusDashboard";
import TelegramMiniApp from "./TelegramMiniApp";

const MIN_TOKENS = 300;
const GENERAL_KEY = "entropy.conversation.general";
const CAREER_KEY = "entropy.conversation.career";
const CAREER_PREFIX = "entropy-career-";
const read = (storage: Storage, key: string) => { try { return storage.getItem(key); } catch { return null; } };
const write = (storage: Storage, key: string, value: string | null) => { try { value ? storage.setItem(key, value) : storage.removeItem(key); } catch { /* storage is optional */ } };
const isCareerId = (id: string) => id === "entropy-career-workspace" || id.startsWith(CAREER_PREFIX);
const timeLabel = (value?: string) => value ? new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "только что";
const statusLabel = (status: TaskStatus) => ({ queued: "в очереди", planning: "планирует", running: "выполняется", delegated: "у Veltrics", completed: "готово", failed: "ошибка" })[status];

function conversationTitle(conversation?: Conversation | null) {
  const title = String(conversation?.title || "").trim();
  const generic = /^(оцени|разбери|проанализируй|помоги|напиши|расскажи|что ты думаешь|вот вакансия)\b/i.test(title);
  if (title && title.length <= 42 && !generic && title !== "Поиск работы" && title !== "Разбор вакансии") return title;
  const stamp = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(conversation?.created_at || conversation?.updated_at || Date.now()));
  return `${conversation && isCareerId(conversation.id) ? "Разбор" : "Диалог"} · ${stamp}`;
}

function App() {
  if (window.location.pathname === "/argus") return <ArgusDashboard />;
  if (window.location.pathname === "/miniapp") return <TelegramMiniApp />;
  return <WorkspaceApp />;
}

function WorkspaceApp() {
  const rootLanding = window.location.pathname === "/" && window.location.hash === "";
  const initialWorkspace: Workspace = window.location.hash === "#career" ? "career" : window.location.hash === "#chat" || rootLanding ? "general" : read(sessionStorage, "entropy.activeWorkspace") === "career" ? "career" : "general";
  const [isRootLanding, setIsRootLanding] = useState(rootLanding);
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [conversationId, setConversationId] = useState<string | null>(rootLanding ? null : read(sessionStorage, initialWorkspace === "career" ? CAREER_KEY : GENERAL_KEY));
  const [newConversation, setNewConversation] = useState(rootLanding || !read(sessionStorage, initialWorkspace === "career" ? CAREER_KEY : GENERAL_KEY));
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [taskDetail, setTaskDetail] = useState<{ task: Task; events: TaskEvent[] } | null>(null);
  const [activity, setActivity] = useState<{ task: Task; events: TaskEvent[] } | null>(null);
  const [tokenLimits, setTokenLimits] = useState<Record<Role, number>>({
    entropy: Number(read(localStorage, "entropy.outputTokens.entropy")) || 1200,
    veltrics: Number(read(localStorage, "entropy.outputTokens.veltrics")) || 800,
  });
  const [hasLoadedTokenCaps, setHasLoadedTokenCaps] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const conversationRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const refreshingRef = useRef(false);
  const activeIdRef = useRef(conversationId);
  const loadedTaskIds = useRef(new Set<string>());
  activeIdRef.current = conversationId;

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const data = await api.state();
      setSnapshot(data);
      setLoadError(null);
      if (!hasLoadedTokenCaps) {
        const next = { ...tokenLimits };
        (Object.keys(next) as Role[]).forEach((role) => {
          const cap = data.output_token_caps?.[role] || next[role];
          const saved = Number(read(localStorage, `entropy.outputTokens.${role}`));
          next[role] = Math.max(Math.min(MIN_TOKENS, cap), Math.min(cap, saved || cap));
        });
        setTokenLimits(next);
        setHasLoadedTokenCaps(true);
      }
      const currentId = activeIdRef.current;
      if (currentId && !sendingRef.current && !data.conversations.some((item) => item.id === currentId)) {
        setConversationId(null);
        setTranscript([]);
        setNewConversation(true);
      }
      const current = currentId ? data.conversations.find((item) => item.id === currentId) : null;
      const turns = data.turns.filter((turn) => turn.conversation_id === currentId).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const turn = turns[0];
      if (turn?.task_id && (["thinking", "delegating"].includes(turn.status) || !loadedTaskIds.current.has(turn.task_id))) {
        const detail = await api.task(turn.task_id);
        setActivity(detail);
        if (["completed", "failed"].includes(detail.task.status)) loadedTaskIds.current.add(turn.task_id);
      }
      if (current && currentId) {
        const recent = data.messages.filter((message) => message.conversation_id === currentId);
        setTranscript((existing) => mergeMessages(existing, recent));
      }
      setPollTick((value) => value + 1);
    } catch (error) {
      const message = error instanceof DOMException && error.name === "TimeoutError"
        ? "Сервер не ответил за 10 секунд. Проверь backend и базу данных, затем повтори подключение."
        : error instanceof TypeError
        ? "Не удалось связаться с локальным сервером. Проверь, что Python-приложение запущено."
        : error instanceof Error ? error.message : "Не удалось загрузить Entropy.";
      setLoadError(message);
    }
    finally { refreshingRef.current = false; }
  }, [hasLoadedTokenCaps, tokenLimits]);

  const latestTurn = snapshot?.turns.filter((turn) => turn.conversation_id === conversationId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const busy = sending || Boolean(latestTurn && ["thinking", "delegating"].includes(latestTurn.status));

  useEffect(() => { void refresh(); }, []); // initial state
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    api.messages(conversationId).then(({ messages }) => {
      if (!cancelled && activeIdRef.current === conversationId) setTranscript(messages);
    }).catch((error: Error) => {
      if (!cancelled && activeIdRef.current === conversationId) setTranscript([{ id: `error-${Date.now()}`, conversation_id: conversationId, speaker: "Entropy", body: error.message }]);
    });
    return () => { cancelled = true; };
  }, [conversationId]);
  useEffect(() => {
    const timer = busy ? window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000) : null;
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { if (timer !== null) window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, busy]);

  useEffect(() => {
    write(sessionStorage, "entropy.activeWorkspace", workspace);
    if (conversationId || !isRootLanding) write(sessionStorage, workspace === "career" ? CAREER_KEY : GENERAL_KEY, conversationId);
    document.title = window.location.pathname === "/argus" ? "Argus — Entropy" : workspace === "career" ? "Поиск работы — Entropy" : `${conversationTitle(snapshot?.conversations.find((item) => item.id === conversationId))} — Entropy`;
  }, [workspace, conversationId, snapshot, isRootLanding]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation && stickToBottomRef.current) conversation.scrollTop = conversation.scrollHeight;
  }, [transcript, sending]);

  const visibleConversations = useMemo(() => (snapshot?.conversations || []).filter((item) => isCareerId(item.id) === (workspace === "career")), [snapshot, workspace]);
  const selectedConversation = snapshot?.conversations.find((item) => item.id === conversationId);
  const caps = snapshot?.output_token_caps || { entropy: 1200, veltrics: 800 };

  const switchWorkspace = async (next: Workspace) => {
    if (next === workspace) return;
    setIsRootLanding(false);
    setWorkspace(next);
    setConversationId(read(sessionStorage, next === "career" ? CAREER_KEY : GENERAL_KEY));
    setNewConversation(!read(sessionStorage, next === "career" ? CAREER_KEY : GENERAL_KEY));
    setTranscript([]);
    stickToBottomRef.current = true;
    setActivity(null);
    window.history.replaceState(null, "", next === "career" ? "#career" : "#chat");
    inputRef.current?.focus();
  };

  const selectConversation = async (conversation: Conversation) => {
    setIsRootLanding(false);
    const nextWorkspace: Workspace = isCareerId(conversation.id) ? "career" : "general";
    setWorkspace(nextWorkspace);
    setConversationId(conversation.id);
    setNewConversation(false);
    setTranscript([]);
    stickToBottomRef.current = true;
    setActivity(null);
    window.history.replaceState(null, "", nextWorkspace === "career" ? "#career" : "#chat");
  };

  const startNew = () => {
    setIsRootLanding(false);
    setConversationId(null);
    setNewConversation(true);
    setTranscript([]);
    stickToBottomRef.current = true;
    setActivity(null);
    setDraft("");
    window.history.replaceState(null, "", workspace === "career" ? "#career" : "#chat");
    inputRef.current?.focus();
  };

  const send = async (text = draft) => {
    const message = text.trim();
    if (!message || sendingRef.current) return;
    sendingRef.current = true;
    stickToBottomRef.current = true;
    setIsRootLanding(false);
    setSending(true);
    const requestedId = workspace === "career" && !conversationId ? `${CAREER_PREFIX}${crypto.randomUUID()}` : conversationId;
    setConversationId(requestedId);
    setNewConversation(false);
    setTranscript((current) => [...current, { id: `pending-${Date.now()}`, conversation_id: requestedId || "", speaker: "Kars", body: message }]);
    setDraft("");
    setActivity(null);
    Object.entries(tokenLimits).forEach(([role, amount]) => write(localStorage, `entropy.outputTokens.${role}`, String(amount)));
    try {
      const result = await api.send({ message, conversation_id: requestedId, workspace, output_token_limits: tokenLimits });
      setConversationId(result.conversation_id);
      if (workspace === "general") window.history.replaceState(null, "", "#chat");
      await refresh();
      const messages = await api.messages(result.conversation_id);
      setTranscript(messages.messages);
    } catch (error) {
      setTranscript((current) => [...current, { id: `error-${Date.now()}`, conversation_id: requestedId || "", speaker: "Entropy", body: (error as Error).message }]);
    } finally {
      sendingRef.current = false;
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const setToken = (role: Role, value: number) => {
    const cap = caps[role] || 1200;
    const minimum = Math.min(MIN_TOKENS, cap);
    const bounded = Math.max(minimum, Math.min(cap, Math.round(value)));
    setTokenLimits((current) => ({ ...current, [role]: bounded }));
    write(localStorage, `entropy.outputTokens.${role}`, String(bounded));
  };

  const openTask = async (id: string) => { try { setTaskDetail(await api.task(id)); } catch { /* stale card */ } };
  const tasks = snapshot?.tasks || [];
  const live = snapshot?.mode === "openai-live";
  const hasMessages = transcript.length > 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); startNew(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [workspace]);

  return <div className={`app-shell ${workspace === "career" ? "workspace-career" : ""}`} id="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" onClick={(event) => { event.preventDefault(); setWorkspace("general"); setConversationId(null); setNewConversation(true); setTranscript([]); setIsRootLanding(false); window.history.replaceState(null, "", "/"); }} aria-label="Entropy home"><span className="brand-mark"><span /><span /><span /></span><span>entropy<span className="brand-period">.</span></span></a>
      <button className="new-chat" type="button" onClick={startNew} aria-keyshortcuts="Control+K"><span className="plus">＋</span><span className="new-chat-label">{workspace === "career" ? "Новый разбор" : "Новый диалог"}</span><kbd>Ctrl K</kbd></button>
      <div className="side-label">РАЗДЕЛЫ</div>
      <nav className="main-nav" aria-label="Workspace">
        <a className={`nav-item ${workspace === "general" ? "active" : ""}`} href="#chat" onClick={(event) => { event.preventDefault(); void switchWorkspace("general"); }}><span className="nav-icon">◈</span> Диалог <span className="nav-dot" /></a>
        <a className={`nav-item ${workspace === "career" ? "active" : ""}`} href="#career" onClick={(event) => { event.preventDefault(); void switchWorkspace("career"); }}><span className="nav-icon">⌕</span> Поиск работы</a>
        <a className="nav-item" href="/argus"><span className="nav-icon">◉</span> Argus <span className="nav-count">DEMO</span></a>
        <a className="nav-item" href="#tasks" onClick={(event) => { event.preventDefault(); if (tasks[0]) void openTask(tasks[0].id); }}><span className="nav-icon">▤</span> Задачи Veltrics <span className="nav-count">{tasks.length}</span></a>
        <a className="nav-item muted" href="#memory" onClick={(event) => event.preventDefault()}><span className="nav-icon">⌘</span> Память <span className="soon">скоро</span></a>
      </nav>
      <div className="sidebar-history"><div className="history-heading"><span className="side-label">{workspace === "career" ? "НЕДАВНИЕ РАЗБОРЫ" : "ДИАЛОГИ"}</span><span className="history-count">{visibleConversations.length}</span></div>
        <div className="conversation-list" aria-label={workspace === "career" ? "История разборов вакансий" : "История диалогов"}>{visibleConversations.length ? visibleConversations.map((item) => <button key={item.id} className={`conversation-item ${item.id === conversationId ? "active" : ""}`} type="button" title={item.title} onClick={() => void selectConversation(item)}><span className="conversation-item-title">{conversationTitle(item)}</span><span className="conversation-item-date">{timeLabel(item.updated_at)}</span></button>) : <div className="conversation-empty">{workspace === "career" ? "Сохранённые разборы появятся здесь" : "Сохранённые диалоги появятся здесь"}</div>}</div>
      </div>
      <div className="side-label agents-label">КОМАНДА <span className="live-dot" /></div>
      <div className="agent-list"><Agent initials="E" name="Entropy" subtitle="Оркестратор" type="entropy-avatar" /><Agent initials="V" name="Veltrics" subtitle="Разработчик" type="veltrics-avatar" /><Agent initials="O" name="Ophira" subtitle="Исследователь" type="ophira-avatar" dim /><Agent initials="Ψ" name="Psyche" subtitle="Аналитик · reviewer" type="psyche-avatar" dim /></div>
      <div className="sidebar-bottom"><div className="mode-card"><span className="mode-indicator" /><div><b>{live ? "OpenAI API подключён" : "Локальная демо"}</b><small>{live ? `${snapshot?.model || "OpenAI"} · usage billed by API` : "данные остаются на этом ПК"}</small></div><span className="info">i</span></div><div className="profile"><div className="profile-avatar">K</div><div className="profile-name">Kars<small>Владелец системы</small></div><button className="more-button" aria-label="Настройки">···</button></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumb"><span>Рабочее пространство</span><span className="slash">/</span><span>{workspace === "career" ? "Модули" : "Диалоги"}</span><span className="slash">/</span><b>{workspace === "career" ? "Поиск работы" : conversationId ? conversationTitle(selectedConversation) : "Новый диалог"}</b></div>
        <div className="compact-workspace-switcher" role="tablist" aria-label="Раздел Entropy"><button type="button" role="tab" aria-selected={workspace === "general"} onClick={() => void switchWorkspace("general")}>Диалог</button><button type="button" role="tab" aria-selected={workspace === "career"} onClick={() => void switchWorkspace("career")}>Поиск работы</button></div>
        <button className="mobile-new-chat" type="button" onClick={startNew} aria-label={workspace === "career" ? "Новый разбор" : "Новый диалог"} title={workspace === "career" ? "Новый разбор" : "Новый диалог"}>＋</button>
        <div className="top-actions"><span className="demo-pill"><i />{live ? (snapshot?.model || "OPENAI API").toUpperCase() : "DEMO MODE"}</span>
          <details className="token-settings"><summary aria-label="Настроить лимиты ответа модели"><span>Токены</span><b>{tokenLimits.entropy} / {tokenLimits.veltrics}</b></summary><div className="token-popover"><TokenControl role="entropy" cap={caps.entropy} value={tokenLimits.entropy} onChange={setToken} /><small>Жёсткий предел из окружения: <b>{caps.entropy}</b></small><TokenControl role="veltrics" cap={caps.veltrics} value={tokenLimits.veltrics} onChange={setToken} /><small>Жёсткий предел из окружения: <b>{caps.veltrics}</b></small><p>Минимум — 300 выходных токенов. Это верхний предел, а не целевой объём; входной контекст в лимит не входит.</p></div></details><button className="icon-button" title="Справка">?</button><div className="top-avatar">K</div>
        </div>
      </header>
      <section className="conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 88; }} tabIndex={0} aria-label="Сообщения диалога">
        {!snapshot && loadError ? <div className="welcome connection-error" role="alert"><h1>Entropy пока <span>недоступен.</span></h1><p className="welcome-copy">{loadError}</p><button className="retry-button" type="button" onClick={() => void refresh()}>Повторить подключение</button></div> : !hasMessages && !busy && (workspace === "career" ? <CareerWelcome /> : newConversation ? <GeneralWelcome onSelect={(prompt) => void send(prompt)} /> : <div className="welcome"><p className="welcome-copy">Загружаю диалог…</p></div>)}
        <div className="messages" aria-live="polite">{transcript.map((message) => <Message key={message.id} message={message} />)}</div>
        {busy && <div className="thinking-indicator">{latestTurn?.status === "delegating" ? "Entropy передал задачу Veltrics…" : "Entropy думает…"}</div>}
        {activity && <div className="task-feed"><div className="task-feed-copy"><div className="task-feed-title">{taskFeedTitle(activity.task.status, live)} <span className="task-status">{statusLabel(activity.task.status)}</span></div><div className="task-feed-request">{activity.task.request}</div></div><button className="task-open-button" type="button" onClick={() => setTaskDetail(activity)}>Открыть задачу ↗</button></div>}
      </section>
      <div className="composer-wrap"><form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea ref={inputRef} rows={1} maxLength={workspace === "career" ? 24000 : 8000} placeholder={workspace === "career" ? "Вставь описание вакансии или задай вопрос…" : "Напиши Entropy, что нужно сделать…"} value={draft} onChange={(event) => { setDraft(event.target.value); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 170)}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} /><div className="composer-footer"><div className="composer-hints"><span className="hint-icon">↵</span> для отправки <span className="hint-sep">·</span> <span className="small-lock">⌑</span> Демо не меняет файлы</div><button className="send-button" type="submit" disabled={!draft.trim() || sending}><span>{sending ? "Отправка…" : "Отправить"}</span><b>↑</b></button></div></form><div className="disclaimer"><span className="sparkle">✧</span>{live ? "Сообщения и локальная память отправляются выбранной модели через API и расходуют usage. Veltrics пока не читает и не меняет файлы проекта." : "Демо-режим: ответы синтетические, модель и инструменты пока не подключены."}</div></div>
    </main>

    <aside className="activity-panel"><div className="panel-heading"><div><span className="panel-kicker">LIVE WORKSPACE</span><h2>Ход работы</h2></div><button className="icon-button panel-menu" aria-label="Дополнительно">···</button></div><div className="panel-status"><span className="status-orb" /><span>{busy ? "Выполняется задача" : "Система готова"}</span><span className="status-time">{live ? "API · LIVE" : "ЛОКАЛЬНО"}</span></div>
      <div className="panel-section"><div className="section-heading">АКТИВНОСТЬ <span>{String(activity?.events.length || 0).padStart(2, "0")}</span></div><div className="activity-list">{activity?.events.length ? activity.events.map((event, index) => <div className="activity-item" key={`${event.created_at}-${index}`}><span className="activity-icon">{event.actor === "Veltrics" ? "V" : event.actor === "Entropy" ? "E" : "↗"}</span><div className="activity-copy"><b>{event.actor}</b>{event.detail}<time>{timeLabel(event.created_at)}</time></div></div>) : <div className="empty-activity"><span className="empty-glyph">⌁</span><b>Пока тихо</b><span>Отправь задачу — покажу,<br />как агенты двигают её вперёд.</span></div>}</div></div>
      <div className="panel-section task-section"><div className="section-heading">ПОСЛЕДНИЕ ЗАДАЧИ <button className="text-button" onClick={() => void refresh()}>ОБНОВИТЬ</button></div><div className="task-list">{tasks.length ? tasks.map((task) => <button className="task-card" data-task-id={task.id} key={task.id} onClick={() => void openTask(task.id)}><span className="task-card-top"><span className="task-card-title">{task.request}</span><span className={`task-card-status ${task.status}`}>{statusLabel(task.status)}</span></span><span className="task-card-time">{timeLabel(task.created_at)}</span></button>) : <div className="empty-tasks">Задачи появятся здесь</div>}</div></div>
      <div className="panel-bottom"><div className="approval-card"><div className="approval-icon">✓</div><div><b>Ты управляешь действиями</b><span>В демо агенты не имеют доступа к файлам и аккаунтам.</span></div></div><div className="version-line"><span>ENTROPY PROTOTYPE</span><span>v0.1.0</span></div></div>
    </aside>
    {taskDetail && <TaskDialog detail={taskDetail} onClose={() => setTaskDetail(null)} />}
    <span className="sr-only" aria-live="polite">{pollTick > 0 ? "Состояние обновлено" : ""}</span>
  </div>;
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]) {
  const map = new Map(existing.map((message) => [message.id, message]));
  incoming.forEach((message) => map.set(message.id, message));
  return [...map.values()].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
}

function taskFeedTitle(status: TaskStatus, live: boolean) {
  if (!live) return status === "failed" ? "Демо-handoff остановлен" : "Демо-handoff · синтетический ответ";
  if (status === "failed") return "Задача Veltrics остановлена";
  if (status === "completed") return "Ответ Veltrics готов";
  return "Entropy передал задачу Veltrics";
}

function Agent({ initials, name, subtitle, type, dim = false }: { initials: string; name: string; subtitle: string; type: string; dim?: boolean }) {
  return <div className={`agent-row ${dim ? "dimmed" : ""}`}><span className={`agent-avatar ${type}`}>{initials}</span><span className="agent-name">{name}<small>{subtitle}</small></span>{dim ? <span className="soon">позже</span> : <span className={`presence ${name === "Veltrics" ? "idle" : ""}`} />}</div>;
}

function TokenControl({ role, cap, value, onChange }: { role: Role; cap: number; value: number; onChange: (role: Role, value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const min = Math.min(MIN_TOKENS, cap);
  const position = cap <= min ? 1000 : Math.round(Math.log(value / min) / Math.log(cap / min) * 1000);
  const fromPosition = (n: number) => cap <= min ? cap : Math.round(min * (cap / min) ** (n / 1000));
  return <div className="token-setting-row"><label htmlFor={`${role}-token-limit`}>{role === "entropy" ? "Entropy · ответ" : "Veltrics · ответ"}</label><div className="token-setting-control"><input id={`${role}-token-limit`} type="number" min={min} max={cap} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { const parsed = Number(draft); if (draft.trim() && Number.isFinite(parsed)) onChange(role, parsed); else setDraft(String(value)); }} /><input className="token-slider" type="range" min="0" max="1000" value={position} aria-label={`Лимит ответа ${role}`} onChange={(event) => onChange(role, fromPosition(Number(event.target.value)))} /></div></div>;
}

function Message({ message }: { message: ChatMessage }) {
  const user = message.speaker === "Kars";
  const initials = message.speaker === "Entropy" ? "E" : message.speaker === "Veltrics" ? "V" : "A";
  return <article className={`message ${user ? "user" : "agent"} ${message.speaker === "Veltrics" ? "veltrics" : ""}`}>{!user && <div className="message-avatar">{initials}</div>}<div><div className="message-meta">{user ? "Kars" : message.speaker}</div><div className="message-content">{message.body}</div></div>{user && <div className="message-avatar kars">K</div>}</article>;
}

function GeneralWelcome({ onSelect }: { onSelect: (prompt: string) => void }) {
  return <div className="welcome"><div className="orb-wrap"><div className="orb-halo" /><div className="orb"><div className="orb-core" /><i /><i /><i /></div><span className="orb-label">E / 01</span></div><div className="eyebrow"><span className="eyebrow-line" /> YOUR PERSONAL AI WORKSPACE <span className="eyebrow-line" /></div><h1>Думай о цели.<br /><span>Entropy разберётся с путём.</span></h1><p className="welcome-copy">Ты говоришь с Entropy. Ответ Veltrics появится в ленте; ход и подробности задачи можно открыть отдельно.</p><div className="suggestions"><button className="suggestion" onClick={() => onSelect("Помоги спланировать первую версию Entropy и выдели подзадачу для Veltrics.")}><span className="suggestion-icon violet">✳</span><span><b>Спланировать Entropy</b><small>Разложить идею на шаги</small></span><span className="arrow">↗</span></button><button className="suggestion" onClick={() => onSelect("Изучи структуру проекта и предложи следующий небольшой шаг для разработки.")}><span className="suggestion-icon blue">⌘</span><span><b>Продвинуть проект</b><small>Найти следующий шаг</small></span><span className="arrow">↗</span></button></div></div>;
}

function CareerWelcome() {
  return <div className="welcome career-welcome"><div className="eyebrow"><span className="eyebrow-line" /> CAREER WORKSPACE <span className="eyebrow-line" /></div><h1>Найдём твою<br /><span>следующую работу.</span></h1><p className="welcome-copy">Вставь описание вакансии — Entropy сопоставит требования с твоим профилем, отметит пробелы и подготовит честный черновик отклика. Профиль редактируется в локальном файле data/career_profile.md.</p><p className="career-note">В live-режиме профиль и вакансия передаются выбранной модели через API. Ссылки пока не открываются автоматически: если отправишь только ссылку, Entropy попросит вставить текст. Отклики за тебя не отправляются.</p></div>;
}

function TaskDialog({ detail, onClose }: { detail: { task: Task; events: TaskEvent[] }; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  let result: { plan?: { summary?: string; steps?: string[] }; developer_result?: string } = {};
  try { result = detail.task.result ? JSON.parse(detail.task.result) : {}; } catch { /* malformed task result */ }
  return <dialog ref={dialogRef} className="task-dialog" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="task-dialog-shell"><header className="task-dialog-header"><div><span className="panel-kicker">VELTRICS · TASK DETAILS</span><h2>Задача Veltrics</h2></div><button className="icon-button" aria-label="Закрыть" onClick={onClose}>×</button></header><div className="task-dialog-content"><div className="detail-meta"><span className="detail-status">{statusLabel(detail.task.status)}</span><span>{timeLabel(detail.task.created_at)}</span></div><section className="detail-block"><h3>Запрос Kars</h3><p>{detail.task.request}</p></section><section className="detail-block"><h3>План Entropy</h3><p>{result.plan?.summary || "План не сохранён."}</p>{result.plan?.steps?.length ? <ol>{result.plan.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}</section><section className="detail-block solution"><h3>Ответ Veltrics</h3><p>{result.developer_result || "Решение появится здесь после выполнения задачи."}</p></section><section className="detail-block"><h3>Ход работы</h3><div className="detail-events">{detail.events.map((event, index) => <div className="detail-event" key={`${event.created_at}-${index}`}><b>{event.actor} · {timeLabel(event.created_at)}</b><span>{event.detail}</span></div>)}</div></section></div></div></dialog>;
}

export default App;
