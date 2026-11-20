import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text

from entropy_app import career
from entropy_app.database import create_database_engine
from entropy_app.store import Store


class CareerApplicationMigrationRevisionTests(unittest.TestCase):
    def test_revision_ids_fit_default_alembic_version_column(self):
        config_path = Path(__file__).resolve().parents[1] / "alembic.ini"
        revisions = ScriptDirectory.from_config(Config(str(config_path)))
        oversized = [revision.revision for revision in revisions.walk_revisions() if len(revision.revision) > 32]

        self.assertEqual(oversized, [])


class CareerApplicationValidationTests(unittest.TestCase):
    def test_create_payload_normalizes_optional_fields_and_defaults_status(self):
        payload = {"company": " Example ", "job_title": " Backend engineer "}
        result = career.validate_application_payload(payload)

        self.assertEqual(result["company"], "Example")
        self.assertEqual(result["job_title"], "Backend engineer")
        self.assertEqual(result["status"], "saved")
        self.assertEqual(result["job_description"], "")
        self.assertEqual(result["source_url"], "")
        self.assertEqual(result["contact_name"], "")
        self.assertEqual(result["contact_url"], "")
        self.assertIsNone(result["conversation_id"])

    def test_patch_accepts_a_single_status_field(self):
        result = career.validate_application_payload({"status": "interview"}, partial=True)
        self.assertEqual(result, {"status": "interview"})

    def test_follow_up_date_accepts_iso_date_and_empty_value_clears(self):
        self.assertEqual(
            career.validate_application_payload(
                {"company": "Example", "job_title": "Backend", "follow_up_date": "2026-11-20"}
            )["follow_up_date"],
            "2026-11-20",
        )
        self.assertIsNone(
            career.validate_application_payload({"follow_up_date": ""}, partial=True)["follow_up_date"]
        )
        self.assertIsNone(
            career.validate_application_payload({"follow_up_date": None}, partial=True)["follow_up_date"]
        )

    def test_follow_up_date_rejects_invalid_or_noncanonical_dates(self):
        for value in ("2026-02-30", "20261120", 20261120):
            with self.subTest(value=value), self.assertRaises(ValueError):
                career.validate_application_payload({"follow_up_date": value}, partial=True)

    def test_rejects_unknown_fields_and_invalid_status(self):
        with self.assertRaises(ValueError):
            career.validate_application_payload(
                {"company": "X", "job_title": "Y", "private": "unexpected"}
            )
        with self.assertRaises(ValueError):
            career.validate_application_payload({"status": "sent"}, partial=True)

    def test_job_description_has_a_bounded_text_contract(self):
        accepted = career.validate_application_payload({
            "company": "Example",
            "job_title": "Backend",
            "job_description": "x" * 12_000,
        })
        self.assertEqual(len(accepted["job_description"]), 12_000)
        with self.assertRaisesRegex(ValueError, "описание вакансии.*12000"):
            career.validate_application_payload({
                "company": "Example",
                "job_title": "Backend",
                "job_description": "x" * 12_001,
            })

    def test_only_accepts_https_job_urls(self):
        urls = (
            "http://jobs.example/1",
            "javascript:alert(1)",
            "https://user:pass@jobs.example/1",
        )
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                career.validate_application_payload(
                    {"company": "X", "job_title": "Y", "source_url": url}
                )

    def test_contact_profile_requires_a_safe_https_url(self):
        valid = career.validate_application_payload({
            "company": "X",
            "job_title": "Y",
            "contact_name": " Recruiter ",
            "contact_url": "https://www.linkedin.com/in/recruiter",
        })
        self.assertEqual(valid["contact_name"], "Recruiter")
        self.assertEqual(valid["contact_url"], "https://www.linkedin.com/in/recruiter")

        for url in ("http://linkedin.com/in/recruiter", "javascript:alert(1)", "https://user:pass@example.com/"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "Ссылка на профиль контакта"):
                career.validate_application_payload({
                    "company": "X",
                    "job_title": "Y",
                    "contact_url": url,
                })


class CareerApplicationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp_dir.cleanup)
        database_path = Path(self.temp_dir.name) / "career.db"
        database_url = f"sqlite:///{database_path.as_posix()}"
        config = Config("alembic.ini")
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "head")
        self.engine = create_database_engine(database_url)
        self.addCleanup(self.engine.dispose)
        self.store = Store(self.engine)

    def test_cursor_ordering_has_a_composite_index(self):
        indexes = {
            item["name"]: tuple(item["column_names"])
            for item in inspect(self.engine).get_indexes("career_applications")
        }

        self.assertEqual(
            indexes.get("ix_career_applications_created_at_id"),
            ("created_at", "id"),
        )

    def test_application_can_be_created_listed_and_updated(self):
        self.store.ensure_conversation("entropy-career-workspace", "Career search")
        payload = career.validate_application_payload({
            "company": "Example",
            "job_title": "Backend developer",
            "conversation_id": "entropy-career-workspace",
            "contact_name": "Recruiter",
            "contact_url": "https://www.linkedin.com/in/recruiter",
        })
        self.assertTrue(self.store.conversation_exists(payload["conversation_id"]))

        created = self.store.create_career_application("application-1", payload)
        updated = self.store.update_career_application("application-1", {"status": "interview"})

        self.assertEqual(created["status"], "saved")
        self.assertEqual(created["contact_name"], "Recruiter")
        self.assertEqual(created["contact_url"], "https://www.linkedin.com/in/recruiter")
        self.assertEqual(updated["status"], "interview")
        self.assertEqual(len(self.store.list_career_applications()), 1)
        self.assertEqual(
            {event["event_type"] for event in self.store.list_career_application_activity("application-1")},
            {"created", "status_changed"},
        )

    def test_application_conversation_link_changes_are_recorded(self):
        first_conversation = "entropy-career-00000000-0000-0000-0000-000000000001"
        second_conversation = "entropy-career-00000000-0000-0000-0000-000000000002"
        self.store.ensure_conversation(first_conversation, "First career review")
        self.store.ensure_conversation(second_conversation, "Second career review")
        values = career.validate_application_payload({"company": "Example", "job_title": "Backend"})
        self.store.create_career_application("application-link", values)

        linked = self.store.update_career_application(
            "application-link", {"conversation_id": first_conversation}
        )
        unchanged = self.store.update_career_application(
            "application-link", {"conversation_id": first_conversation}
        )
        relinked = self.store.update_career_application(
            "application-link", {"conversation_id": second_conversation}
        )
        unlinked = self.store.update_career_application(
            "application-link", {"conversation_id": None}
        )

        self.assertEqual(linked["conversation_id"], first_conversation)
        self.assertEqual(unchanged["conversation_id"], first_conversation)
        self.assertEqual(relinked["conversation_id"], second_conversation)
        self.assertIsNone(unlinked["conversation_id"])
        events = self.store.list_career_application_activity("application-link")
        self.assertEqual(
            [event["event_type"] for event in events],
            ["conversation_unlinked", "conversation_linked", "conversation_linked", "created"],
        )
        self.assertEqual(events[1]["from_value"], first_conversation)
        self.assertEqual(events[1]["to_value"], second_conversation)

    def test_application_pages_cover_tied_timestamps_without_gaps(self):
        values = career.validate_application_payload({"company": "Example", "job_title": "Backend"})
        for index in range(5):
            self.store.create_career_application(
                f"00000000-0000-0000-0000-{index + 1:012d}",
                {**values, "company": f"Example {index}"},
            )

        expected_ids = [
            item["id"]
            for item in sorted(
                self.store.list_career_applications(),
                key=lambda item: (item["created_at"], item["id"]),
                reverse=True,
            )
        ]
        collected_ids = []
        cursor = None
        while True:
            page = self.store.list_career_applications_page(
                limit=2,
                **(cursor or {}),
            )
            collected_ids.extend(item["id"] for item in page["applications"])
            if not page["has_more"]:
                self.assertIsNone(page["next_cursor"])
                break
            cursor = {
                "before_created_at": page["next_cursor"]["created_at"],
                "before_id": page["next_cursor"]["id"],
            }

        self.assertEqual(collected_ids, expected_ids)
        self.assertEqual(len(collected_ids), len(set(collected_ids)))

    def test_application_page_rejects_partial_cursor(self):
        with self.assertRaisesRegex(ValueError, "Cursor must include creation time and ID"):
            self.store.list_career_applications_page(before_created_at="2026-11-15T00:00:00+00:00")

    def test_application_search_uses_unicode_casefold_and_treats_wildcards_literally(self):
        values = career.validate_application_payload({"company": "Пример", "job_title": "Backend"})
        self.store.create_career_application(
            "00000000-0000-0000-0000-000000000101",
            {**values, "contact_name": "Алия Иванова"},
        )
        self.store.create_career_application(
            "00000000-0000-0000-0000-000000000102",
            {**values, "company": "Dev_100%!"},
        )
        self.store.create_career_application(
            "00000000-0000-0000-0000-000000000103",
            {**values, "company": "DevX1000"},
        )
        self.store.create_career_application(
            "00000000-0000-0000-0000-000000000104",
            {**values, "company": "Straße Systems"},
        )
        self.store.create_career_application(
            "00000000-0000-0000-0000-000000000105",
            {**values, "company": "ＡＩＧ Labs"},
        )

        russian_match = self.store.list_career_applications_page(search="АЛИЯ")
        wildcard_match = self.store.list_career_applications_page(search="dev_100%!")
        casefold_match = self.store.list_career_applications_page(search="STRASSE")
        compatibility_match = self.store.list_career_applications_page(search="AIG")
        cross_field_match = self.store.list_career_applications_page(search="Пример Backend")

        self.assertEqual([item["contact_name"] for item in russian_match["applications"]], ["Алия Иванова"])
        self.assertEqual([item["company"] for item in wildcard_match["applications"]], ["Dev_100%!"])
        self.assertEqual([item["company"] for item in casefold_match["applications"]], ["Straße Systems"])
        self.assertEqual([item["company"] for item in compatibility_match["applications"]], ["ＡＩＧ Labs"])
        self.assertEqual(cross_field_match["total_count"], 0)
        self.assertEqual(russian_match["total_count"], 1)
        self.assertEqual(wildcard_match["total_count"], 1)
        self.assertNotIn("search_key", russian_match["applications"][0])

    def test_application_search_key_updates_with_searchable_fields(self):
        values = career.validate_application_payload({
            "company": "Example",
            "job_title": "Backend",
            "job_description": "Kafka и асинхронные очереди",
            "notes": "Первичный контакт",
        })
        self.store.create_career_application("00000000-0000-0000-0000-000000000106", values)

        updated = self.store.update_career_application(
            "00000000-0000-0000-0000-000000000106",
            career.validate_application_payload({"notes": "Касым получил приглашение"}, partial=True),
        )

        self.assertIsNotNone(updated)
        self.assertNotIn("search_key", updated)
        self.assertEqual(
            self.store.list_career_applications_page(search="КАСЫМ")["total_count"],
            1,
        )
        self.assertEqual(
            self.store.list_career_applications_page(search="АСИНХРОННЫЕ ОЧЕРЕДИ")["total_count"],
            1,
        )
        self.store.update_career_application(
            "00000000-0000-0000-0000-000000000106",
            career.validate_application_payload({"job_description": "Python и PostgreSQL"}, partial=True),
        )
        self.assertEqual(self.store.list_career_applications_page(search="KAFKA")["total_count"], 0)
        self.assertEqual(self.store.list_career_applications_page(search="POSTGRESQL")["total_count"], 1)
        self.assertEqual(
            self.store.list_career_applications_page(search="Первичный контакт")["total_count"],
            0,
        )

    def test_search_key_migration_backfills_unicode_rows(self):
        database_path = Path(self.temp_dir.name) / "search-key-backfill.db"
        database_url = f"sqlite:///{database_path.as_posix()}"
        config = Config("alembic.ini")
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "0008_career_cursor_idx")

        engine = create_database_engine(database_url)
        with engine.begin() as db:
            db.execute(text("""
                INSERT INTO career_applications (
                    id, company, job_title, source_url, contact_name, contact_url, location, salary_range,
                    status, notes, conversation_id, follow_up_date, created_at, updated_at
                ) VALUES (
                    'legacy-unicode-search', 'Алия Straße ＡＩＧ', 'Backend', '', '', '', '', '',
                    'applied', '', NULL, NULL, '2026-11-14T10:00:00+00:00', '2026-11-14T10:05:00+00:00'
                )
            """))
        engine.dispose()

        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "head")

        migrated_engine = create_database_engine(database_url)
        try:
            migrated_store = Store(migrated_engine)
            russian = migrated_store.list_career_applications_page(search="АЛИЯ")
            casefold = migrated_store.list_career_applications_page(search="STRASSE")
            compatibility = migrated_store.list_career_applications_page(search="AIG")
            with migrated_engine.connect() as db:
                search_key = db.execute(
                    text("SELECT search_key FROM career_applications WHERE id=:id"),
                    {"id": "legacy-unicode-search"},
                ).scalar_one()
        finally:
            migrated_engine.dispose()

        self.assertEqual(russian["total_count"], 1)
        self.assertEqual(casefold["total_count"], 1)
        self.assertEqual(compatibility["total_count"], 1)
        self.assertEqual(search_key, "алия strasse aig\ue000backend")

    def test_job_description_migration_preserves_existing_rows(self):
        database_path = Path(self.temp_dir.name) / "job-description-upgrade.db"
        database_url = f"sqlite:///{database_path.as_posix()}"
        config = Config("alembic.ini")
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "0009_career_search_key")

        engine = create_database_engine(database_url)
        with engine.begin() as db:
            db.execute(text("""
                INSERT INTO career_applications (
                    id, company, job_title, source_url, contact_name, contact_url, location, salary_range,
                    status, notes, conversation_id, follow_up_date, search_key, created_at, updated_at
                ) VALUES (
                    'legacy-job-description', 'Example', 'Backend', '', '', '', '', '',
                    'saved', '', NULL, NULL, 'example',
                    '2026-11-14T10:00:00+00:00', '2026-11-14T10:00:00+00:00'
                )
            """))
        engine.dispose()

        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "head")

        migrated_engine = create_database_engine(database_url)
        try:
            application = Store(migrated_engine).list_career_applications()[0]
        finally:
            migrated_engine.dispose()

        self.assertEqual(application["id"], "legacy-job-description")
        self.assertEqual(application["job_description"], "")

    def test_filtered_search_finds_a_match_after_the_first_unfiltered_page(self):
        base = career.validate_application_payload({
            "company": "Routine company",
            "job_title": "Backend developer",
        })
        records = []
        for index in range(1, 102):
            values = {**base, "company": f"Routine company {index}"}
            if index == 1:
                values.update({"company": "Rare target", "status": "interview"})
            records.append((f"career-{index:03d}", values))

        with patch("entropy_app.store.now", return_value="2026-11-15T00:00:00+00:00"):
            self.store.create_career_applications(records)

        unfiltered = self.store.list_career_applications_page(limit=100)
        filtered = self.store.list_career_applications_page(
            limit=100,
            search="RARE TARGET",
            status="interview",
        )

        self.assertEqual(unfiltered["total_count"], 101)
        self.assertTrue(unfiltered["has_more"])
        self.assertEqual(filtered["total_count"], 1)
        self.assertEqual([item["company"] for item in filtered["applications"]], ["Rare target"])

    def test_application_due_filter_counts_all_matches_across_cursor_pages(self):
        values = career.validate_application_payload({"company": "Example", "job_title": "Backend"})
        records = [
            ("00000000-0000-0000-0000-000000000111", {**values, "follow_up_date": "2026-11-14", "status": "applied"}),
            ("00000000-0000-0000-0000-000000000112", {**values, "follow_up_date": "2026-11-15", "status": "interview"}),
            ("00000000-0000-0000-0000-000000000113", {**values, "follow_up_date": "2026-11-16", "status": "applied"}),
            ("00000000-0000-0000-0000-000000000114", {**values, "follow_up_date": "2026-11-14", "status": "offer"}),
        ]
        with patch("entropy_app.store.now", return_value="2026-11-15T00:00:00+00:00"):
            for application_id, payload in records:
                self.store.create_career_application(application_id, payload)

        first = self.store.list_career_applications_page(limit=1, due_by="2026-11-15")
        cursor = {
            "before_created_at": first["next_cursor"]["created_at"],
            "before_id": first["next_cursor"]["id"],
        }
        second = self.store.list_career_applications_page(limit=1, due_by="2026-11-15", **cursor)

        self.assertEqual(first["total_count"], 2)
        self.assertEqual(second["total_count"], 2)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertNotEqual(first["applications"][0]["id"], second["applications"][0]["id"])
        self.assertEqual(
            self.store.list_career_applications_page(status="applied")["total_count"],
            2,
        )

    def test_application_pages_do_not_skip_older_card_if_it_is_updated_between_pages(self):
        values = career.validate_application_payload({"company": "Example", "job_title": "Backend"})
        identifiers = [f"00000000-0000-0000-0000-{index:012d}" for index in range(1, 4)]
        with patch("entropy_app.store.now", return_value="2026-11-15T00:00:00+00:00"):
            for index, application_id in enumerate(identifiers):
                self.store.create_career_application(application_id, {**values, "company": f"Example {index}"})

        first = self.store.list_career_applications_page(limit=2)
        cursor = {
            "before_created_at": first["next_cursor"]["created_at"],
            "before_id": first["next_cursor"]["id"],
        }
        first_page_ids = {item["id"] for item in first["applications"]}
        remaining_id = next(
            application_id
            for application_id in identifiers
            if application_id not in first_page_ids
        )
        with patch("entropy_app.store.now", return_value="2026-11-15T00:01:00+00:00"):
            self.store.update_career_application(remaining_id, {"status": "preparing"})

        second = self.store.list_career_applications_page(limit=2, **cursor)

        self.assertEqual([item["id"] for item in second["applications"]], [remaining_id])
        self.assertFalse(second["has_more"])
        self.assertEqual(second["applications"][0]["updated_at"], "2026-11-15T00:01:00+00:00")

    def test_follow_up_date_persists_and_can_be_cleared(self):
        payload = career.validate_application_payload({
            "company": "Example",
            "job_title": "Backend developer",
            "follow_up_date": "2026-11-20",
        })
        created = self.store.create_career_application("application-follow-up", payload)
        updated = self.store.update_career_application(
            "application-follow-up",
            career.validate_application_payload({"follow_up_date": None}, partial=True),
        )

        self.assertEqual(created["follow_up_date"], "2026-11-20")
        self.assertIsNone(updated["follow_up_date"])
        events = self.store.list_career_application_activity("application-follow-up")
        self.assertEqual([event["event_type"] for event in events], ["follow_up_changed", "created"])
        self.assertEqual(events[0]["from_value"], "2026-11-20")
        self.assertIsNone(events[0]["to_value"])

    def test_activity_for_unknown_application_returns_none(self):
        self.assertIsNone(self.store.list_career_application_activity("missing"))

    def test_activity_migration_backfills_creation_for_existing_applications(self):
        database_path = Path(self.temp_dir.name) / "migration-backfill.db"
        database_url = f"sqlite:///{database_path.as_posix()}"
        config = Config("alembic.ini")
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "0004_career_follow_up_date")
        engine = create_database_engine(database_url)
        with engine.begin() as db:
            db.execute(text("""
                INSERT INTO career_applications (
                    id, company, job_title, source_url, location, salary_range,
                    status, notes, conversation_id, follow_up_date, created_at, updated_at
                ) VALUES (
                    'legacy-application', 'Example', 'Backend', '', '', '',
                    'applied', '', NULL, NULL, '2026-11-14T10:00:00+00:00', '2026-11-14T10:05:00+00:00'
                )
            """))
        engine.dispose()
        with patch.dict(os.environ, {"ENTROPY_DATABASE_URL": database_url}):
            command.upgrade(config, "head")

        migrated_engine = create_database_engine(database_url)
        try:
            migrated_store = Store(migrated_engine)
            events = migrated_store.list_career_application_activity("legacy-application")
            applications = migrated_store.list_career_applications()
        finally:
            migrated_engine.dispose()

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event_type"], "created")
        self.assertEqual(events[0]["created_at"], "2026-11-14T10:00:00+00:00")
        self.assertEqual(applications[0]["contact_name"], "")
        self.assertEqual(applications[0]["contact_url"], "")

    def test_unknown_application_update_returns_none(self):
        self.assertIsNone(self.store.update_career_application("missing", {"status": "offer"}))


if __name__ == "__main__":
    unittest.main()
