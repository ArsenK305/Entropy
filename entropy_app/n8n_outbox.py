"""Background delivery for durable n8n order webhook records."""

from __future__ import annotations

import logging
import threading

from entropy_app import n8n
from entropy_app.store import Store


LOGGER = logging.getLogger(__name__)
MAX_ATTEMPTS = 5
RETRY_DELAYS_SECONDS = (5, 20, 60, 300)
POLL_INTERVAL_SECONDS = 1.0


def is_retryable(http_status: int | None) -> bool:
    """Retry transient network and server failures; stop on client errors."""
    return http_status is None or http_status in {408, 425, 429} or http_status >= 500


class N8nOutboxWorker:
    """Claim and deliver due order webhooks without blocking HTTP requests."""

    def __init__(self, store: Store, poll_interval: float = POLL_INTERVAL_SECONDS):
        self._store = store
        self._poll_interval = max(0.1, poll_interval)
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def dispatch_once(self) -> bool:
        """Deliver one due order; return whether an attempt was made."""
        if not n8n.configured():
            return False
        dispatch = self._store.claim_n8n_dispatch()
        if dispatch is None:
            return False

        accepted, _dispatch_status, http_status = n8n.dispatch_order(dispatch)
        if accepted:
            detail = "n8n вернул успешный HTTP-ответ по webhook."
        elif http_status is not None:
            detail = f"n8n вернул HTTP {http_status}."
        else:
            detail = "Не удалось связаться с n8n."

        self._store.finish_n8n_dispatch(
            dispatch["id"],
            dispatch["lease_token"],
            accepted=accepted,
            http_status=http_status,
            retryable=is_retryable(http_status),
            max_attempts=MAX_ATTEMPTS,
            retry_delays=RETRY_DELAYS_SECONDS,
        )
        if not accepted:
            LOGGER.info("n8n order delivery attempt %s ended: %s", dispatch["attempt_count"], detail)
        return True

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="entropy-n8n-outbox",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 6.0) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(0.1, timeout))
        if self._thread and not self._thread.is_alive():
            self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                attempted = self.dispatch_once()
            except Exception as error:
                # Do not log request payloads, credentials, or configured URLs.
                LOGGER.error("n8n outbox worker iteration failed (%s).", type(error).__name__)
                attempted = False
            if not attempted:
                self._stop_event.wait(self._poll_interval)
