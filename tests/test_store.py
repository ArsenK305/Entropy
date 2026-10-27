import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy.exc import IntegrityError

from entropy_app.database import create_database_engine
from entropy_app.store import Store


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

    def test_conversation_transcript_is_scoped_and_excludes_veltrics(self):
        self.store.ensure_conversation("first", "First")
        self.store.ensure_conversation("second", "Second")
        self.store.add_message("first", "Kars", "Question")
        self.store.add_message("first", "Entropy", "Answer")
        self.store.add_message("first", "Veltrics", "Task detail")
        self.store.add_message("second", "Kars", "Other conversation")

        messages = self.store.list_conversation_messages("first")

        self.assertEqual([message["body"] for message in messages], ["Question", "Answer"])

    def test_foreign_key_rejects_message_for_unknown_conversation(self):
        with self.assertRaises(IntegrityError):
            self.store.add_message("missing", "Kars", "Must fail")


if __name__ == "__main__":
    unittest.main()
