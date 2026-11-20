import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from entropy_app.database import create_database_engine
from entropy_app.n8n_outbox import N8nOutboxWorker, is_retryable
from entropy_app.store import Store


class N8nOutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp_dir.cleanup)
        database_url = f"sqlite:///{(Path(self.temp_dir.name) / 'outbox.db').as_posix()}"
        config = Config("alembic.ini")
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "head")
        self.engine = create_database_engine(database_url)
        self.addCleanup(self.engine.dispose)
        self.store = Store(self.engine)

    def test_order_and_delivery_record_are_committed_together_and_idempotently(self):
        request_id = "11111111-1111-4111-8111-111111111111"
        order, created = self.store.create_order(
            "order-1", "entropy-box", "Entropy Box", "miniapp_preview",
            request_id=request_id, dispatch_requested=True,
        )
        replay, replay_created = self.store.create_order(
            "order-2", "entropy-box", "Entropy Box", "miniapp_preview",
            request_id=request_id, dispatch_requested=True,
        )

        with self.engine.connect() as db:
            outbox_count = db.execute(text("SELECT COUNT(*) FROM n8n_dispatch_outbox")).scalar_one()
            event_types = db.execute(
                text("SELECT event_type FROM observability_events WHERE correlation_id=:id ORDER BY id"),
                {"id": order["id"]},
            ).scalars().all()

        self.assertTrue(created)
        self.assertFalse(replay_created)
        self.assertEqual(replay["id"], order["id"])
        self.assertEqual(outbox_count, 1)
        self.assertEqual(event_types, ["order.created", "workflow.dispatch_queued"])

    def test_successful_delivery_is_recorded_once(self):
        self.store.create_order(
            "order-accepted", "entropy-box", "Entropy Box", "miniapp_preview",
            dispatch_requested=True,
        )
        worker = N8nOutboxWorker(self.store)

        with (
            patch("entropy_app.n8n.configured", return_value=True),
            patch("entropy_app.n8n.dispatch_order", return_value=(True, "accepted", 202)) as dispatch,
        ):
            self.assertTrue(worker.dispatch_once())
            self.assertFalse(worker.dispatch_once())

        dispatch.assert_called_once()
        with self.engine.connect() as db:
            status = db.execute(
                text("SELECT status FROM n8n_dispatch_outbox WHERE order_id='order-accepted'")
            ).scalar_one()
            event_types = db.execute(
                text("SELECT event_type FROM observability_events WHERE correlation_id='order-accepted' ORDER BY id")
            ).scalars().all()
        self.assertEqual(status, "delivered")
        self.assertEqual(event_types, ["order.created", "workflow.dispatch_queued", "workflow.dispatched"])

    def test_transient_failure_is_scheduled_and_client_error_stops_retries(self):
        self.store.create_order(
            "order-retry", "entropy-box", "Entropy Box", "miniapp_preview",
            dispatch_requested=True,
        )
        first = self.store.claim_n8n_dispatch()
        self.assertEqual(first["attempt_count"], 1)

        status = self.store.finish_n8n_dispatch(
            first["id"], first["lease_token"], accepted=False, http_status=503,
            retryable=True, retry_delays=(60,),
        )
        self.assertEqual(status, "pending")
        self.assertIsNone(self.store.claim_n8n_dispatch())

        with self.engine.begin() as db:
            db.execute(
                text("UPDATE n8n_dispatch_outbox SET available_at='2000-01-01T00:00:00+00:00' WHERE order_id='order-retry'")
            )
        second = self.store.claim_n8n_dispatch()
        self.assertEqual(second["attempt_count"], 2)

        status = self.store.finish_n8n_dispatch(
            second["id"], second["lease_token"], accepted=False, http_status=401,
            retryable=False,
        )
        self.assertEqual(status, "failed")
        with self.engine.connect() as db:
            event_types = db.execute(
                text("SELECT event_type FROM observability_events WHERE correlation_id='order-retry' ORDER BY id")
            ).scalars().all()
        self.assertEqual(event_types, [
            "order.created", "workflow.dispatch_queued",
            "workflow.dispatch_retry", "workflow.dispatch_failed",
        ])

    def test_expired_lease_replaces_token_and_rejects_late_result(self):
        self.store.create_order(
            "order-lease", "entropy-box", "Entropy Box", "miniapp_preview",
            dispatch_requested=True,
        )
        old_lease = self.store.claim_n8n_dispatch()
        with self.engine.begin() as db:
            db.execute(
                text("UPDATE n8n_dispatch_outbox SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE order_id='order-lease'")
            )
        new_lease = self.store.claim_n8n_dispatch()

        self.assertNotEqual(old_lease["lease_token"], new_lease["lease_token"])
        self.assertIsNone(self.store.finish_n8n_dispatch(
            old_lease["id"], old_lease["lease_token"], accepted=True,
            http_status=200, retryable=False,
        ))
        self.assertEqual(self.store.finish_n8n_dispatch(
            new_lease["id"], new_lease["lease_token"], accepted=True,
            http_status=200, retryable=False,
        ), "delivered")

    def test_worker_leaves_pending_delivery_untouched_when_webhook_is_unconfigured(self):
        self.store.create_order(
            "order-offline", "entropy-box", "Entropy Box", "miniapp_preview",
            dispatch_requested=True,
        )
        worker = N8nOutboxWorker(self.store)
        with patch("entropy_app.n8n.configured", return_value=False):
            self.assertFalse(worker.dispatch_once())
        with self.engine.connect() as db:
            status = db.execute(
                text("SELECT status FROM n8n_dispatch_outbox WHERE order_id='order-offline'")
            ).scalar_one()
        self.assertEqual(status, "pending")

    def test_retry_classifier_retries_only_transient_http_statuses(self):
        self.assertTrue(is_retryable(None))
        for status in (408, 425, 429, 500, 503):
            with self.subTest(status=status):
                self.assertTrue(is_retryable(status))
        for status in (400, 401, 403, 404):
            with self.subTest(status=status):
                self.assertFalse(is_retryable(status))

    def test_retry_budget_ends_in_a_terminal_failure_after_five_attempts(self):
        self.store.create_order(
            "order-max-attempts", "entropy-box", "Entropy Box", "miniapp_preview",
            dispatch_requested=True,
        )

        outcomes = []
        for attempt in range(1, 6):
            dispatch = self.store.claim_n8n_dispatch()
            self.assertEqual(dispatch["attempt_count"], attempt)
            outcome = self.store.finish_n8n_dispatch(
                dispatch["id"], dispatch["lease_token"], accepted=False,
                http_status=503, retryable=True,
            )
            outcomes.append(outcome)
            if attempt < 5:
                with self.engine.begin() as db:
                    db.execute(text(
                        "UPDATE n8n_dispatch_outbox "
                        "SET available_at='2000-01-01T00:00:00+00:00' "
                        "WHERE order_id='order-max-attempts'"
                    ))

        self.assertEqual(outcomes, ["pending", "pending", "pending", "pending", "failed"])
        self.assertIsNone(self.store.claim_n8n_dispatch())
        with self.engine.connect() as db:
            attempt_count = db.execute(text(
                "SELECT attempt_count FROM n8n_dispatch_outbox WHERE order_id='order-max-attempts'"
            )).scalar_one()
            event_types = db.execute(text(
                "SELECT event_type FROM observability_events "
                "WHERE correlation_id='order-max-attempts' ORDER BY id"
            )).scalars().all()
        self.assertEqual(attempt_count, 5)
        self.assertEqual(event_types.count("workflow.dispatch_retry"), 4)
        self.assertEqual(event_types[-1], "workflow.dispatch_failed")


if __name__ == "__main__":
    unittest.main()
