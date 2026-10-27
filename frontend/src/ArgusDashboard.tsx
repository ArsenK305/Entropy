import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { api, type ObservabilityEvent, type ObservabilitySnapshot } from "./api";
import "./argus.css";
import "./argus-overrides.css";

const agents = [
  { source: "entropy", symbol: "◈", name: "ENTROPY", role: "Оркестратор", tone: "red" },
  { source: "psyche", symbol: "Ψ", name: "PSYCHE", role: "Аналитик и reviewer", tone: "violet" },
  { source: "ophira", symbol: "✳", name: "OPHIRA", role: "Исследователь", tone: "cyan" },
  { source: "veltrics", symbol: "⌁", name: "VELTRICS", role: "Разработчик", tone: "orange" },
];

const timeLabel = (value: string) => new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));

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
  return event.detail;
}

export default function ArgusDashboard() {
  const [snapshot, setSnapshot] = useState<ObservabilitySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const refreshingRef = useRef(false);
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

  const events = snapshot?.events || [];
  const n8nConfigured = Boolean(snapshot?.n8n_configured);
  const telegramConfigured = Boolean(snapshot?.telegram_configured);
  const eventCount = snapshot?.summary.events_today ?? 0;

  return <main className="argus-shell">
    <div className="argus-grain" aria-hidden="true" />
    <header className="argus-topbar">
      <a className="argus-brand" href="/"><span className="argus-brand-mark"><span/><span/><span/></span><span className="argus-brand-name">entropy<span className="entropy-period">.</span><small>ARGUS / OBSERVABILITY</small></span></a>
      <div className="argus-breadcrumb">SYSTEMS <span>/</span> OBSERVABILITY <span>/</span> <b>EVENTS</b></div>
      <div className="argus-top-right"><span className={`argus-demo-badge ${loadError ? "offline" : ""}`}><i /> {loadError ? "API OFFLINE" : snapshot?.n8n_configured ? "WEBHOOK CONFIGURED" : "LOCAL OBSERVABILITY"}</span><a className="argus-back" href="/">← <span>В рабочее пространство</span></a><span className="argus-user">K</span></div>
    </header>

    <div className="argus-layout">
      <aside className="argus-rail">
        <div className="argus-rail-label">ARGUS</div>
        <a className={`argus-rail-link ${activeSection === "overview" ? "selected" : ""}`} href="#overview" onClick={(event) => navigateSection(event, "overview")}><span>◈</span> Обзор</a>
        <a className={`argus-rail-link ${activeSection === "flow" ? "selected" : ""}`} href="#flow" onClick={(event) => navigateSection(event, "flow")}><span>⌘</span> Поток <em>ПЛАН</em></a>
        <a className={`argus-rail-link ${activeSection === "agents" ? "selected" : ""}`} href="#agents" onClick={(event) => navigateSection(event, "agents")}><span>◎</span> Агенты <em>{agents.length}</em></a>
        <a className={`argus-rail-link ${activeSection === "events" ? "selected" : ""}`} href="#events" onClick={(event) => navigateSection(event, "events")}><span>≋</span> События <em>{events.length}</em></a>
        <div className="argus-rail-bottom"><div className={`argus-health ${n8nConfigured ? "configured" : ""}`}><span className="health-orb"/><span>{n8nConfigured ? "n8n WEBHOOK" : "n8n НЕ ПОДКЛЮЧЁН"}<small>{n8nConfigured ? "URL задан · доступность не проверена" : "Ждёт ENTROPY_N8N_WEBHOOK_URL"}</small></span></div><div className="argus-rail-version">ARGUS · ENTROPY MODULE</div></div>
      </aside>

      <section className="argus-main" id="overview" ref={mainRef}>
        <div className="argus-title-row"><div><div className="argus-eyebrow"><span /> ENTROPY SYSTEMS / OBSERVABILITY</div><h1>Argus <span>наблюдает за потоком.</span></h1><p className="argus-intro">События из базы, ход n8n-сценариев и статусы агентов — без выдуманной телеметрии.</p></div><button className="argus-run" type="button" onClick={() => void refresh()} disabled={refreshing}><span className={refreshing ? "argus-spinner" : ""}>{refreshing ? "◌" : "↻"}</span>{refreshing ? "Обновляю…" : "Обновить события"}</button></div>

        {loadError && <div className="argus-load-error" role="alert"><span>ARGUS API НЕДОСТУПЕН</span><b>{loadError}</b><small>Проверь запуск Python-сервера, PostgreSQL и миграций.</small></div>}

        <div className="argus-metrics">
          <Metric label="СОБЫТИЯ СЕГОДНЯ" value={String(snapshot?.summary.events_today ?? 0).padStart(2, "0")} change="Сохранено в базе" icon="≋" />
          <Metric label="АКТИВНЫЕ WORKFLOWS" value={String(snapshot?.summary.active_workflows ?? 0).padStart(2, "0")} change={n8nConfigured ? "Состояние по событиям" : "n8n не настроен"} icon="⌁" />
          <Metric label="АКТИВНЫЕ АГЕНТЫ" value={String(snapshot?.summary.active_agents ?? 0).padStart(2, "0")} change="Последние статусы" icon="◎" />
          <Metric label="СБОИ СЕГОДНЯ" value={String(snapshot?.summary.failed_today ?? 0).padStart(2, "0")} change="Требуют внимания" icon="!" />
        </div>

        <section className="argus-card argus-flow-card" id="flow">
          <div className="argus-card-head"><div><div className="argus-card-kicker">TARGET TOPOLOGY</div><h2>Планируемый путь события</h2></div><div className="argus-card-meta"><span className="argus-chip">АРХИТЕКТУРНАЯ СХЕМА</span><span className="argus-updated">{lastUpdated ? `API · ${lastUpdated}` : "API · ОЖИДАНИЕ"}</span></div></div>
          <div className="argus-flow-canvas"><div className="argus-flow-grid" />
            <svg className="argus-connectors" viewBox="0 0 1000 180" preserveAspectRatio="none" aria-hidden="true"><path d="M95 91 H250 M250 91 H410 M410 91 H570 M570 91 C625 91 625 48 700 48 H750 M570 91 C625 91 625 133 700 133 H750 M750 48 C820 48 820 91 905 91 M750 133 C820 133 820 91 905 91"/></svg>
            <FlowNode className="node-telegram" icon="↗" name="TELEGRAM" description="Mini App" status={telegramConfigured ? "ТОКЕН ЗАДАН" : "ЖДЁТ БОТА"} />
            <FlowNode className="node-entropy" icon="◈" name="ENTROPY" description="Оркестратор" status="ОСНОВНОЙ СЕРВИС" />
            <FlowNode className="node-n8n" icon="⌘" name="n8n" description="Workflow engine" status={n8nConfigured ? "URL ЗАДАН" : "НЕ ПОДКЛЮЧЁН"} />
            <FlowNode className="node-wormhole" icon="⟡" name="WORMHOLE" description="Tool gateway" status="ПЛАН" />
            <FlowNode className="node-psyche" icon="Ψ" name="PSYCHE" description="Аналитик" status={eventStatus(latestFor(events, "psyche")).toUpperCase()} />
            <FlowNode className="node-ophira" icon="✳" name="OPHIRA" description="Исследователь" status={eventStatus(latestFor(events, "ophira")).toUpperCase()} />
            <FlowNode className="node-redshift" icon="⌁" name="REDSHIFT" description="Состояние задач" status="ПЛАН" />
          </div>
          <div className="argus-flow-legend"><span><i className="legend-dot red-dot"/> Поток запроса</span><span><i className="legend-dot violet-dot"/> Ветка агентов</span><span className="argus-flow-caption">СХЕМА ПЛАНА · СТАТУСЫ ПОЯВЛЯЮТСЯ ПОСЛЕ ПОДКЛЮЧЕНИЯ СЕРВИСОВ</span></div>
        </section>

        <div className="argus-lower-grid">
          <section className="argus-card agent-card" id="agents"><div className="argus-card-head"><div><div className="argus-card-kicker">OBSERVED COMPONENTS</div><h2>Агенты Entropy</h2></div><span className="argus-event-count">СОБЫТИЙ: {eventCount}</span></div>
            <div className="agent-grid">{agents.map((agent) => { const latest = latestFor(events, agent.source); return <AgentCard key={agent.source} {...agent} event={latest} />; })}</div>
          </section>
          <section className="argus-card events-card" id="events"><div className="argus-card-head"><div><div className="argus-card-kicker">PERSISTED EVENT STREAM</div><h2>Последние события</h2></div><span className="argus-event-count">{String(events.length).padStart(2, "0")}</span></div>
            {events.length ? <div className="argus-event-list">{events.map((event) => <div className="argus-event" key={event.id}><time>{timeLabel(event.created_at)}</time><span title={event.source} className={`event-type ${event.status === "failed" ? "red" : event.status === "running" ? "violet" : "cyan"}`}>{event.source === "miniapp_preview" ? "PREVIEW" : event.source === "telegram_miniapp" ? "TELEGRAM" : event.source.toUpperCase()}</span><div><b title={event.event_type}>{event.event_type}</b><small title={event.detail}>{event.detail}</small></div><span className="event-arrow">{event.status === "failed" ? "!" : "·"}</span></div>)}</div> : <div className="argus-empty-events"><span>≋</span><b>{loadError ? "События не загружены" : "Событий пока нет"}</b><small>{loadError ? "Argus повторит подключение автоматически." : "Создай заказ в Telegram Mini App или подключи n8n."}</small></div>}
          </section>
        </div>
        <footer className="argus-footer"><span>ARGUS <i>●</i> НАБЛЮДАЕМОСТЬ ENTROPY</span><span>{snapshot ? `ОБНОВЛЕНО ${lastUpdated}` : "ОЖИДАНИЕ API"}</span></footer>
      </section>
    </div>
  </main>;
}

function Metric({ label, value, change, icon }: { label: string; value: string; change: string; icon: string }) {
  return <article className="argus-metric"><div className="metric-top"><span>{label}</span><i>{icon}</i></div><div className="metric-value">{value}</div><div className="metric-change">{change}</div></article>;
}

function FlowNode({ className, icon, name, description, status }: { className: string; icon: string; name: string; description: string; status: string }) {
  return <div className={`argus-node ${className}`}><span className="node-icon">{icon}</span><b>{name}</b><small>{description}</small><i className="node-state">{status}</i></div>;
}

function AgentCard({ symbol, name, role, tone, event }: { source: string; symbol: string; name: string; role: string; tone: string; event?: ObservabilityEvent }) {
  const active = event?.status === "running" || event?.status === "started";
  const failed = event?.status === "failed";
  return <article className={`agent-tile ${tone} ${failed ? "failed" : ""}`}><div className="agent-tile-top"><span className="agent-symbol">{symbol}</span><span className={`agent-presence ${active ? "active" : ""} ${failed ? "failed" : ""}`} /></div><b>{name}</b><small>{role}</small><div className="agent-status"><i />{eventStatus(event)}</div></article>;
}
