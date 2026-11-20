const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "career-application-utils.ts");
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

const { careerEmptyResultsMessage, effectiveCareerSort, filterAndSortCareerApplications, hasUpcomingFollowUp, isCurrentCareerApplicationsRead, needsFollowUp, toggleCareerFilter } = moduleRecord.exports;
const today = "2026-11-15";

function application(id, overrides = {}) {
  return {
    id,
    company: "Example",
    job_title: "Backend developer",
    job_description: "",
    source_url: "",
    contact_name: "",
    contact_url: "",
    location: "",
    salary_range: "",
    status: "saved",
    notes: "",
    conversation_id: null,
    follow_up_date: null,
    created_at: "2026-11-01T00:00:00+00:00",
    updated_at: "2026-11-01T00:00:00+00:00",
    ...overrides,
  };
}

const cases = [
  ["search covers the saved job description", () => {
    const rows = [
      application("match", { job_description: "Событийная архитектура и Kafka" }),
      application("other", { job_description: "Python и PostgreSQL" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "kafka", "updated", today).map((row) => row.id),
      ["match"],
    );
  }],
  ["search covers recruiter and notes", () => {
    const rows = [
      application("contact", { contact_name: "Алия Иванова" }),
      application("notes", { notes: "Написать Алии после звонка" }),
      application("other", { company: "Другая компания" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "али", "updated", today).map((row) => row.id),
      ["contact", "notes"],
    );
  }],
  ["search normalizes Unicode like the backend career search", () => {
    const rows = [
      application("sharp-s", { company: "Straße Systems" }),
      application("compatibility", { company: "ＡＩＧ Labs" }),
      application("sigma", { company: "Μάιος Systems" }),
      application("other", { company: "Other Systems" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "STRASSE", "updated", today).map((row) => row.id),
      ["sharp-s"],
    );
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "aig", "updated", today).map((row) => row.id),
      ["compatibility"],
    );
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "ΜΆΙΟΣ", "updated", today).map((row) => row.id),
      ["sigma"],
    );
  }],
  ["follow-up filter includes today and overdue, excludes closed", () => {
    const rows = [
      application("past", { follow_up_date: "2026-11-14", status: "applied" }),
      application("today", { follow_up_date: today, status: "interview" }),
      application("future", { follow_up_date: "2026-11-16", status: "applied" }),
      application("offer", { follow_up_date: "2026-11-14", status: "offer" }),
      application("archived", { follow_up_date: "2026-11-14", status: "archived" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "follow_up", "", "company", today).map((row) => row.id),
      ["past", "today"],
    );
    assert.equal(needsFollowUp(rows[3], today), false);
  }],
  ["upcoming follow-up filter includes tomorrow through day seven and excludes closed", () => {
    const rows = [
      application("overdue", { follow_up_date: "2026-11-14", status: "applied" }),
      application("today", { follow_up_date: today, status: "interview" }),
      application("tomorrow", { follow_up_date: "2026-11-16", status: "applied" }),
      application("last-day", { follow_up_date: "2026-11-22", status: "saved" }),
      application("outside", { follow_up_date: "2026-11-23", status: "saved" }),
      application("offer", { follow_up_date: "2026-11-20", status: "offer" }),
      application("rejected", { follow_up_date: "2026-11-20", status: "rejected" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "follow_up_week", "", "company", today).map((row) => row.id),
      ["tomorrow", "last-day"],
    );
    assert.equal(hasUpcomingFollowUp(rows[4], today), false);
  }],
  ["empty upcoming state describes the selected window", () => {
    assert.equal(
      careerEmptyResultsMessage("follow_up_week", ""),
      "На ближайшие 7 дней контакты не запланированы.",
    );
  }],
  ["empty state describes combined search and stage filters", () => {
    assert.equal(
      careerEmptyResultsMessage("interview", "backend"),
      "По текущему поиску и фильтру вакансий не найдено.",
    );
  }],
  ["follow-up sorting puts nearest dates first and blank dates last", () => {
    const rows = [
      application("blank"),
      application("later", { follow_up_date: "2026-11-17" }),
      application("near", { follow_up_date: "2026-11-16" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "", "follow_up", today).map((row) => row.id),
      ["near", "later", "blank"],
    );
    assert.equal(effectiveCareerSort("follow_up", "company"), "follow_up");
    assert.equal(effectiveCareerSort("follow_up_week", "company"), "follow_up");
    assert.equal(effectiveCareerSort("all", "company"), "company");
  }],
  ["same-company rows sort by role", () => {
    const rows = [
      application("senior", { company: "Альфа", job_title: "Senior backend" }),
      application("junior", { company: "Альфа", job_title: "Junior backend" }),
      application("beta", { company: "Бета" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "", "company", today).map((row) => row.id),
      ["junior", "senior", "beta"],
    );
  }],
  ["updated sorting is newest first without mutating input", () => {
    const rows = [
      application("older", { updated_at: "2026-11-10T00:00:00+00:00" }),
      application("newer", { updated_at: "2026-11-14T00:00:00+00:00" }),
    ];
    assert.deepEqual(
      filterAndSortCareerApplications(rows, "all", "", "updated", today).map((row) => row.id),
      ["newer", "older"],
    );
    assert.deepEqual(rows.map((row) => row.id), ["older", "newer"]);
  }],
  ["stage filters toggle off when selected again", () => {
    assert.equal(toggleCareerFilter("all", "interview"), "interview");
    assert.equal(toggleCareerFilter("interview", "interview"), "all");
    assert.equal(toggleCareerFilter("offer", "offer"), "all");
    assert.equal(toggleCareerFilter("applied", "applied"), "all");
  }],
  ["changing a stage filter selects the new stage", () => {
    assert.equal(toggleCareerFilter("saved", "offer"), "offer");
    assert.equal(toggleCareerFilter("follow_up", "applied"), "applied");
  }],
  ["a late list response cannot replace a newer request or a local mutation", () => {
    assert.equal(isCurrentCareerApplicationsRead(4, 4, 2, 2), true);
    assert.equal(isCurrentCareerApplicationsRead(3, 4, 2, 2), false);
    assert.equal(isCurrentCareerApplicationsRead(4, 4, 1, 2), false);
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

console.log(`PASS: ${cases.length} career filter/sort checks.`);
