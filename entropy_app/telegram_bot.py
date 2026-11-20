"""Opt-in Telegram long-polling entry point for the Entropy Mini App."""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import threading
from http.client import HTTPException
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)


def token_configured(token: str | None = None) -> bool:
    """Report whether a Telegram token is present without claiming it is valid."""
    value = os.environ.get("TELEGRAM_BOT_TOKEN", "") if token is None else token
    value = value.strip()
    return bool(value) and value.casefold() != "disabled"


class TelegramBotPoller:
    """Handle basic private-chat commands without a bot framework dependency."""

    def __init__(
        self,
        token: str,
        miniapp_url: str,
        question_handler: Callable[[str], str] | None = None,
    ):
        self._token = token.strip()
        self._miniapp_url = self._validated_miniapp_url(miniapp_url)
        self._question_handler = question_handler
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._offset: int | None = None

    @staticmethod
    def _validated_miniapp_url(value: str) -> str:
        parsed = urlparse(value.strip())
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("TELEGRAM_MINIAPP_URL must be a public HTTPS URL.")
        hostname = parsed.hostname.rstrip(".").lower()
        if hostname == "localhost" or hostname.endswith((".localhost", ".local")):
            raise ValueError("TELEGRAM_MINIAPP_URL must not use a local hostname.")
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError("TELEGRAM_MINIAPP_URL must not use a private IP address.")
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("TELEGRAM_MINIAPP_URL has an invalid port.") from exc
        if parsed.query or parsed.fragment:
            raise ValueError("TELEGRAM_MINIAPP_URL must not include a query or fragment.")
        return value.strip()

    @classmethod
    def from_environment(
        cls,
        question_handler: Callable[[str], str] | None = None,
    ) -> TelegramBotPoller | None:
        enabled = os.environ.get("ENTROPY_TELEGRAM_POLLING", "").strip().lower()
        if enabled not in {"1", "true", "yes"}:
            return None
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        miniapp_url = os.environ.get("TELEGRAM_MINIAPP_URL", "").strip()
        if not token_configured(token):
            raise RuntimeError("Telegram polling is enabled, but TELEGRAM_BOT_TOKEN is missing or disabled.")
        if not miniapp_url:
            raise RuntimeError("Telegram polling is enabled, but TELEGRAM_MINIAPP_URL is missing.")
        return cls(token, miniapp_url, question_handler)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._poll,
            name="entropy-telegram-poller",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 16.0) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def _api_call(self, method: str, payload: dict[str, Any], timeout: int) -> Any:
        request = Request(
            f"https://api.telegram.org/bot{self._token}/{method}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            # HTTP status is enough to diagnose common poller conflicts (e.g. 409).
            # Never log the request URL, which contains the bot token.
            status = exc.code
            exc.close()
            raise RuntimeError(f"Telegram Bot API request failed with HTTP {status}.") from None
        except (URLError, TimeoutError, OSError, HTTPException, ValueError) as exc:
            raise RuntimeError(
                f"Telegram Bot API request failed ({type(exc).__name__})."
            ) from None
        if not isinstance(result, dict) or result.get("ok") is not True:
            error_code = result.get("error_code") if isinstance(result, dict) else None
            status = (
                f" (error code {error_code})"
                if isinstance(error_code, int) and not isinstance(error_code, bool)
                else ""
            )
            raise RuntimeError(f"Telegram Bot API returned an unsuccessful response{status}.")
        return result.get("result")

    def _poll(self) -> None:
        while not self._stop.is_set():
            payload: dict[str, Any] = {"timeout": 10, "allowed_updates": ["message"]}
            if self._offset is not None:
                payload["offset"] = self._offset
            try:
                updates = self._api_call("getUpdates", payload, timeout=15)
                if not isinstance(updates, list):
                    raise RuntimeError("Telegram returned an invalid updates list.")
                for update in updates:
                    if self._stop.is_set():
                        break
                    if not isinstance(update, dict):
                        continue
                    update_id = update.get("update_id")
                    self._handle_update(update)
                    if isinstance(update_id, int) and not isinstance(update_id, bool):
                        self._offset = max(self._offset or 0, update_id + 1)
            except RuntimeError as exc:
                # Keep the bot process alive through outages without logging request data or secrets.
                logger.warning("%s Retrying Telegram polling in 5 seconds.", exc)
                self._stop.wait(5)

    def _handle_update(self, update: dict[str, Any]) -> None:
        message = update.get("message")
        if not isinstance(message, dict):
            return
        chat = message.get("chat")
        if not isinstance(chat, dict) or chat.get("type") != "private":
            return
        chat_id = chat.get("id")
        text = message.get("text")
        if isinstance(chat_id, bool) or not isinstance(chat_id, int) or not isinstance(text, str):
            return
        command = text.strip().split(maxsplit=1)[0].split("@", 1)[0].lower()
        if command in {"/start", "/help"}:
            self._api_call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": (
                        "Entropy — демонстрационная концепция продукта. "
                        "Задай вопрос о продукте или открой Mini App кнопкой ниже. "
                        "Витрина показывает Entropy Box и возможные модули. "
                        "Состав и цены не утверждены; заказ тестовый, оплаты и выдачи нет."
                    ),
                    "reply_markup": {
                        "keyboard": [[{"text": "Открыть Entropy Box", "web_app": {"url": self._miniapp_url}}]],
                        "resize_keyboard": True,
                        "is_persistent": True,
                    },
                },
                timeout=10,
            )
        elif not command.startswith("/"):
            if self._question_handler:
                self._api_call("sendChatAction", {"chat_id": chat_id, "action": "typing"}, timeout=10)
                try:
                    reply = self._question_handler(text.strip())
                except Exception:
                    logger.warning("Telegram question handler failed; sending fallback response.")
                    reply = "Не получилось ответить сейчас. Попробуй ещё раз или открой витрину."
            else:
                reply = "Я пока умею открывать витрину. Нажми кнопку «Открыть Entropy Box» или отправь /start."
            self._api_call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": reply,
                },
                timeout=10,
            )
