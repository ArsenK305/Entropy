export type Workspace = "general" | "career";
export type Role = "entropy" | "veltrics";
export type TaskStatus = "queued" | "planning" | "running" | "delegated" | "completed" | "failed";

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  speaker: string;
  body: string;
  created_at?: string;
  task_id?: string | null;
}

export interface Task {
  id: string;
  request: string;
  status: TaskStatus;
  created_at: string;
  result?: string | null;
}

export interface TaskEvent {
  actor: string;
  detail: string;
  created_at: string;
}

export interface Turn {
  conversation_id: string;
  status: string;
  created_at: string;
  task_id?: string | null;
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
  order: { id: string; product_id: string; product_name: string; status: string; created_at: string };
  workflow: { status: "accepted" | "not_configured" | "unavailable" | "rejected"; configured: boolean };
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
  summary: { events_today: number; failed_today: number; active_workflows: number; active_agents: number };
  n8n_configured: boolean;
  telegram_configured: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
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
  miniappCatalog: () => request<MiniAppCatalog>("/api/miniapp/catalog", { cache: "no-store" }),
  createMiniAppOrder: (product_id: string, init_data: string) => request<MiniAppOrderResult>("/api/miniapp/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_id, init_data }),
  }),
  observability: () => request<ObservabilitySnapshot>("/api/observability/events", { cache: "no-store" }),
  messages: (id: string) => request<{ messages: ChatMessage[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  task: (id: string) => request<{ task: Task; events: TaskEvent[] }>(`/api/tasks/${encodeURIComponent(id)}`),
  send: (payload: { message: string; conversation_id: string | null; workspace: Workspace; output_token_limits: Record<Role, number> }) =>
    request<{ conversation_id: string }>("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
