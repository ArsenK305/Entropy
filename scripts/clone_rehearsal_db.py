"""Create an isolated SQLite snapshot of a prepared video rehearsal database."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: clone_rehearsal_db.py SOURCE_DB TARGET_DB", file=sys.stderr)
        return 2

    source_path = Path(sys.argv[1]).resolve()
    target_path = Path(sys.argv[2]).resolve()
    if not source_path.is_file() or source_path == target_path or target_path.exists():
        print("Source must exist and target must be a new file.", file=sys.stderr)
        return 2

    source_uri = f"{source_path.as_uri()}?mode=ro"
    source = sqlite3.connect(source_uri, uri=True)
    target = sqlite3.connect(target_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
