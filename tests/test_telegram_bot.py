import os
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from entropy_app.telegram_bot import TelegramBotPoller


class TelegramBotPollerTests(unittest.TestCase):
    def setUp(self):
        self.bot = TelegramBotPoller("token-for-test", "https://example.com/miniapp")

    def test_start_in_private_chat_returns_web_app_keyboard(self):
        with patch.object(self.bot, "_api_call") as api_call:
            self.bot._handle_update(
                {
                    "message": {
                        "chat": {"id": 42, "type": "private"},
                        "text": "/start@entropy_test_bot payload",
                    }
                }
            )

        api_call.assert_called_once()
        method, payload = api_call.call_args.args[:2]
        self.assertEqual(method, "sendMessage")
        self.assertEqual(payload["chat_id"], 42)
        self.assertIn("Entropy Box", payload["text"])
        self.assertIn("цены не утверждены", payload["text"])
        self.assertIn("тестовый", payload["text"])
        button = payload["reply_markup"]["keyboard"][0][0]
        self.assertEqual(button["text"], "Открыть Entropy Box")
        self.assertEqual(button["web_app"]["url"], "https://example.com/miniapp")

    def test_product_question_shows_typing_then_sends_rag_answer(self):
        self.bot = TelegramBotPoller(
            "token-for-test",
            "https://example.com/miniapp",
            question_handler=lambda question: f"Ответ по базе: {question}",
        )
        with patch.object(self.bot, "_api_call") as api_call:
            self.bot._handle_update(
                {"message": {"chat": {"id": 42, "type": "private"}, "text": "Какие есть модули?"}}
            )

        self.assertEqual(api_call.call_count, 2)
        self.assertEqual(api_call.call_args_list[0].args[0], "sendChatAction")
        self.assertEqual(api_call.call_args_list[0].args[1]["action"], "typing")
        self.assertEqual(api_call.call_args_list[1].args[0], "sendMessage")
        self.assertEqual(api_call.call_args_list[1].args[1]["text"], "Ответ по базе: Какие есть модули?")

    def test_product_question_falls_back_if_handler_fails(self):
        def fail(_question):
            raise RuntimeError("private search endpoint")

        self.bot = TelegramBotPoller("token-for-test", "https://example.com/miniapp", question_handler=fail)
        with patch.object(self.bot, "_api_call") as api_call:
            self.bot._handle_update(
                {"message": {"chat": {"id": 42, "type": "private"}, "text": "Есть ли оплата?"}}
            )

        sent_text = api_call.call_args_list[1].args[1]["text"]
        self.assertIn("Не получилось ответить", sent_text)
        self.assertNotIn("private search endpoint", sent_text)

    def test_ignores_group_messages(self):
        with patch.object(self.bot, "_api_call") as api_call:
            self.bot._handle_update(
                {"message": {"chat": {"id": -42, "type": "group"}, "text": "/start"}}
            )

        api_call.assert_not_called()

    def test_rejects_non_https_or_parameterized_miniapp_urls(self):
        for url in (
            "http://example.com/miniapp",
            "https://example.com/miniapp?preview=1",
            "https://localhost:5173/miniapp",
            "https://127.0.0.1/miniapp",
            "https://example.com:bad/miniapp",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                TelegramBotPoller("token-for-test", url)

    def test_polling_requires_explicit_opt_in_and_configuration(self):
        with patch.dict(os.environ, {"ENTROPY_TELEGRAM_POLLING": "0"}, clear=False):
            self.assertIsNone(TelegramBotPoller.from_environment())
        with patch.dict(os.environ, {"ENTROPY_TELEGRAM_POLLING": "1", "TELEGRAM_BOT_TOKEN": ""}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "TELEGRAM_BOT_TOKEN"):
                TelegramBotPoller.from_environment()
        with patch.dict(os.environ, {"ENTROPY_TELEGRAM_POLLING": "1", "TELEGRAM_BOT_TOKEN": "disabled"}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "TELEGRAM_BOT_TOKEN"):
                TelegramBotPoller.from_environment()

    def test_api_http_error_reports_status_without_token(self):
        error = HTTPError(
            "https://api.telegram.org/bottoken-for-test/getUpdates",
            409,
            "Conflict",
            hdrs=None,
            fp=None,
        )
        with patch.object(error, "close", wraps=error.close) as close_error:
            with patch("entropy_app.telegram_bot.urlopen", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, "HTTP 409") as raised:
                    self.bot._api_call("getUpdates", {"timeout": 10}, timeout=15)

        self.assertNotIn("token-for-test", str(raised.exception))
        close_error.assert_called_once()

    def test_polling_logs_failure_and_continues_without_sensitive_data(self):
        def conflict(*_args, **_kwargs):
            self.bot._stop.set()
            raise RuntimeError("Telegram Bot API request failed with HTTP 409.")

        with patch("entropy_app.telegram_bot.logger.warning") as warning:
            with patch.object(self.bot, "_api_call", side_effect=conflict):
                self.bot._poll()

        warning.assert_called_once()
        logged_values = " ".join(str(value) for value in warning.call_args.args)
        self.assertIn("HTTP 409", logged_values)
        self.assertIn("Retrying Telegram polling", logged_values)
        self.assertNotIn("token-for-test", logged_values)


if __name__ == "__main__":
    unittest.main()
