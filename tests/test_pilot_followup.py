"""UI-loop follow-up: one standing source of truth, physician vs staff ownership on Home,
conflicts in the queue, structured role-aware rationale, learning basis, history summaries,
decline/redirect office notification, and role-aware assistant text. Synthetic data only."""

from __future__ import annotations

import pytest

from backend.pilot.public_api import limiter
from backend.pilot.rationale import rationale_view, render
from backend.pilot.standing import queue_detail, referral_standing
from backend.pilot.voice import PHYSICIAN, Voice
from tests.test_pilot_foundation import DIABETES_RULE, RECENT, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h

STAFF = Voice(physician=False, doctor="Dr. A")
COMPLETE_ITEMS = [{"key": "recent_a1c", "value": "8%", "observed_date": RECENT},
                  {"key": "renal_function", "value": "ok", "observed_date": RECENT}]


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    limiter.reset()
    yield
    limiter.reset()


def _ready(pilot: Pilot, staff: bool = True) -> dict:
    pilot.ready_physician()
    if staff:
        pilot.add_staff()
    return pilot.add_rule()


def _send_request(pilot: Pilot, rid: str, user: str = "user-c") -> str:
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/request-information", user, {}).json()
    request = detail["information_requests"][-1]
    sent = pilot.post(f"/api/me/practice/information-requests/{request['id']}/send", user, {"mode": "mark_sent"}).json()
    return sent["status_link"].rsplit("/r/", 1)[1]


# ------------------------------------------------------------------------- standing


def _rec(*states: str, readiness: str = "missing_information") -> dict:
    return {"readiness": readiness, "requirements": [
        {"key": f"k{index}", "label": label, "required": True, "state": state}
        for index, (label, state) in enumerate(zip(["Thyroid ultrasound", "Recent TSH"], states, strict=False))]}


def test_standing_never_calls_a_referral_complete_while_anything_is_open() -> None:
    open_ultrasound = referral_standing(status="ready_for_review", recommendation=_rec("missing", "satisfied"),
                                        next_step="request_information", requests=[{"status": "sent"}], voice=STAFF)
    assert open_ultrasound["heading"] == "Ready for Dr. A’s decision"
    assert open_ultrasound["still_open"] == "Still open: Thyroid ultrasound — requested from the referring office, not received yet"
    assert open_ultrasound["complete"] is False and open_ultrasound["readiness_text"] == "Missing Thyroid ultrasound"
    unverified = referral_standing(status="needs_information", recommendation=_rec("satisfied", "sender_reported"),
                                   next_step=None, requests=[{"status": "partially_resolved"}], voice=PHYSICIAN)
    assert unverified["heading"] == "Verify what the referring office sent" and unverified["complete"] is False
    assert unverified["readiness_text"] == "Received, not yet verified: Recent TSH"
    done = referral_standing(status="triaged", recommendation=_rec("satisfied", "satisfied", readiness="ready"),
                             next_step="physician_review", requests=[], voice=PHYSICIAN)
    assert done["complete"] and done["readiness_text"] == "Complete per your rule" and done["still_open"] is None
    assert referral_standing(status="triaged", recommendation=_rec("satisfied", "satisfied", readiness="ready"),
                             next_step="physician_review", requests=[], voice=STAFF)["heading"] == "Check, then mark ready for Dr. A"
    # A rule with nothing required: never "complete per your rule".
    none = referral_standing(status="triaged", recommendation={"readiness": "ready", "requirements": []},
                             next_step="physician_review", requests=[], voice=PHYSICIAN)
    assert none["no_requirements"] and not none["complete"]
    assert none["readiness_text"] == "No requirements set — completeness not checked"
    assert queue_detail("Osteoporosis", none, PHYSICIAN) == "Osteoporosis · no requirements set"


def test_home_says_what_is_still_open_on_a_referral_marked_ready(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral("user-c", submitted_items=[COMPLETE_ITEMS[0]])["referral"]["id"]  # renal function missing
    _send_request(pilot, rid)
    pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-c", {"note": "A1c is in"})
    home = pilot.get("/api/me/practice/home", "user-a").json()
    [row] = [item for item in home["needs_you"] if item.get("referral_id") == rid]
    assert "complete per your rules" not in row["detail"]
    assert row["detail"] == "Diabetes management · marked ready by Front desk · missing Renal function"
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()
    assert detail["standing"]["still_open"].startswith("Still open: Renal function")
    listed = {item["id"]: item for item in pilot.get("/api/me/practice/referrals", "user-a").json()}
    assert listed[rid]["standing"] == {**detail["standing"]}, "the list and the referral page read one standing"
    complete = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{complete}/mark-ready", "user-c", {})
    home = pilot.get("/api/me/practice/home", "user-a").json()
    [row] = [item for item in home["needs_you"] if item.get("referral_id") == complete]
    assert row["detail"].endswith("complete per your rules")


# --------------------------------------------------------------------- ownership


def test_physician_needs_only_their_decisions_and_staff_get_the_paperwork(pilot: Pilot) -> None:
    _ready(pilot)
    triaged = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
    unrequested = pilot.referral("user-c")["referral"]["id"]  # needs information, nothing requested
    physician = pilot.get("/api/me/practice/home", "user-a").json()
    assert {item.get("referral_id") for item in physician["needs_you"]} & {triaged, unrequested} == set()
    assert {item["referral_id"]: item["kind"] for item in physician["waiting"]}[triaged] == "waiting_staff"
    staff = pilot.get("/api/me/practice/home", "user-c").json()
    kinds = {item.get("referral_id"): item["kind"] for item in staff["needs_you"]}
    assert kinds[triaged] == "triage_review" and kinds[unrequested] in {"triage_review", "request_missing"}
    assert "triaged referrals need checking before the physician sees them" in staff["briefing"]["detail"]


def test_conflicts_are_marked_in_the_physician_queue_and_sorted_first(pilot: Pilot) -> None:
    rule = _ready(pilot)
    rid = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"})
    pilot.client.put(f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"), json={**DIABETES_RULE, "modality": "either"})
    pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a")
    other = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{other}/mark-ready", "user-c", {})
    needs = pilot.get("/api/me/practice/home", "user-a").json()["needs_you"]
    conflict = next(item for item in needs if item.get("referral_id") == rid)
    assert conflict["kind"] == "correction_conflict" and "your correction differs" in conflict["title"]
    assert needs.index(conflict) < needs.index(next(item for item in needs if item.get("referral_id") == other))
    # Staff can't resolve it: their queue doesn't show it as theirs.
    staff = pilot.get("/api/me/practice/home", "user-c").json()["needs_you"]
    assert all(item["kind"] != "correction_conflict" for item in staff)


# ---------------------------------------------------------------------- rationale


def test_rationale_is_structured_and_rendered_for_each_reader(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
    for user, fit_line in (("user-a", "your fit criterion"), ("user-c", "’s fit criterion")):
        rationale = pilot.get(f"/api/me/practice/referrals/{rid}", user).json()["recommendation"]["rationale"]
        fit = next(item for item in rationale if item["code"] == "fit_match")
        assert fit["params"]["phrase"] == "type 2 diabetes not at goal" and fit["params"]["matched"]
        assert fit_line in fit["text"] and fit["worded_for_physician"] is False
        assert fit["source"]["rule_version"] == 1
    staff_text = " ".join(item["text"] for item in pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["recommendation"]["rationale"])
    assert "your" not in staff_text.lower().split()
    # The stored statement is the physician wording of the same parts (older readers).
    assert render("fit_match", {"phrase": "x", "matched": ["x"]}) == "Referral text matches your fit criterion “x” (matched: x)."
    # A recommendation stored before structured rationale is shown as written, flagged for staff.
    legacy = rationale_view({"statement": "Your rule applies.", "source": {"kind": "practice_rule"}}, STAFF)
    assert legacy["text"] == "Your rule applies." and legacy["worded_for_physician"] is True


def test_a_rule_with_no_requirements_never_reads_complete(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule(rule={"referral_type": "Osteoporosis", "good_fit": ["low bone density"], "modality": "either"})
    rid = pilot.referral(referral_type="Osteoporosis", reason="Low bone density on DXA")["referral"]["id"]
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()
    codes = [item["code"] for item in detail["recommendation"]["rationale"]]
    assert "requirements_none" in codes and "requirements_complete" not in codes
    assert detail["standing"]["readiness_text"] == "No requirements set — completeness not checked"


# ----------------------------------------------------------------- history, notices


def test_history_names_what_was_requested_and_what_the_office_sent(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral("user-c", submitted_items=[COMPLETE_ITEMS[0]])["referral"]["id"]
    token = _send_request(pilot, rid)
    pilot.client.post(f"/api/public/r/{token}/response", json={"items": [{"key": "renal_function", "value": "eGFR 80", "observed_date": RECENT}]})
    history = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["history"]
    sent = next(event for event in history if event["event_type"] == "missing_information_request_sent")
    assert sent["actor_name"] == "Front desk" and sent["summary"] == "Asked for Renal function · sent outside Lamina by fax/email"
    reply = next(event for event in history if event["event_type"] == "sender_response_received")
    assert reply["actor_name"] == "Rivera Family Medicine" and reply["summary"] == "Sent Renal function"


def test_a_decline_shows_an_honest_notice_state_and_nothing_is_sent(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "decline", "reason": "Outside our service"})
    notice = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["office_notification"]
    assert notice["state"] == "not_sent" and "unable to accept it. Reason: Outside our service." in notice["draft"]
    assert "Alex Example" in notice["draft"]
    staff_home = pilot.get("/api/me/practice/home", "user-c").json()
    assert any(item["kind"] == "notify_office" and item["referral_id"] == rid for item in staff_home["needs_you"])
    assert not any(item["kind"] == "notify_office" for item in pilot.get("/api/me/practice/home", "user-a").json()["needs_you"])
    marked = pilot.post(f"/api/me/practice/referrals/{rid}/office-notified", "user-c")
    assert marked.status_code == 200
    after = marked.json()
    assert after["office_notification"]["state"] == "sent" and after["office_notification"]["by_name"] == "Front desk"
    practice_id = after["referral"]["practice_id"]
    [recorded] = pilot.store.events(practice_id=practice_id, referral_id=rid, event_type="referring_office_notified")
    assert recorded["metadata"]["sent_via"] == "outside_lamina", "recorded only; Lamina sent nothing"
    assert not pilot.store.events(practice_id=practice_id, referral_id=rid, event_type="missing_information_request_sent")
    assert pilot.post(f"/api/me/practice/referrals/{rid}/office-notified", "user-c").status_code == 409
    open_rid = pilot.referral("user-c")["referral"]["id"]
    assert pilot.post(f"/api/me/practice/referrals/{open_rid}/office-notified", "user-c").status_code == 409


# ------------------------------------------------------------------ learning, dock


def test_learning_basis_replaces_the_numeric_confidence(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(2):
        rid = pilot.referral("user-c", submitted_items=COMPLETE_ITEMS)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"})
    pilot.post("/api/me/practice/teach", "user-a", {"text": "For diabetes management referrals I need a lipid panel."})
    proposals = pilot.get("/api/me/practice/teach", "user-a").json()["proposals"]
    learned = next(item for item in proposals if item["source"] == "correction_pattern")
    assert learned["basis"] == "Seen in 2 of the last 2 Diabetes management decisions"
    told = next(item for item in proposals if item["source"] == "explicit_instruction")
    assert told["basis"] == "From an instruction"


def test_dock_text_is_written_for_the_reader(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral("user-c", submitted_items=[COMPLETE_ITEMS[0]], patient={"name": "Casey Dock", "date_of_birth": "1970-01-02"})["referral"]["id"]
    assert rid
    staff = pilot.post("/api/me/practice/assistant/messages", "user-c", {"text": "What's missing for Casey Dock?"}).json()
    physician = pilot.post("/api/me/practice/assistant/messages", "user-a", {"text": "What's missing for Casey Dock?"}).json()
    staff_text, physician_text = (" ".join(reply["reply"]["reply"]["paragraphs"]) for reply in (staff, physician))
    assert "per your rules" in physician_text
    assert "per your rules" not in staff_text and "’s rules" in staff_text
