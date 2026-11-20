import os
import unittest
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError

import app
from entropy_app.rag import RagError, _validated_results, authentication_configured, configured, ready, search


class RagResponseValidationTests(unittest.TestCase):
    def test_http_error_response_is_closed_without_exposing_remote_body(self):
        response_body = BytesIO(b"private service detail")
        error = HTTPError("https://n8n.example/webhook", 500, "Internal Server Error", None, response_body)
        with (
            patch.dict(
                os.environ,
                {
                    "ENTROPY_RAG_SEARCH_WEBHOOK_URL": "https://n8n.example/webhook",
                    "ENTROPY_RAG_WEBHOOK_TOKEN": "configured-token",
                },
            ),
            patch("entropy_app.rag.urlopen", side_effect=error),
        ):
            with self.assertRaisesRegex(RagError, "could not be reached") as raised:
                search("career", "test question")

        self.assertTrue(response_body.closed)
        self.assertNotIn("private service detail", str(raised.exception))

    def test_rag_readiness_requires_endpoint_and_usable_token(self):
        with patch.dict(
            os.environ,
            {"ENTROPY_RAG_SEARCH_WEBHOOK_URL": "https://n8n.example/webhook", "ENTROPY_RAG_WEBHOOK_TOKEN": ""},
        ):
            self.assertTrue(configured())
            self.assertFalse(authentication_configured())
            self.assertFalse(ready())

        for token in ("disabled", " Disabled "):
            with self.subTest(token=token), patch.dict(
                os.environ,
                {"ENTROPY_RAG_SEARCH_WEBHOOK_URL": "https://n8n.example/webhook", "ENTROPY_RAG_WEBHOOK_TOKEN": token},
            ):
                self.assertTrue(configured())
                self.assertFalse(authentication_configured())
                self.assertFalse(ready())

    def test_search_does_not_call_webhook_without_usable_token(self):
        with (
            patch.dict(
                os.environ,
                {
                    "ENTROPY_RAG_SEARCH_WEBHOOK_URL": "https://n8n.example/webhook",
                    "ENTROPY_RAG_WEBHOOK_TOKEN": "disabled",
                },
            ),
            patch("entropy_app.rag.urlopen") as open_url,
        ):
            with self.assertRaisesRegex(RagError, "token is not configured"):
                search("career", "test question")

        open_url.assert_not_called()

    def test_filters_other_scope_and_malformed_results(self):
        rows = [
            {"scope": "entropy_product", "source_id": "wrong", "title": "Wrong area", "content": "no"},
            {"scope": "career", "source_id": "empty", "title": "Empty", "content": "  "},
            {"scope": "career", "source_id": "profile", "title": "Profile", "content": "Python", "score": float("inf")},
        ]

        result = _validated_results("career", rows)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source_id"], "profile")
        self.assertIsNone(result[0]["score"])

    def test_caps_source_fields_and_content_length(self):
        result = _validated_results(
            "career",
            [{"scope": "career", "source_id": "s" * 200, "title": "t" * 300, "content": "c" * 9_000, "score": 0.5}],
        )

        self.assertEqual(len(result[0]["source_id"]), 160)
        self.assertEqual(len(result[0]["title"]), 240)
        self.assertEqual(len(result[0]["content"]), 8_000)

    def test_keeps_only_https_google_drive_source_links(self):
        rows = [
            {"scope": "career", "source_id": "ok", "title": "Profile", "content": "Python", "source_url": "https://drive.google.com/file/d/abc/view"},
            {"scope": "career", "source_id": "paren", "title": "Path", "content": "Python", "source_url": "https://drive.google.com/file/d/a_(b)/view"},
            {"scope": "career", "source_id": "http", "title": "HTTP", "content": "Python", "source_url": "http://drive.google.com/file/d/abc/view"},
            {"scope": "career", "source_id": "host", "title": "Lookalike", "content": "Python", "source_url": "https://drive.google.com.evil.example/file/d/abc/view"},
            {"scope": "career", "source_id": "other", "title": "Other", "content": "Python", "source_url": "https://example.com/file"},
        ]

        result = _validated_results("career", rows)

        self.assertEqual(result[0]["source_url"], "https://drive.google.com/file/d/abc/view")
        self.assertEqual(result[1]["source_url"], "https://drive.google.com/file/d/a_%28b%29/view")
        self.assertTrue(all(item["source_url"] is None for item in result[2:]))

    def test_builds_google_drive_link_when_index_did_not_return_source_url(self):
        file_id = "FAKEdriveID_1234567890-xyz"
        rows = [
            {
                "scope": "career",
                "source_id": file_id,
                "title": "response_rules.md",
                "content": "Правила ответа.",
                "kind": "drive",
            },
            {
                "scope": "career",
                "source_id": "not-a-valid-id/../../evil.example",
                "title": "Unknown",
                "content": "Do not link.",
                "kind": "drive",
            },
            {
                "scope": "career",
                "source_id": file_id,
                "title": "Mock",
                "content": "Mock data should not get a Drive link.",
                "kind": "mock",
            },
        ]

        result = _validated_results("career", rows)

        self.assertEqual(
            result[0]["source_url"],
            f"https://drive.google.com/open?id={file_id}",
        )
        self.assertIsNone(result[1]["source_url"])
        self.assertIsNone(result[2]["source_url"])


class CareerRagContextTests(unittest.TestCase):
    def test_skips_search_when_endpoint_authentication_is_not_ready(self):
        with (
            patch("app.rag.ready", return_value=False),
            patch("app.rag.search") as search,
        ):
            self.assertEqual(app.load_career_rag_context("Покажи мой опыт"), ("", []))

        search.assert_not_called()

    def test_source_id_is_not_used_as_a_display_title(self):
        self.assertEqual(
            app._display_rag_source_title("drive-secret-id", source_id="drive-secret-id"),
            "Источник знаний",
        )

    def test_keeps_profile_and_rules_but_filters_fictional_candidate(self):
        search_result = {
            "results": [
                {
                    "scope": "career",
                    "source_id": "career-response-rules-mock",
                    "title": "Правила карьерного модуля (mock)",
                    "content": "Пришли вакансию — подготовь черновик письма.",
                    "kind": "mock",
                    "score": 0.9,
                },
                {
                    "scope": "career",
                    "source_id": "career-mock-candidate-001",
                    "title": "Вымышленный кандидат",
                    "content": "У вымышленного кандидата пять лет опыта.",
                    "kind": "mock",
                    "score": 0.8,
                },
                {
                    "scope": "career",
                    "source_id": "drive-file-mock-candidate",
                    "title": "Mock_Candidate.MD",
                    "content": "Марина Тестова — вымышленная кандидатка.",
                    "kind": "drive",
                    "score": 0.75,
                },
                {
                    "scope": "career",
                    "source_id": "career-profile-kars",
                    "title": "Подтверждённый профиль",
                    "content": "Подтверждённый навык: Python.",
                    "kind": "profile",
                    "score": 0.7,
                    "source_url": "https://drive.google.com/file/d/profile/view",
                },
                {
                    "scope": "career",
                    "source_id": "drive-profile-copy",
                    "title": "Подтверждённый профиль",
                    "content": (
                        "# Mock source: imported profile\n"
                        "`source_id`: `drive-profile-copy`\n"
                        "`scope`: `career`\n\n"
                        "## Подтверждённые навыки\n\n"
                        "Подтверждённый навык: Python."
                    ),
                    "kind": "drive",
                    "score": 0.68,
                },
                {
                    "scope": "career",
                    "source_id": "career-profile-kars-section-2",
                    "title": "Подтверждённый профиль",
                    "content": "Ещё один подтверждённый факт.",
                    "kind": "profile",
                    "score": 0.65,
                },
                {
                    "scope": "career",
                    "source_id": "drive-response-rules",
                    "title": "response_rules.md",
                    "content": (
                        "# Mock source: правила карьерного модуля\n\n"
                        "`source_id`: `career-response-rules-mock`\n"
                        "`scope`: `career`\n\n"
                        "## Правила ответа\n\n"
                        "Подготовить честный черновик."
                    ),
                    "kind": "drive",
                    "score": 0.6,
                },
            ]
        }
        with (
            patch("app.rag.ready", return_value=True),
            patch("app.rag.search", return_value=search_result),
            patch("app.STORE.add_observability_event") as add_event,
        ):
            context, sources = app.load_career_rag_context("Оцени вакансию")

        self.assertIn("### Правила карьерного модуля (mock)", context)
        self.assertIn("### Подтверждённый профиль", context)
        self.assertNotIn("response_rules.md", context)
        self.assertNotIn("career-response-rules-mock", context)
        self.assertNotIn("career-profile-kars", context)
        self.assertNotIn("https://drive.google.com/file/d/profile/view", context)
        self.assertEqual(context.count("Подтверждённый навык: Python."), 1)
        self.assertNotIn("вымышленного кандидата пять лет", context)
        self.assertNotIn("Марина Тестова", context)
        self.assertNotIn("drive-file-mock-candidate", " ".join(sources))
        self.assertEqual(
            sources,
            ["Правила карьерного модуля (mock)", "[Подтверждённый профиль](https://drive.google.com/file/d/profile/view)"],
        )
        self.assertNotIn("drive-response-rules", context)
        add_event.assert_called_once()
        self.assertIn("4 approved reference(s)", add_event.call_args.args[-1])
        self.assertNotIn("source_id", add_event.call_args.args[-1])
        self.assertNotIn("career-profile-kars", add_event.call_args.args[-1])
        self.assertNotIn("drive-profile-copy", add_event.call_args.args[-1])

    def test_run_turn_keeps_retrieved_references_separate_from_project_rules(self):
        from unittest.mock import Mock

        agents = Mock()
        agents.route_message.return_value = {
            "reply": "Краткий разбор.",
            "delegate_to_veltrics": False,
        }
        store = Mock()
        store.list_conversation_context.return_value = []

        with (
            patch("app.load_project_context", return_value="Trusted local project rules"),
            patch(
                "app.load_career_rag_context",
                return_value=("Retrieved source excerpt", ["Career profile"]),
            ),
            patch("app.AGENTS", agents),
            patch("app.STORE", store),
        ):
            app.run_turn("turn-1", "conversation-1", "Оцени вакансию", workspace="career")

        call = agents.route_message.call_args
        self.assertEqual(call.args[1], "Trusted local project rules")
        self.assertEqual(call.kwargs["retrieved_reference_context"], "Retrieved source excerpt")
        self.assertEqual(call.kwargs["workspace"], "career")

    def test_rag_failure_falls_back_without_revealing_remote_error(self):
        with (
            patch("app.rag.ready", return_value=True),
            patch("app.rag.search", side_effect=RagError("private endpoint details")),
            patch("app.STORE.add_observability_event") as add_event,
        ):
            context, sources = app.load_career_rag_context("Покажи мой опыт")

        self.assertEqual((context, sources), ("", []))
        failure_event = add_event.call_args.args[2:]
        self.assertIn("rag.search.failed", failure_event)
        self.assertNotIn("private endpoint details", repr(failure_event))


class TelegramProductRagTests(unittest.TestCase):
    def test_rejects_empty_or_oversized_questions_before_search(self):
        with patch("app.rag.search") as search:
            self.assertIn("Напиши вопрос", app.answer_product_question("   "))
            self.assertIn("2000 символов", app.answer_product_question("x" * 2_001))

        search.assert_not_called()

    def test_answers_from_product_scope_and_cites_sources(self):
        search_result = {
            "results": [
                {
                    "scope": "entropy_product",
                    "source_id": "entropy-box-mock",
                    "title": "Концепция Entropy Box (mock)",
                    "content": "Базовая коробка — демонстрационная.",
                    "kind": "mock",
                    "score": 0.8,
                    "source_url": "https://drive.google.com/file/d/entropy-box/view",
                },
                {
                    "scope": "entropy_product",
                    "source_id": "entropy-box-mock-chunk-2",
                    "title": "Концепция Entropy Box (mock)",
                    "content": "Второй фрагмент той же карточки.",
                    "kind": "mock",
                    "score": 0.75,
                },
                {
                    "scope": "entropy_product",
                    "source_id": "drive-entropy-box",
                    "title": "entropy_box_mock.md",
                    "content": (
                        "# Mock source: product concept\n\n"
                        "`source_id`: `drive-entropy-box`\n"
                        "`scope`: `entropy_product`\n\n"
                        "## Состав\n\n"
                        "Базовая коробка — демонстрационная."
                    ),
                    "kind": "drive",
                    "score": 0.72,
                },
                {
                    "scope": "career",
                    "source_id": "career-profile-kars",
                    "title": "Профиль пользователя",
                    "content": "Private career context.",
                    "kind": "profile",
                    "score": 0.7,
                },
            ]
        }
        with (
            patch("app.rag.search", return_value=search_result) as search,
            patch.object(app.AGENTS, "answer_with_references", return_value="Карточки пока demo.") as answer,
            patch("app.STORE.add_observability_event") as add_event,
        ):
            response = app.answer_product_question("Что такое Entropy Box?")

        search.assert_called_once_with("entropy_product", "Что такое Entropy Box?")
        references = answer.call_args.args[1]
        self.assertEqual(
            [item["title"] for item in references],
            ["Концепция Entropy Box (mock)"] * 2,
        )
        self.assertEqual(
            [item["content"] for item in references],
            ["Базовая коробка — демонстрационная.", "Второй фрагмент той же карточки."],
        )
        self.assertTrue(all("source_id" not in item for item in references))
        self.assertTrue(all("source_url" not in item for item in references))
        self.assertIn("Концепция Entropy Box (mock)", response)
        self.assertEqual(response.count("Концепция Entropy Box (mock)"), 1)
        self.assertNotIn("entropy-box-mock", response)
        self.assertNotIn("career-profile-kars", response)
        self.assertNotIn("Private career context", response)
        self.assertIn("https://drive.google.com/file/d/entropy-box/view", response)
        self.assertEqual(add_event.call_count, 4)
        completion_event = add_event.call_args_list[-1].args
        self.assertIn("telegram.product_answer.completed", completion_event)
        self.assertIn("найденным материалам (2)", completion_event[-1])
        self.assertNotIn("source_id", completion_event[-1])
        self.assertNotIn("entropy-box-mock", completion_event[-1])

    def test_product_search_failure_returns_safe_fallback(self):
        with (
            patch("app.rag.search", side_effect=RagError("private endpoint details")),
            patch.object(app.AGENTS, "answer_with_references") as answer,
            patch("app.STORE.add_observability_event") as add_event,
        ):
            response = app.answer_product_question("Есть ли платный модуль?")

        self.assertIn("не получилось обратиться к каталогу", response.lower())
        answer.assert_not_called()
        self.assertEqual(add_event.call_count, 2)
        self.assertNotIn("private endpoint details", repr(add_event.call_args_list))

    def test_response_stays_within_telegram_message_limit(self):
        search_result = {
            "results": [
                {
                    "scope": "entropy_product",
                    "source_id": f"source-{index}",
                    "title": f"Карточка {index}",
                    "content": f"Содержание {index}",
                    "kind": "drive",
                    "score": 0.9 - index / 100,
                    "source_url": f"https://drive.google.com/file/d/{index}/view",
                }
                for index in range(5)
            ]
        }
        with (
            patch("app.rag.search", return_value=search_result),
            patch.object(app.AGENTS, "answer_with_references", return_value="Ответ. " * 1_000),
            patch("app.STORE.add_observability_event"),
        ):
            response = app.answer_product_question("Расскажи о продукте")

        self.assertLessEqual(len(response), 4_096)
        self.assertIn("Источники:", response)


if __name__ == "__main__":
    unittest.main()
