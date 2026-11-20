import type { ObservabilityEvent } from "./api";

export type EventGroup = {
  key: string;
  correlationId: string | null;
  events: ObservabilityEvent[];
};

const agentSources = new Set(["entropy", "psyche", "ophira", "veltrics"]);
const orderDispatchEvents = new Set([
  "workflow.dispatch_queued",
  "workflow.dispatch_retry",
  "workflow.dispatched",
  "workflow.dispatch_failed",
]);

/** Return the newest outbox lifecycle event instead of a stale retry record. */
export function latestOrderDispatchEvent(events: ObservabilityEvent[]): ObservabilityEvent | null {
  let latest: ObservabilityEvent | null = null;
  for (const event of events) {
    if (!orderDispatchEvents.has(event.event_type)) continue;
    if (!latest || event.id > latest.id) latest = event;
  }
  return latest;
}

export function isSameLocalCalendarDay(value: string, reference: Date): boolean {
  const date = new Date(value);
  return date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}

/** Match the backend summary: an agent branch is active only while its latest record is active. */
export function activeAgentEventIds(events: ObservabilityEvent[]): Set<number> {
  const latestByBranch = new Map<string, ObservabilityEvent>();
  for (const event of events) {
    if (!agentSources.has(event.source)) continue;
    const correlationId = event.correlation_id || event.source;
    const key = `${event.source}\u0000${correlationId}`;
    const previous = latestByBranch.get(key);
    if (!previous || event.id > previous.id) latestByBranch.set(key, event);
  }

  return new Set(
    [...latestByBranch.values()]
      .filter((event) => event.status === "running" || event.status === "started")
      .map((event) => event.id),
  );
}

/** Group lifecycle records for one correlated operation while keeping each event visible. */
export function groupObservabilityEvents(events: ObservabilityEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const key = event.correlation_id ? `correlation:${event.correlation_id}` : `event:${event.id}`;
    const group = groups.get(key) ?? { key, correlationId: event.correlation_id, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    new Date(right.events[0].created_at).getTime() - new Date(left.events[0].created_at).getTime(),
  );
}
