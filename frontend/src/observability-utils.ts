import type { ObservabilityEvent } from "./api";

const eventLabels: Record<string, string> = {
  "order.created": "Тестовый заказ сохранён",
  "workflow.dispatch_queued": "Передача заказа поставлена в очередь",
  "workflow.dispatch_retry": "Повтор передачи заказа запланирован",
  "workflow.dispatched": "n8n принял запрос",
  "workflow.started": "n8n начал обработку заказа",
  "workflow.completed": "n8n завершил обработку заказа",
  "workflow.failed": "Ошибка в n8n workflow",
  "workflow.dispatch_failed": "n8n не принял заказ",
  "workflow.not_configured": "n8n не подключён",
  "rag.search.completed": "Карьерный поиск завершён",
  "rag.search.failed": "Ошибка карьерного поиска",
  "telegram.product_search.started": "Начат поиск о продукте",
  "telegram.product_search.completed": "Материалы о продукте найдены",
  "telegram.product_search.empty": "Подходящие материалы не найдены",
  "telegram.product_search.failed": "Ошибка поиска о продукте",
  "telegram.product_answer.started": "Готовится ответ о продукте",
  "telegram.product_answer.completed": "Ответ о продукте подготовлен",
  "telegram.product_answer.failed": "Не удалось подготовить ответ о продукте",
  "agent.review.started": "Начата проверка PSYCHE",
  "agent.review.completed": "Проверка PSYCHE завершена",
  "agent.review.failed": "Проверка PSYCHE завершилась с ошибкой",
};

const actorLabels: Record<string, string> = {
  entropy: "Entropy",
  entropy_flow: "Entropy · RAG",
  rag: "RAG",
  psyche: "Psyche",
  ophira: "Ophira",
  veltrics: "Veltrics",
  telegram_miniapp: "Telegram Mini App",
  telegram_flow: "Telegram Mini App",
  miniapp_preview: "Mini App preview",
  n8n: "n8n",
};

/** Map internal source names to concise labels for people using the workspace. */
export function observabilityActorLabel(source: string): string {
  return actorLabels[source] ?? "Сервис";
}

/** Keep unknown event types understandable without exposing arbitrary backend payloads. */
export function observabilityEventLabel(eventType: string): string {
  return eventLabels[eventType] ?? "Событие системы";
}

/** Turn persisted event metadata into concise copy; internal source IDs stay in the data layer. */
export function observabilityEventDetail(event: ObservabilityEvent): string {
  switch (event.event_type) {
    case "order.created":
      return "Заказ сохранён в демонстрационном режиме; оплата не выполнялась.";
    case "workflow.dispatch_queued":
      return "Заказ сохранён и ожидает передачи в n8n.";
    case "workflow.dispatch_retry": {
      const seconds = event.detail.match(/через\s+(\d+)\s*с\./i)?.[1];
      return seconds
        ? `Временная ошибка передачи. Повтор запланирован через ${seconds} с.`
        : "Временная ошибка передачи. Запланирована повторная попытка.";
    }
    case "workflow.dispatched":
      return "n8n вернул успешный HTTP-ответ по webhook.";
    case "workflow.started":
      return "n8n начал обработку заказа.";
    case "workflow.completed":
      return "Workflow завершил обработку заказа.";
    case "workflow.failed":
      return "Workflow завершился с ошибкой. Проверь выполнение в n8n.";
    case "workflow.dispatch_failed": {
      const code = event.detail.match(/HTTP\s+(\d{3})/i)?.[1];
      return code
        ? `Передача не удалась (HTTP ${code}); автоматические попытки завершены.`
        : "Не удалось связаться с n8n после нескольких попыток.";
    }
    case "workflow.not_configured":
      return "Заказ сохранён, но адрес webhook n8n не настроен.";
    case "rag.search.completed": {
      const count = event.detail.match(/(\d+) approved reference/i)?.[1];
      return count
        ? `Карьерный поиск нашёл фрагменты профиля: ${count}.`
        : "Поиск завершён в карьерной базе знаний.";
    }
    case "rag.search.failed":
      return "Карьерный поиск временно недоступен; локальный профиль остаётся доступен.";
    case "telegram.product_search.started":
      return "Ищу сведения о составе и возможностях Entropy Box.";
    case "telegram.product_search.completed": {
      const count = event.detail.match(/(\d+) продуктов(?:ых)? источников/i)?.[1];
      return count ? `Найдено фрагментов о продукте: ${count}.` : "Поиск завершён в базе знаний о продукте.";
    }
    case "telegram.product_search.empty":
      return "В демонстрационном каталоге не нашлось подтверждённого ответа.";
    case "telegram.product_search.failed":
      return "Каталог временно недоступен. Попробуй ещё раз позже.";
    case "telegram.product_answer.started":
      return "Готовлю ответ по найденным материалам.";
    case "telegram.product_answer.completed":
      return "Ответ подготовлен по найденным материалам.";
    case "telegram.product_answer.failed":
      return "Материалы найдены, но ответ подготовить не удалось.";
    case "agent.review.started":
      return "Psyche проверяет текстовый результат.";
    case "agent.review.completed":
      return "Psyche завершила проверку текстового результата.";
    case "agent.review.failed":
      return "Psyche не смогла завершить проверку.";
    default:
      if (event.status === "failed") return "Сервис сообщил об ошибке. Подробности доступны в Argus.";
      if (event.status === "running" || event.status === "started") return "Операция выполняется.";
      if (event.status === "completed") return "Операция завершена.";
      if (event.status === "waiting") return "Операция ожидает выполнения.";
      return "Записано событие системы.";
  }
}

/** Prevent a period at the end of the summary from becoming a double period in the button name. */
export function observabilityActivityLabel(actor: string, detail: string, action: string): string {
  const summary = detail.trim().replace(/[.!?…]+$/u, "") || "Событие системы";
  return `${actor}: ${summary}. ${action}`;
}

export function observabilityEventUrl(eventId: number): string {
  return `/argus?event_id=${encodeURIComponent(String(eventId))}#events`;
}
