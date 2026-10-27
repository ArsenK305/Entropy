"""Small local Entropy prototype."""

from __future__ import annotations

import json
import hmac
import ipaddress
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sqlalchemy.exc import SQLAlchemyError

from entropy_app.agents import MIN_OUTPUT_TOKEN_LIMIT, build_agent_provider
from entropy_app.database import create_database_engine
from entropy_app.miniapp import CATALOG, PRODUCTS_BY_ID, miniapp_preview_enabled, telegram_user_id
from entropy_app import n8n
from entropy_app.store import Store


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "entropy_app" / "static"
BUILT_FRONTEND = STATIC / "dist"
CAREER_CONVERSATION_ID = "entropy-career-workspace"
DATABASE_ENGINE = create_database_engine()
STORE = Store(DATABASE_ENGINE)
AGENTS = build_agent_provider()
WORKERS = ThreadPoolExecutor(max_workers=3, thread_name_prefix="entropy-task")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def initial_conversation_title(request_text: str, workspace: str) -> str:
    """Create a readable initial title until Entropy returns a concise topic label."""
    if workspace == "career":
        in_vacancy = False
        for raw_line in request_text.splitlines():
            line = raw_line.strip().strip("#* `")
            lowered = line.lower()
            if lowered.startswith("текст вакансии"):
                in_vacancy = True
                continue
            if not line:
                continue
            if not in_vacancy and lowered.startswith(("оцени", "в ответе", "мой профиль", "ничего не отправляй", "не выдумывай")):
                continue
            if lowered in {"кто нам нужен", "что предстоит делать", "что мы предлагаем", "условия", "описание вакансии"}:
                continue
            for separator in (" — ", " – ", " - "):
                if separator in line:
                    line = line.split(separator, 1)[0].strip()
                    break
            line = " ".join(line.split())[:56].rstrip(" .,:;—-")
            if line:
                return line
        return "Разбор вакансии"

    first_line = next((" ".join(line.split()) for line in request_text.splitlines() if line.strip()), "Новый диалог")
    first_line = first_line.removeprefix("#").strip(" *`\t")
    sentence = first_line.split(". ", 1)[0].strip()
    return sentence[:56].rstrip(" .,:;—-") or "Новый диалог"


def load_project_context(workspace: str = "general") -> str:
    """Load project guidance plus the local continuity memory for the model."""
    reference_files = (
        ROOT / "AGENTS.md",
        ROOT / "docs" / "CHARTER.md",
        ROOT / "docs" / "MVP.md",
    )
    sections = []
    for path in reference_files:
        try:
            content = path.read_text(encoding="utf-8")[:8_000]
        except OSError:
            continue
        sections.append(f"## Reference: {path.relative_to(ROOT).as_posix()}\n{content}")
    learning_path = ROOT / "LEARNING.md"
    try:
        learning_snapshot = learning_path.read_text(encoding="utf-8").split("\n## Дорожная карта", 1)[0]
    except OSError:
        learning_snapshot = ""
    if learning_snapshot:
        sections.append(f"## Learning state: LEARNING.md\n{learning_snapshot[:4_000]}")
    memory_path = ROOT / "data" / "entropy_memory.md"
    try:
        user_memory = memory_path.read_text(encoding="utf-8")[:8_000]
    except OSError:
        user_memory = ""
    if user_memory:
        sections.append(f"## User memory (private local file)\n{user_memory}")
    if workspace == "career":
        profile_path = ROOT / "data" / "career_profile.md"
        try:
            career_profile = profile_path.read_text(encoding="utf-8")[:12_000]
        except OSError:
            career_profile = ""
        if career_profile:
            sections.append(f"## Career profile (private local file)\n{career_profile}")
    return "\n\n---\n\n".join(sections)


def run_turn(
    turn_id: str,
    conversation_id: str,
    request_text: str,
    workspace: str = "general",
    entropy_output_tokens: int | None = None,
    veltrics_output_tokens: int | None = None,
) -> None:
    """Let Entropy answer directly or delegate a technical task to Veltrics."""
    task_id = None
    try:
        project_context = load_project_context(workspace)
        conversation_context = STORE.list_conversation_context(conversation_id, turn_id)
        decision = AGENTS.route_message(
            request_text,
            project_context,
            conversation_context,
            workspace=workspace,
            output_token_limit=entropy_output_tokens,
        )
        title = decision.get("conversation_title")
        if isinstance(title, str) and title.strip():
            STORE.rename_conversation(conversation_id, title)
        if workspace == "career":
            decision["delegate_to_veltrics"] = False
        reply = str(decision.get("reply", "Понял тебя.")).strip()
        if not decision.get("delegate_to_veltrics"):
            STORE.add_message(conversation_id, "Entropy", reply, turn_id=turn_id)
            STORE.set_turn_status(turn_id, "completed")
            return

        task_id = str(uuid.uuid4())
        STORE.create_task(task_id, conversation_id, request_text)
        STORE.set_turn_status(turn_id, "delegating", task_id=task_id)
        STORE.add_event(task_id, "Redshift", "Задача поставлена в очередь.")
        STORE.set_task_status(task_id, "planning")
        plan = {
            "summary": decision.get("summary", reply),
            "goal": decision.get("goal", request_text),
            "steps": decision.get("steps", []),
            "developer_task": decision.get("developer_task", request_text),
        }
        STORE.add_event(task_id, "Entropy", f"План сформирован через {getattr(AGENTS, 'model', 'демо')}.")
        STORE.add_message(conversation_id, "Entropy", reply, task_id, turn_id)
        STORE.add_event(task_id, "Entropy", "План готов. Передаю подзадачу Veltrics.")
        STORE.set_task_status(task_id, "running")
        if AGENTS.mode == "openai-live":
            veltrics_model = getattr(AGENTS, "veltrics_model", AGENTS.model)
            detail = f"Отправляю подзадачу модели {veltrics_model}; доступа к файлам пока нет."
        else:
            detail = "Демо-режим: запускаю синтетический handoff без вызова модели."
        STORE.add_event(task_id, "Veltrics", detail)
        result = AGENTS.do_developer_task(
            request_text,
            plan,
            project_context,
            conversation_context,
            output_token_limit=veltrics_output_tokens,
        )
        STORE.add_message(conversation_id, "Veltrics", result, task_id, turn_id)
        STORE.add_event(task_id, "Veltrics", "Ответ модели готов; файлы не читались и не менялись." if AGENTS.mode == "openai-live" else "Синтетический демо-результат готов; модель не вызывалась.")
        final = ("Veltrics вернул техническое предложение. У него пока нет доступа к файлам проекта; ответ и ход работы сохранены в карточке задачи." if AGENTS.mode == "openai-live" else "Демо-handoff завершён синтетическим ответом; модель не вызывалась. Ответ и ход работы сохранены в карточке задачи.")
        STORE.add_message(conversation_id, "Entropy", final, task_id, turn_id)
        STORE.set_task_result(task_id, json.dumps({"plan": plan, "developer_result": result}, ensure_ascii=False))
        STORE.set_task_status(task_id, "completed")
        STORE.add_event(task_id, "Entropy", "Задача завершена; можно продолжить диалог.")
        STORE.set_turn_status(turn_id, "completed", task_id=task_id)
    except Exception as exc:
        message = f"Не получилось обработать запрос: {str(exc)[:300] or type(exc).__name__}. Попробуй ещё раз."
        STORE.add_message(conversation_id, "Entropy", message, task_id, turn_id)
        STORE.set_turn_status(turn_id, "failed", task_id=task_id, error=message)
        if task_id:
            STORE.set_task_status(task_id, "failed")
            STORE.add_event(task_id, "Argus", f"Задача остановлена: {str(exc)[:300] or type(exc).__name__}.")


class EntropyHandler(SimpleHTTPRequestHandler):
    server_version = "EntropyLocal/0.1"

    def __init__(self, *args, **kwargs):
        frontend_root = BUILT_FRONTEND if (BUILT_FRONTEND / "index.html").is_file() else STATIC
        super().__init__(*args, directory=str(frontend_root), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"[{utc_now()}] {self.address_string()} {format % args}")

    def end_headers(self) -> None:
        if not urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = min(int(self.headers.get("Content-Length", "0")), 64_000)
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _is_local_preview_request(self) -> bool:
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return False
        except ValueError:
            return False
        origin = urlparse(self.headers.get("Origin", ""))
        try:
            origin_port = origin.port
        except ValueError:
            return False
        return (
            origin.scheme == "http"
            and origin.hostname in {"127.0.0.1", "localhost", "::1"}
            and origin_port in {5173, 5174, 8765}
        )

    def _create_miniapp_order(self) -> None:
        try:
            payload = self._read_json()
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json({"error": "Не удалось разобрать заказ."}, 400)
            return
        if not isinstance(payload, dict):
            self._json({"error": "Заказ должен быть JSON-объектом."}, 400)
            return
        product_id = payload.get("product_id")
        if not isinstance(product_id, str) or product_id not in PRODUCTS_BY_ID:
            self._json({"error": "Выбери товар из каталога."}, 400)
            return

        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        init_data = payload.get("init_data")
        if token:
            try:
                telegram_user_id(init_data if isinstance(init_data, str) else "", token)
            except ValueError:
                self._json({"error": "Не удалось подтвердить запуск из Telegram. Закрой и заново открой Mini App."}, 401)
                return
            source = "telegram_miniapp"
        elif miniapp_preview_enabled() and self._is_local_preview_request():
            source = "miniapp_preview"
        else:
            self._json({"error": "Mini App не настроен: добавь токен Telegram-бота в окружение или включи локальный preview."}, 503)
            return

        product = PRODUCTS_BY_ID[product_id]
        order_id = str(uuid.uuid4())
        try:
            order = STORE.create_order(order_id, product_id, product["title"], source)
            webhook_configured = n8n.configured()
            if webhook_configured:
                accepted, dispatch_status = n8n.dispatch_order(order)
                if accepted:
                    STORE.add_observability_event(
                        order_id, "n8n", "workflow.dispatched", "accepted",
                        "Webhook n8n принял событие заказа.", order_status="submitted",
                    )
                else:
                    STORE.add_observability_event(
                        order_id, "n8n", "workflow.dispatch_failed", "failed",
                        "Не удалось передать заказ в n8n; запись заказа сохранена.",
                    )
            else:
                dispatch_status = "not_configured"
                STORE.add_observability_event(
                    order_id, "n8n", "workflow.not_configured", "waiting",
                    "Заказ сохранён; ENTROPY_N8N_WEBHOOK_URL пока не задан.",
                )
        except SQLAlchemyError:
            self._json({"error": "Не удалось сохранить заказ. Проверь базу данных и миграции."}, 503)
            return

        self._json(
            {
                "order": order,
                "workflow": {"status": dispatch_status, "configured": webhook_configured},
                "payment": {"status": "not_implemented"},
            },
            201,
        )

    def _record_n8n_event(self) -> None:
        expected_token = os.environ.get("ENTROPY_N8N_EVENT_TOKEN", "").strip()
        if not expected_token:
            self._json({"error": "Приём событий n8n не настроен."}, 503)
            return
        received_token = self.headers.get("X-Entropy-Event-Token", "")
        if not hmac.compare_digest(received_token, expected_token):
            self._json({"error": "Недействительный токен события."}, 401)
            return
        try:
            payload = self._read_json()
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json({"error": "Не удалось разобрать событие."}, 400)
            return
        if not isinstance(payload, dict):
            self._json({"error": "Событие должно быть JSON-объектом."}, 400)
            return

        correlation_id = payload.get("correlation_id")
        source = payload.get("source")
        event_type = payload.get("event_type")
        status = payload.get("status")
        detail = payload.get("detail", "")
        allowed_sources = {"n8n", "entropy", "psyche", "ophira", "veltrics", "wormhole", "redshift"}
        allowed_statuses = {"started", "running", "accepted", "completed", "failed", "waiting", "skipped"}
        if (
            not isinstance(correlation_id, str)
            or len(correlation_id) > 64
            or not isinstance(source, str)
            or source not in allowed_sources
            or not isinstance(event_type, str)
            or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}", event_type)
            or not isinstance(status, str)
            or status not in allowed_statuses
            or not isinstance(detail, str)
        ):
            self._json({"error": "Событие не соответствует контракту."}, 400)
            return
        order_status = {
            "workflow.started": "running",
            "workflow.completed": "completed",
            "workflow.failed": "failed",
        }.get(event_type)
        try:
            if not STORE.get_order(correlation_id):
                self._json({"error": "Заказ не найден."}, 404)
                return
            STORE.add_observability_event(
                correlation_id,
                source,
                event_type,
                status,
                detail.strip()[:500],
                order_status=order_status,
            )
        except ValueError:
            self._json({"error": "Недопустимый переход состояния заказа."}, 409)
            return
        except SQLAlchemyError:
            self._json({"error": "Не удалось сохранить событие в базе."}, 503)
            return
        self._json({"accepted": True}, 201)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/miniapp/catalog":
            self._json(
                {
                    "products": CATALOG,
                    "telegram_configured": bool(os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()),
                    "preview_enabled": miniapp_preview_enabled(),
                }
            )
            return
        if path == "/api/observability/events":
            try:
                query = parse_qs(urlparse(self.path).query)
                try:
                    limit = int(query.get("limit", ["50"])[0])
                except (TypeError, ValueError):
                    limit = 50
                day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
                self._json(
                    {
                        "events": STORE.list_observability_events(limit),
                        "summary": STORE.observability_summary(day_start),
                        "n8n_configured": n8n.configured(),
                        "telegram_configured": bool(os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()),
                    }
                )
            except SQLAlchemyError:
                self._json({"error": "Хранилище Argus недоступно. Проверь базу данных и миграции."}, 503)
            return
        if path == "/api/state":
            try:
                state = {
                    "mode": AGENTS.mode,
                    "model": getattr(AGENTS, "model", None),
                    "output_token_caps": {
                        "entropy": AGENTS.entropy_output_tokens,
                        "veltrics": AGENTS.veltrics_output_tokens,
                    },
                    "conversations": STORE.list_conversations(),
                    "tasks": STORE.list_tasks(),
                    "turns": STORE.list_recent_turns(),
                    "messages": STORE.list_recent_messages(),
                }
            except SQLAlchemyError:
                self._json({"error": "База данных Entropy недоступна. Проверь подключение и миграции."}, 503)
                return
            self._json(state)
            return
        if path.startswith("/api/conversations/"):
            conversation_id = path.rsplit("/", 1)[-1]
            conversation_ids = {item["id"] for item in STORE.list_conversations()}
            if conversation_id not in conversation_ids:
                self._json({"error": "Conversation not found"}, 404)
                return
            self._json({"messages": STORE.list_conversation_messages(conversation_id)})
            return
        if path.startswith("/api/tasks/"):
            task_id = path.rsplit("/", 1)[-1]
            task = STORE.get_task(task_id)
            self._json({"task": task, "events": STORE.list_events(task_id)} if task else {"error": "Task not found"}, 200 if task else 404)
            return
        if path in {"/", "/index.html", "/argus", "/miniapp"}:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/miniapp/orders":
            self._create_miniapp_order()
            return
        if path == "/api/observability/events":
            self._record_n8n_event()
            return
        if path != "/api/chat":
            self._json({"error": "Not found"}, 404)
            return
        try:
            payload = self._read_json()
            request_text = str(payload.get("message", "")).strip()
            workspace = str(payload.get("workspace", "general")).strip().lower()
            if workspace not in {"general", "career"}:
                self._json({"error": "Неизвестная рабочая вкладка."}, 400)
                return
            if not request_text:
                self._json({"error": "Напиши, что Entropy должен сделать."}, 400)
                return
            max_length = 24_000 if workspace == "career" else 8_000
            if len(request_text) > max_length:
                self._json({"error": f"Запрос слишком длинный (лимит {max_length} символов)."}, 413)
                return

            requested_limits = payload.get("output_token_limits", {})
            if not isinstance(requested_limits, dict):
                self._json({"error": "Лимиты токенов должны быть объектом настроек."}, 400)
                return
            try:
                entropy_output_tokens = _requested_output_limit(
                    requested_limits.get("entropy", AGENTS.entropy_output_tokens),
                    AGENTS.entropy_output_tokens,
                )
                veltrics_output_tokens = _requested_output_limit(
                    requested_limits.get("veltrics", AGENTS.veltrics_output_tokens),
                    AGENTS.veltrics_output_tokens,
                )
            except (TypeError, ValueError):
                self._json({"error": "Лимит ответа должен быть целым числом не меньше 16."}, 400)
                return

            if workspace == "career":
                requested_id = str(payload.get("conversation_id") or "")
                valid_career_id = requested_id == CAREER_CONVERSATION_ID
                prefix = "entropy-career-"
                if requested_id.startswith(prefix):
                    try:
                        suffix = requested_id[len(prefix):]
                        valid_career_id = str(uuid.UUID(suffix)) == suffix
                    except ValueError:
                        valid_career_id = False
                if not valid_career_id:
                    self._json({"error": "Не удалось определить диалог этого разбора."}, 400)
                    return
                conversation_id = requested_id
            else:
                conversation_id = str(payload.get("conversation_id") or uuid.uuid4())
            turn_id = str(uuid.uuid4())
            STORE.ensure_conversation(conversation_id, initial_conversation_title(request_text, workspace))
            STORE.add_message(conversation_id, "Kars", request_text, turn_id=turn_id)
            STORE.create_turn(turn_id, conversation_id, request_text)
            WORKERS.submit(
                run_turn,
                turn_id,
                conversation_id,
                request_text,
                workspace,
                entropy_output_tokens,
                veltrics_output_tokens,
            )
            self._json({"conversation_id": conversation_id, "turn_id": turn_id}, 202)
        except (ValueError, json.JSONDecodeError):
            self._json({"error": "Не удалось разобрать запрос."}, 400)


def main() -> None:
    host = os.environ.get("ENTROPY_HOST", "127.0.0.1")
    port = int(os.environ.get("ENTROPY_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), EntropyHandler)
    print(f"Entropy local demo is ready at http://{host}:{port}")
    print(f"Mode: {AGENTS.mode}; model: {getattr(AGENTS, 'model', 'none')}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Entropy.")
    finally:
        server.server_close()
        WORKERS.shutdown(wait=False, cancel_futures=True)
        DATABASE_ENGINE.dispose()


def _requested_output_limit(value: object, hard_cap: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("Token limits must be integers.")
    limit = int(value)
    minimum = min(MIN_OUTPUT_TOKEN_LIMIT, hard_cap)
    return min(max(limit, minimum), hard_cap)


if __name__ == "__main__":
    main()
