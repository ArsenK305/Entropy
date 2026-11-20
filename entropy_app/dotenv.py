"""Load simple project-local environment settings without extra dependencies."""

from __future__ import annotations

import os
import re
from pathlib import Path


_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def load_env_file(path: Path) -> None:
    """Load KEY=VALUE lines, preserving values already set by the process."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return

    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not _KEY_PATTERN.fullmatch(key):
            raise ValueError(f"Invalid .env entry at line {line_number}.")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)
