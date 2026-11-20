import type { CareerApplication, CareerApplicationStatus } from "./api";

export type CareerFilter = "all" | "follow_up" | "follow_up_week" | CareerApplicationStatus;
export type CareerSortOrder = "updated" | "follow_up" | "company";

const closedStatuses: CareerApplicationStatus[] = ["offer", "rejected", "archived"];

export function normalizeCareerSearchText(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("ru")
    .replace(/[ßẞ]/gu, "ss")
    .replace(/\u03c2/gu, "\u03c3");
}

export function isCurrentCareerApplicationsRead(
  requestId: number,
  currentRequestId: number,
  dataRevision: number,
  currentDataRevision: number,
) {
  return requestId === currentRequestId && dataRevision === currentDataRevision;
}

export function toggleCareerFilter(current: CareerFilter, target: CareerFilter): CareerFilter {
  return current === target ? "all" : target;
}

export function effectiveCareerSort(filter: CareerFilter, sortOrder: CareerSortOrder): CareerSortOrder {
  return filter === "follow_up" || filter === "follow_up_week" ? "follow_up" : sortOrder;
}

export function careerEmptyResultsMessage(filter: CareerFilter, search: string) {
  const hasSearch = Boolean(search.trim());
  if (hasSearch && filter !== "all") return "По текущему поиску и фильтру вакансий не найдено.";
  if (hasSearch) return "По этому запросу вакансий не найдено.";
  if (filter === "follow_up_week") return "На ближайшие 7 дней контакты не запланированы.";
  if (filter === "follow_up") return "Нет вакансий с просроченным или сегодняшним контактом.";
  return "На выбранном этапе вакансий нет.";
}

export function needsFollowUp(application: CareerApplication, today: string) {
  return Boolean(
    application.follow_up_date
      && application.follow_up_date <= today
      && !closedStatuses.includes(application.status),
  );
}

export function hasUpcomingFollowUp(application: CareerApplication, today: string) {
  if (!application.follow_up_date || closedStatuses.includes(application.status)) return false;
  const [year, month, day] = today.split("-").map(Number);
  const through = new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);
  return application.follow_up_date > today && application.follow_up_date <= through;
}

export function filterAndSortCareerApplications(
  applications: CareerApplication[],
  filter: CareerFilter,
  search: string,
  sortOrder: CareerSortOrder,
  today: string,
): CareerApplication[] {
  const query = normalizeCareerSearchText(search);
  const result = applications.filter((application) => {
    const matchesFilter = filter === "all"
      || (filter === "follow_up" && needsFollowUp(application, today))
      || (filter === "follow_up_week" && hasUpcomingFollowUp(application, today))
      || application.status === filter;
    const searchableText = normalizeCareerSearchText([
      application.company,
      application.job_title,
      application.job_description,
      application.location,
      application.contact_name,
      application.notes,
    ].filter(Boolean).join(" "));
    return matchesFilter && (!query || searchableText.includes(query));
  });

  const effectiveSort = effectiveCareerSort(filter, sortOrder);
  result.sort((left, right) => {
    if (effectiveSort === "follow_up") {
      const dateOrder = (left.follow_up_date || "9999-12-31")
        .localeCompare(right.follow_up_date || "9999-12-31");
      return dateOrder || right.updated_at.localeCompare(left.updated_at);
    }
    if (effectiveSort === "company") {
      const companyOrder = left.company.localeCompare(
        right.company,
        "ru",
        { sensitivity: "base" },
      );
      return companyOrder || left.job_title.localeCompare(
        right.job_title,
        "ru",
        { sensitivity: "base" },
      );
    }
    return right.updated_at.localeCompare(left.updated_at);
  });
  return result;
}
