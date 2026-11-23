"""Triage sign-off model and attribution (Step 17 decision, staff walkthrough fixes).

The physician's accept / redirect / decline IS the sign-off; there is no separate approval.
Staff do the paperwork (request, verify, mark ready / flag). Every recorded action names who
did it. For Step 18, each decision stores the agent's recommendation at that moment, its
representation version, the physician's corrections and the decision, separately from staff.
"""

from __future__ import annotations

import pytest

from backend.pilot.public_api import limiter
from tests.test_pilot_foundation import (  # noqa: F401
    RECENT,
    Pilot,
    pilot,
)
from tests.test_pilot_onboarding import _h


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    limiter.reset()
    yield
    limiter.reset()


def _ready(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()
    pilot.add_staff()


def _send_request(pilot: Pilot, rid: str, user: str) -> dict:
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/request-information", user, {}).json()
    request = detail["information_requests"][-1]
    return pilot.post(f"/api/me/practice/information-requests/{request['id']}/send", user, {"mode": "mark_sent"}).json()


def test_history_and_requests_name_the_actor_not_your_team(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral("user-c")["referral"]["id"]
    token = _send_request(pilot, rid, "user-c")["status_link"].rsplit("/r/", 1)[1]
    pilot.client.post(f"/api/public/r/{token}/response", json={"items": [
        {"key": "recent_a1c", "value": "8.1%", "observed_date": RECENT}]})
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/items/recent_a1c/verify", "user-c", {}).json()
    physician = pilot.get("/api/me/practice/status", "user-a").json()["physician_name"]
    assert physician and physician.startswith("Dr. ")
    by_type = {}
    for event in detail["history"]:
        by_type.setdefault(event["event_type"], set()).add((event["actor_name"], event["actor_role"]))
    assert by_type["missing_information_request_sent"] == {("Front desk", "staff")}
    assert by_type["sender_response_received"] == {("Rivera Family Medicine", "referring_office")}
    assert by_type["referral_item_verified"] == {("Front desk", "staff")}
    assert ("Lamina", "lamina") in by_type["referral_triaged"]
    assert all(event["actor_name"] != "Your team" for event in detail["history"])
    request = detail["information_requests"][-1]
    assert request["created_by_name"] == "Front desk" and request["approved_by_name"] == "Front desk"
    a1c = next(item for item in detail["recommendation"]["requirements"] if item["key"] == "recent_a1c")
    assert "sent by Rivera Family Medicine, verified by Front desk" in a1c["detail"]
    assert "your team" not in a1c["detail"]
    physician_view = pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_priority": "soon"}).json()
    corrected = [e for e in physician_view["history"] if e["event_type"] == "triage_corrected"]
    assert corrected[-1]["actor_name"] == physician and corrected[-1]["actor_role"] == "physician"


def test_staff_hand_off_ready_or_flag_without_touching_clinical_fields(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    staff = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()
    assert "mark_ready" in staff["allowed_actions"] and "correct" not in staff["allowed_actions"]
    assert "mark_ready" not in pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["allowed_actions"]
    assert pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-a", {}).status_code == 403
    ready = pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-c",
                       {"note": "All paperwork in", "confirm_missing": ["Recent HbA1c", "Renal function"]}).json()
    assert ready["referral"]["status"] == "ready_for_review"
    assert ready["referral"]["handoff"]["kind"] == "ready" and ready["referral"]["handoff"]["note"] == "All paperwork in"
    assert ready["effective_triage"] == staff["effective_triage"], "a hand-off never changes the clinical triage"
    marked = [e for e in ready["history"] if e["event_type"] == "referral_marked_ready"]
    assert marked[-1]["actor_name"] == "Front desk"
    other = pilot.referral()["referral"]["id"]
    flagged = pilot.post(f"/api/me/practice/referrals/{other}/escalate", "user-c", {"note": "Odd history"}).json()
    assert flagged["referral"]["handoff"]["kind"] == "flag"
    home = pilot.get("/api/me/practice/home", "user-a").json()
    assert any(item["kind"] == "ready_for_review" and item["referral_id"] == rid for item in home["needs_you"])
    assert "ready to approve" not in str(home)


def test_signoff_record_separates_physician_decisions_from_staff_actions(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-c", {"note": "ok"})
    first = pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"}).json()
    pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_priority": "soon", "reason": "rising"})
    assert pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-c", {"decision": "accept"}).status_code == 403
    decided = pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a",
                         {"decision": "redirect", "reason": "Better elsewhere", "redirect_to": "Nephrology"}).json()
    stored = pilot.store.signoff(decided["referral"]["practice_id"], rid)
    assert stored["decision"] == "redirect" and stored["redirect_to"] == "Nephrology" and stored["actor_role"] == "physician"
    assert stored["actor"] == "user:user-a", "the sign-off is the physician's, not the staff member who marked it ready"
    assert stored["recommendation"]["id"] == first["recommendation"]["id"]
    assert stored["recommendation"]["suggested_modality"] != "econsult", "the agent's own recommendation is kept"
    assert stored["representation_version_id"] == first["recommendation"]["representation_version_id"]
    assert [(c["field"], c["to_value"], c["actor_role"]) for c in stored["corrections"]] == [
        ("suggested_modality", "econsult", "physician"), ("suggested_priority", "soon", "physician")]
    assert stored["effective_triage"]["suggested_modality"] == "econsult"
    assert stored["effective_triage"]["suggested_priority"] == "soon"
    trust = pilot.get("/api/me/practice/metrics", "user-a").json()["all_time"]["agent_trust"]
    assert trust["physician_signoffs"] == 1 and trust["signed_off_without_corrections"] == 0
    assert trust["physician_corrections"] == 2 and trust["agreement_rate"] == 0.0


def test_staff_teaching_is_a_pending_suggestion_the_physician_sees(pilot: Pilot) -> None:
    _ready(pilot)
    suggestion = pilot.post("/api/me/practice/teach", "user-c", {"text": "For diabetes referrals I need a lipid panel."}).json()
    assert suggestion["operational_status"] == "inferred" and suggestion["layer"] == "practice"
    home = pilot.get("/api/me/practice/home", "user-a").json()
    item = next(i for i in home["needs_you"] if i.get("proposal_id") == suggestion["id"])
    assert item["title"] == "Front desk suggested something for your agent"
    assert pilot.post(f"/api/me/practice/teach/{suggestion['id']}/confirm", "user-c", {}).status_code == 403
    confirmed = pilot.post(f"/api/me/practice/teach/{suggestion['id']}/confirm", "user-a", {})
    assert confirmed.status_code == 200, confirmed.text


def test_editing_a_rule_keeps_requirement_keys_so_received_values_still_count(pilot: Pilot) -> None:
    """Found in the walkthrough: re-saving a rule rebuilt "Recent TSH" as key recent_tsh (was tsh),
    orphaning a value the referring office had already sent. Keys now follow the label lineage."""
    from tests.test_pilot_foundation import DIABETES_RULE

    _ready(pilot)
    rule = pilot.get("/api/me/practice/rules", "user-a").json()[0]
    original = {item["label"]: item["key"] for item in rule["content"]["required"]}
    drifted = {**DIABETES_RULE, "required": [
        {**item, "key": item["label"].lower().replace(" ", "_") + "_v2"} for item in DIABETES_RULE["required"]]}
    revised = pilot.client.put(f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"), json=drifted).json()
    assert {item["label"]: item["key"] for item in revised["content"]["required"]} == original


def test_chat_teaching_that_extends_a_rule_keeps_its_requirement_keys(pilot: Pilot) -> None:
    """The key fix sits in rules.create, which every new version goes through: the rule editor
    (revise), chat teaching merged into the existing rule, and confirmed proposals."""
    _ready(pilot)
    current = pilot.get("/api/me/practice/rules", "user-a").json()[0]
    original = {item["label"]: item["key"] for item in current["content"]["required"]}
    taught = pilot.post("/api/me/practice/teach", "user-a",
                        {"text": "For Diabetes management referrals I need a lipid panel."}).json()
    confirmed = pilot.post(f"/api/me/practice/teach/{taught['id']}/confirm", "user-a", {}).json()["rule"]
    keys = {item["label"]: item["key"] for item in confirmed["content"]["required"]}
    assert confirmed["version"] == current["version"] + 1 and confirmed["supersedes_id"] == current["id"]
    assert {label: keys[label] for label in original} == original, "existing requirements keep their keys"
    assert len(keys) == len(original) + 1, "the taught requirement is added"
