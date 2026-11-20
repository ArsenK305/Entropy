"""Validation and shared rules for the local career application tracker."""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from urllib.parse import urlparse


CAREER_APPLICATION_STATUSES = (
    "saved",
    "preparing",
    "applied",
    "interview",
    "offer",
    "rejected",
    "archived",
)
CAREER_ACTIVITY_TYPES = (
    "contact",
    "interview",
    "research",
    "follow_up",
    "other",
)
CAREER_APPLICATION_SEARCH_FIELDS = (
    "company",
    "job_title",
    "job_description",
    "location",
    "contact_name",
    "notes",
)
_CAREER_SEARCH_FIELD_SEPARATOR = "\ue000"

_CAREER_APPLICATION_FIELDS: dict[str, int] = {
    "company": 160,
    "job_title": 160,
    "job_description": 12_000,
    "source_url": 2_048,
    "contact_name": 120,
    "contact_url": 2_048,
    "location": 160,
    "salary_range": 120,
    "notes": 4_000,
}
_CAREER_APPLICATION_FIELD_LABELS = {
    "company": "название компании",
    "job_title": "название должности",
    "job_description": "описание вакансии",
    "source_url": "ссылка на вакансию",
    "contact_name": "имя контакта",
    "contact_url": "ссылка на профиль контакта",
    "location": "местоположение",
    "salary_range": "зарплата",
    "notes": "заметки",
}
_CAREER_APPLICATION_ID = re.compile(
    r"^entropy-career-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.ASCII,
)


def normalize_career_search_text(value: str) -> str:
    """Apply the same locale-independent search normalization to input and rows."""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    # Escape the reserved delimiter so a query cannot accidentally span fields.
    return normalized.replace(_CAREER_SEARCH_FIELD_SEPARATOR, _CAREER_SEARCH_FIELD_SEPARATOR * 2)


def career_application_search_key(values: object) -> str:
    """Build the private, deterministic search key for searchable application fields."""
    if not isinstance(values, dict):
        raise ValueError("Career application search values must be an object.")
    searchable_parts = []
    for field in CAREER_APPLICATION_SEARCH_FIELDS:
        value = values.get(field)
        if isinstance(value, str) and value.strip():
            searchable_parts.append(normalize_career_search_text(value.strip()))
    return _CAREER_SEARCH_FIELD_SEPARATOR.join(searchable_parts)


def validate_application_payload(
    payload: object,
    *,
    partial: bool = False,
) -> dict[str, str | None]:
    """Normalize client input and reject fields outside the tracker contract."""
    if not isinstance(payload, dict):
        raise ValueError("Данные вакансии должны быть JSON-объектом.")

    allowed = set(_CAREER_APPLICATION_FIELDS) | {"status", "conversation_id", "follow_up_date"}
    unknown = set(payload) - allowed
    if unknown:
        raise ValueError("В запросе есть неизвестные поля.")
    if not payload:
        raise ValueError("Укажи хотя бы одно поле вакансии.")

    normalized: dict[str, str | None] = {}
    for field, maximum in _CAREER_APPLICATION_FIELDS.items():
        if field not in payload:
            continue
        value = payload[field]
        label = _CAREER_APPLICATION_FIELD_LABELS[field]
        if not isinstance(value, str):
            raise ValueError(f"Поле «{label}» должно быть текстом.")
        if "\x00" in value:
            raise ValueError(f"Поле «{label}» содержит недопустимый нулевой символ.")
        value = value.strip()
        if len(value) > maximum:
            raise ValueError(f"Поле «{label}» превышает лимит {maximum} символов.")
        if field in {"company", "job_title"} and not value:
            raise ValueError("Укажи компанию и название должности.")
        normalized[field] = value

    if not partial:
        if not normalized.get("company") or not normalized.get("job_title"):
            raise ValueError("Укажи компанию и название должности.")
        normalized.setdefault("source_url", "")
        normalized.setdefault("job_description", "")
        normalized.setdefault("contact_name", "")
        normalized.setdefault("contact_url", "")
        normalized.setdefault("location", "")
        normalized.setdefault("salary_range", "")
        normalized.setdefault("notes", "")
        normalized.setdefault("conversation_id", None)
        normalized.setdefault("follow_up_date", None)

    if "follow_up_date" in payload:
        value = payload["follow_up_date"]
        if value is None:
            normalized["follow_up_date"] = None
        elif isinstance(value, str):
            value = value.strip()
            if not value:
                normalized["follow_up_date"] = None
            else:
                try:
                    parsed_date = date.fromisoformat(value)
                except ValueError as error:
                    raise ValueError("Дата следующего контакта должна быть корректной датой.") from error
                if parsed_date.isoformat() != value:
                    raise ValueError("Дата следующего контакта должна быть в формате ГГГГ-ММ-ДД.")
                normalized["follow_up_date"] = value
        else:
            raise ValueError("Дата следующего контакта должна быть текстом или пустой.")

    if "status" in payload:
        status = payload["status"]
        if not isinstance(status, str) or status not in CAREER_APPLICATION_STATUSES:
            raise ValueError("Выбери этап из списка.")
        normalized["status"] = status
    elif not partial:
        normalized["status"] = "saved"

    url_fields = {
        "source_url": "Ссылка на вакансию должна быть корректным HTTPS URL.",
        "contact_url": "Ссылка на профиль контакта должна быть корректным HTTPS URL.",
    }
    for field, error_message in url_fields.items():
        candidate = normalized.get(field)
        if not candidate:
            continue
        try:
            parsed = urlparse(candidate)
            host = parsed.hostname
            port = parsed.port
        except ValueError as error:
            raise ValueError(error_message) from error
        if (
            parsed.scheme != "https"
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or port not in {None, 443}
            or any(char.isspace() or char == "\\" or ord(char) < 32 for char in candidate)
        ):
            raise ValueError(error_message)

    if "conversation_id" in payload:
        conversation_id = payload["conversation_id"]
        if conversation_id is not None:
            if (
                not isinstance(conversation_id, str)
                or len(conversation_id) > 64
                or not (
                    conversation_id == "entropy-career-workspace"
                    or _CAREER_APPLICATION_ID.fullmatch(conversation_id)
                )
            ):
                raise ValueError("Не удалось связать вакансию с разбором.")
        normalized["conversation_id"] = conversation_id

    return normalized


def validate_activity_payload(payload: object) -> dict[str, str]:
    """Validate a short, user-entered activity note for a career application."""
    if not isinstance(payload, dict) or set(payload) != {"activity_type", "note"}:
        raise ValueError("Запись должна содержать тип действия и заметку.")
    activity_type = payload["activity_type"]
    note = payload["note"]
    if not isinstance(activity_type, str) or activity_type not in CAREER_ACTIVITY_TYPES:
        raise ValueError("Выбери тип действия из списка.")
    if not isinstance(note, str):
        raise ValueError("Заметка должна быть текстом.")
    note = note.strip()
    if not note:
        raise ValueError("Добавь короткую заметку о действии.")
    if len(note) > 1_000:
        raise ValueError("Заметка не должна превышать 1000 символов.")
    if "\x00" in note:
        raise ValueError("Заметка содержит недопустимый нулевой символ.")
    return {"activity_type": activity_type, "note": note}
