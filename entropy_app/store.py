"""SQLAlchemy-backed persistence for conversations, tasks, and events."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import Engine, text
from sqlalchemy.engine import Connection

from entropy_app.career import (
    CAREER_APPLICATION_SEARCH_FIELDS,
    CAREER_APPLICATION_STATUSES,
    career_application_search_key,
    normalize_career_search_text,
)

CONVERSATION_CONTEXT_MESSAGE_LIMIT = 12


class IdempotencyConflict(ValueError):
    """A request ID was reused for a different Mini App product."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


class Store:
    ORDER_TRANSITIONS = {
        "created": {"submitted", "running", "completed", "failed"},
        "submitted": {"running", "completed", "failed"},
        "running": {"completed", "failed"},
        "completed": set(),
        "failed": set(),
    }
    TASK_TRANSITIONS = {
        "queued": {"planning", "failed", "interrupted"},
        "planning": {"running", "failed", "interrupted"},
        "running": {"completed", "failed", "interrupted"},
        "delegated": {"running", "completed", "failed", "interrupted"},
        "interrupted": set(),
        "completed": set(),
        "failed": set(),
    }

    def __init__(self, engine: Engine):
        self.engine = engine

    def list_memory_source_preferences(self, workspace: str) -> dict[str, bool]:
        with self.engine.connect() as db:
            rows = db.execute(
                text(
                    """
                    SELECT source_id, enabled
                    FROM memory_source_preferences
                    WHERE workspace=:workspace
                    """
                ),
                {"workspace": workspace},
            ).mappings().all()
        return {row["source_id"]: bool(row["enabled"]) for row in rows}

    def set_memory_source_preference(
        self,
        workspace: str,
        source_id: str,
        enabled: bool,
    ) -> None:
        with self.engine.begin() as db:
            db.execute(
                text(
                    """
                    INSERT INTO memory_source_preferences (workspace, source_id, enabled, updated_at)
                    VALUES (:workspace, :source_id, :enabled, :updated_at)
                    ON CONFLICT (workspace, source_id) DO UPDATE
                    SET enabled=:enabled, updated_at=:updated_at
                    """
                ),
                {
                    "workspace": workspace,
                    "source_id": source_id,
                    "enabled": enabled,
                    "updated_at": now(),
                },
            )

    def ensure_conversation(self, conversation_id: str, title: str) -> None:
        stamp = now()
        with self.engine.begin() as db:
            db.execute(
                text("""
                    INSERT INTO conversations (id, title, created_at, updated_at)
                    VALUES (:id, :title, :created_at, :updated_at)
                    ON CONFLICT (id) DO NOTHING
                """),
                {"id": conversation_id, "title": title or "Новый диалог", "created_at": stamp, "updated_at": stamp},
            )
            db.execute(
                text("UPDATE conversations SET updated_at=:updated_at WHERE id=:id"),
                {"updated_at": stamp, "id": conversation_id},
            )

    def rename_conversation(self, conversation_id: str, title: str) -> None:
        cleaned_title = " ".join(title.split())[:64]
        if not cleaned_title:
            return
        with self.engine.begin() as db:
            db.execute(
                text("UPDATE conversations SET title=:title WHERE id=:id"),
                {"title": cleaned_title, "id": conversation_id},
            )

    def add_message(
        self,
        conversation_id: str,
        speaker: str,
        body: str,
        task_id: str | None = None,
        turn_id: str | None = None,
    ) -> None:
        with self.engine.begin() as db:
            db.execute(
                text("""
                    INSERT INTO messages (conversation_id, task_id, turn_id, speaker, body, created_at)
                    VALUES (:conversation_id, :task_id, :turn_id, :speaker, :body, :created_at)
                """),
                {
                    "conversation_id": conversation_id,
                    "task_id": task_id,
                    "turn_id": turn_id,
                    "speaker": speaker,
                    "body": body,
                    "created_at": now(),
                },
            )
            db.execute(
                text("UPDATE conversations SET updated_at=:updated_at WHERE id=:id"),
                {"updated_at": now(), "id": conversation_id},
            )

    def create_turn(self, turn_id: str, conversation_id: str, request: str) -> None:
        stamp = now()
        with self.engine.begin() as db:
            db.execute(
                text("""
                    INSERT INTO assistant_turns (id, conversation_id, request, status, created_at, updated_at)
                    VALUES (:id, :conversation_id, :request, :status, :created_at, :updated_at)
                """),
                {"id": turn_id, "conversation_id": conversation_id, "request": request, "status": "thinking", "created_at": stamp, "updated_at": stamp},
            )

    def set_turn_status(
        self,
        turn_id: str,
        status: str,
        task_id: str | None = None,
        error: str | None = None,
    ) -> None:
        with self.engine.begin() as db:
            db.execute(
                text("""
                    UPDATE assistant_turns
                    SET status=:status, task_id=COALESCE(:task_id, task_id), error=:error, updated_at=:updated_at
                    WHERE id=:id
                """),
                {"status": status, "task_id": task_id, "error": error, "updated_at": now(), "id": turn_id},
            )

    def create_task(self, task_id: str, conversation_id: str, request: str) -> None:
        stamp = now()
        with self.engine.begin() as db:
            db.execute(
                text("""
                    INSERT INTO tasks (id, conversation_id, request, status, created_at, updated_at)
                    VALUES (:id, :conversation_id, :request, :status, :created_at, :updated_at)
                """),
                {"id": task_id, "conversation_id": conversation_id, "request": request, "status": "queued", "created_at": stamp, "updated_at": stamp},
            )

    def set_task_status(self, task_id: str, status: str) -> None:
        with self.engine.begin() as db:
            row = db.execute(
                text("SELECT status FROM tasks WHERE id=:id"), {"id": task_id}
            ).first()
            if row is None:
                raise KeyError(f"Task {task_id!r} does not exist.")
            current = row.status
            if status == current:
                return
            if status not in self.TASK_TRANSITIONS:
                raise ValueError(f"Unknown task status: {status!r}.")
            if status not in self.TASK_TRANSITIONS.get(current, set()):
                raise ValueError(f"Invalid task status transition: {current!r} -> {status!r}.")
            result = db.execute(
                text("UPDATE tasks SET status=:status, updated_at=:updated_at WHERE id=:id AND status=:current"),
                {"status": status, "updated_at": now(), "id": task_id, "current": current},
            )
            if result.rowcount != 1:
                raise ValueError(f"Task {task_id!r} changed while updating its status.")

    def interrupt_incomplete_work(self) -> dict[str, list[str]]:
        """Mark tasks and assistant turns left active by the previous process."""
        interrupted_statuses = ("queued", "planning", "running", "delegated")
        placeholders = ", ".join(f":status_{index}" for index in range(len(interrupted_statuses)))
        params = {f"status_{index}": status for index, status in enumerate(interrupted_statuses)}
        reason = "Backend перезапустился до завершения операции; автоматический повтор не выполнялся."
        stamp = now()
        with self.engine.begin() as db:
            tasks = self._rows(
                db,
                f"SELECT id FROM tasks WHERE status IN ({placeholders}) ORDER BY created_at",
                params,
            )
            interrupted_task_ids: list[str] = []
            for task in tasks:
                task_id = task["id"]
                result = db.execute(
                    text(f"UPDATE tasks SET status='interrupted', updated_at=:updated_at WHERE id=:id AND status IN ({placeholders})"),
                    {**params, "updated_at": stamp, "id": task_id},
                )
                if result.rowcount != 1:
                    continue
                interrupted_task_ids.append(task_id)
                db.execute(
                    text("""
                        INSERT INTO task_events (task_id, actor, detail, created_at)
                        VALUES (:task_id, 'Argus', :detail, :created_at)
                    """),
                    {"task_id": task_id, "detail": reason, "created_at": stamp},
                )
            # A simple chat turn can be interrupted before it creates a Veltrics
            # task. Also cover the crash window after a linked task becomes
            # terminal but before its parent turn is marked complete.
            active_turns = self._rows(
                db,
                "SELECT id FROM assistant_turns WHERE status IN ('thinking', 'delegating') ORDER BY created_at",
            )
            db.execute(
                text("""
                    UPDATE assistant_turns
                    SET status='interrupted', error=:error, updated_at=:updated_at
                    WHERE status IN ('thinking', 'delegating')
                """),
                {"error": reason, "updated_at": stamp},
            )
        return {
            "tasks": interrupted_task_ids,
            "turns": [turn["id"] for turn in active_turns],
        }

    def set_task_result(self, task_id: str, result: str) -> None:
        with self.engine.begin() as db:
            db.execute(
                text("UPDATE tasks SET result=:result, updated_at=:updated_at WHERE id=:id"),
                {"result": result, "updated_at": now(), "id": task_id},
            )

    def add_event(self, task_id: str, actor: str, detail: str) -> None:
        with self.engine.begin() as db:
            db.execute(
                text("""
                    INSERT INTO task_events (task_id, actor, detail, created_at)
                    VALUES (:task_id, :actor, :detail, :created_at)
                """),
                {"task_id": task_id, "actor": actor, "detail": detail, "created_at": now()},
            )

    def create_order(
        self,
        order_id: str,
        product_id: str,
        product_name: str,
        source: str,
        request_id: str | None = None,
        dispatch_requested: bool = False,
    ) -> tuple[dict, bool]:
        stamp = now()
        with self.engine.begin() as db:
            inserted = db.execute(
                text("""
                    INSERT INTO orders
                        (id, product_id, product_name, status, created_at, updated_at, request_id)
                    VALUES
                        (:id, :product_id, :product_name, 'created', :created_at, :updated_at, :request_id)
                    ON CONFLICT (request_id) DO NOTHING
                """),
                {
                    "id": order_id,
                    "product_id": product_id,
                    "product_name": product_name,
                    "created_at": stamp,
                    "updated_at": stamp,
                    "request_id": request_id,
                },
            ).rowcount
            if not inserted:
                existing = db.execute(
                    text("SELECT * FROM orders WHERE request_id=:request_id"),
                    {"request_id": request_id},
                ).mappings().first()
                if existing is None:
                    raise RuntimeError("An order insert was ignored without a matching request ID.")
                if existing["product_id"] != product_id:
                    raise IdempotencyConflict("This request ID was already used for another product.")
                return {
                    "id": existing["id"],
                    "product_id": existing["product_id"],
                    "product_name": existing["product_name"],
                    "status": existing["status"],
                    "created_at": existing["created_at"],
                }, False

            db.execute(
                text("""
                    INSERT INTO observability_events (correlation_id, source, event_type, status, detail, created_at)
                    VALUES (:correlation_id, :source, 'order.created', 'created', :detail, :created_at)
                """),
                {
                    "correlation_id": order_id,
                    "source": source,
                    "detail": f"Тестовый заказ: {product_name}",
                    "created_at": stamp,
                },
            )
            if dispatch_requested:
                db.execute(
                    text("""
                        INSERT INTO n8n_dispatch_outbox (
                            order_id, status, attempt_count, available_at,
                            created_at, updated_at
                        ) VALUES (
                            :order_id, 'pending', 0, :available_at,
                            :created_at, :updated_at
                        )
                    """),
                    {
                        "order_id": order_id,
                        "available_at": stamp,
                        "created_at": stamp,
                        "updated_at": stamp,
                    },
                )
                db.execute(
                    text("""
                        INSERT INTO observability_events (
                            correlation_id, source, event_type, status, detail,
                            created_at, idempotency_key
                        ) VALUES (
                            :correlation_id, 'n8n', 'workflow.dispatch_queued', 'waiting',
                            :detail, :created_at, :idempotency_key
                        )
                    """),
                    {
                        "correlation_id": order_id,
                        "detail": "Передача заказа в n8n поставлена в очередь.",
                        "created_at": stamp,
                        "idempotency_key": f"outbox:{order_id}:queued",
                    },
                )
        return {
            "id": order_id,
            "product_id": product_id,
            "product_name": product_name,
            "status": "created",
            "created_at": stamp,
        }, True

    def get_order(self, order_id: str) -> dict | None:
        with self.engine.connect() as db:
            rows = self._rows(db, "SELECT * FROM orders WHERE id=:id", {"id": order_id})
            return rows[0] if rows else None

    def claim_n8n_dispatch(self, lease_seconds: int = 30) -> dict | None:
        """Atomically lease the next due webhook delivery and return its order."""
        stamp = now()
        lease_expires_at = (
            datetime.now(timezone.utc) + timedelta(seconds=max(5, lease_seconds))
        ).isoformat(timespec="seconds")
        lease_token = str(uuid4())
        eligible = """
            (status='pending' AND available_at<=:now)
            OR (status='running' AND lease_expires_at<=:now)
        """
        with self.engine.begin() as db:
            candidate = db.execute(
                text(f"""
                    SELECT order_id
                    FROM n8n_dispatch_outbox
                    WHERE {eligible}
                    ORDER BY available_at, created_at, order_id
                    LIMIT 1
                """),
                {"now": stamp},
            ).first()
            if candidate is None:
                return None

            updated = db.execute(
                text(f"""
                    UPDATE n8n_dispatch_outbox
                    SET status='running', attempt_count=attempt_count+1,
                        lease_token=:lease_token, lease_expires_at=:lease_expires_at,
                        updated_at=:updated_at
                    WHERE order_id=:order_id AND ({eligible})
                """),
                {
                    "lease_token": lease_token,
                    "lease_expires_at": lease_expires_at,
                    "updated_at": stamp,
                    "order_id": candidate.order_id,
                    "now": stamp,
                },
            )
            if updated.rowcount != 1:
                return None

            dispatch = db.execute(
                text("""
                    SELECT o.id, o.product_id, o.product_name, o.status,
                           o.created_at, b.attempt_count
                    FROM orders AS o
                    JOIN n8n_dispatch_outbox AS b ON b.order_id=o.id
                    WHERE o.id=:order_id AND b.lease_token=:lease_token
                """),
                {"order_id": candidate.order_id, "lease_token": lease_token},
            ).mappings().first()
            if dispatch is None:
                return None
            return {**dict(dispatch), "lease_token": lease_token}

    def finish_n8n_dispatch(
        self,
        order_id: str,
        lease_token: str,
        *,
        accepted: bool,
        http_status: int | None,
        retryable: bool,
        max_attempts: int = 5,
        retry_delays: tuple[int, ...] = (5, 20, 60, 300),
    ) -> str | None:
        """Persist a delivery outcome; reject results from expired leases."""
        stamp = now()
        with self.engine.begin() as db:
            row = db.execute(
                text("""
                    SELECT attempt_count FROM n8n_dispatch_outbox
                    WHERE order_id=:order_id AND status='running' AND lease_token=:lease_token
                """),
                {"order_id": order_id, "lease_token": lease_token},
            ).first()
            if row is None:
                return None

            attempt_count = int(row.attempt_count)
            if accepted:
                status = "delivered"
                event_type = "workflow.dispatched"
                event_status = "accepted"
                detail = "n8n вернул успешный HTTP-ответ по webhook."
                idempotency_key = f"outbox:{order_id}:delivered"
                available_at = stamp
                delivered_at = stamp
            elif retryable and attempt_count < max_attempts:
                status = "pending"
                event_type = "workflow.dispatch_retry"
                event_status = "waiting"
                delay = retry_delays[min(attempt_count - 1, len(retry_delays) - 1)] if retry_delays else 60
                available_at = (
                    datetime.now(timezone.utc) + timedelta(seconds=max(1, delay))
                ).isoformat(timespec="seconds")
                delivered_at = None
                reason = f"HTTP {http_status}" if http_status is not None else "сеть недоступна"
                detail = f"Передача в n8n не удалась ({reason}); следующая попытка через {max(1, delay)} с."
                idempotency_key = f"outbox:{order_id}:attempt:{attempt_count}"
            else:
                status = "failed"
                event_type = "workflow.dispatch_failed"
                event_status = "failed"
                available_at = stamp
                delivered_at = None
                if http_status is not None:
                    detail = f"n8n вернул HTTP {http_status}; автоматические попытки завершены."
                else:
                    detail = "Не удалось связаться с n8n после нескольких попыток."
                idempotency_key = f"outbox:{order_id}:failed"

            db.execute(
                text("""
                    UPDATE n8n_dispatch_outbox
                    SET status=:status, available_at=:available_at,
                        lease_token=NULL, lease_expires_at=NULL,
                        last_http_status=:http_status, last_error=:detail,
                        delivered_at=:delivered_at, updated_at=:updated_at
                    WHERE order_id=:order_id AND status='running' AND lease_token=:lease_token
                """),
                {
                    "status": status,
                    "available_at": available_at,
                    "http_status": http_status,
                    "detail": None if accepted else detail,
                    "delivered_at": delivered_at,
                    "updated_at": stamp,
                    "order_id": order_id,
                    "lease_token": lease_token,
                },
            )
            db.execute(
                text("""
                    INSERT INTO observability_events (
                        correlation_id, source, event_type, status, detail,
                        created_at, idempotency_key
                    ) VALUES (
                        :correlation_id, 'n8n', :event_type, :status, :detail,
                        :created_at, :idempotency_key
                    ) ON CONFLICT (idempotency_key) DO NOTHING
                """),
                {
                    "correlation_id": order_id,
                    "event_type": event_type,
                    "status": event_status,
                    "detail": detail,
                    "created_at": stamp,
                    "idempotency_key": idempotency_key,
                },
            )
        return status

    def set_order_status(self, order_id: str, status: str) -> None:
        with self.engine.begin() as db:
            row = db.execute(text("SELECT status FROM orders WHERE id=:id"), {"id": order_id}).first()
            if row is None:
                raise KeyError(f"Order {order_id!r} does not exist.")
            current = row.status
            if current == status:
                return
            if status not in self.ORDER_TRANSITIONS.get(current, set()):
                raise ValueError(f"Invalid order status transition: {current!r} -> {status!r}.")
            db.execute(
                text("UPDATE orders SET status=:status, updated_at=:updated_at WHERE id=:id"),
                {"status": status, "updated_at": now(), "id": order_id},
            )

    def add_observability_event(
        self,
        correlation_id: str | None,
        source: str,
        event_type: str,
        status: str,
        detail: str,
        order_status: str | None = None,
        idempotency_key: str | None = None,
    ) -> bool:
        if idempotency_key is not None and (
            not isinstance(idempotency_key, str)
            or not idempotency_key.strip()
            or len(idempotency_key) > 200
        ):
            raise ValueError("Observability event idempotency key is invalid.")
        with self.engine.begin() as db:
            inserted = db.execute(
                text("""
                    INSERT INTO observability_events (
                        correlation_id, source, event_type, status, detail,
                        created_at, idempotency_key
                    ) VALUES (
                        :correlation_id, :source, :event_type, :status, :detail,
                        :created_at, :idempotency_key
                    )
                    ON CONFLICT (idempotency_key) DO NOTHING
                """),
                {
                    "correlation_id": correlation_id,
                    "source": source,
                    "event_type": event_type,
                    "status": status,
                    "detail": detail,
                    "created_at": now(),
                    "idempotency_key": idempotency_key,
                },
            ).rowcount
            if not inserted:
                return False
            if order_status and correlation_id:
                row = db.execute(
                    text("SELECT status FROM orders WHERE id=:id"), {"id": correlation_id}
                ).first()
                if row is None:
                    raise KeyError(f"Order {correlation_id!r} does not exist.")
                current = row.status
                if current != order_status:
                    if order_status not in self.ORDER_TRANSITIONS.get(current, set()):
                        raise ValueError(f"Invalid order status transition: {current!r} -> {order_status!r}.")
                    db.execute(
                        text("UPDATE orders SET status=:status, updated_at=:updated_at WHERE id=:id"),
                        {"status": order_status, "updated_at": now(), "id": correlation_id},
                    )
        return True

    def list_observability_events(self, limit: int = 50) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 100))
        with self.engine.connect() as db:
            return self._rows(
                db,
                """
                SELECT id, correlation_id, source, event_type, status, detail, created_at
                FROM observability_events
                ORDER BY id DESC
                LIMIT :limit
                """,
                {"limit": bounded_limit},
            )

    def observability_summary(self, since: str) -> dict:
        with self.engine.connect() as db:
            today_count = db.execute(
                text("SELECT COUNT(*) FROM observability_events WHERE created_at >= :since"), {"since": since}
            ).scalar_one()
            orders_today = db.execute(
                text("SELECT COUNT(*) FROM orders WHERE created_at >= :since"), {"since": since}
            ).scalar_one()
            failed_count = db.execute(
                text("SELECT COUNT(*) FROM observability_events WHERE created_at >= :since AND status='failed'"),
                {"since": since},
            ).scalar_one()
            completed_workflows_count = db.execute(
                text(
                    """
                    SELECT COUNT(DISTINCT correlation_id) FROM observability_events
                    WHERE created_at >= :since
                      AND source = 'n8n'
                      AND event_type = 'workflow.completed'
                      AND status = 'completed'
                    """
                ),
                {"since": since},
            ).scalar_one()
            workflow_rows = self._rows(
                db,
                """
                SELECT source, correlation_id, status FROM observability_events
                WHERE source IN ('n8n', 'entropy', 'psyche', 'ophira', 'veltrics', 'wormhole', 'redshift')
                ORDER BY id DESC LIMIT 500
                """,
            )
        latest_status: dict[tuple[str, str], str] = {}
        for item in workflow_rows:
            key = (item["source"], item["correlation_id"] or item["source"])
            latest_status.setdefault(key, item["status"])
        active_workflows = sum(source == "n8n" and status in {"running", "started"} for (source, _), status in latest_status.items())
        active_agents = sum(
            source in {"entropy", "psyche", "ophira", "veltrics"} and status in {"running", "started"}
            for (source, _), status in latest_status.items()
        )
        return {
            "events_today": int(today_count),
            "orders_today": int(orders_today),
            "failed_today": int(failed_count),
            "completed_workflows_today": int(completed_workflows_count),
            "active_workflows": active_workflows,
            "active_agents": active_agents,
        }

    @staticmethod
    def _rows(db: Connection, query: str, params: dict | None = None) -> list[dict]:
        return [dict(row) for row in db.execute(text(query), params or {}).mappings().all()]

    @staticmethod
    def _career_rows(db: Connection, query: str, params: dict | None = None) -> list[dict]:
        """Read tracker rows without exposing the private, derived search key."""
        return [
            {field: value for field, value in row.items() if field != "search_key"}
            for row in Store._rows(db, query, params)
        ]

    def list_conversations(self) -> list[dict]:
        with self.engine.connect() as db:
            return self._rows(db, "SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 30")

    def list_conversation_page(
        self,
        workspace: str,
        before: dict[str, str] | None = None,
        limit: int = 30,
    ) -> tuple[list[dict], bool]:
        """Return one stable, workspace-scoped page of older conversations."""
        if workspace not in {"general", "career"}:
            raise ValueError("Unsupported conversation workspace")
        if not 1 <= limit <= 100:
            raise ValueError("Conversation page limit is out of range")

        filters = [
            "id LIKE :career_prefix" if workspace == "career" else "id NOT LIKE :career_prefix"
        ]
        params: dict[str, object] = {"career_prefix": "entropy-career-%", "limit": limit + 1}
        if before:
            filters.append("(updated_at < :before_updated_at OR (updated_at = :before_updated_at AND id < :before_id))")
            params["before_updated_at"] = before["updated_at"]
            params["before_id"] = before["id"]

        query = (
            "SELECT * FROM conversations WHERE "
            + " AND ".join(filters)
            + " ORDER BY updated_at DESC, id DESC LIMIT :limit"
        )
        with self.engine.connect() as db:
            conversations = self._rows(db, query, params)

        has_more = len(conversations) > limit
        return conversations[:limit], has_more

    def list_tasks(self) -> list[dict]:
        with self.engine.connect() as db:
            tasks = self._rows(
                db,
                """
                SELECT id, conversation_id, request, status, created_at, updated_at, result
                FROM tasks ORDER BY updated_at DESC, created_at DESC LIMIT 30
                """,
            )
        for task in tasks:
            try:
                result = json.loads(task.pop("result") or "{}")
            except (json.JSONDecodeError, TypeError):
                result = {}
            review = result.get("psyche_review") if isinstance(result, dict) else None
            if not isinstance(review, dict):
                review = {}
            task["review_status"] = review.get("status")
            task["review_verdict"] = review.get("verdict")
        return tasks

    def list_recent_turns(self) -> list[dict]:
        with self.engine.connect() as db:
            return self._rows(db, "SELECT * FROM assistant_turns ORDER BY created_at DESC LIMIT 30")

    def list_recent_messages(self) -> list[dict]:
        with self.engine.connect() as db:
            return self._rows(db, """
                SELECT * FROM (
                    SELECT * FROM messages
                    ORDER BY id DESC LIMIT 100
                ) recent ORDER BY id ASC
            """)

    def list_conversation_messages(self, conversation_id: str) -> list[dict]:
        """Return the visible chat transcript for one conversation."""
        with self.engine.connect() as db:
            return self._career_rows(
                db,
                """
                SELECT * FROM messages
                WHERE conversation_id=:conversation_id AND speaker != 'Veltrics'
                ORDER BY id ASC
                """,
                {"conversation_id": conversation_id},
            )

    def conversation_exists(self, conversation_id: str) -> bool:
        """Check one conversation without loading the recent-conversation list."""
        with self.engine.connect() as db:
            return db.execute(
                text("SELECT 1 FROM conversations WHERE id=:id"),
                {"id": conversation_id},
            ).first() is not None

    def get_conversation(self, conversation_id: str) -> dict | None:
        """Return one conversation's navigation metadata, even when it is old."""
        with self.engine.connect() as db:
            rows = self._rows(
                db,
                "SELECT id, title, created_at, updated_at FROM conversations WHERE id=:id",
                {"id": conversation_id},
            )
            return rows[0] if rows else None

    def list_conversation_context(
        self,
        conversation_id: str,
        exclude_turn_id: str,
        limit: int = CONVERSATION_CONTEXT_MESSAGE_LIMIT,
    ) -> list[dict]:
        """Return prior turns from this conversation, excluding the current request."""
        with self.engine.connect() as db:
            rows = self._rows(
                db,
                """
                SELECT speaker, body, created_at FROM messages
                WHERE conversation_id=:conversation_id AND (turn_id IS NULL OR turn_id != :turn_id)
                ORDER BY id DESC LIMIT :limit
                """,
                {"conversation_id": conversation_id, "turn_id": exclude_turn_id, "limit": limit},
            )
            return list(reversed(rows))

    def get_task(self, task_id: str) -> dict | None:
        with self.engine.connect() as db:
            rows = self._rows(db, "SELECT * FROM tasks WHERE id=:id", {"id": task_id})
            return rows[0] if rows else None

    def list_events(self, task_id: str) -> list[dict]:
        with self.engine.connect() as db:
            return self._rows(db, "SELECT * FROM task_events WHERE task_id=:task_id ORDER BY id", {"task_id": task_id})

    def list_career_applications(self, limit: int = 100) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 200))
        with self.engine.connect() as db:
            return self._career_rows(
                db,
                "SELECT * FROM career_applications ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT :limit",
                {"limit": bounded_limit},
            )

    def list_career_applications_page(
        self,
        *,
        limit: int = 100,
        before_created_at: str | None = None,
        before_id: str | None = None,
        search: str = "",
        status: str | None = None,
        due_by: str | None = None,
        follow_up_after: str | None = None,
    ) -> dict:
        """Return a stable filtered keyset page ordered by immutable creation time and ID."""
        bounded_limit = max(1, min(int(limit), 100))
        cursor_parts = (before_created_at, before_id)
        has_cursor = any(part is not None for part in cursor_parts)
        if has_cursor and any(part is None for part in cursor_parts):
            raise ValueError("Cursor must include creation time and ID.")
        if status is not None and status not in CAREER_APPLICATION_STATUSES:
            raise ValueError("Unknown career application status.")
        trimmed_search = search.strip()
        if len(trimmed_search) > 200:
            raise ValueError("Career application search is too long.")
        normalized_search = normalize_career_search_text(trimmed_search)
        if due_by is not None and status is not None:
            raise ValueError("Follow-up filter cannot be combined with a status filter.")
        if follow_up_after is not None and due_by is None:
            raise ValueError("Follow-up date range requires an upper boundary.")
        if due_by is not None and follow_up_after is not None and follow_up_after >= due_by:
            raise ValueError("Follow-up date range is invalid.")

        filter_clauses: list[str] = []
        cursor_clause = ""
        params: dict[str, object] = {"limit": bounded_limit + 1}
        if has_cursor:
            cursor_clause = """(
                created_at < :before_created_at
                OR (created_at = :before_created_at AND id < :before_id)
            )"""
            params.update({
                "before_created_at": before_created_at,
                "before_id": before_id,
            })
        if status is not None:
            filter_clauses.append("status = :status")
            params["status"] = status
        if due_by is not None:
            filter_clauses.append("""(
                status NOT IN ('offer', 'rejected', 'archived')
                AND follow_up_date IS NOT NULL
                AND follow_up_date <= :due_by
            )""")
            params["due_by"] = due_by
        if follow_up_after is not None:
            filter_clauses.append("follow_up_date > :follow_up_after")
            params["follow_up_after"] = follow_up_after
        if normalized_search:
            escaped_search = (
                normalized_search.replace("!", "!!")
                .replace("%", "!%")
                .replace("_", "!_")
            )
            params["search_pattern"] = f"%{escaped_search}%"
            filter_clauses.append("search_key LIKE :search_pattern ESCAPE '!'")
        filter_where = f"WHERE {' AND '.join(filter_clauses)}" if filter_clauses else ""
        page_clauses = [*filter_clauses]
        if cursor_clause:
            page_clauses.append(cursor_clause)
        where_clause = f"WHERE {' AND '.join(page_clauses)}" if page_clauses else ""

        with self.engine.connect() as db:
            total_count = db.execute(
                text(f"SELECT COUNT(*) FROM career_applications {filter_where}"),
                {key: value for key, value in params.items() if key not in {"limit", "before_created_at", "before_id"}},
            ).scalar_one()
            rows = self._career_rows(
                db,
                f"""
                SELECT * FROM career_applications
                {where_clause}
                ORDER BY created_at DESC, id DESC
                LIMIT :limit
                """,
                params,
            )

        has_more = len(rows) > bounded_limit
        page = rows[:bounded_limit]
        last = page[-1] if page else None
        next_cursor = None
        if has_more and last:
            next_cursor = {
                "created_at": last["created_at"],
                "id": last["id"],
            }
        return {
            "applications": page,
            "has_more": has_more,
            "next_cursor": next_cursor,
            "total_count": int(total_count),
        }

    def career_application_summary(self, as_of_date: str) -> dict:
        """Return whole-tracker counts without loading application records into the UI."""
        upcoming_through = (datetime.fromisoformat(as_of_date) + timedelta(days=7)).date().isoformat()
        status_counts = {status: 0 for status in CAREER_APPLICATION_STATUSES}
        with self.engine.connect() as db:
            rows = db.execute(
                text("""
                    SELECT
                        status,
                        COUNT(*) AS count,
                        SUM(CASE
                            WHEN status NOT IN ('offer', 'rejected', 'archived')
                                AND follow_up_date IS NOT NULL
                                AND follow_up_date <= :as_of_date
                            THEN 1 ELSE 0
                        END) AS due_follow_up_count,
                        SUM(CASE
                            WHEN status NOT IN ('offer', 'rejected', 'archived')
                                AND follow_up_date IS NOT NULL
                                AND follow_up_date > :as_of_date
                                AND follow_up_date <= :upcoming_through
                            THEN 1 ELSE 0
                        END) AS upcoming_follow_up_count
                    FROM career_applications
                    GROUP BY status
                """),
                {"as_of_date": as_of_date, "upcoming_through": upcoming_through},
            ).mappings().all()

        total_count = 0
        due_follow_up_count = 0
        upcoming_follow_up_count = 0
        for row in rows:
            status = row["status"]
            count = int(row["count"])
            if status in status_counts:
                status_counts[status] = count
                total_count += count
                due_follow_up_count += int(row["due_follow_up_count"] or 0)
                upcoming_follow_up_count += int(row["upcoming_follow_up_count"] or 0)

        return {
            "total_count": total_count,
            "status_counts": status_counts,
            "due_follow_up_count": due_follow_up_count,
            "upcoming_follow_up_count": upcoming_follow_up_count,
            "as_of_date": as_of_date,
        }

    def create_career_application(self, application_id: str, values: dict) -> dict:
        return self.create_career_applications([(application_id, values)])[0]

    def create_career_applications(self, records: list[tuple[str, dict]]) -> list[dict]:
        """Insert a validated batch and its creation events in one transaction."""
        if not records:
            return []
        stamp = now()
        applications = []
        with self.engine.begin() as db:
            for application_id, values in records:
                record_values = {"job_description": "", **values}
                db.execute(
                    text(
                        """
                        INSERT INTO career_applications (
                            id, company, job_title, job_description, source_url, contact_name, contact_url, location, salary_range,
                            status, notes, conversation_id, follow_up_date, search_key, created_at, updated_at
                        ) VALUES (
                            :id, :company, :job_title, :job_description, :source_url, :contact_name, :contact_url, :location, :salary_range,
                            :status, :notes, :conversation_id, :follow_up_date, :search_key, :created_at, :updated_at
                        )
                        """
                    ),
                    {
                        "id": application_id,
                        **record_values,
                        "search_key": career_application_search_key(record_values),
                        "created_at": stamp,
                        "updated_at": stamp,
                    },
                )
                db.execute(
                    text(
                        """
                        INSERT INTO career_application_activity (
                            application_id, event_type, from_value, to_value, created_at
                        ) VALUES (:application_id, 'created', NULL, NULL, :created_at)
                        """
                    ),
                    {"application_id": application_id, "created_at": stamp},
                )
                rows = self._career_rows(db, "SELECT * FROM career_applications WHERE id=:id", {"id": application_id})
                if rows:
                    applications.append(rows[0])
        return applications

    def update_career_application(self, application_id: str, values: dict) -> dict | None:
        allowed_fields = {
            "company",
            "job_title",
            "job_description",
            "source_url",
            "contact_name",
            "contact_url",
            "location",
            "salary_range",
            "status",
            "notes",
            "conversation_id",
            "follow_up_date",
        }
        if not values or set(values) - allowed_fields:
            raise ValueError("Career application update contains unsupported fields.")
        with self.engine.begin() as db:
            current = db.execute(
                text(
                    "SELECT status, follow_up_date, conversation_id, company, job_title, job_description, location, contact_name, notes "
                    "FROM career_applications WHERE id=:id"
                ),
                {"id": application_id},
            ).mappings().first()
            if current is None:
                return None
            updated_values = dict(values)
            if any(field in values for field in CAREER_APPLICATION_SEARCH_FIELDS):
                searchable_values = dict(current)
                searchable_values.update(values)
                updated_values["search_key"] = career_application_search_key(searchable_values)
            assignments = ", ".join(f"{field}=:{field}" for field in updated_values)
            stamp = now()
            db.execute(
                text(
                    f"UPDATE career_applications SET {assignments}, updated_at=:updated_at WHERE id=:id"
                ),
                {**updated_values, "updated_at": stamp, "id": application_id},
            )
            events = []
            if "status" in values and values["status"] != current["status"]:
                events.append(("status_changed", current["status"], values["status"]))
            if "follow_up_date" in values and values["follow_up_date"] != current["follow_up_date"]:
                events.append(("follow_up_changed", current["follow_up_date"], values["follow_up_date"]))
            if "conversation_id" in values and values["conversation_id"] != current["conversation_id"]:
                event_type = "conversation_linked" if values["conversation_id"] else "conversation_unlinked"
                events.append((event_type, current["conversation_id"], values["conversation_id"]))
            for event_type, from_value, to_value in events:
                db.execute(
                    text(
                        """
                        INSERT INTO career_application_activity (
                            application_id, event_type, from_value, to_value, created_at
                        ) VALUES (:application_id, :event_type, :from_value, :to_value, :created_at)
                        """
                    ),
                    {
                        "application_id": application_id,
                        "event_type": event_type,
                        "from_value": from_value,
                        "to_value": to_value,
                        "created_at": stamp,
                    },
                )
            rows = self._career_rows(
                db,
                "SELECT * FROM career_applications WHERE id=:id",
                {"id": application_id},
            )
        return rows[0] if rows else None

    def list_career_application_activity(
        self,
        application_id: str,
        limit: int = 100,
    ) -> list[dict] | None:
        bounded_limit = max(1, min(int(limit), 200))
        with self.engine.connect() as db:
            exists = db.execute(
                text("SELECT 1 FROM career_applications WHERE id=:id"),
                {"id": application_id},
            ).first()
            if exists is None:
                return None
            return self._rows(
                db,
                """
                SELECT id, event_type, from_value, to_value, note, created_at
                FROM career_application_activity
                WHERE application_id=:application_id
                ORDER BY created_at DESC, id DESC
                LIMIT :limit
                """,
                {"application_id": application_id, "limit": bounded_limit},
            )

    def add_career_application_activity(
        self,
        application_id: str,
        activity_type: str,
        note: str,
    ) -> dict | None:
        """Add a user-recorded action, returning None if its application is missing."""
        event_type = f"manual_{activity_type}"
        with self.engine.begin() as db:
            exists = db.execute(
                text("SELECT 1 FROM career_applications WHERE id=:id"),
                {"id": application_id},
            ).first()
            if exists is None:
                return None
            row = db.execute(
                text(
                    """
                    INSERT INTO career_application_activity (
                        application_id, event_type, from_value, to_value, note, created_at
                    ) VALUES (:application_id, :event_type, NULL, NULL, :note, :created_at)
                    RETURNING id, event_type, from_value, to_value, note, created_at
                    """
                ),
                {
                    "application_id": application_id,
                    "event_type": event_type,
                    "note": note,
                    "created_at": now(),
                },
            ).mappings().first()
        return dict(row) if row is not None else None
