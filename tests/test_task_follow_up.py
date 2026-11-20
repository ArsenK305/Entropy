import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from app import EntropyHandler, task_follow_up_context


class FollowUpStore:
    def __init__(self, task):
        self.task = task

    def get_task(self, task_id):
        return self.task if self.task and self.task["id"] == task_id else None


class TaskFollowUpTests(unittest.TestCase):
    def _post(self, store, payload):
        server = ThreadingHTTPServer(("127.0.0.1", 0), EntropyHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, timeout=2)
        self.addCleanup(server.shutdown)
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with patch("app.STORE", store):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)
        try:
            return response.exception.code, json.loads(response.exception.read().decode("utf-8"))
        finally:
            response.exception.close()

    def test_follow_up_context_contains_saved_result_and_is_bounded(self):
        context = task_follow_up_context({
            "request": "Implement a setting",
            "status": "completed",
            "result": json.dumps({
                "plan": {"summary": "Add a small setting", "steps": ["Inspect", "Implement"]},
                "developer_result": "The setting now has a safe default.",
                "psyche_review": {"summary": "No critical issues."},
            }),
        })

        self.assertEqual(context["speaker"], "Контекст задачи")
        self.assertIn("Add a small setting", context["body"])
        self.assertIn("safe default", context["body"])
        self.assertLessEqual(len(context["body"]), 6_000)

    def test_follow_up_rejects_task_from_another_conversation(self):
        status, payload = self._post(
            FollowUpStore({"id": "task-1", "conversation_id": "other", "status": "completed"}),
            {
                "message": "Continue this",
                "conversation_id": "current",
                "workspace": "general",
                "output_token_limits": {},
                "follow_up_task_id": "task-1",
            },
        )

        self.assertEqual(status, 404)
        self.assertIn("этом диалоге", payload["error"])

    def test_follow_up_rejects_task_that_is_still_active(self):
        status, payload = self._post(
            FollowUpStore({"id": "task-1", "conversation_id": "current", "status": "running"}),
            {
                "message": "Continue this",
                "conversation_id": "current",
                "workspace": "general",
                "output_token_limits": {},
                "follow_up_task_id": "task-1",
            },
        )

        self.assertEqual(status, 409)
        self.assertIn("дождись завершения", payload["error"])


if __name__ == "__main__":
    unittest.main()
