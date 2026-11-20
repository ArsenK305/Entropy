export type Workspace = "general" | "career";
export type Role = "entropy" | "veltrics" | "psyche";
export type TaskStatus = "queued" | "planning" | "running" | "delegated" | "completed" | "failed" | "interrupted";

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationHistoryCursor {
  updated_at: string;
  id: string;
}

export interface ChatMessage {
  // Persisted rows use an integer ID; local pending/error rows use a string key.
  id: string | number;
  conversation_id: string;
  speaker: string;
  body: string;
  created_at?: string;
  task_id?: string | null;
  turn_id?: string | null;
}

export interface Task {
  id: string;
  conversation_id: string;
  request: string;
  status: TaskStatus;
  created_at: string;
  updated_at?: string;
  result?: string | null;
  review_status?: string | null;
  review_verdict?: string | null;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  actor: string;
  detail: string;
  created_at: string;
}

export interface Turn {
  id: string;
  conversation_id: string;
  request: string;
  status: string;
  created_at: string;
  updated_at: string;
  task_id: string | null;
  error: string | null;
}

export interface AppSnapshot {
  mode: string;
  model?: string | null;
  output_token_caps: Record<Role, number>;
  conversations: Conversation[];
  tasks: Task[];
  turns: Turn[];
  messages: ChatMessage[];
}

export type MemoryWorkspace = "general" | "career";

export interface MemorySource {
  id: string;
  title: string;
  path: string;
  purpose: string;
  content: string;
  available: boolean;
  selected: boolean;
  included: boolean;
  sensitive: boolean;
  truncated: boolean;
  modified_at: string | null;
  included_in: MemoryWorkspace[];
}

export interface DynamicMemorySource {
  id: string;
  title: string;
  enabled: boolean;
  description: string;
  endpoint_configured?: boolean;
  authentication_configured?: boolean;
  connection_verified?: boolean;
}

export interface MemorySnapshot {
  workspace: MemoryWorkspace;
  history_limit: number;
  model_requests_enabled: boolean;
  sources: MemorySource[];
  dynamic_sources: DynamicMemorySource[];
}

export interface MiniAppProduct {
  id: string;
  title: string;
  description: string;
  tag: string;
  cover: string;
}

export interface MiniAppCatalog {
  products: MiniAppProduct[];
  telegram_configured: boolean;
  preview_enabled: boolean;
}

export interface MiniAppOrderResult {
  replayed: boolean;
  order: { id: string; product_id: string; product_name: string; status: string; created_at: string };
  workflow: {
    status: "accepted" | "queued" | "not_configured" | "unavailable" | "rejected" | "duplicate";
    configured: boolean;
    message?: string;
    http_status?: number | null;
  };
  payment: { status: "not_implemented" };
}

export interface ObservabilityEvent {
  id: number;
  correlation_id: string | null;
  source: string;
  event_type: string;
  status: string;
  detail: string;
  created_at: string;
}

export interface ObservabilitySnapshot {
  events: ObservabilityEvent[];
  summary: { events_today: number; orders_today: number; failed_today: number; completed_workflows_today: number; active_workflows: number; active_agents: number };
  n8n_configured: boolean;
  n8n_event_token_configured?: boolean;
  telegram_configured: boolean;
}

export type CareerApplicationStatus = "saved" | "preparing" | "applied" | "interview" | "offer" | "rejected" | "archived";

export interface CareerApplication {
  id: string;
  company: string;
  job_title: string;
  job_description: string;
  source_url: string;
  contact_name: string;
  contact_url: string;
  location: string;
  salary_range: string;
  status: CareerApplicationStatus;
  notes: string;
  conversation_id: string | null;
  follow_up_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface CareerApplicationsCursor {
  created_at: string;
  id: string;
}

export type CareerApplicationFilter = CareerApplicationStatus | "all" | "follow_up" | "follow_up_week";

export interface CareerApplicationsFilters {
  search?: string;
  filter?: CareerApplicationFilter;
  as_of_date?: string;
}

export interface CareerApplicationsPage {
  applications: CareerApplication[];
  has_more: boolean;
  next_cursor: CareerApplicationsCursor | null;
  total_count: number;
}

export interface CareerApplicationSummary {
  total_count: number;
  status_counts: Record<CareerApplicationStatus, number>;
  due_follow_up_count: number;
  upcoming_follow_up_count: number;
  as_of_date: string;
}

export interface CareerApplicationActivity {
  id: number;
  event_type: "created" | "status_changed" | "follow_up_changed" | "conversation_linked" | "conversation_unlinked" | "manual_contact" | "manual_interview" | "manual_research" | "manual_follow_up" | "manual_other";
  from_value: string | null;
  to_value: string | null;
  note: string;
  created_at: string;
}

export type CareerActivityType = "contact" | "interview" | "research" | "follow_up" | "other";

export type CareerApplicationInput = Partial<Omit<CareerApplication, "id" | "created_at" | "updated_at">> & {
  company: string;
  job_title: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Backend не ответил за 10 секунд. Проверь, что Entropy запущен.");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Запрос к backend был отменён.");
    }
    throw new Error("Не удалось связаться с backend. Проверь подключение и работу Entropy.");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const errorMessage = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
    ? data.error
    : `Запрос не выполнен (${response.status}).`;
  if (!response.ok) throw new Error(errorMessage);
  if (data === null) throw new Error("Сервер вернул пустой или некорректный ответ.");
  return data as T;
}

export const api = {
  state: () => request<AppSnapshot>("/api/state", { cache: "no-store" }),
  memory: (workspace: MemoryWorkspace) => request<MemorySnapshot>(`/api/memory?workspace=${workspace}`, { cache: "no-store" }),
  setMemorySourcePreference: (workspace: MemoryWorkspace, source_id: string, enabled: boolean) => request<{
    source_id: string;
    selected: boolean;
    included: boolean;
  }>("/api/memory/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, source_id, enabled }),
  }),
  miniappCatalog: () => request<MiniAppCatalog>("/api/miniapp/catalog", { cache: "no-store" }),
  createMiniAppOrder: (product_id: string, init_data: string, request_id: string) => request<MiniAppOrderResult>("/api/miniapp/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_id, init_data, request_id }),
  }),
  observability: () => request<ObservabilitySnapshot>(
    `/api/observability/events?utc_offset=${-new Date().getTimezoneOffset()}`,
    { cache: "no-store" },
  ),
  careerApplications: (cursor?: CareerApplicationsCursor | null, filters: CareerApplicationsFilters = {}) => {
    const query = new URLSearchParams();
    if (cursor) {
      query.set("before_created_at", cursor.created_at);
      query.set("before_id", cursor.id);
    }
    const search = filters.search?.trim();
    if (search) query.set("search", search);
    if (filters.filter && filters.filter !== "all") query.set("filter", filters.filter);
    if ((filters.filter === "follow_up" || filters.filter === "follow_up_week") && filters.as_of_date) {
      query.set("as_of_date", filters.as_of_date);
    }
    const queryString = query.toString();
    const suffix = queryString ? `?${queryString}` : "";
    return request<CareerApplicationsPage>(`/api/career/applications${suffix}`, { cache: "no-store" });
  },
  careerApplicationSummary: (asOfDate: string) => request<CareerApplicationSummary>(
    `/api/career/applications/summary?${new URLSearchParams({ as_of_date: asOfDate })}`,
    { cache: "no-store" },
  ),
  careerApplicationActivity: (id: string) => request<{ events: CareerApplicationActivity[] }>(`/api/career/applications/${encodeURIComponent(id)}/activity`, { cache: "no-store" }),
  addCareerApplicationActivity: (id: string, payload: { activity_type: CareerActivityType; note: string }) => request<{ event: CareerApplicationActivity }>(
    `/api/career/applications/${encodeURIComponent(id)}/activity`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
  ),
  createCareerApplication: (payload: CareerApplicationInput) => request<{ application: CareerApplication }>("/api/career/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }),
  importCareerApplications: (rows: Array<{ row_number: number; values: CareerApplicationInput }>) => request<{
    applications: CareerApplication[];
    imported_count: number;
  }>("/api/career/applications/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  }),
  updateCareerApplication: (id: string, payload: Partial<CareerApplicationInput>) => request<{ application: CareerApplication }>(`/api/career/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }),
  messages: (id: string) => request<{ conversation: Conversation; messages: ChatMessage[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  conversationHistory: (workspace: Workspace, before?: ConversationHistoryCursor | null) => {
    const query = new URLSearchParams({ workspace });
    if (before) {
      query.set("before_updated_at", before.updated_at);
      query.set("before_id", before.id);
    }
    return request<{
      conversations: Conversation[];
      has_more: boolean;
      next_cursor: ConversationHistoryCursor | null;
    }>(`/api/conversations/history?${query.toString()}`, { cache: "no-store" });
  },
  task: (id: string) => request<{ task: Task; events: TaskEvent[] }>(`/api/tasks/${encodeURIComponent(id)}`),
  send: (payload: { message: string; conversation_id: string | null; workspace: Workspace; output_token_limits: Record<Role, number>; follow_up_task_id?: string }) =>
    request<{ conversation_id: string; turn_id: string }>("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
