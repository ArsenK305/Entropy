const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "api.ts");
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

const { api } = moduleRecord.exports;

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(
      api.state(),
      /Не удалось связаться с backend\. Проверь подключение и работу Entropy\./u,
    );

    globalThis.fetch = async () => {
      throw new DOMException("Signal timed out", "TimeoutError");
    };
    await assert.rejects(api.state(), /Backend не ответил за 10 секунд/u);

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "База данных Entropy недоступна." }),
    });
    await assert.rejects(api.state(), /База данных Entropy недоступна\./u);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("invalid JSON"); },
    });
    await assert.rejects(api.state(), /пустой или некорректный ответ/u);

    let requestedUrl = "";
    let requestedOptions;
    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ conversations: [], has_more: false, next_cursor: null }),
      };
    };
    await api.conversationHistory("career", {
      updated_at: "2026-11-02T00:00:00+00:00",
      id: "entropy-career-older / 1",
    });
    const query = new URL(requestedUrl, "http://localhost").searchParams;
    assert.equal(new URL(requestedUrl, "http://localhost").pathname, "/api/conversations/history");
    assert.equal(query.get("workspace"), "career");
    assert.equal(query.get("before_updated_at"), "2026-11-02T00:00:00+00:00");
    assert.equal(query.get("before_id"), "entropy-career-older / 1");
    assert.equal(requestedOptions.cache, "no-store");

    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 202,
        json: async () => ({ conversation_id: "conversation-1", turn_id: "turn-1" }),
      };
    };
    const chatResult = await api.send({
      message: "Review this request",
      conversation_id: "conversation-1",
      workspace: "general",
      output_token_limits: { entropy: 1200, veltrics: 800, psyche: 600 },
    });
    assert.equal(new URL(requestedUrl, "http://localhost").pathname, "/api/chat");
    assert.equal(requestedOptions.method, "POST");
    assert.deepEqual(chatResult, { conversation_id: "conversation-1", turn_id: "turn-1" });

    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ applications: [], has_more: false, next_cursor: null, total_count: 0 }),
      };
    };
    await api.careerApplications({
      created_at: "2026-11-14T23:00:00+00:00",
      id: "00000000-0000-0000-0000-000000000001",
    });
    const applicationQuery = new URL(requestedUrl, "http://localhost").searchParams;
    assert.equal(new URL(requestedUrl, "http://localhost").pathname, "/api/career/applications");
    assert.equal(applicationQuery.get("before_created_at"), "2026-11-14T23:00:00+00:00");
    assert.equal(applicationQuery.get("before_id"), "00000000-0000-0000-0000-000000000001");
    assert.equal(applicationQuery.has("before_updated_at"), false);
    assert.equal(requestedOptions.cache, "no-store");

    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ applications: [], has_more: false, next_cursor: null, total_count: 0 }),
      };
    };
    await api.careerApplications(null, {
      search: "  Алия  ",
      filter: "follow_up",
      as_of_date: "2026-11-15",
    });
    const filteredApplicationsUrl = new URL(requestedUrl, "http://localhost");
    assert.equal(filteredApplicationsUrl.searchParams.get("search"), "Алия");
    assert.equal(filteredApplicationsUrl.searchParams.get("filter"), "follow_up");
    assert.equal(filteredApplicationsUrl.searchParams.get("as_of_date"), "2026-11-15");
    assert.equal(requestedOptions.cache, "no-store");

    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ applications: [], has_more: false, next_cursor: null, total_count: 0 }),
      };
    };
    await api.careerApplications(null, {
      filter: "follow_up_week",
      as_of_date: "2026-11-15",
    });
    const upcomingApplicationsUrl = new URL(requestedUrl, "http://localhost");
    assert.equal(upcomingApplicationsUrl.searchParams.get("filter"), "follow_up_week");
    assert.equal(upcomingApplicationsUrl.searchParams.get("as_of_date"), "2026-11-15");
    assert.equal(requestedOptions.cache, "no-store");

    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 3,
          status_counts: { saved: 1, preparing: 0, applied: 1, interview: 0, offer: 1, rejected: 0, archived: 0 },
          due_follow_up_count: 1,
          upcoming_follow_up_count: 2,
          as_of_date: "2026-11-15",
        }),
      };
    };
    await api.careerApplicationSummary("2026-11-15");
    const summaryUrl = new URL(requestedUrl, "http://localhost");
    assert.equal(summaryUrl.pathname, "/api/career/applications/summary");
    assert.equal(summaryUrl.searchParams.get("as_of_date"), "2026-11-15");
    assert.equal(requestedOptions.cache, "no-store");

    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input);
      requestedOptions = options;
      return {
        ok: true,
        status: 201,
        json: async () => ({ event: { id: 8, event_type: "manual_contact", note: "Recruiter call", created_at: "2026-11-15T12:00:00+00:00" } }),
      };
    };
    await api.addCareerApplicationActivity("app / id", { activity_type: "contact", note: "Recruiter call" });
    assert.equal(new URL(requestedUrl, "http://localhost").pathname, "/api/career/applications/app%20%2F%20id/activity");
    assert.equal(requestedOptions.method, "POST");
    assert.equal(requestedOptions.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(requestedOptions.body), { activity_type: "contact", note: "Recruiter call" });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().then(() => {
console.log("PASS: chat submission contract, 4 API error checks, cursor/filter serialization, career summary, and manual activity requests.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
