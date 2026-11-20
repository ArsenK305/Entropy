import type { Task, TaskStatus } from "./api";

export type TaskFilter = "all" | "active" | "completed" | "attention";
type TaskReview = { status?: string; verdict?: string | null };
type TaskReviewResult = { psyche_review?: TaskReview };

const activeStatuses: TaskStatus[] = ["queued", "planning", "running", "delegated"];

export function taskPrimaryActionLabel(status: TaskStatus) {
  if (status === "failed" || status === "interrupted") return "Подготовить повтор";
  if (status === "completed") return "Продолжить в диалоге";
  return null;
}

export function taskDraftForAction(task: Pick<Task, "status" | "request">) {
  return task.status === "failed" || task.status === "interrupted" ? task.request : "";
}

export function taskNeedsAttention(task: Task) {
  let review: TaskReview | undefined;
  try {
    const result: unknown = task.result ? JSON.parse(task.result) : {};
    if (typeof result === "object" && result !== null) {
      review = (result as TaskReviewResult).psyche_review;
    }
  } catch {
    review = undefined;
  }

  const status = task.review_status ?? review?.status;
  const verdict = task.review_verdict ?? review?.verdict;
  return status === "unavailable" || verdict === "needs_revision" || verdict === "blocked";
}

function matchesTaskFilter(task: Task, filter: TaskFilter) {
  if (filter === "active") return activeStatuses.includes(task.status);
  if (filter === "completed") return task.status === "completed" && !taskNeedsAttention(task);
  if (filter === "attention") {
    return task.status === "failed" || task.status === "interrupted" || taskNeedsAttention(task);
  }
  return true;
}

export function filterTasks(tasks: Task[], filter: TaskFilter) {
  return tasks.filter((task) => matchesTaskFilter(task, filter));
}

export function countTaskFilters(tasks: Task[]): Record<TaskFilter, number> {
  return {
    all: tasks.length,
    active: tasks.filter((task) => matchesTaskFilter(task, "active")).length,
    completed: tasks.filter((task) => matchesTaskFilter(task, "completed")).length,
    attention: tasks.filter((task) => matchesTaskFilter(task, "attention")).length,
  };
}
