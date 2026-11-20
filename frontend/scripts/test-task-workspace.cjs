const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "task-workspace-utils.ts");
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

const { countTaskFilters, filterTasks, taskDraftForAction, taskNeedsAttention, taskPrimaryActionLabel } = moduleRecord.exports;

function task(id, status, overrides = {}) {
  return {
    id,
    conversation_id: "conversation-1",
    request: `Request ${id}`,
    status,
    created_at: "2026-11-15T00:00:00+00:00",
    ...overrides,
  };
}

const allTasks = [
  task("queued", "queued"),
  task("planning", "planning"),
  task("running", "running"),
  task("delegated", "delegated"),
  task("completed", "completed"),
  task("failed", "failed"),
  task("interrupted", "interrupted"),
  task("review-needed", "completed", { review_verdict: "needs_revision" }),
  task("review-blocked", "completed", { result: JSON.stringify({ psyche_review: { verdict: "blocked" } }) }),
  task("review-unavailable", "completed", { result: JSON.stringify({ psyche_review: { status: "unavailable" } }) }),
];

const cases = [
  ["active filter contains queued, planning, running, and delegated", () => {
    assert.deepEqual(filterTasks(allTasks, "active").map(({ id }) => id), [
      "queued", "planning", "running", "delegated",
    ]);
  }],
  ["completed filter excludes review findings that need attention", () => {
    assert.deepEqual(filterTasks(allTasks, "completed").map(({ id }) => id), ["completed"]);
  }],
  ["attention includes failed, interrupted, blocked, unavailable, and revision-needed tasks", () => {
    assert.deepEqual(filterTasks(allTasks, "attention").map(({ id }) => id), [
      "failed", "interrupted", "review-needed", "review-blocked", "review-unavailable",
    ]);
  }],
  ["all filter preserves every task and the original order", () => {
    assert.deepEqual(filterTasks(allTasks, "all"), allTasks);
  }],
  ["top-level review fields take precedence over the saved result", () => {
    assert.equal(taskNeedsAttention(task("override", "completed", {
      review_verdict: "clear",
      result: JSON.stringify({ psyche_review: { verdict: "blocked" } }),
    })), false);
  }],
  ["malformed review JSON does not crash or falsely mark the task", () => {
    assert.equal(taskNeedsAttention(task("malformed", "completed", { result: "{" })), false);
  }],
  ["filter counts match the result sets without overlap", () => {
    const counts = countTaskFilters(allTasks);
    assert.deepEqual(counts, { all: 10, active: 4, completed: 1, attention: 5 });
    assert.equal(counts.completed + counts.attention, 6);
  }],
  ["terminal task actions describe whether the user will retry or return to chat", () => {
    assert.equal(taskPrimaryActionLabel("interrupted"), "Подготовить повтор");
    assert.equal(taskPrimaryActionLabel("failed"), "Подготовить повтор");
    assert.equal(taskPrimaryActionLabel("completed"), "Продолжить в диалоге");
    assert.equal(taskPrimaryActionLabel("running"), null);
  }],
  ["retry preparation prefills only failed or interrupted work without truncating its request", () => {
    const originalRequest = "Исходный запрос с деталями, который пользователь сможет проверить.";
    assert.equal(taskDraftForAction(task("interrupted-draft", "interrupted", { request: originalRequest })), originalRequest);
    assert.equal(taskDraftForAction(task("failed-draft", "failed", { request: originalRequest })), originalRequest);
    assert.equal(taskDraftForAction(task("completed-draft", "completed", { request: originalRequest })), "");
  }],
];

for (const [name, run] of cases) {
  try {
    run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

console.log(`PASS: ${cases.length} task status/review filter checks.`);
