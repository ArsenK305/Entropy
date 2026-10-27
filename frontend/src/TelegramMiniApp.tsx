import { useEffect, useState } from "react";
import { api, type MiniAppCatalog, type MiniAppOrderResult, type MiniAppProduct } from "./api";
import "./telegram-miniapp.css";

type TelegramWebApp = { initData: string; ready: () => void; expand: () => void; setHeaderColor?: (color: string) => void; setBackgroundColor?: (color: string) => void };
declare global { interface Window { Telegram?: { WebApp?: TelegramWebApp } } }

export default function TelegramMiniApp() {
  const [catalog, setCatalog] = useState<MiniAppCatalog | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<MiniAppProduct | null>(null);
  const [order, setOrder] = useState<MiniAppOrderResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [orderError, setOrderError] = useState("");
  const webApp = window.Telegram?.WebApp;
  const inTelegram = Boolean(webApp?.initData);
  const previewRequested = new URLSearchParams(window.location.search).get("preview") === "1";
  const previewAllowed = Boolean(catalog?.preview_enabled && previewRequested && !inTelegram);

  useEffect(() => {
    document.title = "Entropy Learning · Telegram";
    webApp?.setHeaderColor?.("#100e0e");
    webApp?.setBackgroundColor?.("#100e0e");
    webApp?.expand();
    webApp?.ready();
    void api.miniappCatalog().then(setCatalog).catch((error: Error) => {
      setLoadError(error.message);
    });
  }, []);

  const createOrder = async (product: MiniAppProduct) => {
    setSelected(product);
    setOrder(null);
    setOrderError("");
    setSubmitting(true);
    try {
      setOrder(await api.createMiniAppOrder(product.id, webApp?.initData || ""));
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "Не удалось создать тестовый заказ.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!inTelegram && !previewAllowed) return <main className="tg-store-shell tg-store-gate">
    <div className="tg-store-mark">E<span>.</span></div><div className="tg-store-kicker">ENTROPY LEARNING · TELEGRAM MINI APP</div>
    <h1>Витрина открывается<br/><em>в Telegram.</em></h1>
    <p>Этот каталог предназначен для Mini App бота Entropy. Он не является страницей основного сайта.</p>
    {loadError && <div className="tg-store-error">API недоступен: {loadError}</div>}
    {catalog?.preview_enabled && <a className="tg-preview-link" href="/miniapp?preview=1">Открыть локальный preview ↗</a>}
    <span className="tg-store-demo-stamp">ПРЕДПРОСМОТР · БЕЗ ОПЛАТЫ</span>
  </main>;

  return <main className="tg-store-shell">
    <header className="tg-store-header"><div className="tg-store-brand"><span className="tg-store-mark">E<span>.</span></span><span>ENTROPY <small>LEARNING</small></span></div><span className="tg-store-header-status"><i/> {inTelegram ? "TELEGRAM MINI APP" : "LOCAL PREVIEW"}</span></header>
    <section className="tg-store-hero"><div className="tg-store-kicker">ПРАКТИЧЕСКАЯ ЛАБОРАТОРИЯ · КОЛЛЕКЦИЯ 001</div><h1>Знания,<br/><em>которые работают.</em></h1><p>Короткие практические маршруты по Python, AI и системам, которые соединяют идеи с реальным кодом.</p><div className="tg-store-hero-foot"><span>3 ПОЛЕВЫХ УРОКА</span><span>DEMO EDITION · БЕЗ ОПЛАТЫ</span></div></section>
    <section className="tg-store-products"><div className="tg-store-section-head"><div><span className="tg-store-kicker">ВЫБЕРИ СВОЙ МАРШРУТ</span><h2>Каталог</h2></div><span className="tg-store-count">01 — 03</span></div>
      {loadError && <div className="tg-store-error">Не удалось загрузить каталог: {loadError}</div>}
      {!catalog && !loadError && <div className="tg-store-loading">Подключаю каталог<span>···</span></div>}
      <div className="tg-product-list">{catalog?.products.map((product, index) => <article className="tg-product" key={product.id}>
        <div className={`tg-product-art cover-${product.cover}`}><span>{String(index + 1).padStart(2, "0")} / FIELD NOTE</span><b>{product.cover === "api" ? "⌘" : product.cover === "rag" ? "✳" : "⌁"}</b><small>ENTROPY SYSTEMS</small></div>
        <div className="tg-product-copy"><div className="tg-product-tag">{product.tag}</div><h3>{product.title}</h3><p>{product.description}</p><button type="button" disabled={submitting || (!inTelegram && !previewAllowed) || (inTelegram && !catalog.telegram_configured)} onClick={() => void createOrder(product)}>{submitting && selected?.id === product.id ? "СОХРАНЯЮ…" : "СОЗДАТЬ ТЕСТОВЫЙ ЗАКАЗ"}<span>↗</span></button></div>
      </article>)}</div>
      {catalog && inTelegram && !catalog.telegram_configured && <div className="tg-store-note">Для проверки данных запуска добавь TELEGRAM_BOT_TOKEN в окружение бэкенда.</div>}
      {catalog && previewAllowed && <div className="tg-store-note">Локальный режим: заказ сохранится без Telegram-пользователя. Никаких платежей нет.</div>}
    </section>
    <footer className="tg-store-footer"><span>ENTROPY LEARNING SYSTEM</span><span>DEMO · STARS И ДОСТАВКА НЕ ПОДКЛЮЧЕНЫ</span></footer>
    {(order || orderError) && <div className="tg-order-overlay" role="dialog" aria-modal="true" aria-label="Статус заказа"><div className="tg-order-card"><button className="tg-order-close" type="button" onClick={() => { setOrder(null); setOrderError(""); }} aria-label="Закрыть">×</button>{order ? <><div className="tg-order-check">✓</div><span className="tg-store-kicker">ЗАПИСЬ СОХРАНЕНА</span><h2>Тестовый заказ создан.</h2><p>{order.order.product_name}</p><div className="tg-order-state">{order.workflow.status === "accepted" ? "Webhook n8n принял событие." : order.workflow.status === "unavailable" || order.workflow.status === "rejected" ? "Заказ записан; передача в n8n не удалась." : "Заказ записан. n8n пока не подключён."}</div><small>Оплата не выполнялась. Событие появится в Argus.</small></> : <><div className="tg-order-error-mark">!</div><span className="tg-store-kicker">ЗАКАЗ НЕ СОЗДАН</span><h2>Не удалось оформить.</h2><p>{orderError}</p></>}<button className="tg-order-done" type="button" onClick={() => { setOrder(null); setOrderError(""); }}>Вернуться в каталог</button></div></div>}
  </main>;
}
