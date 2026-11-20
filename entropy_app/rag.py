"""Bounded client for the Entropy RAG search webhook in n8n."""

from __future__ import annotations

import json
import math
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class RagError(RuntimeError):
    """The RAG endpoint is unavailable or returned an invalid response."""


class RagNotConfigured(RagError):
    """The search webhook URL or authentication has not been configured."""


def configured() -> bool:
    value = os.environ.get("ENTROPY_RAG_SEARCH_WEBHOOK_URL", "").strip()
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def authentication_configured() -> bool:
    """Report whether a usable shared token is set for the authenticated webhook."""
    value = os.environ.get("ENTROPY_RAG_WEBHOOK_TOKEN", "").strip()
    return bool(value) and value.lower() != "disabled"


def ready() -> bool:
    """Return whether RAG has both a valid endpoint and its required webhook token."""
    return configured() and authentication_configured()


def _validated_results(scope: str, values: object) -> list[dict]:
    if not isinstance(values, list):
        raise RagError("RAG returned an invalid result list.")
    results = []
    for value in values[:5]:
        if not isinstance(value, dict) or value.get("scope") != scope:
            continue
        content = value.get("content")
        source_id = value.get("source_id")
        title = value.get("title")
        score = value.get("score")
        if not isinstance(content, str) or not content.strip():
            continue
        if not isinstance(source_id, str) or not source_id.strip():
            continue
        if not isinstance(title, str):
            title = source_id
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
            score = None
        kind = value.get("kind")
        kind = kind if isinstance(kind, str) else ""
        source_url = _validated_source_url(value.get("source_url"))
        if source_url is None and kind == "drive":
            source_url = _drive_source_url(source_id)
        results.append(
            {
                "scope": scope,
                "source_id": source_id[:160],
                "title": title[:240],
                "content": content[:8_000],
                "score": score,
                "kind": kind[:40],
                "source_url": source_url,
            }
        )
    return results


def _drive_source_url(source_id: str) -> str | None:
    """Build a Google Drive link only from a Drive file ID's safe character set."""
    candidate = source_id.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,128}", candidate, flags=re.ASCII):
        return None
    return f"https://drive.google.com/open?id={candidate}"


def _validated_source_url(value: object) -> str | None:
    """Accept only direct HTTPS links on Google Drive or Docs hosts."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > 2_048
        or any(ord(char) < 32 for char in candidate)
        or any(char.isspace() or char == "\\" for char in candidate)
    ):
        return None
    try:
        parsed = urlparse(candidate)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or hostname not in {"drive.google.com", "docs.google.com"}
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or not parsed.path.startswith("/")
    ):
        return None
    # Parentheses delimit Markdown links in the career workspace citation.
    return candidate.replace("(", "%28").replace(")", "%29")


def search(scope: str, question: str) -> dict:
    """Search one knowledge scope and return bounded, source-bearing snippets."""
    if scope not in {"career", "entropy_product"}:
        raise ValueError("Unsupported RAG scope.")
    if not isinstance(question, str) or not question.strip() or len(question) > 2_000:
        raise ValueError("Question must contain 1 to 2000 characters.")
    if not configured():
        raise RagNotConfigured("RAG search webhook URL is not configured.")
    if not authentication_configured():
        raise RagNotConfigured("RAG search webhook token is not configured.")

    url = os.environ["ENTROPY_RAG_SEARCH_WEBHOOK_URL"].strip()
    payload = {"scope": scope, "question": question.strip()}
    headers = {"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"}
    token = os.environ.get("ENTROPY_RAG_WEBHOOK_TOKEN", "").strip()
    if token:
        headers["X-Entropy-RAG-Token"] = token
    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=12) as response:
            if not 200 <= response.status < 300:
                raise RagError("RAG search webhook returned an unsuccessful status.")
            raw_response = response.read(128_000)
    except HTTPError as error:
        error.close()
        raise RagError("RAG search webhook could not be reached.") from error
    except (URLError, TimeoutError, OSError, ValueError) as error:
        raise RagError("RAG search webhook could not be reached.") from error

    try:
        body = json.loads(raw_response.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RagError("RAG search webhook returned invalid JSON.") from error
    if not isinstance(body, dict) or body.get("ok") is not True or body.get("scope") != scope:
        raise RagError("RAG search webhook returned an invalid response.")
    return {
        "ok": True,
        "scope": scope,
        "results": _validated_results(scope, body.get("results")),
    }
