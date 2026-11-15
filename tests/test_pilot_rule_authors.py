"""Step 17 cleanup: rule-version authors, correction-vs-rule conflicts, immutable legacy
decisions, and the rule-key drift check. Synthetic data only."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from backend.pilot.public_api import limiter
from backend.pilot.store import PilotStore
from scripts import check_rule_keys
from tests.test_pilot_foundation import DIABETES_RULE, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    limiter.reset()
    yield
    limiter.reset()


def _ready(pilot: Pilot) -> dict:
    pilot.ready_physician()
    pilot.add_staff()
    return pilot.add_rule()


def _rule_row(pilot: Pilot, rule_id: str) -> dict:
    return pilot.store.fetch_one(
        "SELECT created_by, confirmed_by, author_source FROM physician_referral_preferences WHERE id = ?", (rule_id,))


def _revise(pilot: Pilot, rule_id: str, **changes) -> dict:
    response = pilot.client.put(f"/api/me/practice/rules/{rule_id}", headers=_h("user-a"), json={**DIABETES_RULE, **changes})
    assert response.status_code == 200, response.text
    return response.json()


# =============================================================== 1. rule-version authors


def test_each_rule_version_records_its_author_and_confirmer(pilot: Pilot) -> None:
    rule = _ready(pilot)
    assert _rule_row(pilot, rule["id"]) == {"created_by": "user:user-a", "confirmed_by": "user:user-a", "author_source": "recorded"}
    suggestion = pilot.post("/api/me/practice/teach", "user-c", {"text": "For Diabetes management referrals I need a lipid panel."}).json()
    assert _rule_row(pilot, suggestion["id"]) == {"created_by": "user:user-c", "confirmed_by": None, "author_source": "recorded"}
    confirmed = pilot.post(f"/api/me/practice/teach/{suggestion['id']}/confirm", "user-a", {}).json()["rule"]
    # Merged into the rule as a new version the physician made active.
    assert _rule_row(pilot, confirmed["id"])["confirmed_by"] == "user:user-a"
    assert confirmed["created_by"] == "user:user-a" and confirmed["author_source"] == "recorded"


def test_backfill_uses_recorded_history_and_marks_unknowns(pilot: Pilot) -> None:
    rule = _ready(pilot)
    with pilot.store._connect() as db:
        # As written before authors were stored: no author columns, no actor in provenance.
        db.execute("UPDATE physician_referral_preferences SET created_by = NULL, confirmed_by = NULL, "
                   "author_source = NULL, provenance_json = '{}' WHERE id = ?", (rule["id"],))
        # A version with no surviving record of who wrote it.
        db.execute(
            "INSERT INTO physician_referral_preferences (id, workspace_id, physician_id, case_family, source_text, "
            "structured_rules_json, status, source, created_at, updated_at, referral_type, scope, practice_id, "
            "operational_status, physician_confirmed, publishable, version, layer) VALUES "
            "('rule_orphan', 'w', 'p', 'Orphan', '', '{}', 'draft', 'physician_authored_structured', 'x', 'x', "
            "'Orphan', 'practice', ?, 'inferred', 0, 0, 1, 'practice')", (rule["practice_id"],))
    PilotStore(workflow=pilot.store.workflow)  # opening the store runs the one-time backfill
    assert _rule_row(pilot, rule["id"]) == {"created_by": "user:user-a", "confirmed_by": "user:user-a", "author_source": "backfilled"}
    assert _rule_row(pilot, "rule_orphan") == {"created_by": None, "confirmed_by": None, "author_source": "unknown"}


def test_cause_uses_the_stored_author_and_says_when_it_is_unknown(pilot: Pilot) -> None:
    rule = _ready(pilot)
    rid = pilot.referral(reason="Referred for diabetes follow-up")["referral"]["id"]
    revised = _revise(pilot, rule["id"], good_fit=["diabetes follow-up"])
    # A later, unrelated action on the old version must not be credited (it was, by "last event").
    pilot.store.append_event("rule_viewed", actor="user:user-c", practice_id=rule["practice_id"],
                             metadata={"rule_id": revised["id"]})
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-c").json()
    cause = [e for e in detail["history"] if e["event_type"] == "recommendation_changed"][-1]["metadata"]["cause"]
    physician = pilot.get("/api/me/practice/status", "user-a").json()["physician_name"]
    assert cause["text"] == f"{physician} updated the Diabetes management rule (v2)"
    # Unknown author: say so; never credit the person who re-ran the check.
    third = _revise(pilot, revised["id"], good_fit=[])
    with pilot.store._connect() as db:
        db.execute("UPDATE physician_referral_preferences SET created_by = NULL, confirmed_by = NULL, "
                   "author_source = 'unknown' WHERE id = ?", (third["id"],))
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-c").json()
    cause = [e for e in detail["history"] if e["event_type"] == "recommendation_changed"][-1]["metadata"]["cause"]
    assert cause["text"] == "the Diabetes management rule was updated (v3; author not recorded)"
    assert cause["trigger_differs"] is True and "Front desk" not in cause["text"]


# ======================================================= 3. corrections vs newer rules


def test_a_newer_rule_that_disagrees_with_a_correction_is_shown_and_the_choice_recorded(pilot: Pilot) -> None:
    rule = _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"})
    assert pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["correction_conflicts"] == []
    v2 = _revise(pilot, rule["id"], modality="either")
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    [conflict] = detail["correction_conflicts"]
    assert (conflict["field"], conflict["corrected_value"], conflict["rule_value"], conflict["rule_version"]) == \
        ("suggested_modality", "econsult", "either", 2)
    assert conflict["corrected_by_you"] and conflict["rule_by_you"]
    assert detail["effective_triage"]["suggested_modality"] == "econsult", "the correction still applies until a choice"
    staff = pilot.post(f"/api/me/practice/referrals/{rid}/correction-conflicts", "user-c",
                       {"field": "suggested_modality", "choice": "apply_rule"})
    assert staff.status_code == 403
    kept = pilot.post(f"/api/me/practice/referrals/{rid}/correction-conflicts", "user-a",
                      {"field": "suggested_modality", "choice": "keep_correction"}).json()
    assert kept["correction_conflicts"] == [] and kept["effective_triage"]["suggested_modality"] == "econsult"
    # A further rule version re-opens the question.
    _revise(pilot, v2["id"], modality="unspecified")
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    assert [c["rule_version"] for c in detail["correction_conflicts"]] == [3]
    applied = pilot.post(f"/api/me/practice/referrals/{rid}/correction-conflicts", "user-a",
                         {"field": "suggested_modality", "choice": "apply_rule"}).json()
    assert applied["correction_conflicts"] == []
    assert applied["effective_triage"]["suggested_modality"] == "unspecified", "the rule's value now applies"
    assert applied["corrections"][-1]["to"] == "unspecified" and "Applied the updated" in applied["corrections"][-1]["reason"]
    choices = pilot.store.fetch_all(
        "SELECT choice, rule_version, actor_role FROM correction_conflict_resolutions WHERE referral_id = ? ORDER BY created_at, rowid", (rid,))
    assert [(c["choice"], c["rule_version"], c["actor_role"]) for c in choices] == [
        ("keep_correction", 2, "physician"), ("apply_rule", 3, "physician")]
    with sqlite3.connect(pilot.store.path) as db, pytest.raises(sqlite3.DatabaseError):
        db.execute("DELETE FROM correction_conflict_resolutions")
    # Later rule changes now flow through; the cleared correction doesn't come back.
    assert pilot.post(f"/api/me/practice/referrals/{rid}/correction-conflicts", "user-a",
                      {"field": "suggested_modality", "choice": "apply_rule"}).status_code == 409


def test_a_legacy_physician_edit_conflicting_with_a_newer_rule_is_shown(pilot: Pilot) -> None:
    """The Eta case: an edit from the retired approval step, then the rule changed."""
    rule = _ready(pilot)
    detail = pilot.referral()
    rid, rec = detail["referral"]["id"], detail["recommendation"]
    with pilot.store._connect() as db:
        db.execute("UPDATE intake_referrals SET review_json = ? WHERE id = ?", (json.dumps({
            "recommendation_id": rec["id"], "decision": "edited", "fields": {"suggested_modality": "econsult"},
            "by": "user:user-a", "role": "physician", "at": "2026-11-01T00:00:00+00:00"}), rid))
    _revise(pilot, rule["id"], modality="either")
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    [conflict] = detail["correction_conflicts"]
    assert conflict["corrected_value"] == "econsult" and conflict["rule_value"] == "either"
    staff_view = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["correction_conflicts"][0]
    assert not staff_view["corrected_by_you"] and staff_view["corrected_by_name"].startswith("Dr. ")


# ===================================================== 4. legacy decisions stay immutable


def test_a_seeded_recommendation_decision_cannot_be_changed_or_deleted(pilot: Pilot) -> None:
    _ready(pilot)
    detail = pilot.referral()
    with sqlite3.connect(pilot.store.path) as db:
        db.execute(
            "INSERT INTO recommendation_decisions (id, recommendation_id, referral_id, practice_id, decision, "
            "changed_fields_json, actor, actor_role, created_at) VALUES ('dec_seed', ?, ?, ?, 'accepted', '{}', "
            "'user:user-c', 'staff', '2026-11-01T00:00:00+00:00')",
            (detail["recommendation"]["id"], detail["referral"]["id"], detail["referral"]["practice_id"]))
        db.commit()
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            db.execute("DELETE FROM recommendation_decisions WHERE id = 'dec_seed'")
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            db.execute("UPDATE recommendation_decisions SET actor_role = 'physician' WHERE id = 'dec_seed'")
    assert pilot.store.fetch_one("SELECT actor_role FROM recommendation_decisions WHERE id = 'dec_seed'")["actor_role"] == "staff"


# ========================================================== 5. rule-key drift check


def _drift_db(path: Path, *, active_drift: bool, stranded: bool) -> Path:
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE physician_referral_preferences (id TEXT, practice_id TEXT, referral_type TEXT, version INTEGER,
      operational_status TEXT, supersedes_id TEXT, structured_rules_json TEXT, scope TEXT);
    CREATE TABLE intake_referrals (id TEXT, practice_id TEXT, status TEXT, current_recommendation_id TEXT, submitted_items_json TEXT);
    CREATE TABLE triage_recommendations (id TEXT, recommendation_json TEXT);
    CREATE TABLE missing_information_requests (referral_id TEXT, status TEXT, items_json TEXT);
    """)
    tsh = lambda key: json.dumps({"required": [{"key": key, "label": "Recent TSH"}]})
    db.execute("INSERT INTO physician_referral_preferences VALUES ('r1','p','Thyroid',1,'superseded',NULL,?,'practice')", (tsh("tsh"),))
    db.execute("INSERT INTO physician_referral_preferences VALUES ('r2','p','Thyroid',2,?, 'r1',?,'practice')",
               ("confirmed" if active_drift else "superseded", tsh("recent_tsh")))
    if not active_drift:
        db.execute("INSERT INTO physician_referral_preferences VALUES ('r3','p','Thyroid',3,'confirmed','r2',?,'practice')", (tsh("tsh"),))
    current = "recent_tsh" if active_drift else "tsh"
    db.execute("INSERT INTO triage_recommendations VALUES ('rec', ?)", (json.dumps({"requirements": [{"key": current}]}),))
    db.execute("INSERT INTO intake_referrals VALUES ('ref','p','needs_information','rec',?)",
               (json.dumps([{"key": "tsh" if stranded else current, "value": "x"}]),))
    db.commit()
    db.close()
    return path


def test_rule_key_check_reports_drift_and_stranded_evidence(tmp_path: Path, capsys) -> None:
    bad = check_rule_keys.scan(_drift_db(tmp_path / "bad.sqlite", active_drift=True, stranded=True))
    assert not bad["ok"] and bad["drift"][0]["first_key"] == "tsh" and bad["drift"][0]["key"] == "recent_tsh"
    assert bad["drift"][0]["active"] and bad["stranded_evidence"][0]["stranded_item_keys"] == ["tsh"]
    assert check_rule_keys.main([str(tmp_path / "bad.sqlite")]) == 1
    healed = check_rule_keys.scan(_drift_db(tmp_path / "healed.sqlite", active_drift=False, stranded=False))
    assert healed["ok"] and len(healed["drift"]) == 1 and not healed["drift"][0]["active"], \
        "drift left only in a superseded version is reported but not a failure"
    assert check_rule_keys.main([str(tmp_path / "healed.sqlite")]) == 0
    assert check_rule_keys.main([str(tmp_path / "missing.sqlite")]) == 2
    assert "REVIEW NEEDED" in capsys.readouterr().out


def test_rule_key_check_is_clean_on_a_store_written_by_the_product(pilot: Pilot) -> None:
    rule = _ready(pilot)
    pilot.referral()
    _revise(pilot, rule["id"], required=[{**item, "key": item["key"] + "_renamed"} for item in DIABETES_RULE["required"]])
    report = check_rule_keys.scan(Path(pilot.store.path))
    assert report["ok"] and report["drift"] == [] and report["stranded_evidence"] == []
