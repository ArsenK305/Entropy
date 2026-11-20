import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { api, type ObservabilityEvent, type ObservabilitySnapshot } from "./api";
import { activeAgentEventIds, groupObservabilityEvents, isSameLocalCalendarDay, latestOrderDispatchEvent, type EventGroup } from "./argus-utils";
import { observabilityEventDetail as eventDetailLabel, observabilityEventLabel as eventLabel } from "./observability-utils";
import { formatRussianCount } from "./text-formatting";
import "./argus.css";
import "./argus-overrides.css";
import "./argus-interactions.css";

const agents = [
  { source: "entropy", symbol: "◈", name: "ENTROPY", role: "Оркестратор", tone: "red" },
  { source: "psyche", symbol: "Ψ", name: "PSYCHE", role: "Аналитик и проверка", tone: "violet" },
  { source: "ophira", symbol: "✳", name: "OPHIRA", role: "Исследователь", tone: "cyan" },
  { source: "veltrics", symbol: "⌁", name: "VELTRICS", role: "Разработчик", tone: "orange" },
];
const sourceLabels: Record<string, string> = {
  entropy: "ENTROPY",
  entropy_flow: "ENTROPY / RAG",
  psyche: "PSYCHE",
  ophira: "OPHIRA",
  veltrics: "VELTRICS",
  telegram_miniapp: "TELEGRAM",
  telegram_flow: "TELEGRAM MINI APP",
  miniapp_preview: "ПРЕДПРОСМОТР MINI APP",
  n8n: "N8N",
};
const flowSourceFilters: Record<string, string[]> = {
  entropy_flow: ["entropy", "rag"],
  telegram_flow: ["telegram_miniapp", "miniapp_preview"],
};

const timeLabel = (value: string) => new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
const dateTimeLabel = (value: string) => new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)).replace(/\./g, "");
const journalTimeLabel = (value: string) => isSameLocalCalendarDay(value, new Date()) ? timeLabel(value) : dateTimeLabel(value);

type MetricFilter = "today" | "workflows-completed" | "active" | "failed";

const metricFilterLabels: Record<MetricFilter, string> = {
  today: "ЗА СЕГОДНЯ",
  "workflows-completed": "ЗАВЕРШЁННЫЕ N8N",
  active: "АКТИВНЫЕ ВЕТКИ АГЕНТОВ",
  failed: "ОШИБКИ ЗА СЕГОДНЯ",
};

function matchesMetricFilter(group: EventGroup, filter: MetricFilter, activeEventIds: Set<number>): boolean {
  if (filter === "today") return group.events.some((event) => isSameLocalCalendarDay(event.created_at, new Date()));
  if (filter === "workflows-completed") return group.events.some((event) => event.event_type === "workflow.completed" && isSameLocalCalendarDay(event.created_at, new Date()));
  if (filter === "active") return group.events.some((event) => activeEventIds.has(event.id));
  return group.events.some((event) => event.status === "failed" && isSameLocalCalendarDay(event.created_at, new Date()));
}

function eventGroupTitle(group: EventGroup): string {
  const created = group.events.find((event) => event.event_type === "order.created");
  if (created) return eventDetailLabel(created);
  return eventLabel(group.events[0].event_type);
}

function eventGroupStatus(group: EventGroup): { label: string; tone: string; progress: string } {
  const latest = group.events[0];
  const workflowUpdate = group.events.find((event) => ["workflow.started", "workflow.completed", "workflow.failed"].includes(event.event_type));
  const dispatchUpdate = latestOrderDispatchEvent(group.events);
  if (workflowUpdate?.event_type === "workflow.completed") return { label: "Готово", tone: "completed", progress: "n8n закончил обработку заказа" };
  if (workflowUpdate?.event_type === "workflow.failed") return { label: "Ошибка", tone: "failed", progress: "Workflow завершился с ошибкой" };
  if (dispatchUpdate?.event_type === "workflow.dispatch_failed") return { label: "Ошибка", tone: "failed", progress: "n8n не принял заказ" };
  if (workflowUpdate?.event_type === "workflow.started") return { label: "В процессе", tone: "running", progress: "n8n начал обработку" };
  if (dispatchUpdate?.event_type === "workflow.dispatch_retry") return { label: "Повтор передачи", tone: "waiting", progress: "Временная ошибка; следующая попытка запланирована" };
  if (dispatchUpdate?.event_type === "workflow.dispatched") return { label: "Передано", tone: "accepted", progress: "Webhook ответил; ждём события workflow" };
  if (dispatchUpdate?.event_type === "workflow.dispatch_queued") return { label: "В очереди", tone: "waiting", progress: "Передача в n8n ожидает своей попытки" };
  if (group.events.some((event) => event.event_type === "workflow.not_configured")) return { label: "n8n не подключён", tone: "waiting", progress: "Заказ сохранён; webhook не настроен" };
  if (latest.status === "failed") return { label: "Ошибка", tone: "failed", progress: "Событие завершилось с ошибкой" };
  if (latest.status === "completed") return { label: "Завершено", tone: "completed", progress: eventLabel(latest.event_type) };
  return { label: latest.status === "running" ? "В процессе" : "Событие", tone: latest.status === "running" ? "running" : "", progress: eventLabel(latest.event_type) };
}

function latestFor(events: ObservabilityEvent[], source: string): ObservabilityEvent | undefined {
  return events.find((event) => event.source === source);
}

function eventStatus(event?: ObservabilityEvent): string {
  if (!event) return "Нет событий";
  if (event.status === "failed") return "Ошибка";
  if (event.status === "running" || event.status === "started") return "Выполняется";
  if (event.status === "completed") return "Завершено";
  if (event.status === "accepted") return "Передано";
  if (event.status === "waiting") return "Ожидает подключения";
  return eventDetailLabel(event);
}

export default function ArgusDashboard() {
  const [snapshot, setSnapshot] = useState<ObservabilitySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<MetricFilter | null>(null);
  const [selectedPlanNode, setSelectedPlanNode] = useState<{ name: string; description: string } | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<number | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState("");
  const refreshingRef = useRef(false);
  const handledDeepLinkIdRef = useRef<number | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState(() => {
    const section = window.location.hash.slice(1);
    return ["flow", "agents", "events"].includes(section) ? section : "overview";
  });

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      setSnapshot(await api.observability());
      setLoadError("");
      setLastUpdated(new Date().toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Argus не смог загрузить события.");
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Argus — Entropy";
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const initialHash = window.location.hash.slice(1);
    if (["flow", "agents", "events"].includes(initialHash)) {
      window.requestAnimationFrame(() => {
        const main = mainRef.current;
        const target = document.getElementById(initialHash);
        if (main && target) main.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16) });
      });
    }
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);

  const navigateSection = (event: MouseEvent<HTMLAnchorElement>, section: string) => {
    event.preventDefault();
    setActiveSection(section);
    window.history.replaceState(null, "", `#${section}`);
    const main = mainRef.current;
    if (!main) return;
    if (section === "overview") {
      main.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const target = document.getElementById(section);
    if (!target) return;
    const top = target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16;
    main.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  const syncActiveSection = () => {
    const main = mainRef.current;
    if (!main) return;
    const threshold = main.getBoundingClientRect().top + 80;
    const sections = [
      ["overview", main.querySelector<HTMLElement>(".argus-title-row")],
      ["events", document.getElementById("events")],
      ["agents", document.getElementById("agents")],
      ["flow", document.getElementById("flow")],
    ] as const;
    const positions = sections
      .map(([section, element]) => ({ section, top: element?.getBoundingClientRect().top }))
      .filter((item): item is { section: typeof sections[number][0]; top: number } => item.top !== undefined);
    const closestDistance = Math.min(...positions.map((item) => Math.abs(item.top - threshold)));
    const nearest = positions.filter((item) => Math.abs(item.top - threshold) <= closestDistance + 1);
    const lowerColumns = nearest.filter((item) => item.section === "events" || item.section === "agents");
    if (lowerColumns.length === 2) {
      setActiveSection((previous) => {
        const next = previous === "events" || previous === "agents" ? previous : "events";
        return previous === next ? previous : next;
      });
      return;
    }
    const current = nearest[0]?.section ?? "overview";
    setActiveSection((previous) => previous === current ? previous : current);
  };

  const events = snapshot?.events || [];
  const eventGroups = groupObservabilityEvents(events);
  const activeEventIds = activeAgentEventIds(events);
  const matchingSources = selectedSource ? flowSourceFilters[selectedSource] ?? [selectedSource] : null;
  const visibleEventGroups = eventGroups.filter((group) => {
    const matchesSource = !selectedSource || group.events.some((event) => matchingSources?.includes(event.source));
    const matchesMetric = !selectedMetric || matchesMetricFilter(group, selectedMetric, activeEventIds);
    return matchesSource && matchesMetric;
  });
  const selectedAgent = agents.find((agent) => agent.source === selectedSource);
  const selectedSourceLabel = selectedSource
    ? sourceLabels[selectedSource] ?? selectedAgent?.name
    : selectedMetric ? metricFilterLabels[selectedMetric] : undefined;
  const selectMetricFilter = (filter: MetricFilter) => {
    setSelectedSource(null);
    setSelectedMetric(filter);
    setSelectedPlanNode(null);
    setActiveSection("events");
    window.history.replaceState(null, "", "#events");
    window.requestAnimationFrame(() => {
      const main = mainRef.current;
      const target = document.getElementById("events");
      if (main && target) main.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16), behavior: "smooth" });
    });
  };
  const showEventInJournal = (event: ObservabilityEvent) => {
    const groupKey = event.correlation_id ? `correlation:${event.correlation_id}` : `event:${event.id}`;
    setSelectedSource(null);
    setSelectedMetric(null);
    setSelectedPlanNode(null);
    setFocusedEventId(event.id);
    setActiveSection("events");
    window.history.replaceState(null, "", "#events");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const group = Array.from(document.querySelectorAll<HTMLDetailsElement>(".argus-event-group"))
        .find((item) => item.dataset.groupKey === groupKey);
      if (!group) return;
      group.open = true;
      const row = Array.from(group.querySelectorAll<HTMLElement>("[data-event-id]"))
        .find((item) => item.dataset.eventId === String(event.id));
      (row ?? group).scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  };
  useEffect(() => {
    if (!snapshot) return;
    const rawEventId = new URLSearchParams(window.location.search).get("event_id");
    const eventId = rawEventId && /^\d+$/.test(rawEventId) ? Number(rawEventId) : null;
    if (!eventId || handledDeepLinkIdRef.current === eventId) return;
    handledDeepLinkIdRef.current = eventId;
    const event = snapshot.events.find((item) => item.id === eventId);
    if (event) {
      showEventInJournal(event);
      return;
    }
    setDeepLinkNotice("Это событие уже не входит в последние 50 записей Argus.");
    setActiveSection("events");
    window.history.replaceState(null, "", "#events");
    window.requestAnimationFrame(() => {
      const main = mainRef.current;
      const target = document.getElementById("events");
      if (main && target) main.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16) });
    });
  }, [snapshot]);
  const selectAgentSource = (source: string) => {
    setSelectedSource((current) => current === source ? null : source);
    setSelectedMetric(null);
    setSelectedPlanNode(null);
    setActiveSection("events");
    window.history.replaceState(null, "", "#events");
    window.requestAnimationFrame(() => {
      const main = mainRef.current;
      const target = document.getElementById("events");
      if (main && target) main.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16), behavior: "smooth" });
    });
  };
  const latestOrderGroup = eventGroups.find((group) =>
    group.events.some((event) => event.event_type === "order.created"),
  );
  const n8nConfigured = Boolean(snapshot?.n8n_configured);
  const n8nEventTokenConfigured = snapshot?.n8n_event_token_configured;
  const telegramConfigured = Boolean(snapshot?.telegram_configured);

  return <main className="argus-shell">
    <div className="argus-grain" aria-hidden="true" />
    <header className="argus-topbar">
      <a className="argus-brand" href="/"><span className="argus-brand-mark"><span/><span/><span/></span><span className="argus-brand-name">entropy<span className="entropy-period">.</span><small>ARGUS / OBSERVABILITY</small></span></a>
      <div className="argus-breadcrumb">СИСТЕМЫ <span>/</span> НАБЛЮДЕНИЕ <span>/</span> <b>СОБЫТИЯ</b></div>
      <div className="argus-top-right"><span className={`argus-demo-badge ${loadError ? "offline" : ""} ${!loadError && snapshot?.n8n_configured ? "configured" : ""}`}><i /> {loadError ? "API НЕДОСТУПЕН" : snapshot?.n8n_configured ? "АДРЕС N8N УКАЗАН" : "АДРЕС N8N НЕ ЗАДАН"}</span><a className="argus-back" href="/">← <span>В рабочее пространство</span></a><span className="argus-user">K</span></div>
    </header>

    <div className="argus-layout">
      <aside className="argus-rail">
        <div className="argus-rail-label">ARGUS</div>
        <a className={`argus-rail-link ${activeSection === "overview" ? "selected" : ""}`} href="#overview" onClick={(event) => navigateSection(event, "overview")}><span>◈</span> Обзор</a>
        <a className={`argus-rail-link ${activeSection === "flow" ? "selected" : ""}`} href="#flow" onClick={(event) => navigateSection(event, "flow")}><span>⌘</span> Поток <em>ПЛАН</em></a>
        <a className={`argus-rail-link ${activeSection === "agents" ? "selected" : ""}`} href="#agents" onClick={(event) => navigateSection(event, "agents")}><span>◎</span> Агенты <em>{agents.length}</em></a>
        <a className={`argus-rail-link ${activeSection === "events" ? "selected" : ""}`} href="#events" onClick={(event) => navigateSection(event, "events")}><span>≋</span> События <em>{events.length}</em></a>
        <div className="argus-rail-bottom"><div className={`argus-health ${n8nConfigured ? "configured" : ""}`}><span className="health-orb"/><span>{n8nConfigured ? "n8n" : "n8n URL не задан"}<small>{n8nConfigured ? `URL задан · callback-секрет ${n8nEventTokenConfigured === undefined ? "статус недоступен; обнови backend" : n8nEventTokenConfigured ? "загружен; совпадение не проверено" : "не задан"}` : "Ждёт ENTROPY_N8N_WEBHOOK_URL"}</small></span></div><div className="argus-rail-version">ARGUS · ENTROPY MODULE</div></div>
      </aside>

      <section className="argus-main" id="overview" ref={mainRef} onScroll={syncActiveSection}>
        <nav className="argus-mobile-nav" aria-label="Навигация по разделам Argus">
          {[
            ["overview", "Обзор"],
            ["events", "События"],
            ["agents", "Компоненты"],
            ["flow", "Схема"],
          ].map(([section, label]) => (
            <a
              className={`argus-mobile-nav-link ${activeSection === section ? "selected" : ""}`}
              aria-current={activeSection === section ? "location" : undefined}
              href={`#${section}`}
              key={section}
              onClick={(event) => navigateSection(event, section)}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="argus-title-row"><div><div className="argus-eyebrow"><span /> ARGUS · НАБЛЮДЕНИЕ ENTROPY</div><h1>Argus <span>наблюдает за потоком.</span></h1><p className="argus-intro">Один тестовый заказ может создать несколько событий: это шаги обработки, не несколько покупок. Нажми показатель или компонент, чтобы отфильтровать журнал; схема компонентов помечена как план.</p></div><button className="argus-run" type="button" onClick={() => void refresh()} disabled={refreshing}><span className={refreshing ? "argus-spinner" : ""}>{refreshing ? "◌" : "↻"}</span>{refreshing ? "Обновляю…" : "Обновить события"}</button></div>

        {loadError && <div className="argus-load-error" role="alert"><span>ARGUS API НЕДОСТУПЕН</span><b>{loadError}</b><small>Проверь запуск Python-сервера, PostgreSQL и миграций.</small></div>}

        <div className="argus-metrics">
          <Metric label="ЗАПИСЕЙ ЖУРНАЛА СЕГОДНЯ" value={String(snapshot?.summary.events_today ?? 0).padStart(2, "0")} change={`Заказов: ${snapshot?.summary.orders_today ?? 0} · по часам браузера`} icon="≋" selected={selectedMetric === "today"} onClick={() => selectMetricFilter("today")} />
          <Metric label="N8N ЗАВЕРШИЛ СЕГОДНЯ" value={String(snapshot?.summary.completed_workflows_today ?? 0).padStart(2, "0")} change={`Сценариев в работе · ${String(snapshot?.summary.active_workflows ?? 0).padStart(2, "0")}`} icon="⌁" selected={selectedMetric === "workflows-completed"} onClick={() => selectMetricFilter("workflows-completed")} />
          <Metric label="АКТИВНЫХ ВЕТОК АГЕНТОВ" value={String(snapshot?.summary.active_agents ?? 0).padStart(2, "0")} change="По последнему статусу каждой ветки" icon="◎" selected={selectedMetric === "active"} onClick={() => selectMetricFilter("active")} />
          <Metric label="СОБЫТИЙ С ОШИБКОЙ" value={String(snapshot?.summary.failed_today ?? 0).padStart(2, "0")} change="Записи журнала, не заказы" icon="!" selected={selectedMetric === "failed"} onClick={() => selectMetricFilter("failed")} />
        </div>

        <section className="argus-card argus-trace-card" aria-labelledby="latest-order-title">
          <div className="argus-card-head"><div><div className="argus-card-kicker"><span className="live-indicator"/> ФАКТИЧЕСКИЕ СОБЫТИЯ · НАЖМИ ШАГ ДЛЯ ДЕТАЛЕЙ</div><h2 id="latest-order-title">Последний тестовый заказ</h2></div>
            {latestOrderGroup && <span className={`event-group-status ${eventGroupStatus(latestOrderGroup).tone}`}>{eventGroupStatus(latestOrderGroup).label}</span>}
          </div>
          {latestOrderGroup ? <div className="argus-trace-body">
            <div className="argus-trace-summary"><b title={eventGroupTitle(latestOrderGroup)}>{eventGroupTitle(latestOrderGroup)}</b><small>{formatRussianCount(latestOrderGroup.events.length, "событие", "события", "событий")} · без оплаты · {dateTimeLabel(latestOrderGroup.events[0].created_at)}</small></div>
            <ol className="argus-trace-steps">{[...latestOrderGroup.events].reverse().map((event) => {
              const failed = event.status === "failed";
              const complete = !failed && event.status !== "running" && event.status !== "started";
              return <li className={`argus-trace-step ${failed ? "failed" : complete ? "complete" : "pending"}`} key={event.id}>
                <span className="argus-trace-marker" aria-hidden="true">{failed ? "!" : complete ? "✓" : "·"}</span>
                <div className="argus-trace-step-copy"><b><button className="argus-trace-link" type="button" aria-label={`Показать в журнале: ${eventLabel(event.event_type)}`} onClick={() => showEventInJournal(event)}>{eventLabel(event.event_type)}</button></b><small title={eventDetailLabel(event)}>{eventDetailLabel(event)}</small></div>
                <span className="argus-trace-source">{event.source === "miniapp_preview" ? "ПРЕДПРОСМОТР" : event.source === "telegram_miniapp" ? "TELEGRAM" : event.source.toUpperCase()}</span>
                <time>{journalTimeLabel(event.created_at)}</time>
              </li>;
            })}</ol>
          </div> : <div className="argus-trace-empty"><span>ЗАКАЗОВ ПОКА НЕТ</span><small>Когда Mini App сохранит тестовый заказ, здесь появятся его шаги и ответ n8n.</small><a className="argus-preview-link" href="/miniapp?preview=1">Открыть локальный preview каталога ↗</a></div>}
        </section>

          <div className="argus-lower-grid">
          <section className="argus-card events-card" id="events"><div className="argus-card-head"><div><div className="argus-card-kicker">{selectedSourceLabel ? `ПОСЛЕДНИЕ 50 · ${selectedSourceLabel}` : "ПОСЛЕДНИЕ 50 ЗАПИСЕЙ · ШАГИ ЗАКАЗА СГРУППИРОВАНЫ"}</div><h2>Последние события и заказы</h2></div><div className="argus-event-controls"><span className="argus-event-count">Групп: {visibleEventGroups.length} · записей: {visibleEventGroups.reduce((count, group) => count + group.events.length, 0)}</span>{(selectedSource || selectedMetric) && <button className="argus-filter-clear" type="button" onClick={() => { setSelectedSource(null); setSelectedMetric(null); }}>Все события</button>}</div></div>
              {deepLinkNotice && <p className="argus-event-notice" role="status">{deepLinkNotice}</p>}
            {visibleEventGroups.length ? <div className="argus-event-list">{visibleEventGroups.map((group) => {
              const latest = group.events[0];
              const status = eventGroupStatus(group);
              return <details className="argus-event-group" data-group-key={group.key} key={group.key}>
                <summary className="argus-event-group-summary">
                  <time>{journalTimeLabel(latest.created_at)}</time>
                  <span className={`event-group-status ${status.tone}`}>{status.label}</span>
                  <div className="event-group-main"><b title={eventGroupTitle(group)}>{eventGroupTitle(group)}</b><small>{formatRussianCount(group.events.length, "событие", "события", "событий")}{group.events.length > 1 ? ` · ${status.progress}` : ""}</small></div>
                  <span className="event-group-chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="event-group-steps">{[...group.events].reverse().map((event) => <div className={`argus-event ${focusedEventId === event.id ? "focused" : ""}`} data-event-id={event.id} key={event.id}>
                  <time>{journalTimeLabel(event.created_at)}</time>
                  <span title={event.source} className={`event-type ${event.status === "failed" ? "red" : event.status === "running" ? "violet" : "cyan"}`}>{event.source === "miniapp_preview" ? "ПРЕДПРОСМОТР" : event.source === "telegram_miniapp" ? "TELEGRAM" : event.source.toUpperCase()}</span>
                  <div><b title={event.event_type}>{eventLabel(event.event_type)}</b><small title={eventDetailLabel(event)}>{eventDetailLabel(event)}</small></div>
                  <span className="event-arrow">{event.status === "failed" ? "!" : "·"}</span>
                </div>)}</div>
              </details>;
            })}</div> : <div className="argus-empty-events"><span>≋</span><b>{loadError ? "События не загружены" : selectedSourceLabel ? `Событий по фильтру «${selectedSourceLabel.toLowerCase()}» нет` : "Событий пока нет"}</b><small>{loadError ? "Argus повторит подключение автоматически." : selectedMetric ? "Попробуй другой показатель или верни весь журнал." : selectedSource ? "Для этого компонента ещё не записаны события." : "Создай заказ в Telegram Mini App или подключи n8n."}</small>{(selectedSource || selectedMetric) && <button className="argus-filter-clear" type="button" onClick={() => { setSelectedSource(null); setSelectedMetric(null); }}>Показать все события</button>}</div>}
          </section>
          <section className="argus-card agent-card" id="agents"><div className="argus-card-head"><div><div className="argus-card-kicker">СТАТУС ПОСЛЕДНИХ СОБЫТИЙ</div><h2>Компоненты Entropy</h2></div><span className="argus-event-count">{agents.length} · нажми, чтобы увидеть события</span></div>
            <div className="agent-grid">{agents.map((agent) => { const latest = latestFor(events, agent.source); return <AgentCard key={agent.source} {...agent} event={latest} selected={selectedSource === agent.source} onSelect={() => selectAgentSource(agent.source)} />; })}</div>
          </section>
        </div>

        <section className="argus-card argus-flow-card" id="flow">
          <div className="argus-card-head"><div><div className="argus-card-kicker">БУДУЩИЕ КОМПОНЕНТЫ И СВЯЗИ</div><h2>Планируемая схема Entropy</h2></div><div className="argus-card-meta"><span className="argus-chip">НЕ ТРАССА ЗАКАЗА</span><span className="argus-flow-hint">Нажми узел: покажу события или статус</span><span className="argus-updated">{lastUpdated ? `API · ${lastUpdated}` : "API · ОЖИДАНИЕ"}</span></div></div>
          <div className="argus-flow-canvas"><div className="argus-flow-grid" />
            <svg className="argus-connectors" viewBox="0 0 1000 180" preserveAspectRatio="none" aria-hidden="true"><path d="M95 91 H250 M250 91 H410 M410 91 H570 M570 91 C625 91 625 48 700 48 H750 M570 91 C625 91 625 133 700 133 H750 M750 48 C820 48 820 91 905 91 M750 133 C820 133 820 91 905 91"/></svg>
            <FlowNode className="node-telegram" icon="↗" name="TELEGRAM" description="Mini App" status={telegramConfigured ? "ТОКЕН ЗАДАН" : "ЖДЁТ БОТА"} selected={selectedSource === "telegram_flow"} onSelect={() => selectAgentSource("telegram_flow")} />
            <FlowNode className="node-entropy" icon="◈" name="ENTROPY" description="Оркестратор" status="ОСНОВНОЙ СЕРВИС" selected={selectedSource === "entropy_flow"} onSelect={() => selectAgentSource("entropy_flow")} />
            <FlowNode className="node-n8n" icon="⌘" name="n8n" description="Автоматизация" status={n8nConfigured ? "АДРЕС УКАЗАН" : "НЕ ПОДКЛЮЧЁН"} selected={selectedSource === "n8n"} onSelect={() => selectAgentSource("n8n")} />
            <FlowNode className="node-wormhole" icon="⟡" name="WORMHOLE" description="Шлюз инструментов" status="ПЛАН" selected={selectedPlanNode?.name === "WORMHOLE"} onSelect={() => { setSelectedSource(null); setSelectedMetric(null); setSelectedPlanNode({ name: "WORMHOLE", description: "Шлюз инструментов" }); }} />
            <FlowNode className="node-psyche" icon="Ψ" name="PSYCHE" description="Аналитик" status={eventStatus(latestFor(events, "psyche")).toUpperCase()} selected={selectedSource === "psyche"} onSelect={() => selectAgentSource("psyche")} />
            <FlowNode className="node-ophira" icon="✳" name="OPHIRA" description="Исследователь" status={eventStatus(latestFor(events, "ophira")).toUpperCase()} selected={selectedSource === "ophira"} onSelect={() => selectAgentSource("ophira")} />
            <FlowNode className="node-redshift" icon="⌁" name="REDSHIFT" description="Состояние задач" status="ПЛАН" selected={selectedPlanNode?.name === "REDSHIFT"} onSelect={() => { setSelectedSource(null); setSelectedMetric(null); setSelectedPlanNode({ name: "REDSHIFT", description: "Состояние задач" }); }} />
          </div>
          {selectedPlanNode && <div className="argus-plan-note" role="status"><span><b>{selectedPlanNode.name} · {selectedPlanNode.description}</b>Элемент архитектурного плана. Сейчас не подключён; связанных событий ещё нет.</span><button type="button" onClick={() => setSelectedPlanNode(null)} aria-label="Закрыть пояснение">×</button></div>}
          <div className="argus-flow-legend"><span><i className="legend-dot red-dot"/> Поток запроса</span><span><i className="legend-dot violet-dot"/> Ветка агентов</span><span className="argus-flow-caption">АРХИТЕКТУРНЫЙ ПЛАН · НЕ ОТОБРАЖАЕТ ШАГИ ОДНОГО ЗАКАЗА</span></div>
        </section>
        <footer className="argus-footer"><span>ARGUS <i>●</i> НАБЛЮДАЕМОСТЬ ENTROPY</span><span>{snapshot ? `ОБНОВЛЕНО ${lastUpdated}` : "ОЖИДАНИЕ API"}</span></footer>
      </section>
    </div>
  </main>;
}

function Metric({ label, value, change, icon, selected, onClick }: { label: string; value: string; change: string; icon: string; selected: boolean; onClick: () => void }) {
  return <button type="button" className="argus-metric" aria-pressed={selected} aria-label={`Показать события: ${label.toLowerCase()}`} title="Нажми, чтобы открыть связанные события" onClick={onClick}><span className="metric-top"><span>{label}</span><i>{icon}</i></span><span className="metric-value">{value}</span><span className="metric-change">{change}</span></button>;
}

function FlowNode({ className, icon, name, description, status, selected, onSelect }: { className: string; icon: string; name: string; description: string; status: string; selected?: boolean; onSelect?: () => void }) {
  const content = <><span className="node-icon">{icon}</span><b>{name}</b><small>{description}</small><i className="node-state">{status}</i></>;
  if (!onSelect) return <div className={`argus-node ${className}`} aria-label={`${name}: ${description}; ${status}`}>{content}</div>;
  const planned = status === "ПЛАН";
  const action = planned ? `Показать статус ${name}` : `Показать события ${name}`;
  return <button type="button" className={`argus-node flow-node-button ${className} ${selected ? "selected" : ""}`} aria-pressed={selected} aria-label={action} title={action} onClick={onSelect}>{content}</button>;
}

function AgentCard({ symbol, name, role, tone, event, selected, onSelect }: { source: string; symbol: string; name: string; role: string; tone: string; event?: ObservabilityEvent; selected: boolean; onSelect: () => void }) {
  const active = event?.status === "running" || event?.status === "started";
  const failed = event?.status === "failed";
  return <button type="button" className={`agent-tile ${tone} ${failed ? "failed" : ""} ${selected ? "selected" : ""}`} aria-pressed={selected} aria-label={`Показать события ${name}`} title={`Показать события ${name}`} onClick={onSelect}><span className="agent-tile-top"><span className="agent-symbol">{symbol}</span><span className={`agent-presence ${active ? "active" : ""} ${failed ? "failed" : ""}`} /></span><b>{name}</b><small>{role}</small><span className="agent-status"><i />{eventStatus(event)}</span></button>;
}
