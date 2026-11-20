import hashlib
import hmac
import json
import time
import unittest
from urllib.parse import urlencode

from entropy_app.miniapp import CATALOG, telegram_user_id


class MiniAppCatalogTests(unittest.TestCase):
    def test_catalog_matches_the_mock_box_and_module_concept_without_prices(self):
        self.assertEqual(
            [product["id"] for product in CATALOG],
            ["entropy-box", "career-module-candidate", "knowledge-module-candidate"],
        )
        self.assertEqual(CATALOG[0]["title"], "Entropy Box")
        self.assertTrue(all("price" not in product and "price_cents" not in product for product in CATALOG))
        self.assertIn("пока не определены", CATALOG[0]["description"])
        self.assertTrue(all("КАНДИДАТ" in product["tag"] for product in CATALOG[1:]))


class TelegramInitDataTests(unittest.TestCase):
    def signed_data(self, token, user_id=123456, auth_date=None):
        values = {
            "auth_date": str(auth_date or int(time.time())),
            "user": json.dumps({"id": user_id}, separators=(",", ":")),
        }
        check_string = "\n".join(f"{key}={value}" for key, value in sorted(values.items()))
        secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
        values["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        return urlencode(values)

    def test_accepts_valid_signed_data(self):
        self.assertEqual(telegram_user_id(self.signed_data("bot-token"), "bot-token"), "123456")

    def test_rejects_non_ascii_malformed_hash_as_validation_error(self):
        with self.assertRaisesRegex(ValueError, "malformed"):
            telegram_user_id("auth_date=1&user=%7B%7D&hash=ф", "bot-token")

    def test_rejects_expired_signed_data(self):
        old_timestamp = int(time.time()) - 90_000
        with self.assertRaisesRegex(ValueError, "expired"):
            telegram_user_id(self.signed_data("bot-token", auth_date=old_timestamp), "bot-token")


if __name__ == "__main__":
    unittest.main()
