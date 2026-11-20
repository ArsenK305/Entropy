const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "career-application-csv.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const utilityPath = path.join(__dirname, "..", "src", "career-application-utils.ts");
const utilitySource = fs.readFileSync(utilityPath, "utf8");
const utilityCompiled = ts.transpileModule(utilitySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const utilityModule = { exports: {} };
const runUtilityModule = vm.runInThisContext(`(function (exports, require, module) {${utilityCompiled}\n})`, {
  filename: utilityPath,
});
runUtilityModule(utilityModule.exports, require, utilityModule);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleRecord = { exports: {} };
const runModule = vm.runInThisContext(`(function (exports, require, module) {${compiled}\n})`, {
  filename: sourcePath,
});
const localRequire = (id) => id === "./career-application-utils"
  ? utilityModule.exports
  : require(id);
runModule(moduleRecord.exports, localRequire, moduleRecord);

const {
  findCareerCsvDuplicates,
  getCareerImportPayloadSizeError,
  MAX_CAREER_CSV_BYTES,
  parseCareerApplicationsCsv,
  serializeCareerCsvCell,
} = moduleRecord.exports;
const cases = [
  ["quotes CSV cells and neutralizes spreadsheet formulas", () => {
    assert.equal(serializeCareerCsvCell('Recruiter, said "yes"'), '"Recruiter, said ""yes"""');
    assert.equal(serializeCareerCsvCell(null), '""');
    for (const formula of [
      "=1+1",
      "+SUM(A1:A2)",
      "-1+2",
      "@SUM(A1:A2)",
      "\t=1+1",
      "\r@SUM(A1:A2)",
      "  +1",
      "\u00a0=1+1",
      "\u2003+SUM(A1:A2)",
      "\ufeff@SUM(A1:A2)",
    ]) {
      assert.equal(serializeCareerCsvCell(formula), `"'${formula}"`);
    }
    assert.equal(serializeCareerCsvCell("ordinary note"), '"ordinary note"');
  }],
  ["round-trips Entropy export columns, quotes, commas, and multiline text", () => {
    const csv = '\uFEFFКомпания,Должность,Описание вакансии,Этап,Ссылка,Контакт,Профиль контакта,Город / формат,Зарплата,Следующий контакт,Заметки,Добавлена,Обновлена\r\n"Example, Inc.",Backend,"Требования: Python, FastAPI\nСтрока ""в кавычках""","Отклик отправлен",https://jobs.example/1,Алия,https://example.com/recruiter,Алматы,1–2 млн,15.11.2026,"Первая строка\nВторая ""цитата""",2026-11-01,2026-11-02\r\n';
    const result = parseCareerApplicationsCsv(csv);
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].row_number, 2);
    assert.equal(result.rows[0].values.company, "Example, Inc.");
    assert.equal(result.rows[0].values.job_description, 'Требования: Python, FastAPI\nСтрока "в кавычках"');
    assert.equal(result.rows[0].values.status, "applied");
    assert.equal(result.rows[0].values.follow_up_date, "2026-11-15");
    assert.equal(result.rows[0].values.notes, 'Первая строка\nВторая "цитата"');
    assert.equal(result.rows[0].values.conversation_id, null);
  }],
  ["detects semicolon CSV and English headings", () => {
    const result = parseCareerApplicationsCsv("Company;Job Title;Status;Follow-up date;Notes\nExample;Engineer;Interviewing;15.11.2026;Bring portfolio\n");
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows[0].values.status, "interview");
    assert.equal(result.rows[0].values.follow_up_date, "2026-11-15");
  }],
  ["round-trips archived status and defaults an empty status", () => {
    const result = parseCareerApplicationsCsv("Компания,Должность,Этап\nExample,Engineer,В архиве\nOther,Backend,\n");
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows[0].values.status, "archived");
    assert.equal(result.rows[1].values.status, "saved");
  }],
  ["reports invalid links and overlong fields before confirmation", () => {
    const longNotes = "x".repeat(4_001);
    const result = parseCareerApplicationsCsv(`Company,Job Title,Job URL,Notes\nExample,Engineer,http://jobs.example/42,${longNotes}\n`);
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0], /ссылка на вакансию/u);
    assert.match(result.errors[0], /заметки должны быть не длиннее 4000/u);
  }],
  ["rejects an overlong job description during CSV preview", () => {
    const result = parseCareerApplicationsCsv(`Company,Job Title,Job Description\nExample,Engineer,${"x".repeat(12_001)}\n`);
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0], /описание вакансии должны быть не длиннее 12000/u);
  }],
  ["rejects PostgreSQL-incompatible NUL characters during CSV preview", () => {
    const result = parseCareerApplicationsCsv("Company,Job Title,Notes\nExample,Engineer,Unsafe\u0000note\n");
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0], /поле «заметки» содержит недопустимый нулевой символ/u);
  }],
  ["shows row numbers for incomplete rows and unknown stages", () => {
    const result = parseCareerApplicationsCsv("Компания,Должность,Этап\nExample,,Сохранена\nExample,Backend,Pending\n");
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0], /Строка 2: нужны компания и должность/u);
    assert.match(result.errors[1], /Строка 3: неизвестный этап/u);
  }],
  ["rejects an impossible calendar date before sending to the server", () => {
    const result = parseCareerApplicationsCsv("Company,Job Title,Follow-up date\nExample,Engineer,2026-02-30\n");
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0], /Строка 2: дата следующего контакта/u);
  }],
  ["rejects missing required headings and unclosed quotes", () => {
    assert.throws(() => parseCareerApplicationsCsv("Company,Notes\nExample,note\n"), /колонки компании и должности/u);
    assert.throws(() => parseCareerApplicationsCsv('Company,Job Title\nExample,"unfinished\n'), /незакрытого поля/u);
  }],
  ["keeps the CSV preview size cap aligned with the file-read guard", () => {
    assert.equal(MAX_CAREER_CSV_BYTES, 1_000_000);
    assert.throws(() => parseCareerApplicationsCsv(`Company,Job Title\nExample,${"x".repeat(1_000_001)}\n`), /больше 1 МБ/u);
  }],
  ["warns during preview when a multilingual CSV fits the file cap but exceeds the request cap", () => {
    const note = "я".repeat(4_000);
    const csv = `Company,Job Title,Notes\n${Array.from({ length: 100 }, (_, index) => `Company ${index},Engineer,${note}`).join("\n")}\n`;
    assert.ok(new TextEncoder().encode(csv).byteLength < MAX_CAREER_CSV_BYTES);
    const preview = parseCareerApplicationsCsv(csv);
    assert.equal(preview.errors.length, 0);
    assert.equal(preview.rows.length, 100);
    assert.match(getCareerImportPayloadSizeError(preview.rows), /CSV слишком велик/u);
  }],
  ["rejects malformed quotes instead of silently changing imported values", () => {
    assert.throws(() => parseCareerApplicationsCsv('Company,Job Title\nExam"ple,Engineer\n'), /кавычка внутри поля/u);
    assert.throws(() => parseCareerApplicationsCsv('Company,Job Title\n"Example"oops,Engineer\n'), /после закрывающей кавычки/u);
  }],
  ["accepts harmless whitespace after a quoted cell", () => {
    const result = parseCareerApplicationsCsv('Company,Job Title\n"Example" , "Engineer"\n');
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows[0].values.company, "Example");
    assert.equal(result.rows[0].values.job_title, "Engineer");
  }],
  ["detects existing and in-file duplicates without fuzzy matching", () => {
    const preview = parseCareerApplicationsCsv("Company,Job Title\n ACME   Corp ,Backend Engineer\nNorthwind,SRE\n northwind , sre \n");
    const summary = findCareerCsvDuplicates(preview.rows, [
      { company: "acme corp", job_title: "BACKEND ENGINEER" },
      { company: "Different", job_title: "SRE" },
    ]);
    assert.deepEqual(summary, { alreadyInTracker: [2], repeatedInFile: [4] });
  }],
  ["detects case-folded Unicode duplicates", () => {
    const preview = parseCareerApplicationsCsv(
      "Company,Job Title\nStraße Systems,Backend Engineer\nSTRASSE SYSTEMS,backend engineer\nＡＩＧ Labs,Platform Engineer\nAIG LABS,PLATFORM ENGINEER\n",
    );
    const summary = findCareerCsvDuplicates(preview.rows, []);
    assert.deepEqual(summary, { alreadyInTracker: [], repeatedInFile: [3, 5] });
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

console.log(`PASS: ${cases.length} CSV import checks.`);
