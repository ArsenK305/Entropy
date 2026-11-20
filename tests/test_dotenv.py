import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from entropy_app.dotenv import load_env_file


class DotEnvLoadingTests(unittest.TestCase):
    def test_loads_values_without_overriding_process_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "# comment\nDOTENV_TEST_OVERRIDE=file-value\nDOTENV_TEST_QUOTED='quoted value'\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"DOTENV_TEST_OVERRIDE": "process-value"}, clear=False):
                load_env_file(path)
                self.assertEqual(os.environ["DOTENV_TEST_OVERRIDE"], "process-value")
                self.assertEqual(os.environ["DOTENV_TEST_QUOTED"], "quoted value")

    def test_missing_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            load_env_file(Path(directory) / "missing.env")


if __name__ == "__main__":
    unittest.main()
