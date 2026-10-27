"""Small outbound webhook client for configured n8n workflows."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def configured() -> bool:
    value = os.environ.get("ENTROPY_N8N_WEBHOOK_URL", "").strip()
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def dispatch_order(order: dict) -> tuple[bool, str]:
    """Post a persisted order to n8n without leaking endpoint details."""
    if not configured():
        return False, "not_configured"
    payload = {
        "event": "order.created",
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
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=5) as response:
            if 200 <= response.status < 300:
                return True, "accepted"
            return False, "rejected"
    except (HTTPError, URLError, TimeoutError, OSError, ValueError):
        return False, "unavailable"
