import { useEffect, useRef, useState } from "react";
import { api, type MemorySnapshot, type MemoryWorkspace } from "./api";
import "./memory-center.css";

interface MemoryCenterProps {
  initialWorkspace: MemoryWorkspace;
  onBack: () => void;
}

const modifiedLabel = (value: string | null) => {
  if (!value) return "дата не определена";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "дата не определена";
  return new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

export default function MemoryCenter({ initialWorkspace, onBack }: MemoryCenterProps) {
  const [workspace, setWorkspace] = useState<MemoryWorkspace>(initialWorkspace);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [savingSourceId, setSavingSourceId] = useState<string | null>(null);
  const savingPreference = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingSensitiveSource, setPendingSensitiveSource] = useState<MemorySnapshot["sources"][number] | null>(null);
  const sensitiveDialog = useRef<HTMLDialogElement>(null);
  const summaryRagSource = snapshot?.dynamic_sources.find((source) => source.id === (workspace === "career" ? "career-rag" : "telegram-product-rag"));
  const ragStatus = !summaryRagSource
    ? "ЗАГРУЗКА"
    : !summaryRagSource.endpoint_configured
    ? "НЕТ WEBHOOK"
    : !summaryRagSource.authentication_configured
      ? "НУЖЕН ТОКЕН"
      : summaryRagSource.connection_verified
        ? "СВЯЗЬ ПРОВЕРЕНА"
        : "НЕ ПРОВЕРЕНО";
  const ragStatusDetail = !summaryRagSource
    ? "Получаю состояние интеграции"
    : !summaryRagSource.endpoint_configured
      ? "Адрес webhook не задан"
      : !summaryRagSource.authentication_configured
        ? "Токен webhook не задан"
        : summaryRagSource.connection_verified
          ? "Последняя проверка связи прошла"
          : "URL и токен заданы; связь не проверялась";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.memory(workspace)
      .then((result) => { if (!cancelled) setSnapshot(result); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace, reloadTick]);

  useEffect(() => {
    const dialog = sensitiveDialog.current;
    if (!dialog) return;
    if (pendingSensitiveSource && !dialog.open) dialog.showModal();
    if (!pendingSensitiveSource && dialog.open) dialog.close();
  }, [pendingSensitiveSource]);

  async function saveSourcePreference(sourceId: string, enabled: boolean) {
    if (savingPreference.current) return false;
    savingPreference.current = true;
    setSavingSourceId(sourceId);
    setSaveError(null);
    try {
      const result = await api.setMemorySourcePreference(workspace, sourceId, enabled);
      setSnapshot((current) => current ? {
        ...current,
        sources: current.sources.map((source) => source.id === sourceId
          ? { ...source, selected: result.selected, included: result.included }
          : source),
      } : current);
      return true;
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Не удалось сохранить настройку.");
      return false;
    } finally {
      savingPreference.current = false;
      setSavingSourceId(null);
    }
  }

  function selectWorkspace(nextWorkspace: MemoryWorkspace) {
    if (savingPreference.current) return;
    setPendingSensitiveSource(null);
    setSaveError(null);
    setWorkspace(nextWorkspace);
  }

  function toggleSource(source: MemorySnapshot["sources"][number]) {
    const nextEnabled = !source.selected;
    if (nextEnabled && source.sensitive && workspace === "general") {
      setPendingSensitiveSource(source);
      return;
    }
    void saveSourcePreference(source.id, nextEnabled);
  }

  async function confirmSensitiveSource() {
    if (!pendingSensitiveSource) return;
    const saved = await saveSourcePreference(pendingSensitiveSource.id, true);
    if (saved) setPendingSensitiveSource(null);
  }

  return <section className="memory-center" aria-labelledby="memory-title">
    <header className="memory-header">
      <div>
      <div className="memory-eyebrow"><span /> КОНТЕКСТ ENTROPY · ИСТОЧНИКИ НА ВЫБОР</div>
        <h1 id="memory-title">Память и данные</h1>
        <p>Посмотри, какие файлы участвуют в контексте и где они используются.</p>
      </div>
      <button className="memory-back" type="button" onClick={onBack}>← Назад</button>
    </header>

    <div className={`memory-mode ${!snapshot ? "loading" : snapshot.model_requests_enabled ? "live" : "demo"}`} role="status" aria-live="polite">
      <span className="memory-mode-dot" />
      {!snapshot
        ? error ? "Режим работы не удалось проверить." : "Проверяю режим работы и загружаю источники…"
        : snapshot.model_requests_enabled
          ? "Live-режим: общие источники и выбранный контекст отправляются настроенной модели при запросе."
          : "Demo-режим: ответы синтетические; внешняя модель не вызывается."}
    </div>

    <div className="memory-workspace-tabs" role="group" aria-label="Контекст рабочей области">
      <button type="button" aria-pressed={workspace === "general"} disabled={Boolean(savingSourceId)} onClick={() => selectWorkspace("general")}>Диалог Entropy</button>
      <button type="button" aria-pressed={workspace === "career"} disabled={Boolean(savingSourceId)} onClick={() => selectWorkspace("career")}>Поиск работы</button>
    </div>

    {loading && <div className="memory-feedback" role="status">Загружаю список источников…</div>}
    {error && <div className="memory-feedback error" role="alert"><b>Не удалось прочитать контекст.</b><span>{error}</span><button type="button" onClick={() => setReloadTick((tick) => tick + 1)}>Повторить</button></div>}
    {saveError && !pendingSensitiveSource && <div className="memory-feedback error" role="alert"><b>Настройка не сохранена.</b><span>{saveError}</span><button type="button" onClick={() => setSaveError(null)}>Закрыть</button></div>}

    {!loading && !error && snapshot && <>
      <div className="memory-summary-grid">
        <article><span>ФАЙЛОВ В КОНТЕКСТЕ</span><b>{snapshot.sources.filter((source) => source.included).length}</b><small>{workspace === "career" ? "для разбора вакансии" : "для общего диалога"}</small></article>
        <article><span>ИСТОРИЯ ДИАЛОГА</span><b>{snapshot.history_limit}</b><small>предыдущих из текущего диалога; другие не входят</small></article>
        <article><span>{workspace === "career" ? "RAG · КАРЬЕРА" : "RAG · TELEGRAM"}</span><b>{ragStatus}</b><small>{ragStatusDetail}</small></article>
      </div>

      <section className="memory-sources" aria-labelledby="memory-sources-title">
        <div className="memory-section-heading"><div><span>ФАЙЛЫ НА ЭТОМ КОМПЬЮТЕРЕ</span><h2 id="memory-sources-title">Постоянный контекст</h2></div><small>Открой файл, чтобы посмотреть содержимое и выбрать, что добавлять в запросы</small></div>
        <div className="memory-source-list">
          {snapshot.sources.map((source) => <article className={`memory-source ${source.included ? "included" : "excluded"} ${source.available ? "" : "unavailable"}`} key={source.id}>
            <div className="memory-source-head">
              <details className="memory-source-details">
                <summary>
                  <span className="memory-source-mark">{source.included ? "✓" : "—"}</span>
                  <span className="memory-source-main"><b>{source.title}</b><small>{source.path}</small></span>
                  <span className="memory-source-status">{!source.available ? "НЕ НАЙДЕН" : !source.content ? "ПУСТОЙ" : source.included ? "В ЗАПРОСЕ" : "ВЫКЛЮЧЕН"}</span>
                  <span className="memory-chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="memory-source-content">
                  <p>{source.purpose}</p>
                  <div className="memory-source-meta"><span>{source.content.length.toLocaleString("ru")} знаков</span><span>Изменён: {modifiedLabel(source.modified_at)}</span>{source.truncated && <b>Показана часть файла, лимит контекста достигнут</b>}</div>
                  {source.content
                    ? <pre>{source.content}</pre>
                    : <div className="memory-file-empty">{source.available ? "В файле нет текста, который добавляется в контекст." : "Файл отсутствует или не читается. Сейчас он не добавляется в контекст."}</div>}
                </div>
              </details>
              <button
                className="memory-source-toggle"
                type="button"
                aria-pressed={source.selected}
                aria-label={`${source.selected ? "Отключить" : "Включить"} источник «${source.title}» ${workspace === "career" ? "для поиска работы" : "для общего диалога"}`}
                disabled={!source.available || !source.content || Boolean(savingSourceId)}
                title={source.sensitive && workspace === "general" && !source.selected ? "Потребуется подтвердить передачу личного профиля в общий контекст" : undefined}
                onClick={() => toggleSource(source)}
              >
                {savingSourceId === source.id ? "Сохраняю…" : !source.available || !source.content ? "Недоступен" : source.selected ? "Отключить" : "Включить"}
              </button>
            </div>
          </article>)}
        </div>
      </section>

      <section className="memory-dynamic" aria-labelledby="memory-dynamic-title">
        <div className="memory-section-heading"><div><span>ДОБАВЛЯЕТСЯ ПО СЦЕНАРИЮ</span><h2 id="memory-dynamic-title">Не хранится как общая память</h2></div></div>
        <div className="memory-dynamic-grid">
          {snapshot.dynamic_sources.map((source) => <article className={source.enabled ? "enabled" : "disabled"} key={source.id}>
            <span className="memory-dynamic-state">{source.id === "conversation-history" ? "ДОСТУПНО" : !source.endpoint_configured ? "WEBHOOK НЕ ЗАДАН" : !source.authentication_configured ? "НУЖЕН ТОКЕН" : source.enabled ? "НАСТРОЕНО · БЕЗ ПРОВЕРКИ" : "ТОЛЬКО ДЛЯ ПОИСКА РАБОТЫ"}</span>
            <h3>{source.title}</h3>
            <p>{source.description}</p>
          </article>)}
        </div>
      </section>

      <p className="memory-privacy-note">Переключатель меняет, какие локальные файлы войдут в следующие запросы; сам файл здесь только для чтения. Личный карьерный профиль в общем диалоге выключен по умолчанию и требует отдельного подтверждения. В live-режиме выбранный контекст передаётся настроенной модели. Demo не вызывает OpenAI; отдельно настроенные RAG-интеграции могут обращаться к n8n и Qdrant.</p>
    </>}

    <dialog
      ref={sensitiveDialog}
      className="memory-confirm-dialog"
      aria-labelledby="memory-confirm-title"
      aria-describedby="memory-confirm-description"
      onCancel={(event) => { event.preventDefault(); setPendingSensitiveSource(null); }}
    >
      <span className="memory-confirm-kicker">ЛИЧНЫЙ КОНТЕКСТ</span>
      <h2 id="memory-confirm-title">Включить карьерный профиль в общий диалог?</h2>
      <p id="memory-confirm-description">
        Файл <code>{pendingSensitiveSource?.path}</code> будет добавляться к следующим сообщениям в разделе «Диалог Entropy».
        {snapshot?.model_requests_enabled
          ? " В live-режиме его содержимое отправится выбранной модели."
          : " Сейчас работает demo-режим без внешнего вызова модели."}
      </p>
      {saveError && <p className="memory-dialog-error" role="alert">Настройка не сохранена: {saveError}</p>}
      <div className="memory-confirm-actions">
        <button type="button" onClick={() => setPendingSensitiveSource(null)}>Отмена</button>
        <button type="button" className="confirm" disabled={savingSourceId === pendingSensitiveSource?.id} onClick={() => void confirmSensitiveSource()}>
          {savingSourceId === pendingSensitiveSource?.id ? "Сохраняю…" : "Включить в общий диалог"}
        </button>
      </div>
    </dialog>
  </section>;
}
