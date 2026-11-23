"""Recompute a physician's readiness-review agreement metrics from the database, read-only.

    python -m scripts.activation_metrics --practice <practice_id> --owner <owner_scope_id> [--db PATH]

The same function the review endpoint uses (backend/pilot/activation.compute_metrics): only that
physician's sign-offs, corrections and conflict choices are counted. Nothing is written.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path


class _ReadOnlyStore:
    """The two read methods compute_metrics needs, on a read-only SQLite connection."""

    def __init__(self, path: Path) -> None:
        self.db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.db.row_factory = sqlite3.Row

    def fetch_all(self, sql: str, values: tuple = ()) -> list[dict]:
        return [dict(row) for row in self.db.execute(sql, values).fetchall()]

    def fetch_one(self, sql: str, values: tuple = ()) -> dict | None:
        row = self.db.execute(sql, values).fetchone()
        return dict(row) if row else None

    def events(self, *, practice_id: str, event_type: str) -> list[dict]:
        rows = self.fetch_all("SELECT * FROM pilot_events WHERE practice_id = ? AND event_type = ? ORDER BY id",
                              (practice_id, event_type))
        return [{**row, "metadata": json.loads(row["metadata_json"] or "{}")} for row in rows]


def main(argv: list[str] | None = None) -> int:
    from backend.pilot.activation import compute_metrics

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--practice", required=True)
    parser.add_argument("--owner", required=True, help="the physician's owner scope id")
    parser.add_argument("--db", default=os.environ.get("LAMINA_WORKFLOW_DATABASE", ""))
    args = parser.parse_args(argv)
    if not args.db or not Path(args.db).is_file():
        print("Database not found: pass --db or set LAMINA_WORKFLOW_DATABASE", file=sys.stderr)
        return 2
    store = _ReadOnlyStore(Path(args.db))
    member = store.fetch_one("SELECT user_id FROM practice_members WHERE practice_id = ? AND physician_owner_scope_id = ? "
                             "AND role = 'physician'", (args.practice, args.owner))
    if not member:
        print("No physician with that owner scope in that practice", file=sys.stderr)
        return 2
    latest = store.fetch_one("SELECT id FROM representation_versions WHERE practice_id = ? AND owner_scope_id = ? "
                             "ORDER BY version DESC LIMIT 1", (args.practice, args.owner))
    metrics = compute_metrics(store, args.practice, args.owner, member["user_id"], latest["id"] if latest else None)  # type: ignore[arg-type]
    print(json.dumps({key: metrics[key] for key in ("all_time", "current_rules", "by_version", "conflict_choices")}, indent=2))
    print(f"{len(metrics['disagreements'])} disagreements", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
