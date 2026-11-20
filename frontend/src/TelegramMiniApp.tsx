import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MiniAppCatalog, type MiniAppOrderResult, type MiniAppProduct } from "./api";
import "./telegram-miniapp.css";

const EXPECTED_CATALOG_IDS = ["entropy-box", "career-module-candidate", "knowledge-module-candidate"];
const ORDER_REQUEST_ID_PREFIX = "entropy:miniapp-order-request:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pendingOrderRequestId(productId: string, memory: Map<string, string>): string {
  const cached = memory.get(productId);
  if (cached) return cached;

  const storageKey = `${ORDER_REQUEST_ID_PREFIX}${productId}`;
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored && UUID_PATTERN.test(stored)) {
      memory.set(productId, stored);
      return stored;
    }
  } catch {
    // Keep retries safe in memory when browser storage is unavailable.
  }

  const requestId = crypto.randomUUID();
  memory.set(productId, requestId);
  try {
    window.sessionStorage.setItem(storageKey, requestId);
  } catch {
    // The current page can still reuse the in-memory request ID.
  }
  return requestId;
}

function clearPendingOrderRequestId(productId: string, requestId: string, memory: Map<string, string>): void {
  memory.delete(productId);
  const storageKey = `${ORDER_REQUEST_ID_PREFIX}${productId}`;
  try {
    if (window.sessionStorage.getItem(storageKey) === requestId) {
      window.sessionStorage.removeItem(storageKey);
    }
  } catch {
    // The completed request is already clear from memory.
  }
}

type TelegramWebApp = { initData: string; ready: () => void; expand: () => void; setHeaderColor?: (color: string) => void; setBackgroundColor?: (color: string) => void };
declare global { interface Window { Telegram?: { WebApp?: TelegramWebApp } } }

export default function TelegramMiniApp() {
  const [catalog, setCatalog] = useState<MiniAppCatalog | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<MiniAppProduct | null>(null);
  const [order, setOrder] = useState<MiniAppOrderResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [orderError, setOrderError] = useState("");
  const orderInFlight = useRef(false);
  const pendingOrderRequestIds = useRef(new Map<string, string>());
  const orderDialogRef = useRef<HTMLDivElement>(null);
  const orderTriggerRef = useRef<HTMLButtonElement>(null);
  const webApp = window.Telegram?.WebApp;
  const inTelegram = Boolean(webApp?.initData);
  const previewRequested = new URLSearchParams(window.location.search).get("preview") === "1";
  const localPreviewRequested = Boolean(previewRequested && !inTelegram);
  const previewAllowed = Boolean(catalog?.preview_enabled && localPreviewRequested);

  useEffect(() => {
    document.documentElement.classList.add("tg-miniapp-page");
    document.title = "Entropy Box · Telegram";
    webApp?.setHeaderColor?.("#100e0e");
    webApp?.setBackgroundColor?.("#100e0e");
    webApp?.expand();
    webApp?.ready();
    void api.miniappCatalog().then((result) => {
      const productIds = Array.isArray(result.products) ? result.products.map((product) => product.id) : [];
      if (productIds.length !== EXPECTED_CATALOG_IDS.length || productIds.some((id, index) => id !== EXPECTED_CATALOG_IDS[index])) {
        throw new Error("Каталог backend устарел. Перезапусти Entropy backend и обнови страницу.");
      }
      setCatalog(result);
    }).catch((error: Error) => {
      setLoadError(error.message);
    });
    return () => document.documentElement.classList.remove("tg-miniapp-page");
  }, []);

  const createOrder = async (product: MiniAppProduct, trigger: HTMLButtonElement) => {
    if (orderInFlight.current) return;
    orderInFlight.current = true;
    orderTriggerRef.current = trigger;
    setSelected(product);
    setOrder(null);
    setOrderError("");
    setSubmitting(true);
    const requestId = pendingOrderRequestId(product.id, pendingOrderRequestIds.current);
    try {
      const result = await api.createMiniAppOrder(product.id, webApp?.initData || "", requestId);
      clearPendingOrderRequestId(product.id, requestId, pendingOrderRequestIds.current);
      setOrder(result);
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "Не удалось создать тестовый заказ.");
    } finally {
      orderInFlight.current = false;
      setSubmitting(false);
    }
  };

  const closeOrderDialog = useCallback(() => {
    setOrder(null);
    setOrderError("");
    window.requestAnimationFrame(() => {
      if (orderTriggerRef.current?.isConnected) orderTriggerRef.current.focus();
    });
  }, []);

  useEffect(() => {
    if (!order && !orderError) return;
    const dialog = orderDialogRef.current;
    if (!dialog) return;

    const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOrderDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [order, orderError, closeOrderDialog]);

  if (!inTelegram && !localPreviewRequested) return <main className="tg-store-shell tg-store-gate">
    <div className="tg-store-mark">E<span>.</span></div><div className="tg-store-kicker">ENTROPY PRODUCT CONCEPT · TELEGRAM MINI APP</div>
    <h1>Витрина открывается<br/><em>в Telegram.</em></h1>
    <p>Этот каталог предназначен для Mini App бота Entropy. Он не является страницей основного сайта.</p>
    {loadError && <div className="tg-store-error">API недоступен: {loadError}</div>}
    {catalog?.preview_enabled && <a className="tg-preview-link" href="/miniapp?preview=1">Открыть локальный preview ↗</a>}
    <span className="tg-store-demo-stamp">ПРЕДПРОСМОТР · БЕЗ ОПЛАТЫ</span>
  </main>;

  return <main className="tg-store-shell">
    <header className="tg-store-header"><div className="tg-store-brand"><span className="tg-store-mark">E<span>.</span></span><span>ENTROPY <small>PRODUCT CONCEPT</small></span></div><span className="tg-store-header-status"><i/> {inTelegram ? "TELEGRAM MINI APP" : "LOCAL PREVIEW"}</span></header>
    <section className="tg-store-hero"><div className="tg-store-kicker">КОНЦЕПЦИЯ ПРОДУКТА · DEMO</div><h1>Entropy<br/><em>Box</em></h1><p>Базовая концепция Entropy с возможными отдельными модулями. Формат, состав и условия пока не утверждены.</p><div className="tg-store-hero-foot"><span>ЧЕРНОВАЯ КОНЦЕПЦИЯ</span><span>ЗАКАЗ · БЕЗ ОПЛАТЫ</span></div></section>
    <section className="tg-store-products"><div className="tg-store-section-head"><div><span className="tg-store-kicker">1 БАЗОВАЯ ИДЕЯ · 2 КАНДИДАТА</span><h2>Концепт продукта</h2></div><span className="tg-store-count">1 + 2</span></div>
      {loadError && <div className="tg-store-error">Не удалось загрузить каталог: {loadError}</div>}
      {!catalog && !loadError && <div className="tg-store-loading">Подключаю каталог<span>···</span></div>}
      <div className="tg-product-list">{catalog?.products.map((product, index) => <article className="tg-product" key={product.id}>
        <div className={`tg-product-art cover-${product.cover}`}><span>{String(index + 1).padStart(2, "0")} / MOCK</span><b>{product.cover === "box" ? "◈" : product.cover === "career" ? "⌕" : "✳"}</b><small>ENTROPY SYSTEMS</small></div>
        <div className="tg-product-copy"><div className="tg-product-tag">{product.tag}</div><h3>{product.title}</h3><p>{product.description}</p><button type="button" disabled={submitting || (!inTelegram && !previewAllowed) || (inTelegram && !catalog.telegram_configured)} onClick={(event) => void createOrder(product, event.currentTarget)}>{submitting && selected?.id === product.id ? "СОХРАНЯЮ…" : "СОЗДАТЬ ТЕСТОВЫЙ ЗАКАЗ"}<span>↗</span></button></div>
      </article>)}</div>
      <div className="tg-store-note">Все позиции — mock. Комплектация, формат Entropy Box, цены и доступность не утверждены. Кнопки создают тестовые записи без оплаты.</div>
      {catalog && localPreviewRequested && !catalog.preview_enabled && <div className="tg-store-note">Просмотр открыт, но создание тестового заказа выключено настройкой backend.</div>}
      {catalog && inTelegram && !catalog.telegram_configured && <div className="tg-store-note">Для проверки данных запуска добавь TELEGRAM_BOT_TOKEN в окружение бэкенда.</div>}
      {catalog && previewAllowed && <div className="tg-store-note">Локальный режим: заказ сохранится без Telegram-пользователя. Никаких платежей нет.</div>}
    </section>
    <footer className="tg-store-footer"><span>ENTROPY PRODUCT CONCEPT</span><span>DEMO · ОПЛАТА И ВЫДАЧА НЕ ПОДКЛЮЧЕНЫ</span></footer>
    {(order || orderError) && <div className="tg-order-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeOrderDialog(); }}><div className="tg-order-card" ref={orderDialogRef} role="dialog" aria-modal="true" aria-labelledby="tg-order-title" aria-describedby="tg-order-description" tabIndex={-1}><button className="tg-order-close" type="button" onClick={closeOrderDialog} aria-label="Закрыть">×</button>{order ? <><div className="tg-order-check">✓</div><span className="tg-store-kicker">{order.replayed ? "ПОВТОР ЗАПРОСА" : "ЗАПИСЬ СОХРАНЕНА"}</span><h2 id="tg-order-title">{order.replayed ? "Тестовый заказ уже создан." : "Тестовый заказ создан."}</h2><p id="tg-order-description">{order.order.product_name}</p><div className="tg-order-state">{order.workflow.message ?? (order.workflow.status === "accepted" ? "Webhook n8n принял событие." : order.workflow.status === "queued" ? "Заказ сохранён; передача в n8n поставлена в очередь." : order.workflow.status === "unavailable" || order.workflow.status === "rejected" ? "Заказ записан; передача в n8n не удалась." : "Заказ записан. n8n пока не подключён.")}</div><small>Оплата не выполнялась. Событие появится в Argus.</small></> : <><div className="tg-order-error-mark">!</div><span className="tg-store-kicker">ЗАКАЗ НЕ СОЗДАН</span><h2 id="tg-order-title">Не удалось оформить.</h2><p id="tg-order-description">{orderError}</p></>}<button className="tg-order-done" type="button" onClick={closeOrderDialog}>Вернуться в каталог</button></div></div>}
  </main>;
}
