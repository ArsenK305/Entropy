import http.client
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from sqlalchemy.exc import OperationalError

from app import EntropyHandler, _utc_day_start, load_project_context, project_context_sources
from entropy_app.store import IdempotencyConflict


class UnavailableStore:
    def list_conversations(self):
        raise OperationalError("SELECT 1", {}, RuntimeError("database details"))

    def get_conversation(self, conversation_id):
        del conversation_id
        raise OperationalError("SELECT 1", {}, RuntimeError("database details"))

    def conversation_exists(self, conversation_id):
        del conversation_id
        raise OperationalError("SELECT 1", {}, RuntimeError("database details"))


class UnavailableTaskStore:
    def get_task(self, task_id):
        del task_id
        raise OperationalError("SELECT 1", {}, RuntimeError("database details"))


class RecentListIndependentConversationStore:
    def get_conversation(self, conversation_id):
        if conversation_id != "older-conversation":
            return None
        return {
            "id": conversation_id,
            "title": "Old saved chat",
            "created_at": "2000-01-01T00:00:00+00:00",
            "updated_at": "2000-01-01T00:00:00+00:00",
        }

    def list_conversation_messages(self, conversation_id):
        return [{"speaker": "Kars", "body": f"History for {conversation_id}"}]

    def list_conversations(self):
        raise AssertionError("Conversation history must not load the recent list")


class ConversationHistoryStore:
    def list_conversation_page(self, workspace, cursor):
        if workspace == "career" and cursor is None:
            return ([{
                "id": "entropy-career-older",
                "title": "Older career analysis",
                "created_at": "2026-11-01T00:00:00+00:00",
                "updated_at": "2026-11-02T00:00:00+00:00",
            }], True)
        return ([], False)


class OrderStore:
    def __init__(self):
        self.events = []
        self.orders_by_request_id = {}
        self.create_calls = 0

    def create_order(
        self, order_id, product_id, product_name, source,
        request_id=None, dispatch_requested=False,
    ):
        self.create_calls += 1
        if request_id and request_id in self.orders_by_request_id:
            existing = self.orders_by_request_id[request_id]
            if existing["product_id"] != product_id:
                raise IdempotencyConflict("Request ID was reused for another product.")
            return existing, False
        order = {
            "id": order_id,
            "product_id": product_id,
            "product_name": product_name,
            "status": "submitted",
            "source": source,
        }
        if request_id:
            self.orders_by_request_id[request_id] = order
        if dispatch_requested:
            self.events.append(((order_id, "n8n", "workflow.dispatch_queued", "waiting", "Queued."), {}))
        return order, True

    def add_observability_event(self, *args, **kwargs):
        self.events.append((args, kwargs))


class AppStateTests(unittest.TestCase):
    def _server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), EntropyHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, timeout=2)
        self.addCleanup(server.shutdown)
        return server

    def test_health_returns_ok_when_database_is_reachable(self):
        server = self._server()

        with patch("app.DATABASE_ENGINE.connect") as connect:
            with urlopen(f"http://127.0.0.1:{server.server_port}/health", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"status": "ok", "database": "ok"})
        connect.assert_called_once()
        connect.return_value.__enter__.return_value.execute.assert_called_once()

    def test_liveness_health_does_not_depend_on_database(self):
        server = self._server()

        with patch(
            "app.DATABASE_ENGINE.connect",
            side_effect=AssertionError("database should not be queried"),
        ) as connect:
            with urlopen(f"http://127.0.0.1:{server.server_port}/health/live", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"status": "ok"})
        connect.assert_not_called()

    def test_frontend_routes_explain_when_react_build_is_missing(self):
        server = self._server()
        with tempfile.TemporaryDirectory() as temp_dir:
            missing_build = Path(temp_dir) / "dist"
            with patch("app.BUILT_FRONTEND", missing_build):
                for path in ("/", "/argus", "/miniapp?preview=1"):
                    with self.assertRaises(HTTPError) as response:
                        urlopen(f"http://127.0.0.1:{server.server_port}{path}", timeout=2)

                    self.assertEqual(response.exception.code, 503, path)
                    body = response.exception.read().decode("utf-8")
                    response.exception.close()
                    self.assertIn("Актуальный интерфейс ещё не собран", body, path)
                    self.assertIn("npm run dev", body, path)

    def test_legacy_static_prototype_is_not_served_as_a_fallback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing_build = Path(temp_dir) / "dist"
            with patch("app.BUILT_FRONTEND", missing_build):
                server = self._server()

                with self.assertRaises(HTTPError) as response:
                    urlopen(f"http://127.0.0.1:{server.server_port}/app.js", timeout=2)

                self.assertEqual(response.exception.code, 404)
                response.exception.close()

    def test_frontend_routes_serve_the_current_react_build_when_available(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            build_dir = Path(temp_dir) / "dist"
            build_dir.mkdir()
            (build_dir / "index.html").write_text(
                "<!doctype html><title>Current React build</title>", encoding="utf-8"
            )
            with patch("app.BUILT_FRONTEND", build_dir):
                server = self._server()
                for path in ("/", "/argus", "/miniapp?preview=1"):
                    with urlopen(f"http://127.0.0.1:{server.server_port}{path}", timeout=2) as response:
                        body = response.read().decode("utf-8")

                    self.assertEqual(response.status, 200, path)
                    self.assertIn("Current React build", body, path)

    def test_miniapp_catalog_exposes_the_mock_product_concept(self):
        server = self._server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/catalog",
            headers={"CF-Ray": "public-tunnel-test"},
        )

        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 200)
        self.assertEqual(
            [product["id"] for product in payload["products"]],
            ["entropy-box", "career-module-candidate", "knowledge-module-candidate"],
        )
        self.assertTrue(all("price" not in product for product in payload["products"]))

    def test_disabled_telegram_token_is_not_reported_as_configured(self):
        server = self._server()
        request = Request(f"http://127.0.0.1:{server.server_port}/api/miniapp/catalog")

        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": " disabled "}):
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertFalse(payload["telegram_configured"])

    def test_cloudflare_tunnel_cannot_read_private_workspace_state(self):
        server = self._server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/state",
            headers={"CF-Ray": "public-tunnel-test"},
        )

        with self.assertRaises(HTTPError) as response:
            urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 403)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertNotIn("conversations", payload)

    def test_cloudflare_tunnel_blocks_career_rag_and_event_reads(self):
        server = self._server()
        requests = (
            ("GET", "/api/career/applications", None),
            ("GET", "/api/career/applications/summary?as_of_date=2026-11-15", None),
            ("GET", "/api/memory?workspace=career", None),
            ("POST", "/api/memory/preferences", b'{"workspace":"general","source_id":"career-profile","enabled":true}'),
            ("POST", "/api/rag/search", b'{"scope":"career","question":"test"}'),
            ("GET", "/api/observability/events", None),
        )

        for method, path, body in requests:
            with self.subTest(method=method, path=path):
                headers = {"CF-Connecting-IP": "203.0.113.10"}
                if body is not None:
                    headers["Content-Type"] = "application/json"
                request = Request(
                    f"http://127.0.0.1:{server.server_port}{path}",
                    data=body,
                    headers=headers,
                    method=method,
                )

                with self.assertRaises(HTTPError) as response:
                    urlopen(request, timeout=2)

                self.assertEqual(response.exception.code, 403)
                response.exception.close()

    def test_memory_context_is_reviewable_and_career_profile_is_opt_in_for_general(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "data").mkdir()
            (root / "AGENTS.md").write_text("Project rules", encoding="utf-8")
            (root / "docs" / "CHARTER.md").write_text("Project purpose", encoding="utf-8")
            (root / "docs" / "MVP.md").write_text("Product scope", encoding="utf-8")
            (root / "LEARNING.md").write_text("Current progress\n\n## Дорожная карта\nLong roadmap", encoding="utf-8")
            (root / "data" / "entropy_memory.md").write_text("Stable preference", encoding="utf-8")
            (root / "data" / "career_profile.md").write_text("Career-only profile", encoding="utf-8")

            with patch("app.ROOT", root), patch("app.STORE.list_memory_source_preferences", return_value={}):
                general_sources = project_context_sources("general")
                career_sources = project_context_sources("career")
                general_context = load_project_context("general")
                career_context = load_project_context("career")

            with patch("app.ROOT", root), patch("app.STORE.list_memory_source_preferences", return_value={"career-profile": True}):
                enabled_general_sources = project_context_sources("general", {"career-profile": True})
                enabled_general_context = load_project_context("general")

        general_ids = {source["id"] for source in general_sources}
        career_ids = {source["id"] for source in career_sources}
        self.assertIn("continuity-memory", general_ids)
        self.assertIn("career-profile", general_ids)
        self.assertIn("career-profile", career_ids)
        general_profile = next(source for source in general_sources if source["id"] == "career-profile")
        career_profile = next(source for source in career_sources if source["id"] == "career-profile")
        enabled_profile = next(source for source in enabled_general_sources if source["id"] == "career-profile")
        self.assertFalse(general_profile["selected"])
        self.assertFalse(general_profile["included"])
        self.assertTrue(general_profile["sensitive"])
        self.assertTrue(career_profile["selected"])
        self.assertTrue(career_profile["included"])
        self.assertTrue(enabled_profile["included"])
        self.assertIn("Stable preference", general_context)
        self.assertNotIn("Career-only profile", general_context)
        self.assertIn("Career-only profile", career_context)
        self.assertIn("Career-only profile", enabled_general_context)
        self.assertNotIn("Long roadmap", general_context)

    def test_memory_endpoint_shows_sensitive_profile_disabled_in_general(self):
        server = self._server()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            (root / "data" / "career_profile.md").write_text("Private test profile", encoding="utf-8")
            with (
                patch("app.ROOT", root),
                patch("app.STORE.list_memory_source_preferences", return_value={}),
                patch("app.rag.configured", return_value=False),
                patch("app.rag.ready", return_value=False),
                patch("app.rag.authentication_configured", return_value=False),
            ):
                with urlopen(f"http://127.0.0.1:{server.server_port}/api/memory?workspace=general", timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))

        profile = next(source for source in payload["sources"] if source["id"] == "career-profile")
        self.assertEqual(response.status, 200)
        self.assertFalse(profile["selected"])
        self.assertFalse(profile["included"])
        self.assertTrue(profile["sensitive"])

    def test_memory_endpoint_returns_local_sources_without_prompt_metadata(self):
        server = self._server()
        sources = [
            {
                "id": "career-profile",
                "title": "Карьерный профиль",
                "path": "data/career_profile.md",
                "purpose": "Career only",
                "content": "Local profile",
                "available": True,
                "included": True,
                "truncated": False,
                "modified_at": None,
                "included_in": ["career"],
                "prompt_heading": "internal heading",
            }
        ]
        with (
            patch("app.project_context_sources", return_value=sources),
            patch("app.STORE.list_memory_source_preferences", return_value={}),
            patch("app.rag.configured", return_value=True),
            patch.dict("os.environ", {"ENTROPY_RAG_WEBHOOK_TOKEN": "configured-token"}),
        ):
            with urlopen(f"http://127.0.0.1:{server.server_port}/api/memory?workspace=career", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(payload["workspace"], "career")
        self.assertEqual(payload["history_limit"], 12)
        self.assertEqual(payload["sources"][0]["content"], "Local profile")
        self.assertNotIn("prompt_heading", payload["sources"][0])
        dynamic = {source["id"]: source for source in payload["dynamic_sources"]}
        self.assertTrue(dynamic["career-rag"]["enabled"])
        self.assertTrue(dynamic["career-rag"]["endpoint_configured"])
        self.assertTrue(dynamic["career-rag"]["authentication_configured"])
        self.assertFalse(dynamic["career-rag"]["connection_verified"])
        self.assertEqual(dynamic["conversation-history"]["enabled"], True)
        self.assertIn("12 предыдущих сообщений", dynamic["conversation-history"]["description"])

    def test_memory_endpoint_distinguishes_rag_url_from_missing_token(self):
        server = self._server()
        with (
            patch("app.STORE.list_memory_source_preferences", return_value={}),
            patch("app.rag.configured", return_value=True),
            patch.dict("os.environ", {"ENTROPY_RAG_WEBHOOK_TOKEN": ""}),
        ):
            with urlopen(f"http://127.0.0.1:{server.server_port}/api/memory?workspace=career", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        career_rag = next(source for source in payload["dynamic_sources"] if source["id"] == "career-rag")
        self.assertTrue(career_rag["endpoint_configured"])
        self.assertFalse(career_rag["authentication_configured"])
        self.assertFalse(career_rag["enabled"])
        self.assertFalse(career_rag["connection_verified"])

    def test_rag_search_endpoint_does_not_send_request_with_disabled_token(self):
        server = self._server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/rag/search",
            data=json.dumps({"scope": "career", "question": "Покажи мой опыт"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with (
            patch.dict(
                "os.environ",
                {
                    "ENTROPY_RAG_SEARCH_WEBHOOK_URL": "https://n8n.example/webhook",
                    "ENTROPY_RAG_WEBHOOK_TOKEN": " Disabled ",
                },
            ),
            patch("app.rag.urlopen") as open_url,
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 503)
        self.assertIn("ENTROPY_RAG_WEBHOOK_TOKEN", response.exception.read().decode("utf-8"))
        response.exception.close()
        open_url.assert_not_called()

    def test_memory_endpoint_rejects_unknown_workspace(self):
        server = self._server()
        with self.assertRaises(HTTPError) as response:
            urlopen(f"http://127.0.0.1:{server.server_port}/api/memory?workspace=admin", timeout=2)

        self.assertEqual(response.exception.code, 400)
        response.exception.close()

    def test_memory_preference_endpoint_persists_an_explicit_selection(self):
        server = self._server()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            (root / "data" / "career_profile.md").write_text("Private test profile", encoding="utf-8")
            request = Request(
                f"http://127.0.0.1:{server.server_port}/api/memory/preferences",
                data=json.dumps({"workspace": "general", "source_id": "career-profile", "enabled": True}).encode("utf-8"),
                headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:5174"},
                method="POST",
            )
            with (
                patch("app.ROOT", root),
                patch("app.STORE.set_memory_source_preference") as save_preference,
                patch("app.STORE.list_memory_source_preferences", return_value={"career-profile": True}),
            ):
                with urlopen(request, timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"source_id": "career-profile", "selected": True, "included": True})
        save_preference.assert_called_once_with("general", "career-profile", True)

    def test_memory_preference_endpoint_rejects_remote_browser_origin(self):
        server = self._server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/memory/preferences",
            data=b'{"workspace":"general","source_id":"career-profile","enabled":true}',
            headers={"Content-Type": "application/json", "Origin": "https://attacker.example"},
            method="POST",
        )
        with patch("app.STORE.set_memory_source_preference") as save_preference:
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 403)
        response.exception.close()
        save_preference.assert_not_called()

    def test_memory_preference_endpoint_rejects_invalid_values_and_missing_files(self):
        server = self._server()
        bad_payloads = (
            {"workspace": "general", "source_id": "career-profile", "enabled": 1},
            {"workspace": "admin", "source_id": "career-profile", "enabled": True},
            {"workspace": "general", "source_id": "unknown", "enabled": True},
        )
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                request = Request(
                    f"http://127.0.0.1:{server.server_port}/api/memory/preferences",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(HTTPError) as response:
                    urlopen(request, timeout=2)
                self.assertEqual(response.exception.code, 400)
                response.exception.close()

        with tempfile.TemporaryDirectory() as directory:
            request = Request(
                f"http://127.0.0.1:{server.server_port}/api/memory/preferences",
                data=json.dumps({"workspace": "general", "source_id": "career-profile", "enabled": True}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with patch("app.ROOT", Path(directory)), patch("app.STORE.set_memory_source_preference") as save_preference:
                with self.assertRaises(HTTPError) as response:
                    urlopen(request, timeout=2)
        self.assertEqual(response.exception.code, 400)
        response.exception.close()
        save_preference.assert_not_called()

    def test_health_returns_generic_unavailable_when_database_is_down(self):
        server = self._server()

        with patch(
            "app.DATABASE_ENGINE.connect",
            side_effect=OperationalError("SELECT 1", {}, RuntimeError("private details")),
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(f"http://127.0.0.1:{server.server_port}/health", timeout=2)

        self.assertEqual(response.exception.code, 503)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertEqual(payload, {"status": "unavailable", "database": "unavailable"})
        self.assertNotIn("private details", repr(payload))

    def test_utc_day_start_uses_browser_local_midnight(self):
        current = datetime(2026, 11, 9, 19, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _utc_day_start(360, current),
            "2026-11-09T18:00:00+00:00",
        )

    def test_utc_day_start_rejects_out_of_range_offset(self):
        with self.assertRaises(ValueError):
            _utc_day_start(900)

    def test_observability_rejects_invalid_browser_offset(self):
        server = self._server()

        with self.assertRaises(HTTPError) as response:
            urlopen(
                f"http://127.0.0.1:{server.server_port}/api/observability/events?utc_offset=900",
                timeout=2,
            )

        self.assertEqual(response.exception.code, 400)
        response.exception.close()

    def test_observability_uses_browser_local_day_boundary(self):
        server = self._server()
        since = _utc_day_start(360)
        summary = {
            "events_today": 1,
            "orders_today": 1,
            "failed_today": 0,
            "completed_workflows_today": 0,
            "active_workflows": 0,
            "active_agents": 0,
        }

        with patch("app.STORE") as store:
            store.list_observability_events.return_value = []
            store.observability_summary.return_value = summary
            with urlopen(
                f"http://127.0.0.1:{server.server_port}/api/observability/events?utc_offset=360",
                timeout=2,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(payload["summary"], summary)
        store.observability_summary.assert_called_once_with(since)

    def test_state_returns_service_unavailable_when_database_is_down(self):
        server = self._server()

        with patch("app.STORE", UnavailableStore()):
            with self.assertRaises(HTTPError) as response:
                urlopen(f"http://127.0.0.1:{server.server_port}/api/state", timeout=2)

        self.assertEqual(response.exception.code, 503)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertIn("База данных Entropy недоступна", payload["error"])
        self.assertNotIn("database details", payload["error"])

    def test_conversation_history_returns_safe_service_unavailable_when_database_is_down(self):
        server = self._server()

        with patch("app.STORE", UnavailableStore()):
            with self.assertRaises(HTTPError) as response:
                urlopen(
                    f"http://127.0.0.1:{server.server_port}/api/conversations/conversation-1",
                    timeout=2,
                )

        self.assertEqual(response.exception.code, 503)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertIn("История диалога недоступна", payload["error"])
        self.assertNotIn("database details", payload["error"])

    def test_conversation_history_loads_ids_outside_the_recent_list(self):
        server = self._server()
        with patch("app.STORE", RecentListIndependentConversationStore()):
            with urlopen(
                f"http://127.0.0.1:{server.server_port}/api/conversations/older-conversation",
                timeout=2,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 200)
        self.assertEqual(
            payload,
            {
                "conversation": {
                    "id": "older-conversation",
                    "title": "Old saved chat",
                    "created_at": "2000-01-01T00:00:00+00:00",
                    "updated_at": "2000-01-01T00:00:00+00:00",
                },
                "messages": [{"speaker": "Kars", "body": "History for older-conversation"}],
            },
        )

    def test_conversation_history_page_returns_workspace_scoped_cursor(self):
        server = self._server()
        with patch("app.STORE", ConversationHistoryStore()):
            with urlopen(
                f"http://127.0.0.1:{server.server_port}/api/conversations/history?workspace=career",
                timeout=2,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["conversations"][0]["id"], "entropy-career-older")
        self.assertTrue(payload["has_more"])
        self.assertEqual(
            payload["next_cursor"],
            {"updated_at": "2026-11-02T00:00:00+00:00", "id": "entropy-career-older"},
        )

    def test_conversation_history_rejects_invalid_cursors_before_database_access(self):
        server = self._server()
        invalid_queries = (
            "workspace=unknown",
            "workspace=general&before_updated_at=2026-11-01T00%3A00%3A00%2B00%3A00",
            f"workspace=general&before_updated_at={'x' * 65}&before_id=chat-1",
            "workspace=general&before_updated_at=not-a-date&before_id=chat-1",
            f"workspace=general&before_updated_at=2026-11-01T00%3A00%3A00%2B00%3A00&before_id={'x' * 101}",
        )

        with patch("app.STORE") as store:
            for query in invalid_queries:
                with self.subTest(query=query[:70]):
                    with self.assertRaises(HTTPError) as response:
                        urlopen(
                            f"http://127.0.0.1:{server.server_port}/api/conversations/history?{query}",
                            timeout=2,
                        )
                    self.assertEqual(response.exception.code, 400)
                    response.exception.close()

        store.list_conversation_page.assert_not_called()

    def test_task_state_returns_safe_service_unavailable_when_database_is_down(self):
        server = self._server()

        with patch("app.STORE", UnavailableTaskStore()):
            with self.assertRaises(HTTPError) as response:
                urlopen(f"http://127.0.0.1:{server.server_port}/api/tasks/task-1", timeout=2)

        self.assertEqual(response.exception.code, 503)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertIn("Состояние задачи недоступно", payload["error"])
        self.assertNotIn("database details", payload["error"])

    def test_chat_rejects_non_object_json_without_worker_crash(self):
        server = self._server()
        request = Request(f"http://127.0.0.1:{server.server_port}/api/chat", data=b"[]", method="POST")
        with self.assertRaises(HTTPError) as response:
            urlopen(request, timeout=2)
        self.assertEqual(response.exception.code, 400)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertIn("JSON-объектом", payload["error"])

    def test_chat_rejects_negative_content_length(self):
        server = self._server()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        self.addCleanup(connection.close)
        connection.request(
            "POST",
            "/api/chat",
            body=None,
            headers={"Content-Length": "-1", "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertIn("прочитать запрос", json.loads(response.read().decode("utf-8"))["error"])

    def test_chat_rejects_oversized_content_length(self):
        server = self._server()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        self.addCleanup(connection.close)
        connection.request(
            "POST",
            "/api/chat",
            body=None,
            headers={"Content-Length": "64001", "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()

    def test_local_preview_order_works_when_telegram_token_is_configured(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({"product_id": "entropy-box", "init_data": ""}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:5186",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {
                "TELEGRAM_BOT_TOKEN": "configured-bot-token",
                "ENTROPY_MINIAPP_PREVIEW": "1",
                "ENTROPY_LOCAL_FRONTEND_PORT": "5186",
            }),
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=False),
        ):
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 201)
        self.assertEqual(payload["order"]["source"], "miniapp_preview")
        self.assertEqual(payload["workflow"]["status"], "not_configured")
        self.assertEqual(len(store.events), 1)

    def test_retried_miniapp_order_returns_saved_order_without_redispatch(self):
        server = self._server()
        store = OrderStore()
        request_id = "11111111-1111-4111-8111-111111111111"

        def submit_order():
            request = Request(
                f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
                data=json.dumps({
                    "product_id": "entropy-box",
                    "init_data": "",
                    "request_id": request_id,
                }).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Origin": "http://127.0.0.1:5174",
                },
                method="POST",
            )
            with urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read().decode("utf-8"))

        with (
            patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "configured-bot-token", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=True),
            patch("app.n8n.dispatch_order", return_value=(True, "accepted", 200)) as dispatch_order,
        ):
            first_status, first = submit_order()
            replay_status, replay = submit_order()

        self.assertEqual(first_status, 201)
        self.assertEqual(replay_status, 200)
        self.assertFalse(first["replayed"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["order"]["id"], first["order"]["id"])
        self.assertEqual(replay["workflow"]["status"], "duplicate")
        dispatch_order.assert_not_called()
        self.assertEqual(first["workflow"]["status"], "queued")
        self.assertEqual(len(store.events), 1)

    def test_invalid_miniapp_order_request_id_is_rejected_before_storage(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({
                "product_id": "entropy-box",
                "init_data": "",
                "request_id": "not-a-uuid",
            }).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:5174",
            },
            method="POST",
        )

        with (
            patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "configured-bot-token", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.STORE", store),
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 400)
        response.exception.close()
        self.assertEqual(store.create_calls, 0)
        self.assertEqual(store.events, [])

    def test_miniapp_request_id_reuse_for_another_product_returns_conflict(self):
        server = self._server()
        store = OrderStore()
        request_id = "11111111-1111-4111-8111-111111111111"

        def submit_order(product_id):
            request = Request(
                f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
                data=json.dumps({
                    "product_id": product_id,
                    "init_data": "",
                    "request_id": request_id,
                }).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Origin": "http://127.0.0.1:5174",
                },
                method="POST",
            )
            return urlopen(request, timeout=2)

        with (
            patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "configured-bot-token", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=False),
        ):
            with submit_order("entropy-box") as response:
                self.assertEqual(response.status, 201)
            with self.assertRaises(HTTPError) as conflict:
                submit_order("career-module-candidate")

        self.assertEqual(conflict.exception.code, 409)
        conflict.exception.close()
        self.assertEqual(store.create_calls, 2)
        self.assertEqual(len(store.events), 1)

    def test_cloudflare_tunnel_cannot_use_local_preview_order_origin(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({"product_id": "entropy-box", "init_data": ""}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:5174",
                "CF-Ray": "public-tunnel-test",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.STORE", store),
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 503)
        response.exception.close()
        self.assertEqual(store.events, [])

    def test_cloudflare_miniapp_order_accepts_verified_telegram_launch(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({"product_id": "entropy-box", "init_data": "signed-init-data"}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "https://entropy.example",
                "CF-Ray": "public-tunnel-test",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "configured-bot-token", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.telegram_user_id", return_value=1234) as validate_init_data,
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=False),
        ):
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 201)
        self.assertEqual(payload["order"]["source"], "telegram_miniapp")
        validate_init_data.assert_called_once_with("signed-init-data", "configured-bot-token")

    def test_disabled_telegram_token_cannot_validate_public_miniapp_order(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({"product_id": "entropy-box", "init_data": "signed-with-disabled"}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "https://entropy.example",
                "CF-Ray": "public-tunnel-test",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "disabled", "ENTROPY_MINIAPP_PREVIEW": "0"}),
            patch("app.telegram_user_id") as validate_init_data,
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=False),
            patch.object(store, "create_order", wraps=store.create_order) as create_order,
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 503)
        response.exception.close()
        validate_init_data.assert_not_called()
        create_order.assert_not_called()
        self.assertEqual(store.events, [])

    def test_signed_n8n_callback_remains_available_through_cloudflare(self):
        server = self._server()
        payload = {
            "correlation_id": "order-1",
            "source": "n8n",
            "event_type": "workflow.started",
            "status": "running",
            "detail": "started",
        }
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/observability/events",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Entropy-Event-Token": "event-secret",
                "CF-Ray": "public-tunnel-test",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"ENTROPY_N8N_EVENT_TOKEN": "event-secret"}),
            patch("app.STORE") as store,
        ):
            store.get_order.return_value = {"id": "order-1"}
            with urlopen(request, timeout=2) as response:
                result = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 201)
        self.assertEqual(result, {"accepted": True})
        store.add_observability_event.assert_called_once()

    def test_duplicate_n8n_callback_returns_success_without_replaying_state_change(self):
        server = self._server()
        payload = {
            "correlation_id": "order-1",
            "source": "n8n",
            "event_type": "workflow.started",
            "status": "running",
            "detail": "started",
            "event_id": "execution-42:workflow.started",
        }

        def post_callback():
            request = Request(
                f"http://127.0.0.1:{server.server_port}/api/observability/events",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-Entropy-Event-Token": "event-secret"},
                method="POST",
            )
            with urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read().decode("utf-8"))

        with (
            patch.dict("os.environ", {"ENTROPY_N8N_EVENT_TOKEN": "event-secret"}),
            patch("app.STORE") as store,
        ):
            store.get_order.return_value = {"id": "order-1"}
            store.add_observability_event.side_effect = [True, False]
            first = post_callback()
            duplicate = post_callback()

        self.assertEqual(first, (201, {"accepted": True}))
        self.assertEqual(duplicate, (200, {"accepted": True, "duplicate": True}))
        self.assertEqual(store.add_observability_event.call_count, 2)
        self.assertEqual(
            store.add_observability_event.call_args.kwargs["idempotency_key"],
            "n8n:execution-42:workflow.started",
        )

    def test_n8n_callback_rejects_malformed_event_id(self):
        server = self._server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/observability/events",
            data=json.dumps({
                "correlation_id": "order-1",
                "source": "n8n",
                "event_type": "workflow.started",
                "status": "running",
                "detail": "started",
                "event_id": "bad id\nforged",
            }).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Entropy-Event-Token": "event-secret"},
            method="POST",
        )

        with (
            patch.dict("os.environ", {"ENTROPY_N8N_EVENT_TOKEN": "event-secret"}),
            patch("app.STORE") as store,
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 400)
        self.assertEqual(
            json.loads(response.exception.read().decode("utf-8")),
            {"error": "Событие не соответствует контракту."},
        )
        response.exception.close()
        store.get_order.assert_not_called()

    def test_disabled_n8n_callback_token_is_not_accepted_as_a_credential(self):
        server = self._server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/observability/events",
            data=json.dumps({
                "correlation_id": "order-1",
                "source": "n8n",
                "event_type": "workflow.started",
                "status": "running",
                "detail": "started",
            }).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Entropy-Event-Token": "disabled",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"ENTROPY_N8N_EVENT_TOKEN": "disabled"}),
            patch("app.STORE") as store,
        ):
            with self.assertRaises(HTTPError) as response:
                urlopen(request, timeout=2)

        self.assertEqual(response.exception.code, 503)
        self.assertEqual(json.loads(response.exception.read().decode("utf-8")), {"error": "Приём событий n8n не настроен."})
        response.exception.close()
        store.get_order.assert_not_called()

    def test_local_preview_accepts_only_the_loopback_video_preview_origin(self):
        handler = object.__new__(EntropyHandler)
        handler.client_address = ("127.0.0.1", 12345)
        with patch.dict("os.environ", {"ENTROPY_MINIAPP_PREVIEW": "1", "ENTROPY_PORT": "8767"}):
            handler.headers = {"Origin": "http://127.0.0.1:8767"}
            self.assertTrue(handler._is_local_preview_request())

        with patch.dict("os.environ", {"ENTROPY_MINIAPP_PREVIEW": "1", "ENTROPY_PORT": "8770"}):
            handler.headers = {"Origin": "http://127.0.0.1:8770"}
            self.assertTrue(handler._is_local_preview_request())
            handler.headers = {"Origin": "http://127.0.0.1:8768"}
            self.assertFalse(handler._is_local_preview_request())

        handler.client_address = ("192.0.2.10", 12345)
        handler.headers = {"Origin": "http://127.0.0.1:8767"}
        self.assertFalse(handler._is_local_preview_request())

    def test_local_preview_accepts_configured_compose_frontend_port(self):
        handler = object.__new__(EntropyHandler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {"Origin": "http://127.0.0.1:5186"}

        with patch.dict("os.environ", {
            "ENTROPY_MINIAPP_PREVIEW": "1",
            "ENTROPY_LOCAL_FRONTEND_PORT": "5186",
        }):
            self.assertTrue(handler._is_local_preview_request())

        with patch.dict("os.environ", {
            "ENTROPY_MINIAPP_PREVIEW": "1",
            "ENTROPY_LOCAL_FRONTEND_PORT": "70000",
        }):
            self.assertFalse(handler._is_local_preview_request())

    def test_saved_order_is_queued_for_n8n_without_blocking_the_request(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({"product_id": "entropy-box", "init_data": ""}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:5174",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "configured-bot-token", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=True),
            patch("app.n8n.dispatch_order", return_value=(True, "accepted", 200)) as dispatch_order,
        ):
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(payload["workflow"]["status"], "queued")
        self.assertEqual(payload["workflow"]["message"], "Заказ сохранён; передача в n8n поставлена в очередь.")
        self.assertEqual(store.events[0][0][2], "workflow.dispatch_queued")
        self.assertEqual(store.events[0][0][3], "waiting")
        dispatch_order.assert_not_called()

    def test_saved_order_does_not_fail_when_n8n_delivery_is_deferred(self):
        server = self._server()
        store = OrderStore()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/miniapp/orders",
            data=json.dumps({"product_id": "entropy-box", "init_data": ""}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:5174",
            },
            method="POST",
        )

        with (
            patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "configured-bot-token", "ENTROPY_MINIAPP_PREVIEW": "1"}),
            patch("app.STORE", store),
            patch("app.n8n.configured", return_value=True),
            patch("app.n8n.dispatch_order", return_value=(False, "rejected", 500)) as dispatch_order,
        ):
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(response.status, 201)
        self.assertEqual(payload["order"]["source"], "miniapp_preview")
        self.assertIsNone(payload["workflow"]["http_status"])
        self.assertEqual(payload["workflow"]["status"], "queued")
        self.assertNotIn("HTTP 500", payload["workflow"]["message"])
        dispatch_order.assert_not_called()


if __name__ == "__main__":
    unittest.main()
