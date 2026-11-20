import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, type CareerActivityType, type CareerApplication, type CareerApplicationActivity, type CareerApplicationFilter, type CareerApplicationInput, type CareerApplicationStatus, type CareerApplicationsCursor, type CareerApplicationSummary, type Conversation } from "./api";
import { careerEmptyResultsMessage, effectiveCareerSort, filterAndSortCareerApplications, hasUpcomingFollowUp, isCurrentCareerApplicationsRead, needsFollowUp, toggleCareerFilter, type CareerFilter, type CareerSortOrder } from "./career-application-utils";
import { findCareerCsvDuplicates, getCareerImportPayloadSizeError, MAX_CAREER_CSV_BYTES, parseCareerApplicationsCsv, serializeCareerCsvCell, type CareerCsvPreview } from "./career-application-csv";
import { russianCountForm } from "./text-formatting";
import "./career-applications.css";

const statusMeta: Record<CareerApplicationStatus, { label: string; short: string }> = {
  saved: { label: "Сохранена", short: "Сохранена" },
  preparing: { label: "Готовлю отклик", short: "Готовлю" },
  applied: { label: "Отклик отправлен", short: "Отправлено" },
  interview: { label: "Собеседование", short: "Интервью" },
  offer: { label: "Оффер", short: "Оффер" },
  rejected: { label: "Отказ", short: "Отказ" },
  archived: { label: "В архиве", short: "Архив" },
};
const stageGuidance: Record<CareerApplicationStatus, { title: string; description: string }> = {
  saved: {
    title: "Проверь вакансию",
    description: "Пока роль только сохранена. Сверь требования со своим опытом и реши, стоит ли готовить отклик.",
  },
  preparing: {
    title: "Подготовь материалы",
    description: "Проверь резюме и черновик письма. Этап «Готовлю отклик» не означает, что работодатель уже получил заявку.",
  },
  applied: {
    title: "Не потеряй следующий контакт",
    description: "Отмечай «Отклик отправлен» только после отправки на стороне работодателя. Запланируй дату follow-up, если она нужна.",
  },
  interview: {
    title: "Зафиксируй договорённости",
    description: "Сохрани заметки после разговора и дату, когда нужно вернуться к рекрутеру или команде.",
  },
  offer: {
    title: "Сверь условия предложения",
    description: "Оцени обязанности, команду и условия целиком. Зарплата — важная часть решения, но не единственная.",
  },
  rejected: {
    title: "Сохрани полезную обратную связь",
    description: "Если работодатель поделился причиной отказа, добавь её в заметки и используй в следующих откликах.",
  },
  archived: {
    title: "Вакансия в архиве",
    description: "Она скрыта из активного поиска, но запись и история остаются в трекере.",
  },
};
const statuses = Object.keys(statusMeta) as CareerApplicationStatus[];
const activeStatuses = statuses.filter((status) => status !== "archived");
type FormValues = Omit<CareerApplicationInput, "company" | "job_title"> & { company: string; job_title: string; conversation_id: string };

const emptyForm = (conversationId: string | null = null): FormValues => ({
  company: "", job_title: "", job_description: "", source_url: "", contact_name: "", contact_url: "", location: "", salary_range: "", notes: "", status: "saved", conversation_id: conversationId || "", follow_up_date: null,
});

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(date);
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayPlainDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(date);
}

function displayActivityTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function activityLabel(event: CareerApplicationActivity) {
  if (event.event_type === "created") return "Вакансия добавлена в трекер";
  if (event.event_type === "conversation_linked") {
    return event.from_value ? "Связанный карьерный разбор изменён" : "Карьерный разбор связан с вакансией";
  }
  if (event.event_type === "conversation_unlinked") return "Связь с карьерным разбором удалена";
  if (event.event_type === "status_changed") {
    const from = event.from_value ? statusMeta[event.from_value as CareerApplicationStatus]?.short || event.from_value : "—";
    const to = event.to_value ? statusMeta[event.to_value as CareerApplicationStatus]?.short || event.to_value : "—";
    return `Этап изменён: ${from} → ${to}`;
  }
  if (event.event_type.startsWith("manual_")) {
    const labels: Record<CareerActivityType, string> = {
      contact: "Контакт с работодателем",
      interview: "Собеседование",
      research: "Изучение компании",
      follow_up: "Повторное сообщение",
      other: "Заметка",
    };
    return labels[event.event_type.slice("manual_".length) as CareerActivityType] || "Запись по вакансии";
  }
  if (event.event_type !== "follow_up_changed") return "Изменение в карточке вакансии";
  const from = event.from_value ? displayPlainDate(event.from_value) : "не задан";
  const to = event.to_value ? displayPlainDate(event.to_value) : "не задан";
  return `Следующий контакт: ${from} → ${to}`;
}

function followUpState(value: string | null, today: string) {
  if (!value) return null;
  if (value < today) return `Просрочено · ${displayPlainDate(value)}`;
  if (value === today) return "Связаться сегодня";
  return `Связаться · ${displayPlainDate(value)}`;
}

function followUpDraft(application: CareerApplication) {
  const role = `вакансии «${application.job_title}» в компании ${application.company}`;
  const greeting = application.contact_name.trim()
    ? `Здравствуйте, ${application.contact_name.trim()}!`
    : "Здравствуйте!";
  if (application.status === "interview") {
    return `${greeting}\n\nСпасибо за возможность обсудить ${role}. Мне интересны команда и задачи. Подскажите, пожалуйста, когда ориентировочно можно ожидать обратную связь по дальнейшим шагам?\n\nС уважением`;
  }
  return `${greeting}\n\nПишу, чтобы уточнить статус моего отклика на ${role}. Мой интерес к позиции сохраняется. Буду рад ответить на дополнительные вопросы.\n\nС уважением`;
}

function isClosed(application: CareerApplication) {
  return ["offer", "rejected", "archived"].includes(application.status);
}

function sortCareerApplications(applications: CareerApplication[]) {
  return [...applications].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
    || right.created_at.localeCompare(left.created_at)
    || right.id.localeCompare(left.id));
}

function exportCareerApplications(applications: CareerApplication[]) {
  const headers = ["Компания", "Должность", "Описание вакансии", "Этап", "Ссылка", "Контакт", "Профиль контакта", "Город / формат", "Зарплата", "Следующий контакт", "Заметки", "Добавлена", "Обновлена"];
  const rows = applications.map((application) => [
    application.company,
    application.job_title,
    application.job_description,
    statusMeta[application.status].label,
    application.source_url,
    application.contact_name,
    application.contact_url,
    application.location,
    application.salary_range,
    application.follow_up_date || "",
    application.notes,
    application.created_at,
    application.updated_at,
  ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(serializeCareerCsvCell).join(",")).join("\r\n")}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `entropy-job-tracker-${localDateString()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function CareerApplications({
  conversations,
  onOpenConversation,
  onAnalyzeApplication,
  applicationDraftRequest,
  onApplicationDraftConsumed,
}: {
  conversations: Conversation[];
  onOpenConversation: (conversationId: string) => void;
  onAnalyzeApplication: (application: CareerApplication) => void;
  applicationDraftRequest: { requestId: string; conversationId: string } | null;
  onApplicationDraftConsumed: (requestId: string) => void;
}) {
  const [applications, setApplications] = useState<CareerApplication[]>([]);
  const [summary, setSummary] = useState<CareerApplicationSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMoreApplications, setHasMoreApplications] = useState(false);
  const [nextApplicationsCursor, setNextApplicationsCursor] = useState<CareerApplicationsCursor | null>(null);
  const [loadingMoreApplications, setLoadingMoreApplications] = useState(false);
  const [loadingAllApplications, setLoadingAllApplications] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [exportingApplications, setExportingApplications] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CareerFilter>("all");
  const [sortOrder, setSortOrder] = useState<CareerSortOrder>("updated");
  const [applicationMatchCount, setApplicationMatchCount] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CareerApplication | null>(null);
  const [values, setValues] = useState<FormValues>(() => emptyForm());
  const [selected, setSelected] = useState<CareerApplication | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [activity, setActivity] = useState<CareerApplicationActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityReloadKey, setActivityReloadKey] = useState(0);
  const [activityFormOpen, setActivityFormOpen] = useState(false);
  const [activityType, setActivityType] = useState<CareerActivityType>("contact");
  const [activityNote, setActivityNote] = useState("");
  const [activitySaving, setActivitySaving] = useState(false);
  const [activitySaveError, setActivitySaveError] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageCopyStatus, setMessageCopyStatus] = useState("");
  const [importPreview, setImportPreview] = useState<CareerCsvPreview | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSaving, setImportSaving] = useState(false);
  const [importChecking, setImportChecking] = useState(false);
  const [importComparisonError, setImportComparisonError] = useState<string | null>(null);
  const [importComparisonApplications, setImportComparisonApplications] = useState<CareerApplication[] | null>(null);
  const [importSuccess, setImportSuccess] = useState("");
  const [importDuplicatesAcknowledged, setImportDuplicatesAcknowledged] = useState(false);
  const formDialog = useRef<HTMLDialogElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importTrigger = useRef<HTMLButtonElement>(null);
  const messageDraftInput = useRef<HTMLTextAreaElement>(null);
  const formTrigger = useRef<HTMLElement | null>(null);
  const formFocusTarget = useRef<string | null>(null);
  const addApplicationButton = useRef<HTMLButtonElement>(null);
  const consumedDraftRequest = useRef<string | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const applicationsPageRequest = useRef<number | null>(null);
  const applicationsPageRequestSequence = useRef(0);
  const applicationsReadRequest = useRef(0);
  const applicationsDataRevision = useRef(0);
  const summaryRequest = useRef(0);

  const currentApplicationFilters = (): { search: string; filter: CareerApplicationFilter; as_of_date?: string } => ({
    search: search.trim(),
    filter,
    ...(filter === "follow_up" || filter === "follow_up_week" ? { as_of_date: localDateString() } : {}),
  });
  const invalidateFilterRead = () => {
    applicationsReadRequest.current += 1;
    setLoading(true);
    setLoadError(null);
  };
  const updateFilter = (next: CareerFilter | ((current: CareerFilter) => CareerFilter)) => {
    invalidateFilterRead();
    setFilter(next);
  };
  const updateSearch = (next: string) => {
    invalidateFilterRead();
    setSearch(next);
  };

  const importDuplicates = useMemo(
    () => importPreview
      ? findCareerCsvDuplicates(importPreview.rows, importComparisonApplications || [])
      : { alreadyInTracker: [], repeatedInFile: [] },
    [importPreview, importComparisonApplications],
  );
  const duplicateRowNumbers = useMemo(
    () => new Set([...importDuplicates.alreadyInTracker, ...importDuplicates.repeatedInFile]),
    [importDuplicates],
  );
  const hasImportDuplicates = duplicateRowNumbers.size > 0;

  const refreshSummary = async () => {
    const requestId = ++summaryRequest.current;
    try {
      const result = await api.careerApplicationSummary(localDateString());
      if (requestId !== summaryRequest.current) return;
      setSummary(result);
      setSummaryError(null);
    } catch (error) {
      if (requestId !== summaryRequest.current) return;
      setSummaryError(error instanceof Error ? error.message : "Не удалось обновить сводку.");
    }
  };

  const refresh = async () => {
    const requestId = ++applicationsReadRequest.current;
    const dataRevision = applicationsDataRevision.current;
    setLoading(true);
    try {
      const result = await api.careerApplications(null, currentApplicationFilters());
      if (!isCurrentCareerApplicationsRead(requestId, applicationsReadRequest.current, dataRevision, applicationsDataRevision.current)) return;
      setApplications(result.applications);
      setApplicationMatchCount(result.total_count);
      setHasMoreApplications(result.has_more);
      setNextApplicationsCursor(result.next_cursor);
      setLoadMoreError(null);
      setLoadError(null);
      void refreshSummary();
    } catch (error) {
      if (isCurrentCareerApplicationsRead(requestId, applicationsReadRequest.current, dataRevision, applicationsDataRevision.current)) {
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить отклики.");
      }
    } finally {
      if (requestId === applicationsReadRequest.current) setLoading(false);
    }
  };

  const invalidateApplicationReads = () => {
    applicationsDataRevision.current += 1;
    applicationsReadRequest.current += 1;
    setLoading(false);
    setLoadError(null);
  };

  const loadMoreApplications = async () => {
    if (!hasMoreApplications || !nextApplicationsCursor || applicationsPageRequest.current) return;
    const pageRequestId = ++applicationsPageRequestSequence.current;
    applicationsPageRequest.current = pageRequestId;
    const requestId = ++applicationsReadRequest.current;
    const dataRevision = applicationsDataRevision.current;
    setLoadingMoreApplications(true);
    setLoadMoreError(null);
    try {
      const result = await api.careerApplications(nextApplicationsCursor, currentApplicationFilters());
      if (!isCurrentCareerApplicationsRead(requestId, applicationsReadRequest.current, dataRevision, applicationsDataRevision.current)) return;
      setApplications((current) => {
        const byId = new Map(current.map((application) => [application.id, application]));
        result.applications.forEach((application) => byId.set(application.id, application));
        return sortCareerApplications([...byId.values()]);
      });
      setHasMoreApplications(result.has_more);
      setNextApplicationsCursor(result.next_cursor);
      setApplicationMatchCount(result.total_count);
    } catch (error) {
      if (isCurrentCareerApplicationsRead(requestId, applicationsReadRequest.current, dataRevision, applicationsDataRevision.current)) {
        setLoadMoreError(error instanceof Error ? error.message : "Не удалось загрузить следующие вакансии.");
      }
    } finally {
      if (applicationsPageRequest.current === pageRequestId) {
        applicationsPageRequest.current = null;
        if (isCurrentCareerApplicationsRead(requestId, applicationsReadRequest.current, dataRevision, applicationsDataRevision.current)) {
          setLoading(false);
        }
        setLoadingMoreApplications(false);
      }
    }
  };

  const fetchAllApplications = async (
    expectedDataRevision = applicationsDataRevision.current,
    filters = currentApplicationFilters(),
  ) => {
    const firstPage = await api.careerApplications(null, filters);
    if (expectedDataRevision !== applicationsDataRevision.current) {
      throw new Error("Список откликов изменился во время загрузки. Повтори действие.");
    }
    const byId = new Map(firstPage.applications.map((application) => [application.id, application]));
    let cursor = firstPage.next_cursor;
    let hasMore = firstPage.has_more;
    while (hasMore) {
      if (!cursor) throw new Error("Сервер не вернул курсор для следующей страницы.");
      const page = await api.careerApplications(cursor, filters);
      if (expectedDataRevision !== applicationsDataRevision.current) {
        throw new Error("Список откликов изменился во время загрузки. Повтори действие.");
      }
      page.applications.forEach((application) => byId.set(application.id, application));
      cursor = page.next_cursor;
      hasMore = page.has_more;
    }
    return sortCareerApplications([...byId.values()]);
  };

  const loadAllApplications = async () => {
    if (!hasMoreApplications || applicationsPageRequest.current) return;
    const pageRequestId = ++applicationsPageRequestSequence.current;
    applicationsPageRequest.current = pageRequestId;
    const filterRequestId = applicationsReadRequest.current;
    const dataRevision = applicationsDataRevision.current;
    setLoadingAllApplications(true);
    setLoadMoreError(null);
    try {
      const allApplications = await fetchAllApplications(dataRevision, currentApplicationFilters());
      if (!isCurrentCareerApplicationsRead(
        filterRequestId,
        applicationsReadRequest.current,
        dataRevision,
        applicationsDataRevision.current,
      )) return;
      setApplications(allApplications);
      setApplicationMatchCount(allApplications.length);
      setHasMoreApplications(false);
      setNextApplicationsCursor(null);
    } catch (error) {
      if (dataRevision === applicationsDataRevision.current) {
        setLoadMoreError(error instanceof Error ? error.message : "Не удалось загрузить все вакансии.");
      }
    } finally {
      if (applicationsPageRequest.current === pageRequestId) {
        applicationsPageRequest.current = null;
        setLoadingAllApplications(false);
      }
    }
  };

  const exportAllApplications = async () => {
    if (!(summary?.total_count ?? applications.length) || applicationsPageRequest.current) return;
    const pageRequestId = ++applicationsPageRequestSequence.current;
    applicationsPageRequest.current = pageRequestId;
    const dataRevision = applicationsDataRevision.current;
    setExportingApplications(true);
    setExportError(null);
    try {
      const allApplications = await fetchAllApplications(dataRevision, { search: "", filter: "all" });
      if (dataRevision !== applicationsDataRevision.current) return;
      exportCareerApplications(allApplications);
    } catch (error) {
      if (dataRevision === applicationsDataRevision.current) {
        setExportError(error instanceof Error ? error.message : "Не удалось собрать полный экспорт.");
      }
    } finally {
      if (applicationsPageRequest.current === pageRequestId) {
        applicationsPageRequest.current = null;
        setExportingApplications(false);
      }
    }
  };

  const checkImportDuplicates = async (preview: CareerCsvPreview) => {
    if (!preview.rows.length || preview.errors.length) return;
    const expectedDataRevision = applicationsDataRevision.current;
    setImportChecking(true);
    setImportComparisonError(null);
    setImportComparisonApplications(null);
    try {
      const allApplications = await fetchAllApplications(expectedDataRevision, { search: "", filter: "all" });
      if (expectedDataRevision !== applicationsDataRevision.current) {
        throw new Error("Трекер изменился во время проверки. Выбери CSV ещё раз.");
      }
      setImportComparisonApplications(allApplications);
    } catch (error) {
      setImportComparisonError(error instanceof Error ? error.message : "Не удалось проверить весь трекер.");
    } finally {
      setImportChecking(false);
    }
  };

  const chooseImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImportFileName(file.name);
    setImportError(null);
    setImportSuccess("");
    setImportDuplicatesAcknowledged(false);
    setImportComparisonApplications(null);
    setImportComparisonError(null);
    setImportPreview(null);
    if (file.size > MAX_CAREER_CSV_BYTES) {
      setImportPreview({ rows: [], errors: [] });
      setImportError("CSV больше 1 МБ. Раздели его на файлы поменьше.");
      return;
    }
    try {
      const preview = parseCareerApplicationsCsv(await file.text());
      setImportPreview(preview);
      if (!preview.errors.length && preview.rows.length) {
        const payloadSizeError = getCareerImportPayloadSizeError(preview.rows);
        if (payloadSizeError) setImportError(payloadSizeError);
        else await checkImportDuplicates(preview);
      }
    } catch (error) {
      setImportPreview({ rows: [], errors: [] });
      setImportError(error instanceof Error ? error.message : "Не удалось прочитать CSV.");
    }
  };

  const closeImport = () => {
    if (importSaving) return;
    setImportPreview(null);
    setImportError(null);
    setImportDuplicatesAcknowledged(false);
    setImportComparisonError(null);
    setImportComparisonApplications(null);
    window.requestAnimationFrame(() => importTrigger.current?.focus());
  };

  const importApplications = async () => {
    if (!importPreview?.rows.length || importPreview.errors.length || importSaving || importChecking || !importComparisonApplications || importComparisonError || (hasImportDuplicates && !importDuplicatesAcknowledged)) return;
    const payloadSizeError = getCareerImportPayloadSizeError(importPreview.rows);
    if (payloadSizeError) {
      setImportError(payloadSizeError);
      return;
    }
    setImportSaving(true);
    setImportError(null);
    try {
      const result = await api.importCareerApplications(importPreview.rows);
      invalidateApplicationReads();
      void refresh();
      void refreshSummary();
      setImportSuccess(`Добавлено вакансий: ${result.imported_count}. Записи сохранены локально; отклики не отправлялись.`);
      setImportPreview(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Не удалось импортировать CSV.");
    } finally {
      setImportSaving(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), search ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [search, filter]);
  useEffect(() => {
    const dialog = formDialog.current;
    if (!dialog) return;
    if (formOpen && !dialog.open) {
      dialog.showModal();
      const focusTarget = formFocusTarget.current;
      const target = focusTarget ? dialog.querySelector<HTMLElement>(`#${focusTarget}`) : null;
      (target || dialog.querySelector<HTMLElement>("input"))?.focus();
      formFocusTarget.current = null;
    } else if (!formOpen && dialog.open) dialog.close();
  }, [formOpen]);
  useEffect(() => {
    const dialog = detailDialog.current;
    if (!dialog) return;
    if (selected && !formOpen && !dialog.open) dialog.showModal();
    else if (!selected && dialog.open) dialog.close();
  }, [selected, formOpen]);
  useEffect(() => {
    const dialog = importDialog.current;
    if (!dialog) return;
    if (importPreview && !dialog.open) dialog.showModal();
    else if (!importPreview && dialog.open) dialog.close();
  }, [importPreview]);
  useEffect(() => {
    let current = true;
    if (!selected) {
      setActivity([]);
      setActivityError(null);
      setActivityLoading(false);
      setActivityFormOpen(false);
      setActivityNote("");
      setActivitySaveError(null);
      return () => { current = false; };
    }
    setActivityLoading(true);
    setActivityError(null);
    void api.careerApplicationActivity(selected.id)
      .then((result) => { if (current) setActivity(result.events); })
      .catch((error) => {
        if (current) setActivityError(error instanceof Error ? error.message : "Не удалось загрузить историю.");
      })
      .finally(() => { if (current) setActivityLoading(false); });
    return () => { current = false; };
  }, [selected?.id, selected?.updated_at, activityReloadKey]);
  useEffect(() => {
    setMessageDraft("");
    setMessageCopyStatus("");
  }, [selected?.id, selected?.status]);

  const counts = useMemo(() => statuses.reduce((result, status) => {
    result[status] = applications.filter((application) => application.status === status).length;
    return result;
  }, {} as Record<CareerApplicationStatus, number>), [applications]);
  const visibleCounts = summary?.status_counts || counts;
  const today = localDateString();
  const followUpCount = summary?.due_follow_up_count ?? applications.filter((application) => needsFollowUp(application, today)).length;
  const upcomingFollowUpCount = summary?.upcoming_follow_up_count ?? applications.filter((application) => hasUpcomingFollowUp(application, today)).length;
  const totalCount = summary?.total_count ?? applications.length;
  const emptyResultsMessage = careerEmptyResultsMessage(filter, search);
  const filtered = useMemo(
    () => filterAndSortCareerApplications(applications, filter, "", sortOrder, today),
    [applications, filter, sortOrder, today],
  );
  const forcedFollowUpSort = filter === "follow_up" || filter === "follow_up_week";
  const sortHint = filter === "follow_up"
    ? "По дате связи: просроченные и ближайшие сначала."
    : filter === "follow_up_week" ? "По дате связи: ближайшие сначала." : null;
  const selectedConversationId = selected?.conversation_id || null;
  const selectedConversation = selected?.conversation_id
    ? conversations.find((conversation) => conversation.id === selected.conversation_id)
    : null;

  const openForm = (trigger: HTMLElement, application?: CareerApplication, linkedConversationId?: string, focusTarget?: string) => {
    formTrigger.current = trigger;
    formFocusTarget.current = focusTarget || null;
    setEditing(application || null);
    setValues(application ? {
      company: application.company,
      job_title: application.job_title,
      job_description: application.job_description,
      source_url: application.source_url,
      contact_name: application.contact_name,
      contact_url: application.contact_url,
      location: application.location,
      salary_range: application.salary_range,
      notes: application.notes,
      status: application.status,
      conversation_id: application.conversation_id || "",
      follow_up_date: application.follow_up_date,
    } : emptyForm(linkedConversationId || null));
    setSaveError(null);
    setFormOpen(true);
  };

  useEffect(() => {
    const request = applicationDraftRequest;
    if (!request || consumedDraftRequest.current === request.requestId) return;
    const trigger = addApplicationButton.current;
    if (!trigger) return;
    consumedDraftRequest.current = request.requestId;
    openForm(trigger, undefined, request.conversationId);
    onApplicationDraftConsumed(request.requestId);
  }, [applicationDraftRequest, onApplicationDraftConsumed]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const payload: CareerApplicationInput = {
      ...values,
      job_description: values.job_description?.trim() || "",
      source_url: values.source_url?.trim() || "",
      contact_name: values.contact_name?.trim() || "",
      contact_url: values.contact_url?.trim() || "",
      location: values.location?.trim() || "",
      salary_range: values.salary_range?.trim() || "",
      notes: values.notes?.trim() || "",
      conversation_id: values.conversation_id || null,
      follow_up_date: values.follow_up_date || null,
    };
    try {
      const result = editing
        ? await api.updateCareerApplication(editing.id, payload)
        : await api.createCareerApplication(payload);
      invalidateApplicationReads();
      void refresh();
      void refreshSummary();
      if (editing) setSelected(result.application);
      if (editing) setActivityReloadKey((value) => value + 1);
      setFormOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не удалось сохранить вакансию.");
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (status: CareerApplicationStatus) => {
    if (!selected || statusSaving || selected.status === status) return;
    setStatusSaving(true);
    setSaveError(null);
    try {
      const result = await api.updateCareerApplication(selected.id, { status });
      invalidateApplicationReads();
      void refresh();
      void refreshSummary();
      setSelected(result.application);
      setActivityReloadKey((value) => value + 1);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не удалось обновить этап.");
    } finally {
      setStatusSaving(false);
    }
  };

  const saveActivity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || activitySaving) return;
    setActivitySaving(true);
    setActivitySaveError(null);
    try {
      await api.addCareerApplicationActivity(selected.id, {
        activity_type: activityType,
        note: activityNote.trim(),
      });
      setActivityNote("");
      setActivityFormOpen(false);
      setActivityReloadKey((value) => value + 1);
    } catch (error) {
      setActivitySaveError(error instanceof Error ? error.message : "Не удалось сохранить запись.");
    } finally {
      setActivitySaving(false);
    }
  };

  const prepareFollowUpMessage = () => {
    if (!selected || !["applied", "interview"].includes(selected.status)) return;
    setMessageDraft(followUpDraft(selected));
    setMessageCopyStatus("");
    window.requestAnimationFrame(() => messageDraftInput.current?.focus());
  };

  const copyFollowUpMessage = async () => {
    const text = messageDraft.trim();
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(text);
      setMessageCopyStatus("Черновик скопирован. Проверь его перед отправкой.");
    } catch {
      messageDraftInput.current?.focus();
      messageDraftInput.current?.select();
      setMessageCopyStatus("Не удалось скопировать. Текст выделен — нажми Ctrl+C.");
    }
  };

  const closeForm = () => {
    setFormOpen(false);
    window.requestAnimationFrame(() => formTrigger.current?.focus());
  };
  const closeDetails = () => {
    if (activitySaving) return;
    setSelected(null);
    setSaveError(null);
    setActivityFormOpen(false);
    window.requestAnimationFrame(() => detailTrigger.current?.focus());
  };

  const loadMoreControl = hasMoreApplications ? (
    <div className="career-pagination" role="group" aria-label="Загрузка остальных вакансий">
      <p>{summary
        ? `Загружено ${applications.length} из ${applicationMatchCount} найденных · всего в трекере ${totalCount}.`
        : `Загружено ${applications.length} из ${applicationMatchCount} найденных карточек.`}</p>
      {loadMoreError && <span role="alert">{loadMoreError}</span>}
      <div>
        <button className="career-secondary-button" type="button" disabled={loadingMoreApplications || loadingAllApplications || exportingApplications} onClick={() => void loadMoreApplications()}>
        {loadingMoreApplications ? "Загружаю вакансии…" : "Загрузить ещё 100"}
        </button>
        <button className="career-secondary-button" type="button" disabled={loadingMoreApplications || loadingAllApplications || exportingApplications} onClick={() => void loadAllApplications()}>
          {loadingAllApplications ? "Загружаю все вакансии…" : "Загрузить всё"}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <section className="career-tracker" aria-labelledby="career-tracker-title">
      <header className="career-tracker-header">
        <div>
          <span className="career-tracker-eyebrow">ПОИСК РАБОТЫ · МОЙ ПРОЦЕСС</span>
          <h1 id="career-tracker-title">Отклики</h1>
          <p>Сохраняй вакансии и отмечай, что происходит дальше.</p>
        </div>
        <div className="career-header-actions">
          <input
            ref={importInput}
            className="career-import-input"
            type="file"
            accept=".csv"
            aria-label="Выбрать CSV-файл вакансий"
            onChange={(event) => void chooseImportFile(event)}
          />
          <button
            ref={importTrigger}
            className="career-secondary-button"
            type="button"
            disabled={loading || Boolean(loadError)}
            aria-busy={loading}
            title={loading ? "Дождись загрузки трекера, чтобы проверить возможные повторы." : loadError ? "Сначала восстанови загрузку списка откликов." : undefined}
            onClick={() => importInput.current?.click()}
          >
            {loading ? "Загружаю трекер…" : "Импорт CSV"}
          </button>
          <button
            className="career-secondary-button"
            type="button"
            disabled={!(summary?.total_count ?? applications.length) || exportingApplications || loadingAllApplications || loadingMoreApplications}
            aria-label="Экспортировать весь трекер в CSV"
            title="Выгружает все вакансии, независимо от текущего поиска и фильтра."
            aria-busy={exportingApplications}
            onClick={() => void exportAllApplications()}
          >
            {exportingApplications ? "Собираю CSV…" : "Экспорт CSV"}
          </button>
          <button ref={addApplicationButton} className="career-primary-button" type="button" onClick={(event) => openForm(event.currentTarget)}>
            ＋ Добавить вакансию
          </button>
        </div>
      </header>
      {importSuccess && <p className="career-import-success" role="status">{importSuccess}</p>}
      {exportError && <p className="career-import-error" role="alert">Не удалось выгрузить все вакансии: {exportError}</p>}
      {summaryError && <p className="career-summary-error" role="status">{summary ? "Не удалось обновить сводку; показано последнее успешно загруженное значение." : `Общая сводка недоступна; числа рассчитаны по ${applications.length} загруженным карточкам.`}</p>}

      <dialog
        className="career-dialog career-import-dialog"
        ref={importDialog}
        aria-labelledby="career-import-title"
        onCancel={(event) => { event.preventDefault(); closeImport(); }}
        onClose={() => {
          setImportPreview(null);
          setImportDuplicatesAcknowledged(false);
          setImportComparisonError(null);
          setImportComparisonApplications(null);
          window.requestAnimationFrame(() => importTrigger.current?.focus());
        }}
        onClick={(event) => { if (event.target === importDialog.current) closeImport(); }}
      >
        <section>
          <header className="career-dialog-header">
            <div>
              <span className="career-tracker-eyebrow">ПЕРЕНОС ДАННЫХ · {importFileName}</span>
              <h2 id="career-import-title">Импорт вакансий из CSV</h2>
              <p>Проверь распознанные строки перед сохранением.</p>
            </div>
            <button className="career-dialog-close" type="button" onClick={closeImport} aria-label="Закрыть предпросмотр импорта">×</button>
          </header>
          <div className="career-import-content">
            {importError && <p className="career-import-error" role="alert">{importError}</p>}
            {importChecking && <p className="career-import-state" role="status">Сверяю возможные повторы со всем трекером…</p>}
            {importComparisonError && (
              <div className="career-import-duplicate-warning" role="alert">
                <span>Не удалось проверить повторы по всем вакансиям: {importComparisonError}</span>
                <button className="career-secondary-button" type="button" disabled={importChecking} onClick={() => importPreview && void checkImportDuplicates(importPreview)}>
                  Проверить ещё раз
                </button>
              </div>
            )}
            {importPreview?.errors.length ? (
              <div className="career-import-errors" role="alert">
                <b>Импорт не изменит базу: исправь строки в CSV.</b>
                <ul>{importPreview.errors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul>
                {importPreview.errors.length > 8 && <small>И ещё ошибок: {importPreview.errors.length - 8}.</small>}
              </div>
            ) : importPreview?.rows.length ? (
              <>
                <div className="career-import-count"><b>{importPreview.rows.length}</b><span>{russianCountForm(importPreview.rows.length, "вакансия распознана", "вакансии распознаны", "вакансий распознано")}</span></div>
                {hasImportDuplicates && importComparisonApplications && (
                  <div className="career-import-duplicate-warning" role="status">
                    <b>Возможные повторы: {importDuplicates.alreadyInTracker.length} уже в трекере · {importDuplicates.repeatedInFile.length} повторяются в файле.</b>
                    <span>Сверяем компанию и должность со всеми вакансиями в базе и строками этого файла. Совпадения не удаляются автоматически.</span>
                    <label>
                      <input
                        type="checkbox"
                        checked={importDuplicatesAcknowledged}
                        onChange={(event) => setImportDuplicatesAcknowledged(event.currentTarget.checked)}
                      />
                      <span>Я проверил совпадения и хочу добавить строки отдельными карточками.</span>
                    </label>
                  </div>
                )}
                <ol className="career-import-preview">
                  {importPreview.rows.slice(0, 6).map((row) => (
                    <li key={row.row_number}>
                      <span>строка {row.row_number}</span>
                      <b>{row.values.job_title}</b>
                      <small>{row.values.company} · {statusMeta[row.values.status || "saved"].label}</small>
                      {duplicateRowNumbers.has(row.row_number) && <em>возможный повтор</em>}
                    </li>
                  ))}
                </ol>
                {importPreview.rows.length > 6 && <small className="career-import-more">И ещё {importPreview.rows.length - 6} строк.</small>}
              </>
            ) : !importError ? <p className="career-import-error" role="alert">В файле не найдены строки вакансий.</p> : null}
            <p className="career-import-note">Сохранение произойдёт одной операцией: при ошибке не добавится ни одна строка. Импорт не объединяет дубликаты и ничего не отправляет работодателям.</p>
          </div>
          <footer className="career-dialog-footer">
            <span>Принимается CSV Entropy и таблица с колонками Company / Job Title или Компания / Должность.</span>
            <div className="career-import-actions">
              <button className="career-secondary-button" type="button" disabled={importSaving} onClick={closeImport}>Отмена</button>
              <button className="career-primary-button" type="button" disabled={importSaving || importChecking || !importComparisonApplications || Boolean(importComparisonError) || !importPreview?.rows.length || Boolean(importPreview?.errors.length) || Boolean(importError) || (hasImportDuplicates && !importDuplicatesAcknowledged)} onClick={() => void importApplications()}>
                {importSaving ? "Сохраняю…" : `Добавить ${importPreview?.rows.length || 0}`}
              </button>
            </div>
          </footer>
        </section>
      </dialog>

      <div className="career-metrics" role="group" aria-label="Сводка откликов">
        <button
          className={`career-metric ${filter === "all" ? "selected" : ""}`}
          type="button"
          aria-pressed={filter === "all"}
          onClick={() => updateFilter("all")}
        >
          <span>{summary ? "Всего" : "Загружено"}</span><b>{totalCount}</b><small>{summary ? "в трекере" : "на этой странице"}</small>
        </button>
        <button
          className={`career-metric ${filter === "applied" ? "selected" : ""}`}
          type="button"
          aria-pressed={filter === "applied"}
          onClick={() => updateFilter((current) => toggleCareerFilter(current, "applied"))}
        >
          <span>Отклик отправлен</span><b>{visibleCounts.applied}</b><small>этап по трекеру</small>
        </button>
        <button
          className={`career-metric ${filter === "interview" ? "selected" : ""}`}
          type="button"
          aria-pressed={filter === "interview"}
          onClick={() => updateFilter((current) => toggleCareerFilter(current, "interview"))}
        >
          <span>Собеседования</span><b>{visibleCounts.interview}</b><small>этап по трекеру</small>
        </button>
        <button
          className={`career-metric ${filter === "offer" ? "selected" : ""}`}
          type="button"
          aria-pressed={filter === "offer"}
          onClick={() => updateFilter((current) => toggleCareerFilter(current, "offer"))}
        >
          <span>Офферы</span><b>{visibleCounts.offer}</b><small>этап по трекеру</small>
        </button>
        <button
          className={`career-metric career-metric-follow-up ${filter === "follow_up" ? "selected" : ""}`}
          type="button"
          aria-pressed={filter === "follow_up"}
          onClick={() => updateFilter((current) => toggleCareerFilter(current, "follow_up"))}
        >
          <span>Связаться</span><b>{followUpCount}</b><small>сегодня или просрочено</small>
        </button>
        <button
          className={`career-metric career-metric-upcoming ${filter === "follow_up_week" ? "selected" : ""}`}
          type="button"
          aria-pressed={filter === "follow_up_week"}
          onClick={() => updateFilter((current) => toggleCareerFilter(current, "follow_up_week"))}
        >
          <span>На неделе</span><b>{upcomingFollowUpCount}</b><small>следующие 7 дней</small>
        </button>
      </div>

      {summary && (hasMoreApplications || search.trim() || filter !== "all") && (
        <p className="career-summary-scope">Счётчики и поиск охватывают весь трекер. Сортировка применяется к загруженным результатам; CSV включает все записи, даже при активном фильтре.</p>
      )}

      <div className="career-pipeline" role="group" aria-label="Этапы поиска работы">
        {activeStatuses.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={filter === status}
            className={`career-stage ${filter === status ? "active" : ""}`}
            onClick={() => updateFilter((current) => toggleCareerFilter(current, status))}
          >
            <span className={`career-stage-dot stage-${status}`} />
            <span className="career-stage-label">{statusMeta[status].label}</span>
            <b>{visibleCounts[status]}</b>
          </button>
        ))}
      </div>

      <div className="career-list-toolbar">
        <div className="career-list-heading">
          <h2>Мои вакансии</h2>
          <span>{filtered.length} показано{filtered.length !== applicationMatchCount ? ` из ${applicationMatchCount} найденных` : ""}</span>
        </div>
        <div className="career-toolbar-controls">
          <label className="career-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              placeholder="Компания, должность, текст вакансии, контакт или заметки"
              aria-label="Поиск вакансии"
            />
            {search && (
              <button type="button" onClick={() => updateSearch("")} aria-label="Очистить поиск">
                ×
              </button>
            )}
          </label>
          <label className="career-sort">
            <span>Сортировка</span>
            <select
              aria-label="Сортировка вакансий"
              value={effectiveCareerSort(filter, sortOrder)}
              disabled={forcedFollowUpSort}
              aria-describedby={sortHint ? "career-sort-hint" : undefined}
              title={sortHint || undefined}
              onChange={(event) => setSortOrder(event.target.value as CareerSortOrder)}
            >
              <option value="updated">Недавно обновлены</option>
              <option value="follow_up">По дате связи</option>
              <option value="company">Компания А–Я</option>
            </select>
            {sortHint && <small className="career-sort-hint" id="career-sort-hint">{sortHint}</small>}
          </label>
        </div>
        <div className="career-filter-row" role="group" aria-label="Фильтр вакансий">
          <button
            className={filter === "all" ? "active" : ""}
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => updateFilter("all")}
          >
            Все
          </button>
          <button
            className={filter === "follow_up" ? "active" : ""}
            type="button"
            aria-pressed={filter === "follow_up"}
            onClick={() => updateFilter(filter === "follow_up" ? "all" : "follow_up")}
          >
            Связаться · {followUpCount}
          </button>
          <button
            className={filter === "follow_up_week" ? "active" : ""}
            type="button"
            aria-pressed={filter === "follow_up_week"}
            onClick={() => updateFilter(filter === "follow_up_week" ? "all" : "follow_up_week")}
          >
            На неделе · {upcomingFollowUpCount}
          </button>
          {statuses.map((status) => (
            <button
              key={status}
              className={filter === status ? "active" : ""}
              type="button"
              aria-pressed={filter === status}
              aria-label={`Показать вакансии на этапе «${statusMeta[status].label}»`}
              onClick={() => updateFilter(filter === status ? "all" : status)}
            >
              {statusMeta[status].short}
            </button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="career-state career-error" role="alert">
          <b>Не удалось загрузить трекер</b>
          <span>{loadError}</span>
          <button type="button" onClick={() => { setLoading(true); void refresh(); }}>
            Повторить
          </button>
        </div>
      ) : loading ? (
        <div className="career-state" role="status" aria-live="polite">
          <span className="career-loader" />Загружаю вакансии…
        </div>
      ) : !applications.length && applicationMatchCount === 0 && (search.trim() || filter !== "all") ? (
        <div className="career-state" role="status">
          {emptyResultsMessage}
          <button type="button" onClick={() => { updateFilter("all"); updateSearch(""); }}>
            Сбросить фильтры
          </button>
        </div>
      ) : !applications.length ? (
        <div className="career-empty">
          <span className="career-empty-icon">⌕</span>
          <h2>Трекер пока пуст</h2>
          <p>Добавь вакансию, чтобы сохранить ссылку, заметки и этап поиска в одном месте.</p>
          <button className="career-primary-button" type="button" onClick={(event) => openForm(event.currentTarget)}>
            ＋ Добавить первую вакансию
          </button>
          <small>Вакансия сохранится локально в базе Entropy. Отклик отправляешь ты.</small>
        </div>
      ) : !filtered.length ? (
        <>
          <div className="career-state" role="status">
            {emptyResultsMessage}
            <button type="button" onClick={() => { updateFilter("all"); updateSearch(""); }}>
              Сбросить фильтры
            </button>
          </div>
          {loadMoreControl}
        </>
      ) : (
        <>
          <div className="career-application-list">
            {filtered.map((application) => (
              <button
                key={application.id}
                className="career-application-card"
                type="button"
                aria-label={`${application.job_title} в ${application.company}. Этап: ${statusMeta[application.status].label}.${application.follow_up_date && !isClosed(application) ? ` Следующий контакт: ${followUpState(application.follow_up_date, today)}.` : ""} Открыть карточку`}
                onClick={(event) => {
                  detailTrigger.current = event.currentTarget;
                  setSelected(application);
                }}
              >
                <span className={`career-card-symbol stage-${application.status}`}>
                  {application.company.trim().slice(0, 1).toLocaleUpperCase("ru") || "В"}
                </span>
                <span className="career-card-main">
                  <span className="career-card-title">{application.job_title}</span>
                  <span className="career-card-company">
                    {application.company}{application.location ? ` · ${application.location}` : ""}
                  </span>
                  <span className="career-card-note">
                    {application.notes || "Нажми, чтобы посмотреть детали и обновить этап."}
                  </span>
                </span>
                <span className="career-card-meta">
                  <span className={`career-status-pill stage-${application.status}`}>
                    {statusMeta[application.status].label}
                  </span>
                  {application.follow_up_date && !isClosed(application) && (
                    <span className={`career-follow-up ${needsFollowUp(application, today) ? "due" : ""}`}>
                      {followUpState(application.follow_up_date, today)}
                    </span>
                  )}
                  <time dateTime={application.updated_at}>{displayDate(application.updated_at)}</time>
                </span>
                <span className="career-card-chevron" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          {loadMoreControl}
        </>
      )}

      <dialog
        className="career-dialog career-form-dialog"
        ref={formDialog}
        aria-labelledby="career-form-title"
        onCancel={(event) => { event.preventDefault(); closeForm(); }}
        onClose={() => {
          setFormOpen(false);
          window.requestAnimationFrame(() => formTrigger.current?.focus());
        }}
        onClick={(event) => { if (event.target === formDialog.current) closeForm(); }}
      >
        <form onSubmit={(event) => void save(event)}>
          <header className="career-dialog-header">
            <div>
              <span className="career-tracker-eyebrow">МОЙ ТРЕКЕР</span>
              <h2 id="career-form-title">{editing ? "Изменить вакансию" : "Новая вакансия"}</h2>
            </div>
            <button className="career-dialog-close" type="button" onClick={closeForm} aria-label="Закрыть окно">
              ×
            </button>
          </header>
          {!editing && values.conversation_id && (
            <p className="career-linked-draft-note" role="status">
              Текущий разбор уже выбран. Заполни компанию и должность; запись появится после нажатия «Сохранить вакансию».
            </p>
          )}
          <div className="career-form-fields">
            <label>
              Компания
              <input required maxLength={160} autoComplete="organization" value={values.company}
                onChange={(event) => setValues({ ...values, company: event.target.value })} placeholder="Например, Example" />
            </label>
            <label>
              Должность
              <input required maxLength={160} value={values.job_title}
                onChange={(event) => setValues({ ...values, job_title: event.target.value })} placeholder="Backend-разработчик" />
            </label>
            <label className="career-field-wide">
              Ссылка на вакансию
              <input type="url" maxLength={2048} value={values.source_url || ""}
                onChange={(event) => setValues({ ...values, source_url: event.target.value })} placeholder="https://…" />
            </label>
            <label className="career-field-wide">
              Описание вакансии
              <textarea id="career-job-description" rows={8} maxLength={12000} value={values.job_description || ""}
                onChange={(event) => setValues({ ...values, job_description: event.target.value })}
                placeholder="Вставь текст вакансии, чтобы сохранить требования рядом с откликом. Ссылка сама не считывается." />
              <small>Сохраняется локально. До явной отправки разбора Entropy текст никуда не передаёт.</small>
            </label>
            <label>
              Контакт / рекрутер
              <input maxLength={120} autoComplete="name" value={values.contact_name || ""}
                onChange={(event) => setValues({ ...values, contact_name: event.target.value })} placeholder="Например, Алия Иванова" />
            </label>
            <label>
              Профиль контакта
              <input type="url" maxLength={2048} value={values.contact_url || ""}
                onChange={(event) => setValues({ ...values, contact_url: event.target.value })} placeholder="https://…" />
            </label>
            <label>
              Город / формат
              <input maxLength={160} value={values.location || ""}
                onChange={(event) => setValues({ ...values, location: event.target.value })} placeholder="Алматы · удалённо" />
            </label>
            <label>
              Зарплата
              <input maxLength={120} value={values.salary_range || ""}
                onChange={(event) => setValues({ ...values, salary_range: event.target.value })} placeholder="По договорённости" />
            </label>
            <label>
              Следующий контакт
              <input id="career-follow-up-date" type="date" value={values.follow_up_date || ""}
                onChange={(event) => setValues({ ...values, follow_up_date: event.target.value || null })} />
            </label>
            <label>
              Этап
              <select value={values.status || "saved"}
                onChange={(event) => setValues({ ...values, status: event.target.value as CareerApplicationStatus })}>
                {statuses.map((status) => <option key={status} value={status}>{statusMeta[status].label}</option>)}
              </select>
            </label>
            <label>
              Связать с разбором
              <select value={values.conversation_id || ""}
                onChange={(event) => setValues({ ...values, conversation_id: event.target.value })}>
                <option value="">Не связывать</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title || displayDate(conversation.updated_at)}
                  </option>
                ))}
              </select>
            </label>
            <label className="career-field-wide">
              Заметки
              <textarea rows={4} maxLength={4000} value={values.notes || ""}
                onChange={(event) => setValues({ ...values, notes: event.target.value })}
                placeholder="Что важно уточнить, что обсудить и о чём спросить…" />
            </label>
          </div>
          {saveError && <p className="career-form-error" role="alert">{saveError}</p>}
          <footer className="career-dialog-footer">
            <span>Entropy хранит эти заметки локально. Он не отправляет отклик.</span>
            <button className="career-primary-button" type="submit" disabled={saving}>
              {saving ? "Сохраняю…" : editing ? "Сохранить изменения" : "Сохранить вакансию"}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        className="career-dialog career-detail-dialog"
        ref={detailDialog}
        aria-labelledby="career-detail-title"
        onCancel={(event) => { event.preventDefault(); if (!activitySaving) closeDetails(); }}
        onClose={() => {
          setSelected(null);
          window.requestAnimationFrame(() => detailTrigger.current?.focus());
        }}
        onClick={(event) => { if (event.target === detailDialog.current) closeDetails(); }}
      >
        {selected && (
          <div className="career-detail-content">
            <header className="career-dialog-header">
              <div>
                <span className="career-tracker-eyebrow">КАРТОЧКА ВАКАНСИИ</span>
                <h2 id="career-detail-title">{selected.job_title}</h2>
                <p>{selected.company}{selected.location ? ` · ${selected.location}` : ""}</p>
              </div>
              <button className="career-dialog-close" type="button" onClick={closeDetails} disabled={activitySaving} aria-label="Закрыть карточку">
                ×
              </button>
            </header>
            <div className="career-detail-fields">
              <label>
                Этап
                <select disabled={statusSaving} value={selected.status}
                  onChange={(event) => void changeStatus(event.target.value as CareerApplicationStatus)}>
                  {statuses.map((status) => <option key={status} value={status}>{statusMeta[status].label}</option>)}
                </select>
              </label>
              {selected.salary_range && <div><span>Зарплата</span><b>{selected.salary_range}</b></div>}
              {selected.follow_up_date && !isClosed(selected) && (
                <div className={needsFollowUp(selected, today) ? "career-follow-up-detail due" : "career-follow-up-detail"}>
                  <span>Следующий контакт</span>
                  <b>{followUpState(selected.follow_up_date, today)}</b>
                </div>
              )}
              {(selected.contact_name || selected.contact_url) && (
                <div className="career-contact-detail">
                  <span>Контакт / рекрутер</span>
                  {selected.contact_name && <b>{selected.contact_name}</b>}
                  {selected.contact_url && (
                    <a href={selected.contact_url} target="_blank" rel="noopener noreferrer">Открыть профиль ↗</a>
                  )}
                </div>
              )}
              <div><span>Добавлена</span><b>{displayDate(selected.created_at)}</b></div>
              <div><span>Обновлена</span><b>{displayDate(selected.updated_at)}</b></div>
            </div>
            {selected.job_description ? (
              <details className="career-job-description">
                <summary>
                  <b>Описание вакансии</b>
                  <span>{selected.job_description.length.toLocaleString("ru")} знаков</span>
                </summary>
                <p>{selected.job_description}</p>
              </details>
            ) : (
              <div className="career-job-description-empty">
                <span>Текст вакансии не сохранён</span>
                <button type="button" onClick={(event) => openForm(event.currentTarget, selected, undefined, "career-job-description")}>
                  Добавить описание →
                </button>
              </div>
            )}
            <section className="career-stage-guidance" aria-labelledby="career-stage-guidance-title">
              <div>
                <span>ПОДСКАЗКА ПО ЭТАПУ</span>
                <h3 id="career-stage-guidance-title">{stageGuidance[selected.status].title}</h3>
                <p>{stageGuidance[selected.status].description}</p>
              </div>
              {["applied", "interview"].includes(selected.status) && (
                <button type="button" onClick={(event) => openForm(event.currentTarget, selected, undefined, "career-follow-up-date")}>
                  {selected.follow_up_date ? "Изменить дату контакта" : "Задать дату контакта"} →
                </button>
              )}
            </section>
            {["applied", "interview"].includes(selected.status) && (
              <div className="career-message-draft-action">
                <button type="button" onClick={prepareFollowUpMessage}>Подготовить сообщение работодателю →</button>
              </div>
            )}
            {messageDraft && (
              <section className="career-message-draft" aria-labelledby="career-message-draft-title">
                <header>
                  <div>
                    <span>ЧЕРНОВИК · НЕ ОТПРАВЛЯЕТСЯ</span>
                    <h3 id="career-message-draft-title">Сообщение работодателю</h3>
                  </div>
                  <button type="button" onClick={() => { setMessageDraft(""); setMessageCopyStatus(""); }} aria-label="Закрыть черновик">×</button>
                </header>
                <textarea
                  ref={messageDraftInput}
                  aria-label="Редактируемый черновик сообщения работодателю"
                  rows={6}
                  maxLength={2000}
                  value={messageDraft}
                  onChange={(event) => { setMessageDraft(event.target.value); setMessageCopyStatus(""); }}
                />
                <footer>
                  <p role="status" aria-live="polite">{messageCopyStatus || "Проверь формулировки и отправь сообщение сам."}</p>
                  <button type="button" onClick={() => void copyFollowUpMessage()} disabled={!messageDraft.trim()}>Скопировать текст</button>
                </footer>
              </section>
            )}
            <section className="career-activity" aria-labelledby="career-activity-title">
              <header>
                <h3 id="career-activity-title">История</h3>
                <div>
                  <button type="button" onClick={() => { setActivityFormOpen((open) => !open); setActivitySaveError(null); }}>
                    {activityFormOpen ? "Отмена" : "Записать действие"}
                  </button>
                  <button type="button" onClick={() => setActivityReloadKey((value) => value + 1)} disabled={activityLoading}>
                    {activityLoading ? "Обновляю…" : "Обновить"}
                  </button>
                </div>
              </header>
              {activityFormOpen && (
                <form className="career-activity-form" onSubmit={(event) => void saveActivity(event)}>
                  <label>
                    Действие
                    <select value={activityType} onChange={(event) => setActivityType(event.target.value as CareerActivityType)}>
                      <option value="contact">Связался с работодателем</option>
                      <option value="interview">Прошёл собеседование</option>
                      <option value="research">Изучил компанию</option>
                      <option value="follow_up">Отправил follow-up</option>
                      <option value="other">Другое</option>
                    </select>
                  </label>
                  <label>
                    Короткая заметка
                    <textarea rows={3} maxLength={1000} required value={activityNote}
                      onChange={(event) => setActivityNote(event.target.value)}
                      placeholder="Например: поговорили с рекрутером, ждут ответ до пятницы." />
                  </label>
                  {activitySaveError && <p className="career-form-error" role="alert">{activitySaveError}</p>}
                  <footer>
                    <small>Запись добавится в историю вакансии и не редактируется отдельно. Entropy не отправляет сообщения.</small>
                    <button type="submit" disabled={activitySaving || !activityNote.trim()}>
                      {activitySaving ? "Сохраняю…" : "Сохранить запись"}
                    </button>
                  </footer>
                </form>
              )}
              {activityError ? (
                <p className="career-activity-state" role="alert">{activityError}</p>
              ) : activityLoading && !activity.length ? (
                <p className="career-activity-state" role="status">Загружаю историю…</p>
              ) : activity.length ? (
                <ol>
                  {[...activity].reverse().map((event) => (
                    <li key={event.id}>
                      <span className="career-activity-marker" aria-hidden="true" />
                      <span className="career-activity-copy">
                        <b>{activityLabel(event)}</b>
                        {event.note && <span>{event.note}</span>}
                        <time dateTime={event.created_at}>{displayActivityTimestamp(event.created_at)}</time>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="career-activity-state">Для этой вакансии пока нет записей.</p>
              )}
            </section>
            {selected.source_url && (
              <a className="career-source-link" href={selected.source_url} target="_blank" rel="noopener noreferrer">
                Открыть оригинал вакансии ↗
              </a>
            )}
            <div className="career-analysis-action">
              {selectedConversationId ? (
                <>
                  <button type="button" onClick={() => onOpenConversation(selectedConversationId)}>
                    Продолжить связанный разбор →
                  </button>
                  <small>Откроется сохранённый диалог по этой вакансии.</small>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => onAnalyzeApplication(selected)}>
                    Подготовить разбор в поиске работы →
                  </button>
                  <small>После отправки диалог свяжется с карточкой. Перед отправкой ты сможешь всё проверить.</small>
                </>
              )}
            </div>
            {selected.notes ? (
              <section className="career-notes"><h3>Заметки</h3><p>{selected.notes}</p></section>
            ) : (
              <section className="career-notes career-notes-empty">
                <h3>Заметки</h3><p>Добавь вопросы работодателю или следующий шаг.</p>
              </section>
            )}
            {selectedConversationId ? (
              <button
                className="career-linked-conversation"
                type="button"
                onClick={() => onOpenConversation(selectedConversationId)}
                aria-label={`Открыть карьерный разбор: ${selectedConversation?.title || "Сохранённый разбор"}`}
              >
                Связано с разбором: {selectedConversation?.title || "Сохранённый разбор"} <span aria-hidden="true">↗</span>
              </button>
            ) : null}
            {saveError && <p className="career-form-error" role="alert">{saveError}</p>}
            <footer className="career-dialog-footer">
              <span>Этап обновится сразу и останется в базе Entropy.</span>
              <button className="career-secondary-button" type="button" onClick={(event) => openForm(event.currentTarget, selected)}>
                Редактировать вакансию
              </button>
            </footer>
          </div>
        )}
      </dialog>
    </section>
  );
}
