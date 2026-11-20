import type { CareerApplicationInput, CareerApplicationStatus } from "./api";
import { normalizeCareerSearchText } from "./career-application-utils";

export interface CareerCsvImportRow {
  row_number: number;
  values: CareerApplicationInput;
}

export interface CareerCsvPreview {
  rows: CareerCsvImportRow[];
  errors: string[];
}

export interface CareerCsvDuplicateSummary {
  alreadyInTracker: number[];
  repeatedInFile: number[];
}

export const MAX_CAREER_CSV_BYTES = 1_000_000;
export const MAX_CAREER_IMPORT_PAYLOAD_BYTES = 500_000;
export const CAREER_IMPORT_PAYLOAD_SIZE_ERROR = "CSV слишком велик для одного безопасного запроса. Раздели его на несколько файлов и повтори импорт.";
const MAX_CAREER_CSV_CHARACTERS = 1_000_000;

export function serializeCareerCsvCell(value: string | null | undefined) {
  let text = value || "";
  if (/^\s*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function getCareerImportPayloadSizeError(rows: CareerCsvImportRow[]) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ rows })).byteLength;
  return payloadBytes > MAX_CAREER_IMPORT_PAYLOAD_BYTES ? CAREER_IMPORT_PAYLOAD_SIZE_ERROR : null;
}

const HEADER_ALIASES: Record<string, keyof CareerApplicationInput> = {
  "company": "company",
  "company name": "company",
  "employer": "company",
  "компания": "company",
  "должность": "job_title",
  "job title": "job_title",
  "position": "job_title",
  "role": "job_title",
  "описание вакансии": "job_description",
  "текст вакансии": "job_description",
  "job description": "job_description",
  "description": "job_description",
  "ссылка": "source_url",
  "ссылка на вакансию": "source_url",
  "job url": "source_url",
  "source url": "source_url",
  "url": "source_url",
  "contact": "contact_name",
  "contact name": "contact_name",
  "recruiter": "contact_name",
  "контакт": "contact_name",
  "профиль контакта": "contact_url",
  "contact url": "contact_url",
  "contact profile": "contact_url",
  "location": "location",
  "город / формат": "location",
  "city": "location",
  "salary": "salary_range",
  "salary range": "salary_range",
  "зарплата": "salary_range",
  "этап": "status",
  "status": "status",
  "application status": "status",
  "next contact": "follow_up_date",
  "follow up date": "follow_up_date",
  "follow-up date": "follow_up_date",
  "следующий контакт": "follow_up_date",
  "notes": "notes",
  "заметки": "notes",
};

const STATUS_ALIASES: Record<string, CareerApplicationStatus> = {
  saved: "saved",
  bookmarked: "saved",
  сохранена: "saved",
  "в планах": "saved",
  preparing: "preparing",
  applying: "preparing",
  готовлю: "preparing",
  "готовлю отклик": "preparing",
  applied: "applied",
  "отправлено": "applied",
  "отклик отправлен": "applied",
  interview: "interview",
  interviewing: "interview",
  "собеседование": "interview",
  "собеседования": "interview",
  offer: "offer",
  "offer received": "offer",
  оффер: "offer",
  rejected: "rejected",
  отказ: "rejected",
  archived: "archived",
  архив: "archived",
  "в архиве": "archived",
};

const FIELD_LIMITS: Partial<Record<keyof CareerApplicationInput, number>> = {
  company: 160,
  job_title: 160,
  job_description: 12_000,
  source_url: 2_048,
  contact_name: 120,
  contact_url: 2_048,
  location: 160,
  salary_range: 120,
  notes: 4_000,
};

const FIELD_LABELS: Partial<Record<keyof CareerApplicationInput, string>> = {
  company: "название компании",
  job_title: "название должности",
  job_description: "описание вакансии",
  source_url: "ссылка на вакансию",
  contact_name: "имя контакта",
  contact_url: "ссылка на профиль контакта",
  location: "местоположение",
  salary_range: "зарплата",
  notes: "заметки",
};

function isAllowedHttpsUrl(value: string) {
  if (!value) return true;
  if (/[\\\s\u0000-\u001f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/u, "").trim().toLocaleLowerCase("ru").replace(/[\s_-]+/gu, " ");
}

function detectDelimiter(text: string) {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === "\r" || char === "\n")) {
      break;
    } else if (!quoted && char === ",") commas += 1;
    else if (!quoted && char === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

function parseRows(text: string, delimiter: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let recordLine = 1;

  const finishCell = () => { cells.push(cell); cell = ""; closedQuote = false; };
  const finishRow = () => {
    finishCell();
    rows.push({ line: recordLine, cells });
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (quoted) {
        quoted = false;
        closedQuote = true;
      } else if (closedQuote) {
        throw new Error(`Строка ${line}: после закрывающей кавычки неожиданно встретились данные.`);
      } else if (!cell || /^[ \t]*$/u.test(cell)) {
        cell = "";
        quoted = true;
      } else {
        throw new Error(`Строка ${line}: кавычка внутри поля должна быть экранирована.`);
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      finishCell();
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (quoted) {
        cell += "\n";
      } else {
        finishRow();
        recordLine = line + 1;
      }
      line += 1;
      continue;
    }
    if (!quoted && closedQuote) {
      if (char === " " || char === "\t") continue;
      throw new Error(`Строка ${line}: после закрывающей кавычки неожиданно встретились данные.`);
    }
    cell += char;
  }
  if (quoted) throw new Error("CSV заканчивается внутри незакрытого поля в кавычках.");
  if (cell || cells.length) finishRow();
  return rows;
}

function normalizeDate(value: string) {
  const date = value.trim();
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  const localized = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/u.exec(date);
  if (!localized) return date;
  const day = localized[1].padStart(2, "0");
  const month = localized[2].padStart(2, "0");
  return `${localized[3]}-${month}-${day}`;
}

function isRealIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseCareerApplicationsCsv(text: string): CareerCsvPreview {
  if (text.length > MAX_CAREER_CSV_CHARACTERS) throw new Error("CSV больше 1 МБ. Раздели его на файлы поменьше.");
  const parsedRows = parseRows(text, detectDelimiter(text));
  const nonemptyRows = parsedRows.filter(({ cells }) => cells.some((value) => value.trim()));
  if (nonemptyRows.length < 2) throw new Error("В CSV нужна строка заголовков и хотя бы одна вакансия.");

  const header = nonemptyRows[0];
  const fields = header.cells.map((value) => HEADER_ALIASES[normalizeHeader(value)] || null);
  if (!fields.includes("company") || !fields.includes("job_title")) {
    throw new Error("Не распознаны колонки компании и должности. Нужны заголовки «Компания» и «Должность» или Company и Job Title.");
  }
  const duplicates = fields.filter((field, index): field is keyof CareerApplicationInput => Boolean(field) && fields.indexOf(field) !== index);
  if (duplicates.length) throw new Error("В CSV есть повторяющиеся заголовки для одной колонки вакансии.");

  const records = nonemptyRows.slice(1);
  if (records.length > 100) throw new Error("За один раз можно импортировать не больше 100 вакансий.");
  const rows: CareerCsvImportRow[] = [];
  const errors: string[] = [];

  for (const record of records) {
    if (record.cells.length > fields.length) {
      errors.push(`Строка ${record.line}: значений больше, чем заголовков.`);
      continue;
    }
    const values: Record<string, string | null> = {
      company: "",
      job_title: "",
      job_description: "",
      source_url: "",
      contact_name: "",
      contact_url: "",
      location: "",
      salary_range: "",
      notes: "",
      status: "saved",
      conversation_id: null,
      follow_up_date: null,
    };
    fields.forEach((field, index) => {
      if (field) values[field] = record.cells[index]?.trim() || "";
    });

    const company = values.company || "";
    const jobTitle = values.job_title || "";
    const rowErrors: string[] = [];
    if (!company || !jobTitle) rowErrors.push("нужны компания и должность");
    Object.entries(FIELD_LIMITS).forEach(([field, maximum]) => {
      const value = String(values[field] || "");
      if (value.includes("\u0000")) {
        rowErrors.push(`поле «${FIELD_LABELS[field as keyof CareerApplicationInput]}» содержит недопустимый нулевой символ`);
      }
      if (maximum && value.length > maximum) {
        rowErrors.push(`${FIELD_LABELS[field as keyof CareerApplicationInput]} должны быть не длиннее ${maximum} символов`);
      }
    });

    (["source_url", "contact_url"] as const).forEach((field) => {
      const value = String(values[field] || "");
      if (!isAllowedHttpsUrl(value)) {
        rowErrors.push(field === "source_url"
          ? "ссылка на вакансию должна быть корректным HTTPS URL"
          : "ссылка на профиль контакта должна быть корректным HTTPS URL");
      }
    });

    const statusValue = fields.includes("status") ? normalizeHeader(String(values.status || "")) : "";
    if (statusValue) {
      const normalizedStatus = STATUS_ALIASES[statusValue];
      if (normalizedStatus) values.status = normalizedStatus;
      else rowErrors.push(`неизвестный этап «${String(values.status)}»`);
    } else values.status = "saved";
    if (fields.includes("follow_up_date")) {
      values.follow_up_date = normalizeDate(String(values.follow_up_date || ""));
      const dateValue = values.follow_up_date;
      if (dateValue && !isRealIsoDate(dateValue)) {
        rowErrors.push("дата следующего контакта должна быть ГГГГ-ММ-ДД или ДД.ММ.ГГГГ");
      }
    }
    if (rowErrors.length) {
      errors.push(`Строка ${record.line}: ${rowErrors.join("; ")}.`);
      continue;
    }
    rows.push({ row_number: record.line, values: values as CareerApplicationInput });
  }

  return { rows, errors };
}

function applicationKey(company: string, jobTitle: string) {
  return [company, jobTitle]
    .map(normalizeCareerSearchText)
    .join("\u0000");
}

export function findCareerCsvDuplicates(
  rows: CareerCsvImportRow[],
  existing: Array<Pick<CareerApplicationInput, "company" | "job_title">>,
): CareerCsvDuplicateSummary {
  const existingKeys = new Set(existing.map((item) => applicationKey(item.company, item.job_title)));
  const seenFileKeys = new Set<string>();
  const alreadyInTracker: number[] = [];
  const repeatedInFile: number[] = [];

  for (const row of rows) {
    const key = applicationKey(row.values.company, row.values.job_title);
    if (seenFileKeys.has(key)) repeatedInFile.push(row.row_number);
    else if (existingKeys.has(key)) alreadyInTracker.push(row.row_number);
    seenFileKeys.add(key);
  }

  return { alreadyInTracker, repeatedInFile };
}
