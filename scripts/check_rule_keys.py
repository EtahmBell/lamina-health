"""Check practice rules for requirement keys that drifted between versions.

    python -m scripts.check_rule_keys [path/to/workflow.sqlite] [--json]

A requirement is identified by its key. If one version of a rule calls "Recent TSH" `tsh` and a
later version calls it `recent_tsh`, values the referring office already sent (or that were
requested) under the old key stop counting, and the item looks missing again. Rule versions
written since the key-preservation fix keep the oldest key per label; this check finds drift
from before the fix, and any referral whose evidence is stranded under a key its current
recommendation no longer uses.

Read-only. Reads only rule rows and referral metadata (keys, statuses, ids), never values.
Exit code 0: no drift on an active rule and no stranded evidence. 1: something to review.
2: the database can't be opened. Defaults to LAMINA_WORKFLOW_DATABASE.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

ACTIVE = {"confirmed", "inferred_active"}


def _items(content_json: str | None) -> list[dict]:
    content = json.loads(content_json or "{}") or {}
    return [*content.get("required", []), *content.get("helpful", [])]


def scan(path: Path) -> dict[str, Any]:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(row) for row in db.execute(
            "SELECT id, practice_id, referral_type, version, operational_status, supersedes_id, structured_rules_json "
            "FROM physician_referral_preferences WHERE scope = 'practice'")]
        by_id = {row["id"]: row for row in rows}
        successor = {row["supersedes_id"]: row for row in rows if row["supersedes_id"]}
        heads = [row for row in rows if not row["supersedes_id"] or row["supersedes_id"] not in by_id]
        drift = []
        for head in heads:
            chain, node = [head], head
            while node["id"] in successor:
                node = successor[node["id"]]
                chain.append(node)
            first: dict[str, tuple[str, int]] = {}
            for rule in chain:
                for item in _items(rule["structured_rules_json"]):
                    label = (item.get("label") or "").casefold()
                    if label in first and first[label][0] != item.get("key"):
                        drift.append({
                            "practice_id": rule["practice_id"], "referral_type": rule["referral_type"],
                            "label": item.get("label"), "first_key": first[label][0], "first_version": first[label][1],
                            "key": item.get("key"), "version": rule["version"], "rule_id": rule["id"],
                            "status": rule["operational_status"], "active": rule["operational_status"] in ACTIVE,
                        })
                    first.setdefault(label, (item.get("key"), rule["version"]))
        stranded = []
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if {"intake_referrals", "triage_recommendations"} <= tables:
            for referral in db.execute(
                "SELECT id, practice_id, status, current_recommendation_id, submitted_items_json FROM intake_referrals"
            ):
                recommendation = db.execute(
                    "SELECT recommendation_json FROM triage_recommendations WHERE id = ?",
                    (referral["current_recommendation_id"],)).fetchone()
                if not recommendation:
                    continue
                keys = {item["key"] for item in json.loads(recommendation[0]).get("requirements", [])}
                items = [item["key"] for item in json.loads(referral["submitted_items_json"] or "[]") if item.get("key")]
                requested = []
                if "missing_information_requests" in tables:
                    for (items_json,) in db.execute(
                        "SELECT items_json FROM missing_information_requests WHERE referral_id = ? "
                        "AND status NOT IN ('cancelled', 'resolved')", (referral["id"],)):
                        requested += [item["key"] for item in json.loads(items_json or "[]") if item.get("key")]
                orphan_items = sorted({key for key in items if key not in keys})
                orphan_requests = sorted({key for key in requested if key not in keys})
                if orphan_items or orphan_requests:
                    stranded.append({"referral_id": referral["id"], "practice_id": referral["practice_id"],
                                     "status": referral["status"], "current_keys": sorted(keys),
                                     "stranded_item_keys": orphan_items, "stranded_request_keys": orphan_requests})
    finally:
        db.close()
    return {"rule_rows": len(rows), "lineages": len(heads), "drift": drift, "stranded_evidence": stranded,
            "ok": not any(item["active"] for item in drift) and not stranded}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("database", nargs="?", default=os.environ.get("LAMINA_WORKFLOW_DATABASE"))
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    args = parser.parse_args(argv)
    if not args.database or not Path(args.database).is_file():
        print("No database found. Pass a path or set LAMINA_WORKFLOW_DATABASE.", file=sys.stderr)
        return 2
    try:
        report = scan(Path(args.database))
    except sqlite3.Error as error:
        print(f"Could not read the database: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"{report['rule_rows']} rule versions in {report['lineages']} rule histories")
        for item in report["drift"]:
            state = "ACTIVE" if item["active"] else item["status"]
            print(f"  drift: {item['referral_type']} / {item['label']}: {item['first_key']} (v{item['first_version']})"
                  f" -> {item['key']} (v{item['version']}, {state})")
        for item in report["stranded_evidence"]:
            print(f"  stranded: referral {item['referral_id']} ({item['status']}) items={item['stranded_item_keys']}"
                  f" requests={item['stranded_request_keys']} current={item['current_keys']}")
        if not report["drift"] and not report["stranded_evidence"]:
            print("  no key drift, no stranded evidence")
        elif report["ok"]:
            print("  drift only in superseded versions; nothing currently stranded")
        print("OK" if report["ok"] else "REVIEW NEEDED")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
