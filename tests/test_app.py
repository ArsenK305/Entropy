import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch

from sqlalchemy.exc import OperationalError

from app import EntropyHandler


class UnavailableStore:
    def list_conversations(self):
        raise OperationalError("SELECT 1", {}, RuntimeError("database details"))


class AppStateTests(unittest.TestCase):
    def test_state_returns_service_unavailable_when_database_is_down(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), EntropyHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, timeout=2)
        self.addCleanup(server.shutdown)

        with patch("app.STORE", UnavailableStore()):
            with self.assertRaises(HTTPError) as response:
                urlopen(f"http://127.0.0.1:{server.server_port}/api/state", timeout=2)

        self.assertEqual(response.exception.code, 503)
        payload = json.loads(response.exception.read().decode("utf-8"))
        response.exception.close()
        self.assertIn("База данных Entropy недоступна", payload["error"])
        self.assertNotIn("database details", payload["error"])


if __name__ == "__main__":
    unittest.main()
