export type WorkspaceArea = "general" | "career";
export type WorkspaceRoute = "chat" | "career" | "applications" | "tasks" | "memory";

export interface WorkspaceHistoryState {
  entropyWorkspaceHistory: true;
  route: WorkspaceRoute;
  workspace: WorkspaceArea;
  conversationId: string | null;
  selectedTaskId: string | null;
  rootLanding: boolean;
}

export interface WorkspaceHistoryFallback {
  workspace: WorkspaceArea;
  generalConversationId: string | null;
  careerConversationId: string | null;
}

export interface WorkspaceRequestContext {
  workspace: WorkspaceArea;
  route: WorkspaceRoute;
  conversationId: string | null;
  epoch: number;
}

const routes = new Set<WorkspaceRoute>(["chat", "career", "applications", "tasks", "memory"]);

export function routeFromHash(hash: string): WorkspaceRoute {
  const value = hash.replace(/^#/, "") as WorkspaceRoute;
  return routes.has(value) ? value : "chat";
}

export function hashForRoute(route: WorkspaceRoute): string {
  return `#${route}`;
}

export function shouldLoadConversationTranscript(route: WorkspaceRoute): boolean {
  return route === "chat" || route === "career";
}

export function shouldPushWorkspaceHistory(
  currentUrl: string,
  targetUrl: string,
  currentState: unknown,
  nextState: WorkspaceHistoryState,
): boolean {
  const current = new URL(currentUrl);
  const target = new URL(targetUrl, current);
  const sameLocation = current.pathname === target.pathname
    && current.search === target.search
    && current.hash === target.hash;
  const currentHistoryState = currentState as Partial<WorkspaceHistoryState> | null;
  const sameState = Boolean(currentHistoryState)
    && currentHistoryState?.entropyWorkspaceHistory === true
    && currentHistoryState.route === nextState.route
    && currentHistoryState.workspace === nextState.workspace
    && currentHistoryState.conversationId === nextState.conversationId
    && currentHistoryState.selectedTaskId === nextState.selectedTaskId
    && currentHistoryState.rootLanding === nextState.rootLanding;
  return !sameLocation || !sameState;
}

export function isActiveWorkspaceRequest(
  active: WorkspaceRequestContext,
  requested: WorkspaceRequestContext,
  responseConversationId: string | null = requested.conversationId,
): boolean {
  return active.workspace === requested.workspace
    && active.route === requested.route
    && active.epoch === requested.epoch
    && (active.conversationId === requested.conversationId
      || active.conversationId === responseConversationId);
}

export function workspaceDocumentTitle(
  workspace: WorkspaceArea,
  newConversation: boolean,
  conversationId: string | null,
  savedTitle: string | null,
  route: WorkspaceRoute = workspace === "career" ? "career" : "chat",
): string {
  if (route === "applications") return "Отклики";
  if (route === "tasks") return "Задачи Veltrics";
  if (route === "memory") return "Память";
  if (newConversation || !conversationId) {
    return workspace === "career" ? "Новый разбор" : "Новый диалог";
  }
  return savedTitle || (workspace === "career" ? "Сохранённый разбор" : "Сохранённый диалог");
}

export function createWorkspaceHistoryState(
  route: WorkspaceRoute,
  workspace: WorkspaceArea,
  conversationId: string | null,
  selectedTaskId: string | null,
  rootLanding = false,
): WorkspaceHistoryState {
  return {
    entropyWorkspaceHistory: true,
    route,
    workspace,
    conversationId,
    selectedTaskId,
    rootLanding,
  };
}

function isWorkspaceHistoryState(value: unknown): value is WorkspaceHistoryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<WorkspaceHistoryState>;
  const workspaceMatchesRoute = state.route === "career" || state.route === "applications"
    ? state.workspace === "career"
    : state.route === "chat" ? state.workspace === "general" : true;
  return state.entropyWorkspaceHistory === true
    && typeof state.route === "string"
    && routes.has(state.route as WorkspaceRoute)
    && (state.workspace === "general" || state.workspace === "career")
    && workspaceMatchesRoute
    && (state.conversationId === null || typeof state.conversationId === "string")
    && (state.selectedTaskId === null || typeof state.selectedTaskId === "string")
    && typeof state.rootLanding === "boolean";
}

export function restoreWorkspaceHistoryState(
  value: unknown,
  hash: string,
  fallback: WorkspaceHistoryFallback,
): WorkspaceHistoryState {
  const route = routeFromHash(hash);
  if (isWorkspaceHistoryState(value) && value.route === route) return value;

  const workspace: WorkspaceArea = route === "career" || route === "applications"
    ? "career"
    : route === "chat" ? "general" : fallback.workspace;
  const conversationId = workspace === "career"
    ? fallback.careerConversationId
    : fallback.generalConversationId;
  return createWorkspaceHistoryState(route, workspace, conversationId, null, false);
}
