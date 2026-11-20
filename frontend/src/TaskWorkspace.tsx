import RichText from "./RichText";
import type {
  Conversation,
  Task,
  TaskEvent,
  TaskStatus,
} from "./api";
import { countTaskFilters, filterTasks, taskNeedsAttention, taskPrimaryActionLabel, type TaskFilter } from "./task-workspace-utils";
import { formatRussianCount } from "./text-formatting";
export type { TaskFilter } from "./task-workspace-utils";

const timeLabel = (value?: string) => value
  ? new Intl.DateTimeFormat("ru", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
  : "только что";

const dateTimeLabel = (value?: string) => value
  ? new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
  : "дата неизвестна";

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "в очереди",
  planning: "планирует",
  running: "выполняется",
  delegated: "у Veltrics",
  completed: "завершено",
  failed: "ошибка",
  interrupted: "прервана",
};
export const statusLabel = (status: TaskStatus) => TASK_STATUS_LABELS[status];
const taskTitle = (request: string) => {
  const firstLine = request
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "Без названия";
  return firstLine.length > 88 ? `${firstLine.slice(0, 87).trimEnd()}…` : firstLine;
};

interface TaskResult {
  plan?: { summary?: string; steps?: string[] };
  developer_result?: string;
  psyche_review?: {
    status?: string;
    mode?: string;
    verdict?: string | null;
    summary?: string;
    findings?: Array<{ severity: string; issue: string; recommendation: string }>;
  };
}

function readTaskResult(task: Task): TaskResult {
  try {
    const result: unknown = task.result ? JSON.parse(task.result) : {};
    return typeof result === "object" && result !== null ? result as TaskResult : {};
  } catch {
    return {};
  }
}

function taskListStatusLabel(task: Task) {
  const review = readTaskResult(task).psyche_review;
  const status = task.review_status ?? review?.status;
  const verdict = task.review_verdict ?? review?.verdict;
  if (task.status === "completed" && verdict === "needs_revision") return "нужна доработка";
  if (task.status === "completed" && verdict === "blocked") return "есть блокер";
  if (task.status === "completed" && status === "unavailable") return "проверка недоступна";
  return statusLabel(task.status);
}

function taskFeedTitle(status: TaskStatus, live: boolean) {
  if (status === "interrupted") return "Задача прервана при перезапуске backend";
  if (!live) return status === "failed" ? "Демо-handoff остановлен" : "Демо-handoff · синтетический ответ";
  if (status === "failed") return "Задача Veltrics остановлена";
  if (status === "completed") return "Ход задачи завершён";
  return "Entropy передал задачу Veltrics";
}

function reviewLabel(review: NonNullable<TaskResult["psyche_review"]>) {
  if (review.mode === "local-demo" || review.verdict === "demo_review") return "Синтетическая демо-проверка";
  if (review.status === "unavailable") return "Проверка недоступна";
  if (review.verdict === "clear") return "Существенных замечаний нет";
  if (review.verdict === "needs_revision") return "Нужна доработка";
  if (review.verdict === "blocked") return "Есть блокирующее замечание";
  return "Проверка завершена";
}

function reviewTone(review: NonNullable<TaskResult["psyche_review"]>) {
  if (review.verdict === "clear") return "positive";
  if (review.verdict === "needs_revision" || review.verdict === "blocked") return "attention";
  return "neutral";
}

function findingSeverityLabel(severity: string) {
  if (severity === "critical") return "Критично";
  if (severity === "warning") return "Замечание";
  return "Информация";
}

function runStages(detail: { task: Task; events: TaskEvent[] }) {
  const planDone = detail.events.some((event) => (
    event.actor === "Entropy" && event.detail.includes("План сформирован")
  ));
  const executionDone = detail.events.some((event) => (
    event.actor === "Veltrics" && /ответ модели готов|результат готов/i.test(event.detail)
  ));
  const reviewDone = detail.events.some((event) => (
    event.actor === "Psyche" && /проверка завершена|проверка недоступна/i.test(event.detail)
  ));
  const completed = detail.task.status === "completed";
  const done = [planDone, executionDone, reviewDone, completed];
  const activeIndex = completed ? 4 : done.findIndex((isDone) => !isDone);
  const labels = ["План", "Выполнение", "Проверка", "Итог"];
  return labels.map((label, index) => ({
    label,
    state: done[index]
      ? "complete"
      : ["failed", "interrupted"].includes(detail.task.status) && index === activeIndex
        ? "failed"
        : index === activeIndex ? "active" : "pending",
  }));
}

export function TaskRun({
  detail,
  live,
  focusMode = false,
}: {
  detail: { task: Task; events: TaskEvent[] };
  live: boolean;
  focusMode?: boolean;
}) {
  const result = readTaskResult(detail.task);
  const stages = runStages(detail);
  const review = result.psyche_review;
  const reviewSummary = review?.summary?.trim() || "";
  const reviewPreview = focusMode
    ? (reviewSummary.split(/(?<=[.!?])\s+/)[0] || reviewSummary)
    : reviewSummary;
  const findings = review?.findings || [];
  const showInlineFindings = findings.length > 0 && !focusMode;
  const showFullReview = focusMode && (
    reviewPreview.length < reviewSummary.length || findings.length > 0
  );
  const developerResult = result.developer_result?.trim() || "";
  const previewLimit = focusMode ? 420 : 1_000;
  const resultPreview = developerResult.length > previewLimit
    ? `${developerResult.slice(0, previewLimit).trimEnd()}…`
    : developerResult;
  const planFallback = detail.task.status === "interrupted"
    ? "Backend перезапустился до сохранения плана."
    : detail.task.status === "failed"
      ? "План не удалось сохранить."
      : "План появится после завершения этапа планирования.";
  const resultFallback = detail.task.status === "interrupted"
    ? "Задача не запускалась повторно. Проверь сохранённый ответ и события выше."
    : detail.task.status === "failed"
      ? "Задача завершилась с ошибкой до получения результата."
      : "Результат появится здесь после выполнения подзадачи.";
  return (
    <section className="task-feed run-card" aria-label="Полный ход задачи">
      <header className="run-card-header">
        <div>
          <div className="task-feed-title">
            {taskFeedTitle(detail.task.status, live)}
            <span className={`task-status ${detail.task.status}`}>
              {statusLabel(detail.task.status)}
            </span>
          </div>
          <div className="task-feed-request">{detail.task.request}</div>
        </div>
      </header>
      <ol className="run-progress" aria-label="Этапы выполнения">
        {stages.map((stage, index) => (
          <li
            className={`run-progress-step ${stage.state}`}
            key={stage.label}
            aria-current={stage.state === "active" ? "step" : undefined}
          >
            <span className="run-progress-marker">
              {stage.state === "complete" ? "✓" : stage.state === "failed" ? "!" : index + 1}
            </span>
            <span>{stage.label}</span>
          </li>
        ))}
      </ol>
      {review && (
        <section
          className={`run-review-callout ${reviewTone(review)}`}
          aria-label="Итог проверки Psyche"
        >
          <div className="run-review-callout-heading">
            <span>Psyche · проверка</span>
            <b>{reviewLabel(review)}</b>
          </div>
          {reviewPreview && <p>{reviewPreview}</p>}
          {showInlineFindings && (
            <ul>
              {findings.map((finding, index) => (
                <li
                  key={`${finding.severity}-${index}`}
                  className={`finding-${finding.severity}`}
                >
                  <div>
                    <b>{findingSeverityLabel(finding.severity)}</b>
                    <span>{finding.issue}</span>
                  </div>
                  <small>{finding.recommendation}</small>
                </li>
              ))}
            </ul>
          )}
          {showFullReview && (
            <details className="run-full-result run-full-review">
              <summary>Показать полный review Psyche</summary>
              {reviewPreview.length < reviewSummary.length && <p>{reviewSummary}</p>}
              {findings.length > 0 && (
                <ul>
                  {findings.map((finding, index) => (
                    <li
                      key={`${finding.severity}-${index}`}
                      className={`finding-${finding.severity}`}
                    >
                      <div>
                        <b>{findingSeverityLabel(finding.severity)}</b>
                        <span>{finding.issue}</span>
                      </div>
                      <small>{finding.recommendation}</small>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </section>
      )}
      <details
        className="run-card-section run-plan-disclosure"
        key={`plan-${String(focusMode)}`}
        open={!focusMode}
      >
        <summary>
          <h3>План Entropy</h3>
          {result.plan?.summary && <span>{result.plan.summary}</span>}
        </summary>
        {result.plan?.steps?.length ? (
          <ol>
            {result.plan.steps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
        ) : !result.plan?.summary ? (
          <p className="run-pending">{planFallback}</p>
        ) : (
          <RichText text={result.plan.summary} />
        )}
      </details>
      <section className="run-card-section run-result">
        <h3>Предложение Veltrics</h3>
        <p className="run-result-disclosure">
          Текстовое предложение · файлы проекта не читались и не менялись.
        </p>
        {resultPreview ? (
          <RichText text={resultPreview} />
        ) : (
          <p className="run-pending">{resultFallback}</p>
        )}
        {developerResult.length > previewLimit && (
          <details className="run-full-result">
            <summary>Показать полный ответ Veltrics</summary>
            <RichText text={developerResult} />
          </details>
        )}
      </section>
      <details
        className="run-card-section run-events-disclosure"
        key={`events-${String(focusMode)}`}
        open={!focusMode}
      >
        <summary>
          <h3>Ход выполнения</h3>
          <span>{formatRussianCount(detail.events.length, "событие", "события", "событий")}</span>
        </summary>
        {detail.events.length ? (
          <ol className="run-event-list">
            {detail.events.map((event, index) => (
              <li key={`${event.created_at}-${index}`}>
                <span className="run-event-actor">{event.actor}</span>
                <span>{event.detail}</span>
                <time>{timeLabel(event.created_at)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="run-pending">События появятся по мере выполнения задачи.</p>
        )}
      </details>
    </section>
  );
}

interface TaskCenterProps {
  tasks: Task[];
  conversations: Conversation[];
  formatConversationTitle: (conversation: Conversation) => string;
  selectedTask: Task | null;
  selectedEvents: TaskEvent[];
  selectedId: string | null;
  filter: TaskFilter;
  loadError: string | null;
  live: boolean;
  focusMode: boolean;
  onToggleFocus: () => void;
  onFilter: (filter: TaskFilter) => void;
  onSelect: (taskId: string | null) => void;
  onRefresh: () => void;
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
  onContinue: (task: Task) => void;
}

export default function TaskCenter({
  tasks,
  conversations,
  formatConversationTitle,
  selectedTask,
  selectedEvents,
  selectedId,
  filter,
  loadError,
  live,
  focusMode,
  onToggleFocus,
  onFilter,
  onSelect,
  onRefresh,
  onBack,
  onOpenConversation,
  onContinue,
}: TaskCenterProps) {
  const visibleTasks = filterTasks(tasks, filter);
  const changeFilter = (nextFilter: TaskFilter) => {
    const nextTasks = filterTasks(tasks, nextFilter);
    onFilter(nextFilter);
    if (!nextTasks.some((task) => task.id === selectedId)) {
      onSelect(nextTasks[0]?.id || null);
    }
  };
  const counts = countTaskFilters(tasks);
  const conversation = selectedTask ? conversations.find((item) => item.id === selectedTask.conversation_id) : null;
  const planSummary = selectedTask ? readTaskResult(selectedTask).plan?.summary?.trim() : "";
  const selectedTaskTitle = selectedTask
    ? taskTitle(planSummary || selectedTask.request)
    : "";
  const primaryActionLabel = selectedTask ? taskPrimaryActionLabel(selectedTask.status) : null;
  const canContinue = Boolean(selectedTask && primaryActionLabel);
  const filters: Array<{ id: TaskFilter; label: string }> = [
    { id: "all", label: "Все" },
    { id: "active", label: "Активные" },
    { id: "completed", label: "Завершённые" },
    { id: "attention", label: "Требуют внимания" },
  ];
  const taskCountSummary = focusMode
    ? "Показана выбранная задача; список и навигация скрыты."
    : tasks.length
      ? [
        `Всего ${formatRussianCount(tasks.length, "задача", "задачи", "задач")}`,
        formatRussianCount(counts.active, "активная задача", "активные задачи", "активных задач"),
        formatRussianCount(counts.completed, "завершённая задача", "завершённые задачи", "завершённых задач"),
        formatRussianCount(counts.attention, "задача требует внимания", "задачи требуют внимания", "задач требуют внимания"),
      ].join(" · ")
      : "Здесь будет общий список технических задач и их результатов.";

  return (
    <section className="tasks-page" aria-label="Задачи Veltrics">
      <header className="tasks-page-header">
        <div>
          <span className="panel-kicker">РАБОЧЕЕ ПРОСТРАНСТВО / ЗАДАЧИ</span>
          <h1 tabIndex={-1}>Задачи Veltrics</h1>
          <p>{taskCountSummary}</p>
        </div>
        <div className="tasks-page-actions">
          <button
            className="tasks-focus-button"
            type="button"
            aria-pressed={focusMode}
            disabled={!selectedTask}
            onClick={onToggleFocus}
          >
            {focusMode ? "Показать список" : "Фокус на задаче"}
          </button>
          <button type="button" className="tasks-refresh-button" onClick={onRefresh}>
            Обновить список
          </button>
          <button type="button" className="tasks-back-button" onClick={onBack}>
            Вернуться
          </button>
        </div>
      </header>
      <div className="tasks-layout">
        <aside className="tasks-list-pane">
          <div className="tasks-filter-list" role="group" aria-label="Фильтр задач">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                aria-label={`${item.label}: ${counts[item.id]}`}
                className={filter === item.id ? "selected" : ""}
                onClick={() => changeFilter(item.id)}
              >
                <span>{item.label}</span>
                <b>{counts[item.id]}</b>
              </button>
            ))}
          </div>
          <div className="tasks-list" aria-label="Список задач">
            {visibleTasks.length ? visibleTasks.map((task) => {
              const sourceConversation = conversations.find(
                (item) => item.id === task.conversation_id,
              );
              const reviewNeedsAttention = task.status === "completed"
                && taskNeedsAttention(task);
              return (
                <button
                  key={task.id}
                  type="button"
                  className={`tasks-list-item ${task.id === selectedId ? "selected" : ""}`}
                  onClick={() => onSelect(task.id)}
                  aria-current={task.id === selectedId ? "true" : undefined}
                >
                  <span className="tasks-list-item-top">
                    <b>{taskTitle(task.request)}</b>
                    <span className={`task-card-status ${reviewNeedsAttention ? "review-attention" : task.status}`}>
                      {taskListStatusLabel(task)}
                    </span>
                  </span>
                  <span className="tasks-list-item-conversation">
                    {sourceConversation
                      ? formatConversationTitle(sourceConversation)
                      : "Исходный диалог не в недавней истории"}
                  </span>
                  <time>{dateTimeLabel(task.updated_at || task.created_at)}</time>
                </button>
              );
            }) : (
              <div className="tasks-empty-list">
                {tasks.length ? (
                  <>
                    <span>В этом фильтре пока нет задач.</span>
                    <button type="button" onClick={() => changeFilter("all")}>
                      Показать все задачи
                    </button>
                  </>
                ) : (
                  "Задач пока нет. Техническое поручение появится здесь после передачи Veltrics."
                )}
              </div>
            )}
          </div>
        </aside>
        <section className="tasks-detail-pane" aria-label="Выбранная задача">
          {loadError ? (
            <div className="tasks-detail-empty" role="alert">
              <b>Не удалось загрузить задачу</b>
              <span>{loadError}</span>
              <button type="button" onClick={onRefresh}>Повторить</button>
            </div>
          ) : selectedTask ? (
            <>
              <header className="tasks-selected-header">
                <div>
                  <span className={`detail-status ${selectedTask.status}`}>
                    {selectedTask.status === "completed"
                      ? "Ход завершён"
                      : statusLabel(selectedTask.status)}
                  </span>
                  <time>
                    Обновлена {dateTimeLabel(selectedTask.updated_at || selectedTask.created_at)}
                  </time>
                  <h2>{selectedTaskTitle}</h2>
                  <p>{selectedTask.request}</p>
                </div>
                <div className="tasks-selected-actions">
                  {conversation && (
                    <button
                      type="button"
                      onClick={() => onOpenConversation(selectedTask.conversation_id)}
                    >
                      Открыть диалог
                    </button>
                  )}
                  {canContinue && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => onContinue(selectedTask)}
                    >
                      {primaryActionLabel}
                    </button>
                  )}
                </div>
              </header>
              <TaskRun
                detail={{ task: selectedTask, events: selectedEvents }}
                live={live}
                focusMode={focusMode}
              />
            </>
          ) : selectedId ? (
            <div className="tasks-detail-empty">
              <b>Загружаю задачу…</b>
              <span>Загружаю сохранённый план, события и результат.</span>
            </div>
          ) : tasks.length ? (
            <div className="tasks-detail-empty">
              <b>Выбери задачу</b>
              <span>План, ход выполнения и результат появятся здесь.</span>
            </div>
          ) : (
            <div className="tasks-detail-empty">
              <b>Пока нет задач Veltrics</b>
              <span>
                Когда Entropy передаст техническое поручение, здесь появятся его план, состояние и итог.
              </span>
              <button type="button" onClick={onBack}>Вернуться в диалог</button>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

