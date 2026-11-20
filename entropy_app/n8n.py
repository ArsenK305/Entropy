"""Small outbound webhook client for configured n8n workflows."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def order_status_for_event(source: str, event_type: str, status: str) -> str | None:
    """Return the order transition encoded by a consistent n8n workflow event."""
    if source != "n8n":
        return None
    expected_status = {
        "workflow.started": "running",
        "workflow.completed": "completed",
        "workflow.failed": "failed",
    }.get(event_type)
    if expected_status is None:
        return None
    if status != expected_status:
        raise ValueError("Workflow event status does not match its event type.")
    return expected_status


def configured() -> bool:
    value = os.environ.get("ENTROPY_N8N_WEBHOOK_URL", "").strip()
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def event_token_configured() -> bool:
    """Report whether a callback token is loaded, without exposing its value."""
    value = os.environ.get("ENTROPY_N8N_EVENT_TOKEN", "").strip()
    return bool(value) and value.lower() != "disabled"


def dispatch_order(order: dict) -> tuple[bool, str, int | None]:
    """Post a persisted order to n8n without leaking endpoint details."""
    if not configured():
        return False, "not_configured", None
    payload = {
        "event": "order.created",
        "event_id": f"entropy-order-{order['id']}",
        "correlation_id": order["id"],
        "order": {
            "id": order["id"],
            "product_id": order["product_id"],
            "product_name": order["product_name"],
            "created_at": order["created_at"],
            "mode": "demo_no_payment",
        },
    }
    try:
        request = Request(
            os.environ["ENTROPY_N8N_WEBHOOK_URL"].strip(),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Idempotency-Key": f"entropy-order-{order['id']}",
            },
            method="POST",
        )
        with urlopen(request, timeout=5) as response:
            if 200 <= response.status < 300:
                return True, "accepted", response.status
            return False, "rejected", response.status
    except HTTPError as error:
        error.close()
        return False, "rejected", error.code
    except (URLError, TimeoutError, OSError, ValueError):
        return False, "unavailable", None
