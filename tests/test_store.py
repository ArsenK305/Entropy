import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from entropy_app.database import create_database_engine
from entropy_app.store import CONVERSATION_CONTEXT_MESSAGE_LIMIT, IdempotencyConflict, Store, now


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp_dir.cleanup)
        self.database_path = Path(self.temp_dir.name) / "entropy.db"
        database_url = f"sqlite:///{self.database_path.as_posix()}"
        config = Config("alembic.ini")
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "head")
        self.engine = create_database_engine(database_url)
        self.addCleanup(self.engine.dispose)
        self.store = Store(self.engine)

    def test_store_timestamps_preserve_subsecond_ordering(self):
        self.assertRegex(
            now(),
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$",
        )

        self.store.ensure_conversation("timestamp-order", "Timestamp ordering")
        with patch(
            "entropy_app.store.now",
            side_effect=(
                "2026-11-15T10:00:00.000001+00:00",
                "2026-11-15T10:00:00.000002+00:00",
            ),
        ):
            self.store.create_turn("older-turn", "timestamp-order", "Earlier request")
            self.store.create_turn("newer-turn", "timestamp-order", "Later request")

        turns = self.store.list_recent_turns()
        self.assertEqual(turns[0]["id"], "newer-turn")

    def test_memory_source_preferences_are_scoped_and_upserted(self):
        self.assertEqual(self.store.list_memory_source_preferences("general"), {})
        self.assertEqual(self.store.list_memory_source_preferences("career"), {})

        self.store.set_memory_source_preference("career", "career-profile", True)
        self.store.set_memory_source_preference("general", "continuity-memory", False)
        self.store.set_memory_source_preference("career", "career-profile", False)

        self.assertEqual(self.store.list_memory_source_preferences("career"), {"career-profile": False})
        self.assertEqual(self.store.list_memory_source_preferences("general"), {"continuity-memory": False})

    def test_conversation_context_keeps_prior_agent_messages_and_excludes_current_turn(self):
        conversation_id = "conversation"
        self.store.ensure_conversation(conversation_id, "Context test")
        self.store.add_message(conversation_id, "Kars", "Earlier request", turn_id="previous")
        self.store.add_message(conversation_id, "Entropy", "Earlier answer", turn_id="previous")
        self.store.add_message(conversation_id, "Veltrics", "Earlier proposal", turn_id="previous")
        self.store.add_message(conversation_id, "Kars", "Current request", turn_id="current")

        context = self.store.list_conversation_context(conversation_id, "current")

        self.assertEqual([message["speaker"] for message in context], ["Kars", "Entropy", "Veltrics"])
        self.assertEqual(context[-1]["body"], "Earlier proposal")

    def test_conversation_context_uses_shared_default_message_limit(self):
        conversation_id = "bounded-context"
        self.store.ensure_conversation(conversation_id, "Bounded context")
        for index in range(CONVERSATION_CONTEXT_MESSAGE_LIMIT + 2):
            self.store.add_message(conversation_id, "Kars", f"Prior message {index}", turn_id=f"prior-{index}")
        self.store.add_message(conversation_id, "Kars", "Current request", turn_id="current")

        context = self.store.list_conversation_context(conversation_id, "current")

        self.assertEqual(len(context), CONVERSATION_CONTEXT_MESSAGE_LIMIT)
        self.assertEqual(context[0]["body"], "Prior message 2")
        self.assertEqual(context[-1]["body"], f"Prior message {CONVERSATION_CONTEXT_MESSAGE_LIMIT + 1}")

    def test_task_and_event_lifecycle_is_persisted(self):
        self.store.ensure_conversation("conversation", "Task test")
        self.store.create_task("task", "conversation", "Do work")
        self.store.add_event("task", "Entropy", "Task accepted")
        self.store.set_task_result("task", "Done")
        self.store.set_task_status("task", "planning")
        self.store.set_task_status("task", "running")
        self.store.set_task_status("task", "completed")

        task = self.store.get_task("task")

        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["result"], "Done")
        self.assertEqual(self.store.list_events("task")[0]["detail"], "Task accepted")

    def test_task_list_is_lightweight_and_contains_navigation_fields(self):
        self.store.ensure_conversation("conversation", "Task list test")
        self.store.create_task("task", "conversation", "List this task")
        self.store.set_task_result(
            "task",
            json.dumps(
                {
                    "developer_result": "A potentially large result",
                    "psyche_review": {
                        "status": "completed",
                        "verdict": "needs_revision",
                        "findings": [{"issue": "private detail"}],
                    },
                }
            ),
        )

        task = self.store.list_tasks()[0]

        self.assertEqual(task["conversation_id"], "conversation")
        self.assertIn("updated_at", task)
        self.assertNotIn("result", task)
        self.assertEqual(task["review_status"], "completed")
        self.assertEqual(task["review_verdict"], "needs_revision")

    def test_task_lifecycle_rejects_skipped_and_terminal_transitions(self):
        self.store.ensure_conversation("conversation", "Task test")
        self.store.create_task("task", "conversation", "Do work")

        with self.assertRaises(ValueError):
            self.store.set_task_status("task", "completed")

        self.store.set_task_status("task", "planning")
        self.store.set_task_status("task", "running")
        self.store.set_task_status("task", "completed")

        with self.assertRaises(ValueError):
            self.store.set_task_status("task", "failed")

    def test_observability_summary_separates_event_rows_from_order_count(self):
        order_id = "order-with-four-events"
        self.store.create_order(order_id, "entropy-box", "Entropy Box", "miniapp_preview")
        self.store.add_observability_event(
            order_id, "n8n", "workflow.dispatched", "accepted", "Webhook accepted."
        )
        self.store.add_observability_event(
            order_id, "n8n", "workflow.started", "running", "Workflow started.", order_status="running"
        )
        self.store.add_observability_event(
            order_id, "n8n", "workflow.completed", "completed", "Workflow completed.", order_status="completed"
        )

        summary = self.store.observability_summary("2000-01-01T00:00:00+00:00")

        self.assertEqual(summary["events_today"], 4)
        self.assertEqual(summary["orders_today"], 1)
        self.assertEqual(summary["completed_workflows_today"], 1)

    def test_miniapp_order_request_id_returns_the_original_order_without_duplicate_event(self):
        request_id = "11111111-1111-4111-8111-111111111111"
        original, created = self.store.create_order(
            "original-order",
            "entropy-box",
            "Entropy Box",
            "miniapp_preview",
            request_id=request_id,
        )

        replay, replay_created = self.store.create_order(
            "retry-order",
            "entropy-box",
            "Entropy Box",
            "miniapp_preview",
            request_id=request_id,
        )

        self.assertTrue(created)
        self.assertFalse(replay_created)
        self.assertEqual(replay["id"], original["id"])
        self.assertEqual(len(self.store.list_observability_events(limit=10)), 1)

    def test_miniapp_order_request_id_cannot_be_reused_for_another_product(self):
        request_id = "22222222-2222-4222-8222-222222222222"
        self.store.create_order(
            "original-order",
            "entropy-box",
            "Entropy Box",
            "miniapp_preview",
            request_id=request_id,
        )

        with self.assertRaises(IdempotencyConflict):
            self.store.create_order(
                "different-order",
                "career-module-candidate",
                "Career module",
                "miniapp_preview",
                request_id=request_id,
            )

    def test_n8n_event_id_makes_callback_retries_idempotent_after_later_transitions(self):
        order_id = "order-idempotent-callback"
        self.store.create_order(order_id, "entropy-box", "Entropy Box", "miniapp_preview")

        self.assertTrue(self.store.add_observability_event(
            order_id,
            "n8n",
            "workflow.started",
            "running",
            "Workflow started.",
            order_status="running",
            idempotency_key="n8n:exec-42:workflow.started",
        ))
        self.assertTrue(self.store.add_observability_event(
            order_id,
            "n8n",
            "workflow.completed",
            "completed",
            "Workflow completed.",
            order_status="completed",
            idempotency_key="n8n:exec-42:workflow.completed",
        ))

        self.assertFalse(self.store.add_observability_event(
            order_id,
            "n8n",
            "workflow.started",
            "running",
            "Retry of the original callback.",
            order_status="running",
            idempotency_key="n8n:exec-42:workflow.started",
        ))
        self.assertFalse(self.store.add_observability_event(
            order_id,
            "n8n",
            "workflow.completed",
            "completed",
            "Retry of the completion callback.",
            order_status="completed",
            idempotency_key="n8n:exec-42:workflow.completed",
        ))

        self.assertEqual(self.store.get_order(order_id)["status"], "completed")
        events = self.store.list_observability_events(limit=10)
        self.assertEqual(sum(event["correlation_id"] == order_id for event in events), 3)

    def test_restart_marks_incomplete_tasks_and_turns_interrupted_once(self):
        self.store.ensure_conversation("conversation", "Restart test")
        self.store.create_turn("queued-turn", "conversation", "Queued work")
        self.store.create_task("queued-task", "conversation", "Queued work")
        self.store.set_turn_status("queued-turn", "delegating", task_id="queued-task")

        self.store.create_turn("running-turn", "conversation", "Running work")
        self.store.create_task("running-task", "conversation", "Running work")
        self.store.set_turn_status("running-turn", "delegating", task_id="running-task")
        self.store.set_task_status("running-task", "planning")
        self.store.set_task_status("running-task", "running")

        self.store.create_turn("orphan-turn", "conversation", "Simple chat turn")

        self.store.create_task("completed-task", "conversation", "Finished work")
        self.store.create_turn("stale-completed-turn", "conversation", "Finished work")
        self.store.set_turn_status("stale-completed-turn", "delegating", task_id="completed-task")
        self.store.set_task_status("completed-task", "planning")
        self.store.set_task_status("completed-task", "running")
        self.store.set_task_status("completed-task", "completed")
        self.store.create_task("failed-task", "conversation", "Failed work")
        self.store.create_turn("stale-failed-turn", "conversation", "Failed work")
        self.store.set_turn_status("stale-failed-turn", "delegating", task_id="failed-task")
        self.store.set_task_status("failed-task", "failed")
        self.store.create_turn("finished-turn", "conversation", "Finished chat")
        self.store.set_turn_status("finished-turn", "completed")

        interrupted = self.store.interrupt_incomplete_work()

        self.assertCountEqual(interrupted["tasks"], ["queued-task", "running-task"])
        self.assertEqual(self.store.get_task("queued-task")["status"], "interrupted")
        self.assertEqual(self.store.get_task("running-task")["status"], "interrupted")
        self.assertEqual(self.store.get_task("completed-task")["status"], "completed")
        self.assertEqual(self.store.get_task("failed-task")["status"], "failed")
        self.assertEqual(self.store.list_events("running-task")[0]["actor"], "Argus")
        self.assertIn("автоматический повтор не выполнялся", self.store.list_events("running-task")[0]["detail"])

        turns = {turn["id"]: turn for turn in self.store.list_recent_turns()}
        self.assertEqual(turns["queued-turn"]["status"], "interrupted")
        self.assertEqual(turns["running-turn"]["status"], "interrupted")
        self.assertEqual(turns["orphan-turn"]["status"], "interrupted")
        self.assertEqual(turns["stale-completed-turn"]["status"], "interrupted")
        self.assertEqual(turns["stale-failed-turn"]["status"], "interrupted")
        self.assertEqual(turns["finished-turn"]["status"], "completed")
        self.assertCountEqual(
            interrupted["turns"],
            ["queued-turn", "running-turn", "orphan-turn", "stale-completed-turn", "stale-failed-turn"],
        )
        repeated = self.store.interrupt_incomplete_work()
        self.assertEqual(repeated, {"tasks": [], "turns": []})
        self.assertEqual(len(self.store.list_events("running-task")), 1)

    def test_conversation_transcript_is_scoped_and_excludes_veltrics(self):
        self.store.ensure_conversation("first", "First")
        self.store.ensure_conversation("second", "Second")
        self.store.add_message("first", "Kars", "Question")
        self.store.add_message("first", "Entropy", "Answer")
        self.store.add_message("first", "Veltrics", "Task detail")
        self.store.add_message("second", "Kars", "Other conversation")

        messages = self.store.list_conversation_messages("first")

        self.assertEqual([message["body"] for message in messages], ["Question", "Answer"])

    def test_conversation_exists_checks_an_id_outside_the_recent_list(self):
        self.store.ensure_conversation("older-conversation", "Older")
        with self.engine.begin() as db:
            db.execute(
                text("UPDATE conversations SET created_at=:stamp, updated_at=:stamp WHERE id=:id"),
                {"stamp": "2000-01-01T00:00:00+00:00", "id": "older-conversation"},
            )
        for index in range(30):
            self.store.ensure_conversation(f"recent-{index}", f"Recent {index}")

        self.assertEqual(len(self.store.list_conversations()), 30)
        self.assertNotIn(
            "older-conversation",
            {conversation["id"] for conversation in self.store.list_conversations()},
        )
        self.assertTrue(self.store.conversation_exists("older-conversation"))
        self.assertFalse(self.store.conversation_exists("missing-conversation"))
        self.assertEqual(
            self.store.get_conversation("older-conversation"),
            {
                "id": "older-conversation",
                "title": "Older",
                "created_at": "2000-01-01T00:00:00+00:00",
                "updated_at": "2000-01-01T00:00:00+00:00",
            },
        )
        self.assertIsNone(self.store.get_conversation("missing-conversation"))

    def test_conversation_history_pages_are_stable_and_scoped_by_workspace(self):
        for index in range(35):
            conversation_id = f"general-{index:02d}"
            self.store.ensure_conversation(conversation_id, conversation_id)
            with self.engine.begin() as db:
                db.execute(
                    text("UPDATE conversations SET updated_at=:stamp WHERE id=:id"),
                    {"stamp": f"2026-11-01T00:00:{index:02d}+00:00", "id": conversation_id},
                )
        self.store.ensure_conversation("entropy-career-old", "Career")
        with self.engine.begin() as db:
            db.execute(
                text("UPDATE conversations SET updated_at=:stamp WHERE id=:id"),
                {"stamp": "2026-11-02T00:00:00+00:00", "id": "entropy-career-old"},
            )

        first_page, has_more = self.store.list_conversation_page("general", limit=30)
        self.assertTrue(has_more)
        self.assertEqual(len(first_page), 30)
        self.assertEqual(first_page[0]["id"], "general-34")
        self.assertEqual(first_page[-1]["id"], "general-05")

        next_page, has_more = self.store.list_conversation_page(
            "general",
            {"updated_at": first_page[-1]["updated_at"], "id": first_page[-1]["id"]},
            limit=30,
        )
        self.assertFalse(has_more)
        self.assertEqual([item["id"] for item in next_page], [f"general-{index:02d}" for index in range(4, -1, -1)])

        career_page, has_more = self.store.list_conversation_page("career", limit=30)
        self.assertFalse(has_more)
        self.assertEqual([item["id"] for item in career_page], ["entropy-career-old"])

    def test_foreign_key_rejects_message_for_unknown_conversation(self):
        with self.assertRaises(IntegrityError):
            self.store.add_message("missing", "Kars", "Must fail")


if __name__ == "__main__":
    unittest.main()
