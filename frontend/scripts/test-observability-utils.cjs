const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "observability-utils.ts");
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
  observabilityActorLabel,
  observabilityActivityLabel,
  observabilityEventDetail,
  observabilityEventLabel,
  observabilityEventUrl,
} = moduleRecord.exports;
const event = (event_type, detail, status = "completed") => ({
  id: 12,
  correlation_id: null,
  source: "rag",
  event_type,
  status,
  detail,
  created_at: "2026-11-15T08:00:00Z",
});

assert.equal(observabilityActorLabel("telegram_miniapp"), "Telegram Mini App");
assert.equal(observabilityActorLabel("unknown-internal-source"), "Сервис", "unknown source IDs should not leak to the UI");
assert.equal(observabilityEventLabel("rag.search.completed"), "Карьерный поиск завершён");
assert.equal(observabilityEventLabel("unknown.internal.event"), "Событие системы");

const careerResult = observabilityEventDetail(event(
  "rag.search.completed",
  "Career RAG search completed; 4 approved reference(s) attached; source_id: private-drive-id.",
));
assert.equal(careerResult, "Карьерный поиск нашёл фрагменты профиля: 4.");
assert.ok(!careerResult.includes("private-drive-id"), "RAG source IDs should not be displayed in summaries");

assert.equal(
  observabilityEventDetail(event("workflow.dispatch_retry", "Передача в n8n не удалась; повторная попытка через 20 с.", "waiting")),
  "Временная ошибка передачи. Повтор запланирован через 20 с.",
);
assert.equal(
  observabilityEventDetail(event("unknown.internal.event", "api_key=secret-value", "failed")),
  "Сервис сообщил об ошибке. Подробности доступны в Argus.",
  "unknown raw payloads should not appear in user-facing copy",
);
assert.equal(observabilityEventUrl(12), "/argus?event_id=12#events");
assert.equal(
  observabilityActivityLabel("RAG", careerResult, "Открыть события Argus"),
  "RAG: Карьерный поиск нашёл фрагменты профиля: 4. Открыть события Argus",
  "activity button names should not contain doubled punctuation",
);

console.log("PASS: user-facing observability labels, safe summaries, and event deep links.");
