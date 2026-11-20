import json
import os
import tempfile
import threading
import unittest
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app import EntropyHandler
from entropy_app.database import create_database_engine
from entropy_app.store import Store


class CareerApplicationsApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp_dir.cleanup)
        database_path = Path(self.temp_dir.name) / "career-api.db"
        database_url = f"sqlite:///{database_path.as_posix()}"
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(Config("alembic.ini"), "head")
        engine = create_database_engine(database_url)
        self.addCleanup(engine.dispose)
        self.store = Store(engine)
        self.store.ensure_conversation("entropy-career-workspace", "Career search")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), EntropyHandler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join, timeout=2)
        self.addCleanup(self.server.shutdown)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def _request(self, method, path, payload=None, headers=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request_headers = {"Content-Type": "application/json"} if body is not None else {}
        request_headers.update(headers or {})
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers=request_headers,
        )
        return urlopen(request, timeout=3)

    def test_create_list_and_update_application(self):
        payload = {
            "company": "Example",
            "job_title": "Backend developer",
            "job_description": "Kafka and event processing.\nDistributed team.",
            "source_url": "https://jobs.example/42",
            "contact_name": "Recruiter",
            "contact_url": "https://www.linkedin.com/in/recruiter",
            "conversation_id": "entropy-career-workspace",
            "follow_up_date": "2026-11-20",
        }
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications", payload) as response:
                created = json.loads(response.read().decode("utf-8"))["application"]
                self.assertEqual(response.status, 201)
                self.assertEqual(created["contact_name"], "Recruiter")
                self.assertEqual(created["job_description"], "Kafka and event processing.\nDistributed team.")
                self.assertNotIn("search_key", created)
            update_path = f"/api/career/applications/{created['id']}"
            with self._request("PATCH", update_path, {
                "status": "interview",
                "follow_up_date": None,
                "contact_name": "Hiring manager",
            }) as response:
                updated = json.loads(response.read().decode("utf-8"))["application"]
            with self._request("GET", "/api/career/applications") as response:
                applications = json.loads(response.read().decode("utf-8"))["applications"]
            with self._request("GET", f"/api/career/applications?{urlencode({'search': 'DISTRIBUTED TEAM'})}") as response:
                search_results = json.loads(response.read().decode("utf-8"))["applications"]
            with self._request("GET", f"{update_path}/activity") as response:
                activity = json.loads(response.read().decode("utf-8"))["events"]

        self.assertEqual(updated["status"], "interview")
        self.assertNotIn("search_key", updated)
        self.assertEqual(updated["contact_name"], "Hiring manager")
        self.assertEqual(updated["contact_url"], "https://www.linkedin.com/in/recruiter")
        self.assertIsNone(updated["follow_up_date"])
        self.assertEqual(applications[0]["id"], created["id"])
        self.assertEqual(applications[0]["job_description"], created["job_description"])
        self.assertEqual([item["id"] for item in search_results], [created["id"]])
        self.assertEqual(applications[0]["contact_name"], "Hiring manager")
        self.assertNotIn("search_key", applications[0])
        self.assertEqual(applications[0]["conversation_id"], "entropy-career-workspace")
        self.assertEqual(
            {event["event_type"] for event in activity},
            {"created", "status_changed", "follow_up_changed"},
        )

    def test_conversation_link_changes_appear_in_application_activity(self):
        conversation_id = f"entropy-career-{uuid.uuid4()}"
        self.store.ensure_conversation(conversation_id, "Career review")
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications", {
                "company": "Example",
                "job_title": "Backend developer",
            }) as response:
                application = json.loads(response.read().decode("utf-8"))["application"]
            path = f"/api/career/applications/{application['id']}"
            with self._request("PATCH", path, {"conversation_id": conversation_id}):
                pass
            with self._request("GET", f"{path}/activity") as response:
                events = json.loads(response.read().decode("utf-8"))["events"]

        self.assertEqual(events[0]["event_type"], "conversation_linked")
        self.assertIsNone(events[0]["from_value"])
        self.assertEqual(events[0]["to_value"], conversation_id)

    def test_application_summary_counts_all_stages_and_due_follow_ups(self):
        base = {
            "source_url": "",
            "contact_name": "",
            "contact_url": "",
            "location": "",
            "salary_range": "",
            "notes": "",
            "conversation_id": None,
        }
        records = [
            ("saved", "saved", "2026-11-14"),
            ("interview", "interview", "2026-11-15"),
            ("offer", "offer", "2026-11-01"),
            ("future", "applied", "2026-11-16"),
            ("last day", "applied", "2026-11-22"),
            ("outside window", "saved", "2026-11-23"),
            ("closed", "archived", "2026-11-18"),
        ]
        for company, status, follow_up_date in records:
            self.store.create_career_application(
                str(uuid.uuid4()),
                {
                    **base,
                    "company": company,
                    "job_title": "Backend developer",
                    "status": status,
                    "follow_up_date": follow_up_date,
                },
            )

        with patch("app.STORE", self.store):
            with self._request(
                "GET",
                "/api/career/applications/summary?as_of_date=2026-11-15",
            ) as response:
                summary = json.loads(response.read().decode("utf-8"))

        self.assertEqual(summary["total_count"], 7)
        self.assertEqual(summary["status_counts"], {
            "saved": 2,
            "preparing": 0,
            "applied": 2,
            "interview": 1,
            "offer": 1,
            "rejected": 0,
            "archived": 1,
        })
        self.assertEqual(summary["due_follow_up_count"], 2)
        self.assertEqual(summary["upcoming_follow_up_count"], 2)
        self.assertEqual(summary["as_of_date"], "2026-11-15")

    def test_upcoming_follow_up_filter_is_global_and_uses_seven_day_window(self):
        base = {
            "job_title": "Backend developer",
            "source_url": "",
            "contact_name": "",
            "contact_url": "",
            "location": "",
            "salary_range": "",
            "notes": "",
            "conversation_id": None,
        }
        records = [
            ("00000000-0000-0000-0000-000000000301", "Overdue", "applied", "2026-11-14"),
            ("00000000-0000-0000-0000-000000000302", "Today", "interview", "2026-11-15"),
            ("00000000-0000-0000-0000-000000000303", "Tomorrow", "saved", "2026-11-16"),
            ("00000000-0000-0000-0000-000000000304", "Last day", "preparing", "2026-11-22"),
            ("00000000-0000-0000-0000-000000000305", "Outside", "saved", "2026-11-23"),
            ("00000000-0000-0000-0000-000000000306", "Offer", "offer", "2026-11-18"),
            ("00000000-0000-0000-0000-000000000307", "Archived", "archived", "2026-11-17"),
        ]
        for application_id, company, status, follow_up_date in records:
            self.store.create_career_application(
                application_id,
                {
                    **base,
                    "company": company,
                    "status": status,
                    "follow_up_date": follow_up_date,
                },
            )

        query = urlencode({
            "filter": "follow_up_week",
            "as_of_date": "2026-11-15",
        })
        with patch("app.STORE", self.store):
            with self._request("GET", f"/api/career/applications?{query}") as response:
                result = json.loads(response.read().decode("utf-8"))

        self.assertEqual(result["total_count"], 2)
        self.assertEqual(
            {item["company"] for item in result["applications"]},
            {"Tomorrow", "Last day"},
        )

    def test_upcoming_follow_up_filter_requires_a_valid_as_of_date(self):
        with patch("app.STORE", self.store):
            for query in (
                "filter=follow_up_week",
                "filter=follow_up_week&as_of_date=2026-02-30",
            ):
                with self.subTest(query=query):
                    with self.assertRaises(HTTPError) as error:
                        self._request("GET", f"/api/career/applications?{query}")
                    self.assertEqual(error.exception.code, 400)
                    error.exception.close()

    def test_application_summary_rejects_invalid_local_date(self):
        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as error:
                self._request(
                    "GET",
                    "/api/career/applications/summary?as_of_date=2026-02-30",
                )

        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_list_applications_uses_validated_stable_page_cursor(self):
        values = {
            "company": "Example",
            "job_title": "Backend",
            "source_url": "",
            "contact_name": "",
            "contact_url": "",
            "location": "",
            "salary_range": "",
            "status": "saved",
            "notes": "",
            "conversation_id": None,
            "follow_up_date": None,
        }
        identifiers = [str(uuid.UUID(int=index)) for index in range(1, 4)]
        for index, application_id in enumerate(identifiers):
            self.store.create_career_application(application_id, {**values, "company": f"Example {index}"})

        with patch("app.STORE", self.store):
            with self._request("GET", "/api/career/applications?limit=2") as response:
                first = json.loads(response.read().decode("utf-8"))
            self.assertTrue(first["has_more"])
            self.assertIsNotNone(first["next_cursor"])
            query = urlencode({
                "limit": 2,
                "before_created_at": first["next_cursor"]["created_at"],
                "before_id": first["next_cursor"]["id"],
            })
            with self._request("GET", f"/api/career/applications?{query}") as response:
                second = json.loads(response.read().decode("utf-8"))

        self.assertFalse(second["has_more"])
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(
            {item["id"] for item in first["applications"] + second["applications"]},
            {item["id"] for item in self.store.list_career_applications()},
        )
        self.assertEqual(len(first["applications"] + second["applications"]), 3)

    def test_list_applications_filters_globally_and_reports_match_count(self):
        base = {
            "job_title": "Backend developer",
            "source_url": "",
            "contact_name": "",
            "contact_url": "",
            "location": "",
            "salary_range": "",
            "notes": "",
            "conversation_id": None,
            "follow_up_date": None,
        }
        records = [
            ("00000000-0000-0000-0000-000000000201", {**base, "company": "Альфа", "status": "applied", "follow_up_date": "2026-11-14"}),
            ("00000000-0000-0000-0000-000000000202", {**base, "company": "Бета", "contact_name": "Алия Иванова", "status": "interview", "follow_up_date": "2026-11-15"}),
            ("00000000-0000-0000-0000-000000000203", {**base, "company": "Гамма", "status": "offer", "follow_up_date": "2026-11-14"}),
        ]
        with patch("entropy_app.store.now", return_value="2026-11-15T00:00:00+00:00"):
            for application_id, values in records:
                self.store.create_career_application(application_id, values)

        search_query = urlencode({"search": "АЛИЯ"})
        due_query = urlencode({"filter": "follow_up", "as_of_date": "2026-11-15", "limit": 1})
        with patch("app.STORE", self.store):
            with self._request("GET", f"/api/career/applications?{search_query}") as response:
                searched = json.loads(response.read().decode("utf-8"))
            with self._request("GET", f"/api/career/applications?{due_query}") as response:
                due = json.loads(response.read().decode("utf-8"))

        self.assertEqual(searched["total_count"], 1)
        self.assertEqual(searched["applications"][0]["contact_name"], "Алия Иванова")
        self.assertEqual(due["total_count"], 2)
        self.assertEqual(len(due["applications"]), 1)
        self.assertTrue(due["has_more"])

    def test_list_applications_rejects_invalid_page_parameters(self):
        with patch("app.STORE", self.store):
            for path in (
                "/api/career/applications?limit=101",
                "/api/career/applications?unknown=1",
                "/api/career/applications?filter=unknown",
                "/api/career/applications?filter=follow_up",
                "/api/career/applications?filter=all&as_of_date=2026-11-15",
                f"/api/career/applications?search={'x' * 201}",
                "/api/career/applications?before_id=00000000-0000-0000-0000-000000000001",
                "/api/career/applications?before_created_at=2026-11-15T00%3A00%3A00%2B00%3A00&before_id=not-a-uuid",
            ):
                with self.subTest(path=path), self.assertRaises(HTTPError) as response:
                    self._request("GET", path)
                self.assertEqual(response.exception.code, 400)
                response.exception.close()

    def test_csv_import_validates_every_row_before_saving_any(self):
        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as response:
                self._request("POST", "/api/career/applications/import", {
                    "rows": [
                        {"row_number": 2, "values": {"company": "Example", "job_title": "Backend"}},
                        {"row_number": 3, "values": {"company": "Missing title", "job_title": ""}},
                    ],
                })
            payload = json.loads(response.exception.read().decode("utf-8"))
            response.exception.close()
            applications = self.store.list_career_applications()

        self.assertEqual(response.exception.code, 400)
        self.assertIn("Строка 3", payload["error"])
        self.assertIn("Ни одна запись не сохранена", payload["error"])
        self.assertEqual(applications, [])

    def test_career_api_rejects_nul_text_before_database_write(self):
        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as create_response:
                self._request("POST", "/api/career/applications", {
                    "company": "Unsafe\x00Company",
                    "job_title": "Backend",
                })
            create_payload = json.loads(create_response.exception.read().decode("utf-8"))
            create_response.exception.close()

            with self.assertRaises(HTTPError) as import_response:
                self._request("POST", "/api/career/applications/import", {
                    "rows": [
                        {"row_number": 2, "values": {"company": "Valid", "job_title": "Backend"}},
                        {"row_number": 3, "values": {"company": "Also valid", "job_title": "Platform", "notes": "Unsafe\x00note"}},
                    ],
                })
            import_payload = json.loads(import_response.exception.read().decode("utf-8"))
            import_response.exception.close()
            applications = self.store.list_career_applications()

        self.assertEqual(create_response.exception.code, 400)
        self.assertIn("недопустимый нулевой символ", create_payload["error"])
        self.assertIn("название компании", create_payload["error"])
        self.assertEqual(import_response.exception.code, 400)
        self.assertIn("Строка 3", import_payload["error"])
        self.assertIn("Ни одна запись не сохранена", import_payload["error"])
        self.assertIn("заметки", import_payload["error"])
        self.assertEqual(applications, [])

    def test_career_application_writes_reject_cross_site_browser_origins(self):
        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as response:
                self._request(
                    "POST",
                    "/api/career/applications",
                    {"company": "Example", "job_title": "Backend"},
                    headers={"Origin": "https://untrusted.example"},
                )
            create_payload = json.loads(response.exception.read().decode("utf-8"))
            response.exception.close()

            with self._request("POST", "/api/career/applications", {"company": "Example", "job_title": "Backend"}) as created_response:
                application = json.loads(created_response.read().decode("utf-8"))["application"]
            with self.assertRaises(HTTPError) as patch_response:
                self._request(
                    "PATCH",
                    f"/api/career/applications/{application['id']}",
                    {"status": "applied"},
                    headers={"Origin": "https://untrusted.example"},
                )
            patch_payload = json.loads(patch_response.exception.read().decode("utf-8"))
            patch_response.exception.close()

            with self.assertRaises(HTTPError) as import_response:
                self._request(
                    "POST",
                    "/api/career/applications/import",
                    {"rows": [{"row_number": 2, "values": {"company": "Example", "job_title": "Backend"}}]},
                    headers={"Origin": "https://untrusted.example"},
                )
            import_payload = json.loads(import_response.exception.read().decode("utf-8"))
            import_response.exception.close()
            applications = self.store.list_career_applications()

        self.assertEqual(response.exception.code, 403)
        self.assertEqual(patch_response.exception.code, 403)
        self.assertEqual(import_response.exception.code, 403)
        for payload in (create_payload, patch_payload, import_payload):
            self.assertIn("локального рабочего пространства", payload["error"])
        self.assertEqual(applications[0]["status"], "saved")
        self.assertEqual(len(applications), 1)

    def test_career_application_accepts_configured_compose_frontend_port(self):
        origin_headers = {"Origin": "http://127.0.0.1:5186"}
        payload = {"company": "Example", "job_title": "Backend"}

        with patch("app.STORE", self.store), patch.dict(os.environ, {"ENTROPY_LOCAL_FRONTEND_PORT": ""}):
            with self.assertRaises(HTTPError) as unconfigured_response:
                self._request("POST", "/api/career/applications", payload, headers=origin_headers)
            unconfigured_response.exception.close()

            with patch.dict(os.environ, {"ENTROPY_LOCAL_FRONTEND_PORT": "5186"}):
                with self._request("POST", "/api/career/applications", payload, headers=origin_headers) as response:
                    created = json.loads(response.read().decode("utf-8"))["application"]

        self.assertEqual(unconfigured_response.exception.code, 403)
        self.assertEqual(response.status, 201)
        self.assertEqual(created["company"], "Example")

    def test_csv_import_commits_all_rows_and_creation_history(self):
        rows = [
            {"row_number": 2, "values": {"company": "Example A", "job_title": "Backend", "status": "applied"}},
            {"row_number": 3, "values": {"company": "Example B", "job_title": "Platform", "follow_up_date": "2026-11-20"}},
        ]
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications/import", {"rows": rows}) as response:
                payload = json.loads(response.read().decode("utf-8"))
            activity = [self.store.list_career_application_activity(item["id"]) for item in payload["applications"]]

        self.assertEqual(response.status, 201)
        self.assertEqual(payload["imported_count"], 2)
        self.assertEqual([item["company"] for item in payload["applications"]], ["Example A", "Example B"])
        self.assertEqual([[event["event_type"] for event in history] for history in activity], [["created"], ["created"]])

    def test_csv_import_rolls_back_the_whole_batch_on_database_failure(self):
        with self.store.engine.begin() as db:
            db.execute(text("""
                CREATE TRIGGER fail_one_career_import
                BEFORE INSERT ON career_applications
                WHEN NEW.company = 'Reject this row'
                BEGIN
                    SELECT RAISE(ABORT, 'injected import failure');
                END;
            """))

        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as response:
                self._request("POST", "/api/career/applications/import", {
                    "rows": [
                        {"row_number": 2, "values": {"company": "Would be inserted first", "job_title": "Backend"}},
                        {"row_number": 3, "values": {"company": "Reject this row", "job_title": "Platform"}},
                    ],
                })
            payload = json.loads(response.exception.read().decode("utf-8"))
            response.exception.close()
            applications = self.store.list_career_applications()

        self.assertEqual(response.exception.code, 503)
        self.assertIn("откатила всю операцию", payload["error"])
        self.assertEqual(applications, [])

    def test_new_career_chat_can_be_linked_back_to_its_application(self):
        with patch("app.STORE", self.store), patch("app.WORKERS.submit") as submit:
            with self._request("POST", "/api/career/applications", {
                "company": "Example",
                "job_title": "Backend developer",
            }) as response:
                application = json.loads(response.read().decode("utf-8"))["application"]

            conversation_id = f"entropy-career-{uuid.uuid4()}"
            with self._request("POST", "/api/chat", {
                "message": "Разбери вакансию Backend developer в Example.",
                "conversation_id": conversation_id,
                "workspace": "career",
                "output_token_limits": {"entropy": 300, "veltrics": 300, "psyche": 300},
            }) as response:
                chat = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 202)

            with self._request(
                "PATCH",
                f"/api/career/applications/{application['id']}",
                {"conversation_id": chat["conversation_id"]},
            ) as response:
                updated = json.loads(response.read().decode("utf-8"))["application"]

            with self._request("GET", f"/api/conversations/{conversation_id}") as response:
                messages = json.loads(response.read().decode("utf-8"))["messages"]

        submit.assert_called_once()
        self.assertEqual(chat["conversation_id"], conversation_id)
        self.assertEqual(updated["conversation_id"], conversation_id)
        self.assertEqual(messages[0]["conversation_id"], conversation_id)
        self.assertEqual(messages[0]["speaker"], "Kars")

    def test_api_returns_not_found_for_unknown_application_activity(self):
        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as response:
                self._request("GET", "/api/career/applications/00000000-0000-0000-0000-000000000000/activity")
        self.assertEqual(response.exception.code, 404)
        response.exception.close()

    def test_manual_career_activity_is_saved_and_returned_in_history(self):
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications", {
                "company": "Example",
                "job_title": "Backend developer",
            }) as response:
                application = json.loads(response.read().decode("utf-8"))["application"]
            activity_url = f"/api/career/applications/{application['id']}/activity"
            with self._request("POST", activity_url, {
                "activity_type": "interview",
                "note": "  Обсудили команду и следующий этап.  ",
            }) as response:
                created_event = json.loads(response.read().decode("utf-8"))["event"]
            with self._request("GET", activity_url) as response:
                events = json.loads(response.read().decode("utf-8"))["events"]

        self.assertEqual(response.status, 200)
        self.assertEqual(created_event["event_type"], "manual_interview")
        self.assertEqual(created_event["note"], "Обсудили команду и следующий этап.")
        self.assertEqual(events[0], created_event)

    def test_manual_career_activity_rejects_invalid_data_without_writing(self):
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications", {
                "company": "Example",
                "job_title": "Backend developer",
            }) as response:
                application = json.loads(response.read().decode("utf-8"))["application"]
            activity_url = f"/api/career/applications/{application['id']}/activity"
            with self.assertRaises(HTTPError) as invalid_type:
                self._request("POST", activity_url, {"activity_type": "offer_claimed", "note": "Offer"})
            invalid_type.exception.close()
            with self.assertRaises(HTTPError) as blank_note:
                self._request("POST", activity_url, {"activity_type": "contact", "note": "  "})
            blank_note.exception.close()
            events = self.store.list_career_application_activity(application["id"])

        self.assertEqual(invalid_type.exception.code, 400)
        self.assertEqual(blank_note.exception.code, 400)
        self.assertEqual([event["event_type"] for event in events], ["created"])

    def test_manual_career_activity_rejects_non_local_origin(self):
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications", {
                "company": "Example",
                "job_title": "Backend developer",
            }) as response:
                application = json.loads(response.read().decode("utf-8"))["application"]
            with self.assertRaises(HTTPError) as response:
                self._request(
                    "POST",
                    f"/api/career/applications/{application['id']}/activity",
                    {"activity_type": "contact", "note": "Sent a message"},
                    headers={"Origin": "https://attacker.example"},
                )
            payload = json.loads(response.exception.read().decode("utf-8"))
            response.exception.close()
            events = self.store.list_career_application_activity(application["id"])

        self.assertEqual(response.exception.code, 403)
        self.assertIn("локального рабочего пространства", payload["error"])
        self.assertEqual([event["event_type"] for event in events], ["created"])

    def test_career_tracker_reads_reject_non_local_origin(self):
        with patch("app.STORE", self.store):
            with self._request("POST", "/api/career/applications", {
                "company": "Example",
                "job_title": "Backend developer",
            }) as response:
                application = json.loads(response.read().decode("utf-8"))["application"]

            paths = (
                "/api/career/applications",
                "/api/career/applications/summary?as_of_date=2026-11-15",
                f"/api/career/applications/{application['id']}/activity",
            )
            failures = []
            for path in paths:
                with self.assertRaises(HTTPError) as response:
                    self._request("GET", path, headers={"Origin": "https://attacker.example"})
                failures.append(response.exception)

        self.assertEqual([error.code for error in failures], [403, 403, 403])
        for error in failures:
            payload = json.loads(error.read().decode("utf-8"))
            error.close()
            self.assertIn("локального рабочего пространства", payload["error"])

    def test_api_rejects_invalid_follow_up_date(self):
        with patch("app.STORE", self.store):
            with self.assertRaises(HTTPError) as response:
                self._request("POST", "/api/career/applications", {
                    "company": "Example",
                    "job_title": "Backend",
                    "follow_up_date": "2026-02-30",
                })
        self.assertEqual(response.exception.code, 400)
        response.exception.close()

    def test_api_rejects_invalid_urls_and_nonexistent_conversation_links(self):
        with patch("app.STORE", self.store):
            bad_url = {
                "company": "Example",
                "job_title": "Backend",
                "source_url": "http://jobs.example/42",
            }
            with self.assertRaises(HTTPError) as invalid_url_response:
                self._request("POST", "/api/career/applications", bad_url)
            self.assertEqual(invalid_url_response.exception.code, 400)
            invalid_url_response.exception.close()

            bad_contact_url = {
                "company": "Example",
                "job_title": "Backend",
                "contact_url": "http://linkedin.example/person",
            }
            with self.assertRaises(HTTPError) as invalid_contact_response:
                self._request("POST", "/api/career/applications", bad_contact_url)
            contact_error = json.loads(invalid_contact_response.exception.read().decode("utf-8"))
            invalid_contact_response.exception.close()

            missing_conversation = {
                "company": "Example",
                "job_title": "Backend",
                "conversation_id": "entropy-career-00000000-0000-0000-0000-000000000000",
            }
            with self.assertRaises(HTTPError) as missing_link_response:
                self._request("POST", "/api/career/applications", missing_conversation)
            payload = json.loads(missing_link_response.exception.read().decode("utf-8"))
            missing_link_response.exception.close()

        self.assertEqual(missing_link_response.exception.code, 400)
        self.assertIn("разбор не найден", payload["error"])
        self.assertEqual(invalid_contact_response.exception.code, 400)
        self.assertIn("профиль контакта", contact_error["error"])


if __name__ == "__main__":
    unittest.main()
