const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "argus-utils.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleRecord = { exports: {} };
const runModule = vm.runInThisContext("(function (exports, require, module) {" + compiled + "\n})", {
  filename: sourcePath,
});
runModule(moduleRecord.exports, require, moduleRecord);

const {
  activeAgentEventIds,
  groupObservabilityEvents,
  isSameLocalCalendarDay,
  latestOrderDispatchEvent,
} = moduleRecord.exports;
const lifecycle = [
  [9, "workflow.completed", "2026-11-15T10:00:05+00:00"],
  [8, "workflow.started", "2026-11-15T10:00:04+00:00"],
  [7, "workflow.dispatched", "2026-11-15T10:00:03+00:00"],
  [6, "workflow.dispatch_queued", "2026-11-15T10:00:02+00:00"],
  [5, "order.created", "2026-11-15T10:00:01+00:00"],
].map(([id, event_type, created_at]) => ({
  id,
  correlation_id: "order-1",
  source: "n8n",
  event_type,
  status: "completed",
  detail: "",
  created_at,
}));
const standalone = (id, created_at) => ({
  id,
  correlation_id: null,
  source: "entropy",
  event_type: "agent.review.completed",
  status: "completed",
  detail: "",
  created_at,
});

const groups = groupObservabilityEvents([
  standalone(10, "2026-11-15T12:00:00+00:00"),
  standalone(9, "2026-11-15T11:00:00+00:00"),
  ...lifecycle,
]);
const orderGroup = groups.find((group) => group.correlationId === "order-1");

assert.equal(groups.length, 3, "uncorrelated events remain independent groups");
assert.equal(orderGroup.events.length, 5, "one configured test purchase includes queue and workflow lifecycle records");
assert.equal(orderGroup.events[0].event_type, "workflow.completed", "events preserve API order within a group");
assert.equal(groups[0].events[0].id, 10, "groups sort newest-first by their latest event");

const dispatchTrail = [
  { id: 15, event_type: "workflow.dispatched" },
  { id: 13, event_type: "workflow.dispatch_retry" },
  { id: 12, event_type: "workflow.dispatch_queued" },
].map((event) => ({ ...standalone(event.id, "2026-11-15T12:00:00+00:00"), ...event }));
assert.equal(
  latestOrderDispatchEvent(dispatchTrail)?.event_type,
  "workflow.dispatched",
  "a completed retry clears the stale retry status in the order card",
);

const agentEvent = (id, source, correlation_id, status) => ({
  id,
  correlation_id,
  source,
  event_type: `agent.${status}`,
  status,
  detail: "",
  created_at: `2026-11-15T10:00:${String(id).padStart(2, "0")}+00:00`,
});
const activeIds = activeAgentEventIds([
  agentEvent(24, "psyche", null, "completed"),
  agentEvent(23, "psyche", null, "running"),
  agentEvent(22, "entropy", "order-2", "running"),
  agentEvent(21, "entropy", "order-2", "completed"),
  agentEvent(20, "ophira", "order-3", "started"),
  agentEvent(19, "n8n", "order-4", "running"),
]);
assert.deepEqual([...activeIds].sort((left, right) => left - right), [20, 22], "only the latest active event per agent branch is filterable");

const localToday = new Date(2026, 10, 15, 12, 0, 0);
assert.equal(isSameLocalCalendarDay(new Date(2026, 10, 15, 1, 0, 0).toISOString(), localToday), true, "events from the same local calendar day match today");
assert.equal(isSameLocalCalendarDay(new Date(2026, 10, 14, 23, 59, 0).toISOString(), localToday), false, "events from the previous local day remain distinguishable");

console.log("PASS: event grouping, current branch status, and local calendar day handling.");
