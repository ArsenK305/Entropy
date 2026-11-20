import json
import os
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from entropy_app.n8n import dispatch_order, event_token_configured, order_status_for_event


class N8nEventContractTests(unittest.TestCase):
    def test_workflow_event_maps_to_expected_order_status(self):
        self.assertEqual(order_status_for_event("n8n", "workflow.started", "running"), "running")
        self.assertEqual(order_status_for_event("n8n", "workflow.completed", "completed"), "completed")
        self.assertEqual(order_status_for_event("n8n", "workflow.failed", "failed"), "failed")

    def test_rejects_mismatched_workflow_status(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            order_status_for_event("n8n", "workflow.started", "completed")

    def test_agent_events_never_change_miniapp_order_state(self):
        self.assertIsNone(order_status_for_event("psyche", "workflow.completed", "completed"))
        self.assertIsNone(order_status_for_event("n8n", "agent.review.completed", "completed"))


class N8nDispatchTests(unittest.TestCase):
    def test_callback_token_status_does_not_expose_or_accept_disabled_sentinel(self):
        with patch.dict(os.environ, {"ENTROPY_N8N_EVENT_TOKEN": ""}):
            self.assertFalse(event_token_configured())
        with patch.dict(os.environ, {"ENTROPY_N8N_EVENT_TOKEN": "disabled"}):
            self.assertFalse(event_token_configured())
        with patch.dict(os.environ, {"ENTROPY_N8N_EVENT_TOKEN": "configured-secret"}):
            self.assertTrue(event_token_configured())

    def test_reports_remote_http_status_without_leaking_response_details(self):
        remote_error = HTTPError("https://n8n.example/webhook", 500, "Internal Server Error", None, None)
        with (
            patch.dict(os.environ, {"ENTROPY_N8N_WEBHOOK_URL": "https://n8n.example/webhook"}),
            patch("entropy_app.n8n.urlopen", side_effect=remote_error),
        ):
            result = dispatch_order({"id": "order-1", "product_id": "entropy-box", "product_name": "Demo", "created_at": "now"})

        self.assertEqual(result, (False, "rejected", 500))
        self.assertNotIn("n8n.example", repr(result))

    def test_reports_success_status(self):
        response = MagicMock()
        response.status = 202
        context_manager = MagicMock()
        context_manager.__enter__.return_value = response
        with (
            patch.dict(os.environ, {"ENTROPY_N8N_WEBHOOK_URL": "https://n8n.example/webhook"}),
            patch("entropy_app.n8n.urlopen", return_value=context_manager),
        ):
            result = dispatch_order({"id": "order-1", "product_id": "entropy-box", "product_name": "Demo", "created_at": "now"})

        self.assertEqual(result, (True, "accepted", 202))

    def test_delivery_uses_a_stable_idempotency_key(self):
        response = MagicMock()
        response.status = 202
        context_manager = MagicMock()
        context_manager.__enter__.return_value = response
        order = {
            "id": "order-1",
            "product_id": "entropy-box",
            "product_name": "Demo",
            "created_at": "now",
        }
        with (
            patch.dict(os.environ, {"ENTROPY_N8N_WEBHOOK_URL": "https://n8n.example/webhook"}),
            patch("entropy_app.n8n.urlopen", return_value=context_manager) as open_url,
        ):
            self.assertEqual(dispatch_order(order), (True, "accepted", 202))

        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("Idempotency-key"), "entropy-order-order-1")
        self.assertEqual(json.loads(request.data)["event_id"], "entropy-order-order-1")


if __name__ == "__main__":
    unittest.main()
