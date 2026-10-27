"""SQLAlchemy-backed persistence for conversations, tasks, and events."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Engine, text
from sqlalchemy.engine import Connection


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    ORDER_TRANSITIONS = {
        "created": {"submitted", "running", "completed", "failed"},
        "submitted": {"running", "completed", "failed"},
        "running": {"completed", "failed"},
        "completed": set(),
        "failed": set(),
    }
    TASK_TRANSITIONS = {
        "queued": {"planning", "failed"},
        "planning": {"running", "failed"},
        "running": {"completed", "failed"},
        "delegated": {"running", "completed", "failed"},
        "completed": set(),
        "failed": set(),
    }

    def __init__(self, engine: Engine):
        self.engine = engine

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
    ) -> dict:
        stamp = now()
        with self.engine.begin() as db:
            db.execute(
                text("""
                    INSERT INTO orders (id, product_id, product_name, status, created_at, updated_at)
                    VALUES (:id, :product_id, :product_name, 'created', :created_at, :updated_at)
                """),
                {
                    "id": order_id,
                    "product_id": product_id,
                    "product_name": product_name,
                    "created_at": stamp,
                    "updated_at": stamp,
                },
            )
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
        return {
            "id": order_id,
            "product_id": product_id,
            "product_name": product_name,
            "status": "created",
            "created_at": stamp,
        }

    def get_order(self, order_id: str) -> dict | None:
        with self.engine.connect() as db:
            rows = self._rows(db, "SELECT * FROM orders WHERE id=:id", {"id": order_id})
            return rows[0] if rows else None

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
    ) -> None:
        with self.engine.begin() as db:
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
            db.execute(
                text("""
                    INSERT INTO observability_events (correlation_id, source, event_type, status, detail, created_at)
                    VALUES (:correlation_id, :source, :event_type, :status, :detail, :created_at)
                """),
                {
                    "correlation_id": correlation_id,
                    "source": source,
                    "event_type": event_type,
                    "status": status,
                    "detail": detail,
                    "created_at": now(),
                },
            )

    def list_observability_events(self, limit: int = 50) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 100))
        with self.engine.connect() as db:
            return self._rows(
                db,
                "SELECT * FROM observability_events ORDER BY id DESC LIMIT :limit",
                {"limit": bounded_limit},
            )

    def observability_summary(self, since: str) -> dict:
        with self.engine.connect() as db:
            today_count = db.execute(
                text("SELECT COUNT(*) FROM observability_events WHERE created_at >= :since"), {"since": since}
            ).scalar_one()
            failed_count = db.execute(
                text("SELECT COUNT(*) FROM observability_events WHERE created_at >= :since AND status='failed'"),
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
            "failed_today": int(failed_count),
            "active_workflows": active_workflows,
            "active_agents": active_agents,
        }

    @staticmethod
    def _rows(db: Connection, query: str, params: dict | None = None) -> list[dict]:
        return [dict(row) for row in db.execute(text(query), params or {}).mappings().all()]

    def list_conversations(self) -> list[dict]:
        with self.engine.connect() as db:
            return self._rows(db, "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 30")

    def list_tasks(self) -> list[dict]:
        with self.engine.connect() as db:
            return self._rows(db, "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 30")

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
            return self._rows(
                db,
                """
                SELECT * FROM messages
                WHERE conversation_id=:conversation_id AND speaker != 'Veltrics'
                ORDER BY id ASC
                """,
                {"conversation_id": conversation_id},
            )

    def list_conversation_context(self, conversation_id: str, exclude_turn_id: str, limit: int = 12) -> list[dict]:
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
