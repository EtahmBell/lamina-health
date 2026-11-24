"""Step 17: physician initialization and practice representation.

Statement kinds, layers + precedence + conflict surfacing, versioning, no auto-confirmation,
pending-learning lifecycle, lifecycle transitions, recommendation ↔ representation version ↔
decision linkage, isolation, staff limits, public non-leakage, parser regressions, assistant.
Synthetic data only; offline and deterministic.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from backend.pilot.practice import PilotError, PracticeContext
from backend.pilot.public_api import limiter
from backend.pilot.teaching import deterministic_interpret
from tests.test_pilot_foundation import (  # noqa: F401
    NPI_B,
    RECENT,
    Pilot,
    _event_types,
    pilot,
)
from tests.test_pilot_onboarding import _h

BASE = "/api/me/practice/representation"
PRIVATE = ["PRIVATE-JUDGMENT-zebra", "PRIVATE-PREF-quokka", "PRIVATE-EXCEPTION-okapi", "PRIVATE-PHYS-LAYER-narwhal"]


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    limiter.reset()
    yield
    limiter.reset()


def _put(pilot: Pilot, path: str, user: str, body: dict):
    return pilot.client.put(path, headers=_h(user), json=body)


def _setup_thyroid(pilot: Pilot, user: str = "user-a") -> dict:
    scope = pilot.post(f"{BASE}/setup/scope", user, {"types": [
        {"referral_type": "Thyroid nodule", "aliases": ["Thyroid nodules", "Thyroid mass"], "policy": "accept"},
        {"referral_type": "Adrenal nodule", "policy": "out_of_scope"},
        {"referral_type": "Osteoporosis", "policy": "case_by_case"},
        {"referral_type": "Hyperthyroidism", "policy": "unknown"},
    ]})
    assert scope.status_code == 200, scope.text
    return scope.json()


def _confirm_all(pilot: Pilot, user: str = "user-a") -> None:
    for proposal in pilot.get("/api/me/practice/teach", user).json()["proposals"]:
        assert pilot.post(f"/api/me/practice/teach/{proposal['id']}/confirm", user, {}).status_code == 200


def _thyroid_referral(pilot: Pilot, user: str = "user-a", **overrides) -> dict:
    return pilot.referral(user, referral_type="Thyroid nodule", reason="1.6 cm thyroid nodule found on CT", **overrides)


# ============================================================== lifecycle + setup


def test_new_physician_starts_initializing_and_confirm_enters_shadow(pilot: Pilot) -> None:
    pilot.ready_physician()
    setup = pilot.get(f"{BASE}/setup", "user-a").json()
    assert setup["lifecycle"]["state"] == "initializing"
    assert [s["id"] for s in setup["lifecycle"]["stages"]] == ["identity", "scope", "requirements", "delegation", "review"]
    assert setup["lifecycle"]["minutes_remaining"] <= 10, "honest, short estimate"
    assert setup["prefill"]["specialty"]["source"], "prefilled values carry their source"
    assert pilot.post(f"{BASE}/setup/identity/skip", "user-a").status_code == 200
    confirmed = pilot.post(f"{BASE}/confirm", "user-a").json()
    assert confirmed["lifecycle"]["state"] == "shadow"
    assert confirmed["lifecycle"]["label"].startswith("Shadow mode")
    assert confirmed["version"]["version"] == 1
    events = _event_types(pilot.store)
    assert "agent_entered_shadow" in events and "representation_confirmed" in events


def test_existing_physician_with_confirmed_rules_is_already_in_shadow(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()
    assert pilot.get(BASE, "user-a").json()["lifecycle"]["state"] == "shadow"


def test_setup_answers_are_proposals_never_auto_confirmed(pilot: Pilot) -> None:
    pilot.ready_physician()
    result = _setup_thyroid(pilot)
    assert len(result["proposals"]) == 3, "'unknown' creates nothing"
    assert all(p["operational_status"] == "inferred" for p in result["proposals"])
    # Unconfirmed statements never reach triage.
    rec = _thyroid_referral(pilot)["recommendation"]
    assert rec["fit"] == "unknown" and rec["statements_used"] == []
    # Confirming the representation does NOT confirm pending items.
    pilot.post(f"{BASE}/confirm", "user-a")
    view = pilot.get(BASE, "user-a").json()
    statuses = {item["status"] for group in view["types"] for item in group["items"]}
    assert statuses == {"proposed"}
    assert pilot.get("/api/me/practice/rules", "user-a").json() == []


def test_statement_kinds_drive_only_what_they_should(pilot: Pilot) -> None:
    pilot.ready_physician()
    _setup_thyroid(pilot)
    req = pilot.post(f"{BASE}/setup/requirements", "user-a", {
        "referral_type": "Thyroid nodule",
        "text": ("For thyroid nodule referrals I need a thyroid ultrasound and a recent TSH within 90 days. "
                 "I prefer eConsult for stable small nodules. I need a calcitonin unless the nodule is under 1 cm."),
        "urgent_signals": ["stridor"],
    }).json()
    content = req["proposal"]["content"]
    assert [(i["label"], i["freshness_days"]) for i in content["required"]] == [
        ("Thyroid ultrasound", None), ("Recent TSH", 90), ("Calcitonin", None)]
    assert content["exceptions"] and "unless" in content["exceptions"][0]
    assert content.get("modality", "unspecified") == "unspecified", "a conditional preference isn't the type default"
    assert content["preferences"] == ["eConsult first for stable small nodules"]
    _confirm_all(pilot)
    view = pilot.get(BASE, "user-a").json()
    kinds = {group["referral_type"]: {item["kind"] for item in group["items"]} for group in view["types"]}
    assert {"hard_requirement", "scope_policy", "soft_preference", "exception"} <= kinds["Thyroid nodule"]
    assert "physician_judgment" in kinds["Osteoporosis"]
    # Scope policies drive fit deterministically; judgment items never decide.
    assert _thyroid_referral(pilot)["recommendation"]["fit"] == "strong"
    adrenal = pilot.referral(referral_type="Adrenal nodule", reason="incidental adrenal nodule")["recommendation"]
    assert adrenal["fit"] == "outside_scope" and adrenal["next_step"] == "consider_redirect"
    osteo = pilot.referral(referral_type="Osteoporosis", reason="low bone density")["recommendation"]
    assert osteo["fit"] == "possible" and osteo["requires_physician"]
    assert any("case by case" in r["statement"] for r in osteo["rationale"])
    # Aliases from Stage B are honoured by matching.
    alias = pilot.referral(referral_type="Thyroid mass", reason="mass")["recommendation"]
    assert alias["type_match"]["kind"] == "alias"
    # The exception is recorded but not applied: calcitonin is still required.
    thyroid = _thyroid_referral(pilot)["recommendation"]
    assert "Calcitonin" in thyroid["missing_items"]
    exceptions = [s for s in thyroid["statements_used"] if s["kind"] == "exception"]
    assert exceptions and not exceptions[0]["drives"]


def test_unknowns_are_honest(pilot: Pilot) -> None:
    pilot.ready_physician()
    _setup_thyroid(pilot)
    _confirm_all(pilot)
    view = pilot.get(BASE, "user-a").json()
    thyroid = next(group for group in view["types"] if group["referral_type"] == "Thyroid nodule")
    assert set(thyroid["unknown_topics"]) == {"requirements", "urgency", "modality"}
    assert "Who handles each kind of referral work" in view["unknowns"]
    assert not any("Hyperthyroidism" == g["referral_type"] for g in view["types"]), "unknown answers create nothing"
    pilot.post(f"{BASE}/setup/requirements", "user-a", {"referral_type": "Thyroid nodule", "nothing_required": True,
                                                         "no_urgency_signals": True, "modality": "either"})
    _confirm_all(pilot)
    thyroid = next(g for g in pilot.get(BASE, "user-a").json()["types"] if g["referral_type"] == "Thyroid nodule")
    assert thyroid["unknown_topics"] == []


def test_delegation_is_stored_only_and_offers_no_autonomy(pilot: Pilot) -> None:
    pilot.ready_physician()
    bad = _put(pilot, f"{BASE}/setup/delegation", "user-a",
               {"answers": {"check_completeness": {"handled_by": "staff", "autonomy": "autonomous"}}})
    assert bad.status_code == 422
    sending = _put(pilot, f"{BASE}/setup/delegation", "user-a",
                   {"answers": {"send_externally": {"handled_by": "agent_prepares", "autonomy": "observe"}}})
    assert sending.status_code == 422
    ok = _put(pilot, f"{BASE}/setup/delegation", "user-a", {"answers": {
        "check_completeness": {"handled_by": "staff", "autonomy": "prepare_drafts"},
        "draft_information_requests": {"handled_by": "agent_prepares", "autonomy": "ask_before_acting"}}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["delegation"]["check_completeness"]["autonomy"] == "prepare_drafts"
    events = pilot.get("/api/me/practice/events?event_type=delegation_preferences_saved", "user-a").json()
    assert events[0]["metadata"]["enabled"] == [], "nothing is enabled"
    assert pilot.get(BASE, "user-a").json()["lifecycle"]["state"] == "initializing"


def test_leave_unknown_sets_a_proposal_aside(pilot: Pilot) -> None:
    pilot.ready_physician()
    proposals = _setup_thyroid(pilot)["proposals"]
    left = pilot.post(f"{BASE}/proposals/{proposals[0]['id']}/leave-unknown", "user-a")
    assert left.status_code == 200
    thyroid = [g for g in left.json()["types"] if g["referral_type"] == "Thyroid nodule"]
    assert thyroid == [], "left unknown: not a statement"
    assert "learning_left_unknown" in _event_types(pilot.store)


# ===================================================== layers, precedence, conflicts


def _practice_rule(pilot: Pilot, **content) -> dict:
    body = {"referral_type": "Thyroid nodule", "scope_policy": "accept",
            "required": [{"key": "recent_tsh", "label": "Recent TSH", "required": True, "freshness_days": 90}], **content}
    response = pilot.post("/api/me/practice/rules", "user-a", body)
    assert response.status_code == 201, response.text
    return response.json()


def test_physician_cannot_loosen_a_practice_requirement_unless_allowed(pilot: Pilot) -> None:
    pilot.ready_physician()
    _practice_rule(pilot)
    own = pilot.post("/api/me/practice/rules", "user-a", {"referral_type": "Thyroid nodule", "layer": "physician",
                                                           "make_optional": ["recent_tsh"]})
    assert own.status_code == 201 and own.json()["layer"] == "physician"
    rec = _thyroid_referral(pilot)["recommendation"]
    assert "Recent TSH" in rec["missing_items"], "the practice requirement stands"
    assert rec["conflicts"][0]["kind"] == "requirement_loosening" and rec["requires_physician"]
    conflicts = pilot.get(BASE, "user-a").json()["conflicts"]
    assert conflicts and conflicts[0]["kind"] == "requirement_loosening"
    assert _put(pilot, f"{BASE}/practice-settings", "user-a", {"allow_physician_loosening": True}).status_code == 200
    rec = _thyroid_referral(pilot)["recommendation"]
    assert "Recent TSH" not in rec["missing_items"] and rec["conflicts"] == []


def test_scope_conflict_between_layers_is_surfaced_not_resolved(pilot: Pilot) -> None:
    pilot.ready_physician()
    _practice_rule(pilot)
    pilot.post("/api/me/practice/rules", "user-a", {"referral_type": "Thyroid nodule", "layer": "physician",
                                                     "scope_policy": "out_of_scope"})
    rec = _thyroid_referral(pilot)["recommendation"]
    assert rec["fit"] == "unknown" and rec["requires_physician"]
    assert rec["conflicts"][0]["kind"] == "scope_policy"
    assert any("I didn’t choose between them" in r["statement"] for r in rec["rationale"])
    kinds = {(s["kind"], s["layer"]) for s in rec["statements_used"]}
    assert {("scope_policy", "practice"), ("scope_policy", "physician")} <= kinds


def test_practice_level_statements_need_an_admin_physician_own_layer_any_physician(pilot: Pilot) -> None:
    """Decision: only ADMIN physicians confirm practice-level clinical statements; any physician
    confirms their own physician-level statements; staff confirm neither."""
    from backend.pilot import api as pilot_api

    pilot.ready_physician()
    _practice_rule(pilot)
    svc = pilot.client.app.dependency_overrides[pilot_api.get_pilot_services]()
    admin = svc.practice.context("user-a")
    assert admin.is_admin
    # Another physician in the same practice, not an admin.
    other = PracticeContext(user_id="someone-else", practice=admin.practice, member={}, role="physician",
                            owner_scope_id="pos-other")
    assert not other.is_admin
    own = svc.teaching.propose(other, "For thyroid nodule referrals I need a calcium level.")
    assert own["layer"] == "physician", "a non-admin physician's teaching defaults to their own layer"
    practice_level = svc.teaching.propose(admin, "For thyroid nodule referrals I need a PTH level.")
    assert practice_level["layer"] == "practice"
    with pytest.raises(PilotError) as denied:
        svc.teaching.confirm(other, practice_level["id"])
    assert denied.value.code == "practice_admin_required"
    with pytest.raises(PilotError) as hidden:
        svc.teaching.confirm(admin, own["id"])  # another physician's private layer
    assert hidden.value.code == "rule_not_found"
    assert svc.teaching.confirm(other, own["id"])["rule"]["layer"] == "physician"
    assert svc.teaching.confirm(admin, practice_level["id"])["rule"]["layer"] == "practice"


def test_admin_rights_follow_the_member_for_practice_statements(pilot: Pilot) -> None:
    pilot.ready_physician()
    _second_physician_in_practice(pilot)
    body = {"referral_type": "Thyroid nodule", "required": [{"key": "pth", "label": "PTH", "required": True}]}
    denied = pilot.post("/api/me/practice/rules", "user-b", body)
    assert denied.status_code == 403 and _code(denied) == "practice_admin_required", denied.text
    assert "your own statement" in denied.text, "the refusal says what the physician CAN do"
    own = pilot.post("/api/me/practice/rules", "user-b", {**body, "layer": "physician"})
    assert own.status_code == 201 and own.json()["layer"] == "physician"
    member_b = pilot.store.membership_for_user("user-b")["id"]
    assert _put(pilot, f"/api/me/practice/members/{member_b}/admin", "user-a", {"is_admin": True}).status_code == 200
    assert pilot.post("/api/me/practice/rules", "user-b", body).status_code == 201


def _second_physician_in_practice(pilot: Pilot) -> str:
    """Move an approved second physician (user-b) into user-a's practice. Joining a practice as a
    physician isn't a product flow yet, so the test arranges it directly."""
    pilot.ready_physician("user-b", NPI_B)
    practice_a = pilot.store.membership_for_user("user-a")["practice_id"]
    with pilot.store._connect() as db:
        db.execute("UPDATE practice_members SET practice_id = ?, is_admin = 0 WHERE user_id = 'user-b'", (practice_a,))
    return pilot.store.membership_for_user("user-b")["id"]


def _code(response) -> str:
    body = response.json()
    detail = body.get("detail", body)
    return (detail.get("code") if isinstance(detail, dict) else None) or body.get("code") or ""


def test_practice_admin_creator_default_transfer_and_multiple_admins(pilot: Pilot) -> None:
    pilot.ready_physician()
    assert pilot.status("user-a")["is_admin"] is True, "the practice creator is admin by default"
    other_id = _second_physician_in_practice(pilot)
    members = pilot.get("/api/me/practice/members", "user-b").json()["members"]
    assert [m["is_admin"] for m in members if m["is_you"]] == [False]
    # A non-admin physician manages neither membership nor settings ...
    assert pilot.post("/api/me/practice/invitations", "user-b", {"label": "x", "email": "x@example.test"}).status_code == 403
    assert _put(pilot, f"{BASE}/practice-settings", "user-b", {"allow_physician_loosening": True}).status_code == 403
    assert _put(pilot, f"/api/me/practice/members/{other_id}/admin", "user-b", {"is_admin": True}).status_code == 403
    # ... until an admin grants it. Several admins are allowed.
    assert _put(pilot, f"/api/me/practice/members/{other_id}/admin", "user-a", {"is_admin": True}).status_code == 200
    assert pilot.post("/api/me/practice/invitations", "user-b", {"label": "Desk", "email": "desk@example.test"}).status_code == 201
    admins = [m for m in pilot.get("/api/me/practice/members", "user-a").json()["members"] if m["is_admin"]]
    assert len(admins) == 2
    # Transfer: the creator steps down; the practice keeps an admin.
    self_id = pilot.store.membership_for_user("user-a")["id"]
    assert _put(pilot, f"/api/me/practice/members/{self_id}/admin", "user-a", {"is_admin": False}).status_code == 200
    assert pilot.status("user-a")["is_admin"] is False
    assert pilot.post("/api/me/practice/invitations", "user-a", {"label": "x", "email": "x@example.test"}).status_code == 403
    # The last admin can't step down.
    last = _put(pilot, f"/api/me/practice/members/{other_id}/admin", "user-b", {"is_admin": False})
    assert last.status_code == 409 and _code(last) == "last_admin", last.text
    # Staff can't be made admin (no non-physician admin role yet -- a documented gap).
    pilot.add_staff(physician="user-b")
    staff_id = pilot.store.membership_for_user("user-c")["id"]
    refused = _put(pilot, f"/api/me/practice/members/{staff_id}/admin", "user-b", {"is_admin": True})
    assert refused.status_code == 422 and _code(refused) == "admin_requires_physician", refused.text
    events = _event_types(pilot.store)
    assert "practice_admin_granted" in events and "practice_admin_revoked" in events


def test_only_todays_question_counts_as_open_the_rest_are_queued(pilot: Pilot) -> None:
    pilot.ready_physician()
    _practice_rule(pilot, required=[
        {"key": "thyroid_ultrasound", "label": "Thyroid ultrasound", "required": True},
        {"key": "recent_tsh", "label": "Recent TSH", "required": True, "freshness_days": 90},
    ])
    for _ in range(3):
        rid = _thyroid_referral(pilot)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    pending = pilot.store.fetch_all("SELECT id FROM learning_questions WHERE status = 'pending'", ())
    assert len(pending) == 2, "two learnings to ask about"
    summary = pilot.get(f"{BASE}/summary", "user-a").json()
    # One question a day: one is actionable today, the other is queued; neither is "learned".
    assert summary["counts"]["open_questions"] == 1
    assert summary["counts"]["queued_questions"] == 1
    assert summary["counts"]["pending_learnings"] == 0
    assert summary["counts"]["confirmed_this_week"] == 1, "only the physician's own rule, not the questions"
    # Today's open question is exactly the one Home shows.
    home_text = json.dumps(pilot.get("/api/me/practice/home", "user-a").json(), ensure_ascii=False)
    assert summary["open_questions"][0]["question"] in home_text
    assert summary["queued_questions"][0]["question"] not in home_text
    # Answering today's question doesn't unlock the queued one until tomorrow.
    answered = pilot.post(f"/api/me/practice/learning/questions/{summary['open_questions'][0]['id']}/answer",
                          "user-a", {"answer": "ignore"})
    assert answered.status_code == 200, answered.text
    after = pilot.get(f"{BASE}/summary", "user-a").json()["counts"]
    assert (after["open_questions"], after["queued_questions"], after["pending_learnings"]) == (0, 1, 0)


def test_starter_suggestions_stay_labelled_and_are_confirmed_one_by_one(pilot: Pilot) -> None:
    pilot.ready_physician()
    starters = pilot.get(f"{BASE}/setup", "user-a").json()["starter_suggestions"]
    assert len(starters) >= 2 and all(isinstance(name, str) for name in starters), "names only"
    response = pilot.post(f"{BASE}/setup/scope", "user-a", {"types": [
        {"referral_type": starters[0], "policy": "accept", "suggested": True},
        {"referral_type": starters[1], "policy": "unknown", "suggested": True},
        {"referral_type": "Made-up type", "policy": "accept", "suggested": True},  # not on the list
    ]})
    assert response.status_code == 200, response.text
    proposals = {p["referral_type"]: p for p in response.json()["proposals"]}
    assert set(proposals) == {starters[0], "Made-up type"}, "an Unknown answer creates nothing"
    assert proposals[starters[0]]["suggested"] is True
    assert proposals["Made-up type"]["suggested"] is False, "only approved starter names carry the label"
    assert all(p["operational_status"] == "inferred" for p in proposals.values()), "nothing confirmed in bulk"


# ============================================================== versions + linkage


def test_versions_are_append_only_and_track_confirmed_changes(pilot: Pilot) -> None:
    pilot.ready_physician()
    _setup_thyroid(pilot)
    first = pilot.post(f"{BASE}/confirm", "user-a").json()["version"]
    _confirm_all(pilot)
    _thyroid_referral(pilot)  # triage records the version it used
    versions = pilot.get(f"{BASE}/versions", "user-a").json()
    assert versions[0]["version"] > first["version"]
    with sqlite3.connect(pilot.store.path) as db:
        with pytest.raises(sqlite3.DatabaseError):
            db.execute("UPDATE representation_versions SET reason = 'x'")
        with pytest.raises(sqlite3.DatabaseError):
            db.execute("DELETE FROM representation_versions")


def test_recommendation_links_representation_version_and_decisions(pilot: Pilot) -> None:
    pilot.ready_physician()
    _setup_thyroid(pilot)
    _confirm_all(pilot)
    detail = _thyroid_referral(pilot)
    rid = detail["referral"]["id"]
    rec = detail["recommendation"]
    assert rec["representation_version_id"]
    assert {"scope_policy"} <= {s["kind"] for s in rec["statements_used"]}
    with sqlite3.connect(pilot.store.path) as db:
        stored = db.execute("SELECT representation_version_id FROM triage_recommendations WHERE id = ?", (rec["id"],)).fetchone()[0]
    assert stored == rec["representation_version_id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"})
    pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    rows = [row for row in pilot.get(f"{BASE}/linkage", "user-a").json() if row["referral_id"] == rid]
    assert rows[0]["representation_version_id"] == rec["representation_version_id"]
    assert rows[0]["final_decision"] == "accept" and rows[0]["legacy_review"] is None
    signoff = rows[-1]["signoff"]
    assert signoff["decision"] == "accept" and signoff["actor_role"] == "physician"
    assert signoff["representation_version_id"] == rec["representation_version_id"]
    assert signoff["corrections"] == [{"field": "suggested_modality", "from": rec["suggested_modality"],
                                       "to": "econsult", "agent_value": rec["suggested_modality"]}]
    assert rows[0]["referral_type"] == "Thyroid nodule" and "scope_policy" in rows[0]["statement_kinds"]


# ============================================================== continuous learning


def test_accepting_without_an_item_proposes_making_it_optional(pilot: Pilot) -> None:
    pilot.ready_physician()
    _practice_rule(pilot, required=[{"key": "thyroid_ultrasound", "label": "Thyroid ultrasound", "required": True}])
    for _ in range(3):
        rid = _thyroid_referral(pilot)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    summary = pilot.get(f"{BASE}/summary", "user-a").json()
    # One thing to review, counted once: the learning the agent asks about is an open question.
    assert summary["counts"]["open_questions"] == 1 and summary["counts"]["pending_learnings"] == 0
    question = summary["open_questions"][0]
    assert "without “Thyroid ultrasound”" in question["question"]
    # Never auto-confirmed: triage still requires it.
    assert "Thyroid ultrasound" in _thyroid_referral(pilot)["recommendation"]["missing_items"]
    # Rate limit: the same pattern is not asked again.
    rid = _thyroid_referral(pilot)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    assert pilot.get(f"{BASE}/summary", "user-a").json()["counts"]["open_questions"] == 1
    answered = pilot.post(f"/api/me/practice/learning/questions/{question['id']}/answer", "user-a", {"answer": "yes"})
    assert answered.status_code == 200, answered.text
    rule = answered.json()["rule"]
    assert rule["version"] == 2 and not rule["content"]["required"]
    assert rule["content"]["helpful"][0]["key"] == "thyroid_ultrasound"
    assert "Thyroid ultrasound" not in _thyroid_referral(pilot)["recommendation"]["missing_items"]
    summary = pilot.get(f"{BASE}/summary", "user-a").json()
    assert summary["counts"] == {**summary["counts"], "open_questions": 0, "pending_learnings": 0}
    assert any(item["version"] == 2 for item in summary["confirmed_this_week"])


def test_dismissed_learning_is_rejected_not_applied(pilot: Pilot) -> None:
    pilot.ready_physician()
    proposal = pilot.post("/api/me/practice/teach", "user-a", {"text": "For thyroid nodule referrals I need a calcium level."}).json()
    assert pilot.post(f"/api/me/practice/teach/{proposal['id']}/reject", "user-a", {"reason": "no"}).status_code == 200
    assert pilot.get(f"{BASE}/summary", "user-a").json()["counts"]["pending_learnings"] == 0
    assert pilot.get("/api/me/practice/rules", "user-a").json() == []


def test_summary_is_the_single_source_for_counts(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.post("/api/me/practice/teach", "user-a", {"text": "For thyroid nodule referrals I need a calcium level."})
    _setup_thyroid(pilot)
    summary = pilot.get(f"{BASE}/summary", "user-a").json()
    teach = pilot.get("/api/me/practice/teach", "user-a").json()
    home = pilot.get("/api/me/practice/home", "user-a").json()
    assert summary["counts"]["pending_learnings"] == 1 and summary["counts"]["setup_pending"] == 3
    assert len(teach["proposals"]) == summary["counts"]["pending_learnings"] + summary["counts"]["setup_pending"]
    assert sum(1 for item in home["needs_you"] if item["kind"] == "proposed_learning") == summary["counts"]["pending_learnings"]


# ============================================================== permissions + isolation


def test_staff_view_practice_level_only_and_cannot_edit(pilot: Pilot) -> None:
    pilot.ready_physician()
    _practice_rule(pilot, judgment=[PRIVATE[0]])
    pilot.post("/api/me/practice/rules", "user-a", {"referral_type": "Thyroid nodule", "layer": "physician",
                                                     "preferences": [PRIVATE[3]]})
    pilot.add_staff()
    view = pilot.get(BASE, "user-c").json()
    assert view["view"] == "staff_practice_level"
    text = json.dumps(view)
    assert "Recent TSH" in text, "staff see the practice requirements relevant to their work"
    assert PRIVATE[3] not in text, "never another physician's private layer"
    assert view["delegation"] == {} and view["profile"] is None
    assert PRIVATE[3] not in json.dumps(pilot.get("/api/me/practice/rules", "user-c").json())
    for method, path, body in [
        ("get", f"{BASE}/setup", None), ("post", f"{BASE}/setup/scope", {"types": []}),
        ("post", f"{BASE}/confirm", {}), ("post", "/api/me/practice/rules", {"referral_type": "X"}),
    ]:
        response = pilot.get(path, "user-c") if method == "get" else pilot.post(path, "user-c", body)
        assert response.status_code == 403, (path, response.text)
    assert pilot.get(f"{BASE}/linkage", "user-c").status_code == 403


def test_representation_is_practice_isolated(pilot: Pilot) -> None:
    pilot.ready_physician()
    proposal = _setup_thyroid(pilot)["proposals"][0]
    pilot.confirm_physician("user-b", NPI_B)
    pilot.approve("user-b")
    pilot.create_practice("user-b", "Doe Cardiology")
    assert pilot.get(BASE, "user-b").json()["types"] == []
    assert pilot.post(f"/api/me/practice/teach/{proposal['id']}/confirm", "user-b", {}).status_code == 404
    assert pilot.post(f"{BASE}/proposals/{proposal['id']}/leave-unknown", "user-b").status_code == 404
    assert pilot.get(f"{BASE}/summary", "user-b").json()["counts"]["setup_pending"] == 0


def test_private_representation_never_reaches_public_surfaces(pilot: Pilot) -> None:
    pilot.ready_physician()
    rule = _practice_rule(pilot, judgment=[PRIVATE[0]], preferences=[PRIVATE[1]], exceptions=[PRIVATE[2]],
                          publishable=True)
    pilot.post("/api/me/practice/rules", "user-a", {"referral_type": "Thyroid nodule", "layer": "physician",
                                                     "preferences": [PRIVATE[3]], "publishable": True})
    pilot.post("/api/me/practice/teach", "user-a", {"text": f"I decide {PRIVATE[0]} case by case."})
    assert pilot.client.put(f"/api/me/practice/rules/{rule['id']}/publishable", headers=_h("user-a"),
                            json={"publishable": True}).status_code == 200
    pilot.client.put("/api/me/practice/public-profile", headers=_h("user-a"), json={"slug": "test-thyroid"})
    assert pilot.post("/api/me/practice/public-profile/publish", "user-a").status_code == 200
    public = json.dumps(pilot.client.get("/api/public/p/test-thyroid").json())
    assert "Recent TSH" in public, "published practice fields still appear"
    answers = [pilot.client.post("/api/public/p/test-thyroid/ask", json={"question": q}).json()
               for q in ("What do you need for thyroid nodule referrals?", "Do you see thyroid nodules?",
                         "What visit type do you prefer?")]
    rid = _thyroid_referral(pilot)["referral"]["id"]
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/request-information", "user-a", {}).json()
    sent = pilot.post(f"/api/me/practice/information-requests/{detail['information_requests'][-1]['id']}/send",
                      "user-a", {"mode": "mark_sent"}).json()
    sender = pilot.client.get(f"/api/public/r/{sent['status_link'].rsplit('/r/', 1)[1]}").json()
    leaked = json.dumps([public, answers, sender])
    for secret in PRIVATE:
        assert secret not in leaked, secret
    for word in ("judgment", "preferences", "exceptions", "case_by_case", "scope_policy"):
        assert f'"{word}"' not in leaked, word


# ================================================================= parser + assistant


def test_parser_kinds_and_regressions() -> None:
    result = deterministic_interpret("For osteoporosis referrals I decide case by case.", ["Osteoporosis"])
    assert result["content"]["scope_policy"] == "case_by_case" and result["content"]["judgment"]
    result = deterministic_interpret("I prefer to see thyroid nodule referrals in the afternoon.", ["Thyroid nodule"])
    assert result["content"]["preferences"] and not result["content"]["required"]
    result = deterministic_interpret("For thyroid nodule referrals I need a TSH and a calcium, both within 3 months, "
                                     "and I don't need a CT.", ["Thyroid nodule"])
    assert [(i["label"], i["freshness_days"]) for i in result["content"]["required"]] == [("TSH", 90), ("Calcium", 90)]


def test_assistant_cites_kinds_and_never_calls_proposals_confirmed(pilot: Pilot) -> None:
    pilot.ready_physician()
    _practice_rule(pilot, preferences=["eConsult first for stable nodules"])
    _setup_thyroid(pilot)  # Adrenal / Osteoporosis stay proposed
    reply = pilot.post("/api/me/practice/assistant/messages", "user-a", {"text": "What are my referral rules?"}).json()["reply"]
    text = json.dumps(reply, ensure_ascii=False)
    assert "your confirmed requirement — Recent TSH (within 90 days) (v1)" in text
    assert "your stated preference — eConsult first for stable nodules" in text
    assert "Adrenal nodule: proposed, not confirmed yet" in text
    assert "I don’t know yet" in text
    setup = pilot.post("/api/me/practice/assistant/messages", "user-a", {"text": "Let's continue setup"}).json()["reply"]
    assert setup["intent"] == "setup"
    assert setup["reply"]["cards"][0]["path"].startswith("/me/setup?stage=")
    rid = _thyroid_referral(pilot)["referral"]["id"]
    why = pilot.post("/api/me/practice/assistant/messages", "user-a",
                     {"text": "Why did you recommend this?", "referral_id": rid}).json()["reply"]
    assert "Relied on your confirmed requirement: Recent TSH (Thyroid nodule v1)" in json.dumps(why["reply"], ensure_ascii=False)


def test_home_surfaces_referrals_missing_information_nobody_requested(pilot: Pilot) -> None:
    """Found in the Step 17 walkthrough: an edit moved a referral to needs_information with no
    request drafted, and Home showed nothing for it."""
    pilot.ready_physician()
    pilot.add_rule()
    rid = pilot.referral()["referral"]["id"]
    # The approval step that used to cause this is gone; referrals already in this state
    # (older data) must still surface. Put one there directly.
    with pilot.store._connect() as db:
        db.execute("UPDATE intake_referrals SET status = 'needs_information' WHERE id = ?", (rid,))
    assert pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["referral"]["status"] == "needs_information"
    needs = pilot.get("/api/me/practice/home", "user-a").json()["needs_you"]
    item = next(n for n in needs if n["kind"] == "request_missing")
    assert item["referral_id"] == rid and "nothing requested yet" in item["detail"]
    pilot.post(f"/api/me/practice/referrals/{rid}/request-information", "user-a", {})
    needs = pilot.get("/api/me/practice/home", "user-a").json()["needs_you"]
    assert not any(n["kind"] == "request_missing" for n in needs), "a drafted request replaces it"
