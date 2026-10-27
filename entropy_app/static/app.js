function readSessionValue(key) {
  try { return window.sessionStorage.getItem(key); } catch (_) { return null; }
}

function writeSessionValue(key, value) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch (_) { /* Session restoration is optional when browser storage is unavailable. */ }
}

function readLocalValue(key) {
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}

function writeLocalValue(key, value) {
  try { window.localStorage.setItem(key, value); } catch (_) { /* The current page still uses the in-memory value. */ }
}

function storedOutputLimit(role, fallback) {
  const value = Number(readLocalValue(`entropy.outputTokens.${role}`));
  return Number.isInteger(value) && value >= 16 ? value : fallback;
}

const storedWorkspace = readSessionValue("entropy.activeWorkspace");
const MIN_OUTPUT_TOKEN_LIMIT = 300;
const rootLanding = window.location.pathname === "/" && window.location.hash === "";
const initialWorkspace = rootLanding ? "general" : storedWorkspace === "career" || storedWorkspace === "general"
  ? storedWorkspace
  : window.location.hash === "#career" ? "career" : "general";
const initialConversationId = rootLanding ? null : readSessionValue(`entropy.conversation.${initialWorkspace}`);
const state = {
  conversationId: initialConversationId,
  generalConversationId: readSessionValue("entropy.conversation.general"),
  workspace: initialWorkspace,
  conversations: [],
  lastMessageIds: new Set(),
  transcriptLoadedId: null,
  transcriptLoadingId: null,
  activeTaskId: null,
  activeTaskStatus: null,
  refreshing: false,
  rootLanding,
  newConversation: !initialConversationId,
  initialized: false,
  tokenCaps: { entropy: 1_200, veltrics: 800 },
  outputTokenLimits: { entropy: storedOutputLimit("entropy", 1_200), veltrics: storedOutputLimit("veltrics", 800) },
  tokenSettingsLoaded: false,
};
const $ = (selector) => document.querySelector(selector);
const messages = $("#messages");
const input = $("#message-input");
const welcome = $("#welcome");
$("#entropy-token-limit").value = String(state.outputTokenLimits.entropy);
$("#veltrics-token-limit").value = String(state.outputTokenLimits.veltrics);

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function addMessage(message) {
  if (state.lastMessageIds.has(message.id)) return;
  state.lastMessageIds.add(message.id);
  welcome.hidden = true;
  const user = message.speaker === "Kars";
  const article = document.createElement("article");
  article.className = `message ${user ? "user" : "agent"}${message.speaker === "Veltrics" ? " veltrics" : ""}`;
  const speaker = escapeText(message.speaker);
  const content = escapeText(message.body).replace(/\n/g, "<br>");
  article.innerHTML = `${user ? "" : `<div class="message-avatar">${speaker === "Entropy" ? "E" : speaker === "Veltrics" ? "V" : "A"}</div>`}<div><div class="message-meta">${user ? "Kars" : speaker}</div><div class="message-content">${content}</div></div>${user ? '<div class="message-avatar kars">K</div>' : ""}`;
  messages.append(article);
  welcome.hidden = true;
  $("#career-welcome").hidden = true;
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
}

function timeLabel(value) {
  if (!value) return "только что";
  return new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function statusLabel(status) {
  return ({ queued: "в очереди", planning: "планирует", delegated: "у Veltrics", completed: "готово", failed: "ошибка" })[status] || status;
}

function formatText(value) {
  return escapeText(value || "").replace(/\n/g, "<br>");
}

function persistNavigationState() {
  writeSessionValue("entropy.activeWorkspace", state.workspace);
  if (state.conversationId) writeSessionValue(`entropy.conversation.${state.workspace}`, state.conversationId);
  else if (!state.rootLanding) writeSessionValue(`entropy.conversation.${state.workspace}`, null);
  if (state.workspace === "general") {
    if (state.conversationId || !state.rootLanding) {
      writeSessionValue("entropy.conversation.general", state.conversationId);
      state.generalConversationId = state.conversationId;
    } else {
      state.generalConversationId = readSessionValue("entropy.conversation.general");
    }
  }
}

function conversationDisplayTitle(conversation) {
  const title = String(conversation.title || "").trim();
  const genericPrompt = /^(оцени|разбери|проанализируй|помоги|напиши|расскажи|что ты думаешь|вот вакансия)\b/i.test(title);
  if (title && title.length <= 42 && !genericPrompt && title !== "Поиск работы" && title !== "Разбор вакансии") return title;
  const date = new Date(conversation.created_at || conversation.updated_at);
  const stamp = Number.isNaN(date.getTime()) ? "недавно" : new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  return `${isCareerConversation(conversation.id) ? "Разбор" : "Диалог"} · ${stamp}`;
}

function syncOutputTokenLimits() {
  for (const role of ["entropy", "veltrics"]) {
    const field = $(`#${role}-token-limit`);
    const parsed = Number(field.value);
    const requested = Number.isInteger(parsed) ? parsed : state.outputTokenLimits[role];
    const minimum = Math.min(MIN_OUTPUT_TOKEN_LIMIT, state.tokenCaps[role]);
    const value = Math.min(Math.max(requested || minimum, minimum), state.tokenCaps[role]);
    state.outputTokenLimits[role] = value;
    field.value = String(value);
    $(`#${role}-token-slider`).value = String(sliderPositionForLimit(value, state.tokenCaps[role]));
    writeLocalValue(`entropy.outputTokens.${role}`, String(value));
  }
  updateTokenSummary();
}

function updateTokenSummary() {
  $("#token-summary").textContent = `${state.outputTokenLimits.entropy} / ${state.outputTokenLimits.veltrics}`;
}

function sliderPositionForLimit(value, cap) {
  const minimum = Math.min(MIN_OUTPUT_TOKEN_LIMIT, cap);
  if (cap <= minimum) return 0;
  return Math.round(Math.log(value / minimum) / Math.log(cap / minimum) * 1000);
}

function limitForSliderPosition(position, cap) {
  const minimum = Math.min(MIN_OUTPUT_TOKEN_LIMIT, cap);
  if (cap <= minimum) return cap;
  return Math.round(minimum * (cap / minimum) ** (Number(position) / 1000));
}

function renderOutputTokenSettings(caps) {
  for (const role of ["entropy", "veltrics"]) {
    const cap = Math.max(16, Number(caps[role]) || state.tokenCaps[role]);
    state.tokenCaps[role] = cap;
    const field = $(`#${role}-token-limit`);
    field.min = String(Math.min(MIN_OUTPUT_TOKEN_LIMIT, cap));
    field.max = String(cap);
    $(`#${role}-token-cap`).textContent = String(cap);
    if (!state.tokenSettingsLoaded) {
      const saved = Number(readLocalValue(`entropy.outputTokens.${role}`));
      const minimum = Math.min(MIN_OUTPUT_TOKEN_LIMIT, cap);
      const initial = Number.isInteger(saved) ? saved : cap;
      state.outputTokenLimits[role] = Math.min(Math.max(initial, minimum), cap);
      field.value = String(state.outputTokenLimits[role]);
    } else {
      const minimum = Math.min(MIN_OUTPUT_TOKEN_LIMIT, cap);
      const bounded = Math.min(Math.max(state.outputTokenLimits[role], minimum), cap);
      if (bounded !== state.outputTokenLimits[role]) {
        state.outputTokenLimits[role] = bounded;
        field.value = String(bounded);
      }
    }
    $(`#${role}-token-slider`).value = String(sliderPositionForLimit(state.outputTokenLimits[role], cap));
  }
  state.tokenSettingsLoaded = true;
  updateTokenSummary();
}

function renderConversations(conversations) {
  const list = $("#conversation-list");
  const career = state.workspace === "career";
  const visibleConversations = conversations.filter((conversation) => isCareerConversation(conversation.id) === career);
  $("#history-label").textContent = career ? "НЕДАВНИЕ РАЗБОРЫ" : "ДИАЛОГИ";
  $("#conversation-count").textContent = visibleConversations.length;
  list.setAttribute("aria-label", career ? "История разборов вакансий" : "История диалогов");
  list.innerHTML = visibleConversations.length
    ? visibleConversations.map((conversation) => `
      <button class="conversation-item ${conversation.id === state.conversationId ? "active" : ""}"
        type="button" data-conversation-id="${escapeText(conversation.id)}" title="${escapeText(conversation.title)}">
        <span class="conversation-item-title">${escapeText(conversationDisplayTitle(conversation))}</span>
        <span class="conversation-item-date">${timeLabel(conversation.updated_at)}</span>
      </button>`).join("")
    : `<div class="conversation-empty">${career ? "Сохранённые разборы появятся здесь" : "Сохранённые диалоги появятся здесь"}</div>`;
  list.querySelectorAll(".conversation-item").forEach((item) => {
    item.addEventListener("click", () => selectConversation(item.dataset.conversationId));
  });
}

function isCareerConversation(conversationId) {
  return conversationId === "entropy-career-workspace" || conversationId?.startsWith("entropy-career-");
}

async function selectConversation(conversationId) {
  if (conversationId === state.conversationId) return;
  state.rootLanding = false;
  state.workspace = isCareerConversation(conversationId) ? "career" : "general";
  state.conversationId = conversationId;
  if (state.workspace === "general") state.generalConversationId = conversationId;
  state.newConversation = false;
  state.lastMessageIds.clear();
  state.transcriptLoadedId = null;
  state.activeTaskId = null;
  state.activeTaskStatus = null;
  messages.replaceChildren();
  welcome.hidden = true;
  $("#thinking-indicator").hidden = true;
  $("#task-feed").hidden = true;
  $("#activity-list").innerHTML = '<div class="empty-activity"><span class="empty-glyph">⌁</span><b>Диалог открыт</b><span>Здесь появится ход новой задачи.</span></div>';
  $("#activity-count").textContent = "00";
  renderWorkspace();
  renderConversations(state.conversations);
  await loadConversationMessages(conversationId);
  await refresh();
}

function renderWorkspace() {
  const career = state.workspace === "career";
  persistNavigationState();
  if (!state.rootLanding) window.history.replaceState(null, "", career ? "#career" : "#chat");
  $("#app-shell").classList.toggle("workspace-career", career);
  document.querySelectorAll('.main-nav a[href="#chat"], .main-nav a[href="#career"]').forEach((item) => {
    const active = item.getAttribute("href") === (career ? "#career" : "#chat");
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelectorAll(".compact-workspace-switcher [data-workspace]").forEach((item) => {
    item.setAttribute("aria-selected", String(item.dataset.workspace === state.workspace));
  });
  $("#new-chat").hidden = false;
  $(".new-chat-label").textContent = career ? "Новый разбор" : "Новый диалог";
  $("#mobile-new-chat").setAttribute("aria-label", career ? "Новый разбор" : "Новый диалог");
  $("#mobile-new-chat").title = career ? "Новый разбор" : "Новый диалог";
  $("#workspace-section").textContent = career ? "Модули" : "Диалоги";
  $("#workspace-section").hidden = false;
  $(".breadcrumb b").textContent = career
    ? "Поиск работы"
    : state.newConversation ? "Новый диалог" : conversationDisplayTitle(state.conversations.find((item) => item.id === state.conversationId) || { title: "Диалог" });
  input.placeholder = career ? "Вставь описание вакансии или задай вопрос…" : "Напиши Entropy, что нужно сделать…";
  input.maxLength = career ? 24_000 : 8_000;
  $("#workspace-context").textContent = "Рабочее пространство";
  const hasMessages = messages.childElementCount > 0;
  welcome.hidden = career || hasMessages;
  $("#career-welcome").hidden = !career || hasMessages;
  renderConversations(state.conversations);
  const mainArea = $(".main-area");
  mainArea.classList.remove("workspace-entering");
  void mainArea.offsetWidth;
  mainArea.classList.add("workspace-entering");
  window.setTimeout(() => mainArea.classList.remove("workspace-entering"), 520);
}

async function selectWorkspace(workspace) {
  if (workspace === state.workspace) return;
  state.rootLanding = false;
  if (state.workspace === "general") state.generalConversationId = state.conversationId;
  state.workspace = workspace;
  window.history.replaceState(null, "", workspace === "career" ? "#career" : "#chat");
  state.conversationId = workspace === "career"
    ? readSessionValue("entropy.conversation.career")
    : state.generalConversationId || readSessionValue("entropy.conversation.general");
  state.newConversation = workspace === "general" && !state.conversationId;
  state.lastMessageIds.clear();
  state.transcriptLoadedId = null;
  state.transcriptLoadingId = null;
  state.activeTaskId = null;
  state.activeTaskStatus = null;
  messages.replaceChildren();
  $("#thinking-indicator").hidden = true;
  $("#task-feed").hidden = true;
  $("#activity-list").innerHTML = '<div class="empty-activity"><span class="empty-glyph">⌁</span><b>Пока тихо</b><span>Отправь сообщение — Entropy продолжит этот раздел.</span></div>';
  $("#activity-count").textContent = "00";
  renderWorkspace();
  await refresh();
  input.focus();
}

async function loadConversationMessages(conversationId) {
  if (state.transcriptLoadedId === conversationId || state.transcriptLoadingId === conversationId) return;
  state.transcriptLoadingId = conversationId;
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`);
    if (!response.ok) throw new Error("Не удалось загрузить диалог.");
    const data = await response.json();
    if (state.conversationId === conversationId) {
      data.messages.forEach(addMessage);
      state.transcriptLoadedId = conversationId;
    }
  } catch (error) {
    if (state.conversationId === conversationId) {
      addMessage({ id: `error-${Date.now()}`, speaker: "Entropy", body: error.message });
    }
  } finally {
    if (state.transcriptLoadingId === conversationId) state.transcriptLoadingId = null;
  }
}

function renderMode(data) {
  const live = data.mode === "openai-live";
  $("#mode-pill").innerHTML = `<i></i> ${live ? escapeText(data.model || "OPENAI API").toUpperCase() : "DEMO MODE"}`;
  $("#side-mode-title").textContent = live ? "OpenAI API подключён" : "Локальная демо";
  $("#side-mode-subtitle").textContent = live ? `${data.model} · usage billed by API` : "данные остаются на этом ПК";
  $("#system-mode").textContent = live ? "API · LIVE" : "ЛОКАЛЬНО";
  renderOutputTokenSettings(data.output_token_caps || {});
  $("#mode-disclaimer").innerHTML = live
    ? '<span class="sparkle">✧</span> Сообщения и локальная память Entropy отправляются выбранной модели через API и расходуют usage. Veltrics пока не читает и не меняет файлы проекта.'
    : '<span class="sparkle">✧</span> Демо-режим: ответы синтетические, модель и инструменты пока не подключены.';
}

function renderTasks(tasks) {
  $("#task-count").textContent = tasks.length;
  const list = $("#task-list");
  if (!tasks.length) {
    list.innerHTML = '<div class="empty-tasks">Задачи появятся здесь</div>';
    return;
  }
  list.innerHTML = tasks.map((task) => `<div class="task-card" data-task-id="${escapeText(task.id)}"><div class="task-card-top"><span class="task-card-title">${escapeText(task.request)}</span><span class="task-card-status ${escapeText(task.status)}">${escapeText(statusLabel(task.status))}</span></div><div class="task-card-time">${timeLabel(task.created_at)}</div></div>`).join("");
  list.querySelectorAll(".task-card").forEach((card) => card.addEventListener("click", () => {
    loadTask(card.dataset.taskId);
    openTaskDetails(card.dataset.taskId);
  }));
}

async function loadTask(taskId) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) return;
  const { task, events } = await response.json();
  state.activeTaskId = task.id;
  state.activeTaskStatus = task.status;
  const feed = $("#task-feed");
  feed.hidden = false;
  feed.innerHTML = `<div class="task-feed-copy"><div class="task-feed-title">Entropy передал задачу Veltrics <span class="task-status">${escapeText(statusLabel(task.status))}</span></div><div class="task-feed-request">${escapeText(task.request)}</div></div><button class="task-open-button" type="button">Открыть задачу ↗</button>`;
  feed.querySelector(".task-open-button").addEventListener("click", () => openTaskDetails(task.id));
  const activity = $("#activity-list");
  $("#activity-count").textContent = String(events.length).padStart(2, "0");
  activity.innerHTML = events.map((event) => `<div class="activity-item"><span class="activity-icon">${event.actor === "Veltrics" ? "V" : event.actor === "Entropy" ? "E" : "↗"}</span><div class="activity-copy"><b>${escapeText(event.actor)}</b>${escapeText(event.detail)}<time>${timeLabel(event.created_at)}</time></div></div>`).join("");
}

async function openTaskDetails(taskId) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) return;
  const { task, events } = await response.json();
  let result = {};
  try { result = task.result ? JSON.parse(task.result) : {}; } catch (_) { result = {}; }
  const plan = result.plan || {};
  const developerResult = result.developer_result || "Решение появится здесь после выполнения задачи.";
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  $("#task-dialog-title").textContent = "Задача Veltrics";
  $("#task-dialog-content").innerHTML = `
    <div class="detail-meta"><span class="detail-status">${escapeText(statusLabel(task.status))}</span><span>${timeLabel(task.created_at)}</span></div>
    <section class="detail-block"><h3>Запрос Kars</h3><p>${formatText(task.request)}</p></section>
    <section class="detail-block"><h3>План Entropy</h3><p>${formatText(plan.summary || "План не сохранён.")}</p>${steps.length ? `<ol>${steps.map((step) => `<li>${escapeText(step)}</li>`).join("")}</ol>` : ""}</section>
    <section class="detail-block solution"><h3>Решение Veltrics</h3><p>${formatText(developerResult)}</p></section>
    <section class="detail-block"><h3>Ход работы</h3><div class="detail-events">${events.map((event) => `<div class="detail-event"><b>${escapeText(event.actor)} · ${timeLabel(event.created_at)}</b><span>${escapeText(event.detail)}</span></div>`).join("")}</div></section>`;
  $("#task-dialog").showModal();
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.conversations = data.conversations;
    renderMode(data);
    renderTasks(data.tasks);
    if (state.conversationId && !state.sending && !data.conversations.some((item) => item.id === state.conversationId)) {
      state.conversationId = null;
      state.newConversation = true;
      state.lastMessageIds.clear();
      state.transcriptLoadedId = null;
      state.activeTaskId = null;
      state.activeTaskStatus = null;
      messages.replaceChildren();
      persistNavigationState();
      renderWorkspace();
    }
    const generalConversations = data.conversations.filter((conversation) => !isCareerConversation(conversation.id));
    if (!state.conversationId && !state.newConversation && state.workspace === "general" && generalConversations.length) {
      state.conversationId = generalConversations[0].id;
      state.generalConversationId = state.conversationId;
    }
    const current = state.conversationId;
    if (!state.initialized) {
      renderWorkspace();
      state.initialized = true;
    }
    renderConversations(data.conversations);
    const conversation = data.conversations.find((item) => item.id === current);
    if (state.workspace === "general") $(".breadcrumb b").textContent = conversation ? conversationDisplayTitle(conversation) : (state.newConversation ? "Новый диалог" : "Диалог");
    if (current && state.transcriptLoadedId !== current) await loadConversationMessages(current);
    if (!messages.childElementCount) {
      welcome.hidden = state.workspace === "career";
      $("#career-welcome").hidden = state.workspace !== "career";
    }
    const selected = current ? data.messages.filter((message) => message.conversation_id === current) : [];
    selected.forEach(addMessage);
    const turns = (data.turns || []).filter((turn) => turn.conversation_id === current).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const latestTurn = turns[0];
    const indicator = $("#thinking-indicator");
    indicator.hidden = !latestTurn || !["thinking", "delegating"].includes(latestTurn.status);
    indicator.textContent = latestTurn?.status === "delegating" ? "Entropy передал задачу Veltrics…" : "Entropy думает…";
    if (latestTurn?.task_id && latestTurn.task_id !== state.activeTaskId) {
      state.activeTaskId = latestTurn.task_id;
      state.activeTaskStatus = null;
    }
    if (state.activeTaskId && (state.activeTaskStatus === null || ["queued", "planning", "delegated"].includes(state.activeTaskStatus))) {
      await loadTask(state.activeTaskId);
    }
  } catch (_) {
    // The local service may be restarting; the next poll retries.
  } finally {
    state.refreshing = false;
  }
}

async function sendMessage(value) {
  const text = value.trim();
  if (!text) return;
  $("#send-button").disabled = true;
  state.sending = true;
  state.rootLanding = false;
  syncOutputTokenLimits();
  input.value = "";
  input.style.height = "auto";
  try {
    if (state.workspace === "career" && !state.conversationId) {
      state.conversationId = `entropy-career-${crypto.randomUUID()}`;
    }
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        conversation_id: state.conversationId,
        workspace: state.workspace,
        output_token_limits: state.outputTokenLimits,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось отправить задачу.");
    state.conversationId = data.conversation_id;
    if (state.workspace === "general") window.history.replaceState(null, "", "#chat");
    if (state.workspace === "general") state.generalConversationId = state.conversationId;
    state.newConversation = false;
    persistNavigationState();
    $(".breadcrumb b").textContent = conversationDisplayTitle({ id: state.conversationId, title: text, created_at: new Date().toISOString() });
    state.activeTaskId = null;
    state.activeTaskStatus = null;
    $("#task-feed").hidden = true;
    $("#activity-list").innerHTML = '<div class="empty-activity"><span class="empty-glyph">⌁</span><b>Пока тихо</b><span>Entropy разбирает сообщение.</span></div>';
    $("#activity-count").textContent = "00";
    $("#thinking-indicator").hidden = false;
    $("#thinking-indicator").textContent = "Entropy думает…";
    await refresh();
  } catch (error) {
    addMessage({ id: `error-${Date.now()}`, speaker: "Entropy", body: error.message });
  } finally {
    state.sending = false;
    $("#send-button").disabled = false;
    input.focus();
  }
}

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(input.value);
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 170)}px`;
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage(input.value);
  }
});
document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));
$("#entropy-token-limit").addEventListener("change", syncOutputTokenLimits);
$("#veltrics-token-limit").addEventListener("change", syncOutputTokenLimits);
for (const role of ["entropy", "veltrics"]) {
  $(`#${role}-token-slider`).addEventListener("input", (event) => {
    $(`#${role}-token-limit`).value = String(limitForSliderPosition(event.target.value, state.tokenCaps[role]));
    syncOutputTokenLimits();
  });
}
$("#new-chat").addEventListener("click", () => {
  state.rootLanding = false;
  if (state.workspace === "career") {
    state.conversationId = null;
    state.newConversation = true;
    state.lastMessageIds.clear();
    state.transcriptLoadedId = null;
    state.activeTaskId = null;
    state.activeTaskStatus = null;
    messages.replaceChildren();
    $("#thinking-indicator").hidden = true;
    $("#task-feed").hidden = true;
    $("#career-welcome").hidden = false;
    $("#activity-list").innerHTML = '<div class="empty-activity"><span class="empty-glyph">⌁</span><b>Новый разбор</b><span>Вставь описание вакансии, чтобы начать.</span></div>';
    $("#activity-count").textContent = "00";
    renderWorkspace();
    input.focus();
    return;
  }
  state.conversationId = null;
  state.generalConversationId = null;
  state.newConversation = true;
  state.lastMessageIds.clear();
  state.activeTaskId = null;
  state.activeTaskStatus = null;
  state.transcriptLoadedId = null;
  renderConversations(state.conversations);
  $(".breadcrumb b").textContent = "Новый диалог";
  $("#thinking-indicator").hidden = true;
  messages.replaceChildren();
  welcome.hidden = false;
  $("#task-feed").hidden = true;
  renderWorkspace();
  $("#activity-list").innerHTML = '<div class="empty-activity"><span class="empty-glyph">⌁</span><b>Пока тихо</b><span>Отправь задачу — покажу,<br>как агенты двигают её вперёд.</span></div>';
  $("#activity-count").textContent = "00";
  input.focus();
});
$("#mobile-new-chat").addEventListener("click", () => $("#new-chat").click());
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#new-chat").click();
  }
});
document.querySelector('a[href="#chat"]').addEventListener("click", (event) => {
  event.preventDefault();
  selectWorkspace("general");
});
document.querySelector('a[href="#career"]').addEventListener("click", (event) => {
  event.preventDefault();
  selectWorkspace("career");
});
document.querySelectorAll(".compact-workspace-switcher [data-workspace]").forEach((button) => {
  button.addEventListener("click", () => selectWorkspace(button.dataset.workspace));
});
$("#clear-tasks").addEventListener("click", refresh);
document.querySelector('.nav-item[href="#tasks"]').addEventListener("click", (event) => {
  event.preventDefault();
  const latestTask = document.querySelector("#task-list .task-card");
  if (latestTask) {
    loadTask(latestTask.dataset.taskId);
    openTaskDetails(latestTask.dataset.taskId);
  }
});
$("#close-task-dialog").addEventListener("click", () => $("#task-dialog").close());
$("#task-dialog").addEventListener("click", (event) => {
  if (event.target === $("#task-dialog")) $("#task-dialog").close();
});

refresh();
window.setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
