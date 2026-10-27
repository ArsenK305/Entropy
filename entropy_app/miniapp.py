"""Telegram Mini App catalog and authentication helpers."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from urllib.parse import parse_qsl


CATALOG = (
    {
        "id": "python-api",
        "title": "Собираем API, которому можно доверять",
        "description": "Практический маршрут от первого endpoint до надёжного Python-сервиса.",
        "tag": "PYTHON · FASTAPI · 6 УРОКОВ",
        "cover": "api",
    },
    {
        "id": "rag-basics",
        "title": "RAG без магии",
        "description": "Поиск контекста, проверка источников и честные ответы модели.",
        "tag": "LLM · ПОИСК · 4 УРОКА",
        "cover": "rag",
    },
    {
        "id": "agent-workflows",
        "title": "Агенты и рабочие потоки",
        "description": "Роли, передача задач и понятная автоматизация на примерах.",
        "tag": "АГЕНТЫ · n8n · 5 УРОКОВ",
        "cover": "workflows",
    },
)
PRODUCTS_BY_ID = {product["id"]: product for product in CATALOG}


def miniapp_preview_enabled() -> bool:
    return os.environ.get("ENTROPY_MINIAPP_PREVIEW", "").strip().lower() in {"1", "true", "yes"}


def telegram_user_id(init_data: str, bot_token: str, max_age_seconds: int = 86_400) -> str:
    """Validate Telegram's signed initData and return its user ID."""
    if not init_data or len(init_data) > 16_384:
        raise ValueError("Telegram data is missing or too large.")
    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    values: dict[str, str] = {}
    for key, value in pairs:
        if key in values:
            raise ValueError("Telegram data contains duplicate fields.")
        values[key] = value

    received_hash = values.pop("hash", None)
    if not received_hash:
        raise ValueError("Telegram data has no validation hash.")
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(values.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(received_hash, expected_hash):
        raise ValueError("Telegram data signature is invalid.")

    try:
        auth_date = int(values["auth_date"])
        user = json.loads(values["user"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Telegram data is incomplete.") from exc
    now = int(time.time())
    if auth_date > now + 60 or now - auth_date > max_age_seconds:
        raise ValueError("Telegram data has expired.")
    user_id = user.get("id") if isinstance(user, dict) else None
    if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
        raise ValueError("Telegram user ID is invalid.")
    return str(user_id)
