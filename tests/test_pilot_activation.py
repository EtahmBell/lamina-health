"""Step 18: readiness review and physician-approved activation. Synthetic data only."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from backend.pilot.activation import CAPABILITIES, compute_metrics
from backend.pilot.api import get_pilot_services
from backend.pilot.public_api import limiter
from backend.pilot.store import new_id, now_iso
from tests.test_pilot_foundation import DIABETES_RULE, NPI_B, RECENT, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h

COMPLETE = [{"key": "recent_a1c", "value": "8%", "observed_date": RECENT},
            {"key": "renal_function", "value": "ok", "observed_date": RECENT}]
CAP = "auto_draft_requests"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch):
    limiter.reset()
    monkeypatch.setenv("LAMINA_READINESS_MIN_SHADOW_DAYS", "0")
    monkeypatch.setenv("LAMINA_READINESS_MIN_DECIDED", "3")
    monkeypatch.setenv("LAMINA_READINESS_MIN_PER_TYPE", "2")
    monkeypatch.setenv("LAMINA_REVIEW_MIN_FOR_PERCENT", "10")
    yield
    limiter.reset()


def _services(pilot: Pilot):
    return pilot.client.app.dependency_overrides[get_pilot_services]()


def _ready(pilot: Pilot, staff: bool = True) -> dict:
    pilot.ready_physician()
    if staff:
        pilot.add_staff()
    rule = pilot.add_rule()
    pilot.get("/api/me/practice/representation/summary", "user-a")  # lifecycle → shadow (has rules)
    return rule


def _decide(pilot: Pilot, decision: str = "accept", user: str = "user-a", **overrides) -> str:
    rid = pilot.referral(user, submitted_items=COMPLETE, **overrides)["referral"]["id"]
    body = {"decision": decision} if decision == "accept" else {"decision": decision, "reason": "Not ours (synthetic)",
                                                                **({"redirect_to": "Nephrology"} if decision == "redirect" else {})}
    response = pilot.post(f"/api/me/practice/referrals/{rid}/disposition", user, body)
    assert response.status_code == 200, response.text
    return rid


def _review(pilot: Pilot, user: str = "user-a") -> dict:
    response = pilot.get("/api/me/practice/activation", user)
    assert response.status_code == 200, response.text
    return response.json()


def _cap(review: dict, key: str = CAP) -> dict:
    return next(cap for cap in review["capabilities"] if cap["key"] == key)


def _activate(pilot: Pilot, user: str = "user-a", **extra):
    return pilot.client.put(f"/api/me/practice/activation/capabilities/{CAP}", headers=_h(user),
                            json={"state": "active", "confirm": True, **extra})


# ------------------------------------------------------------------- metrics


def test_fit_mapping_deferred_judgment_and_corrections_per_dimension(pilot: Pilot) -> None:
    _ready(pilot)
    agree = _decide(pilot, "accept")  # strong fit + accept → agree
    wrong = _decide(pilot, "decline")  # strong fit + decline → disagree
    # Physician corrects visit type and priority before accepting: those dimensions disagree.
    rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult", "suggested_priority": "soon"})
    pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    # No rule for this type → fit unknown → deferred (never agreement or disagreement).
    unknown = _decide(pilot, "accept", referral_type="Thyroid nodule", reason="Nodule")
    metrics = _review(pilot)["metrics"]["all_time"]
    fit = metrics["dimensions"]["fit"]
    assert (fit["agreed"], fit["disagreed"], fit["deferred"]) == (2, 1, 1)
    assert fit["text"] == "agreed on 2 of 3" and fit["percent"] is None, "no percentage below the minimum"
    assert metrics["dimensions"]["visit_type"]["disagreed"] == 1 and metrics["dimensions"]["priority"]["disagreed"] == 1
    # The unruled referral has no missing items flagged, and the readiness dimension counts it.
    assert metrics["decided"] == 4 and set(metrics["by_type"]) == {"Diabetes management", "Thyroid nodule"}
    disagreements = _review(pilot)["metrics"]["disagreements"]
    by_dimension = {(item["referral_id"], item["dimension"]) for item in disagreements}
    assert (wrong, "fit") in by_dimension and (rid, "visit_type") in by_dimension and (agree, "fit") not in by_dimension
    fit_row = next(item for item in disagreements if item["referral_id"] == wrong and item["dimension"] == "fit")
    assert fit_row["agent_said"] == "strong" and fit_row["physician_did"] == "decline"
    assert fit_row["rule"]["referral_type"] == "Diabetes management" and fit_row["rule"]["version"] == 1
    assert unknown not in {item["referral_id"] for item in disagreements if item["dimension"] == "fit"}


def test_outside_scope_and_readiness_asked_for_more(pilot: Pilot) -> None:
    _ready(pilot)
    outside = pilot.referral("user-c", reason="Type 1 diabetes pump management", submitted_items=COMPLETE)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{outside}/disposition", "user-a", {"decision": "accept"})  # out of scope + accept → disagree
    asked = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{asked}/request-information", "user-c", {"items": ["Lipid panel"]})
    pilot.post(f"/api/me/practice/referrals/{asked}/disposition", "user-a", {"decision": "accept"})
    disagreements = {(d["referral_id"], d["dimension"]): d for d in _review(pilot)["metrics"]["disagreements"]}
    assert disagreements[(outside, "fit")]["agent_said"] == "outside_scope"
    assert disagreements[(asked, "readiness")]["physician_did"] == "asked for more: Lipid panel"


def test_only_this_physicians_sign_offs_count(pilot: Pilot) -> None:
    _ready(pilot)
    rid = _decide(pilot, "accept")
    services = _services(pilot)
    practice_id = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["referral"]["practice_id"]
    # A legacy staff approval and another actor's sign-off-shaped row: neither is this physician's decision.
    other = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
    rec_id = pilot.get(f"/api/me/practice/referrals/{other}", "user-a").json()["recommendation"]["id"]
    services.store.execute([
        (("INSERT INTO recommendation_decisions (id, recommendation_id, referral_id, practice_id, decision, actor, actor_role, "
          "created_at) VALUES (?, ?, ?, ?, 'accepted', 'user:user-c', 'staff', ?)"),
         (new_id("dec"), rec_id, other, practice_id, now_iso())),
        (("INSERT INTO referral_signoffs (id, practice_id, referral_id, recommendation_id, recommendation_json, decision, actor, "
          "actor_role, created_at) VALUES (?, ?, ?, ?, ?, 'decline', 'user:someone-else', 'physician', ?)"),
         (new_id("sgn"), practice_id, other, rec_id, json.dumps({"fit": "strong"}), now_iso())),
    ])
    assert _review(pilot)["metrics"]["all_time"]["decided"] == 1


def test_current_rules_vs_all_time_and_conflict_choices(pilot: Pilot) -> None:
    rule = _ready(pilot)
    pilot.post("/api/me/practice/representation/confirm", "user-a")
    _decide(pilot, "decline")
    v2 = pilot.client.put(f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"), json={**DIABETES_RULE, "modality": "either"}).json()
    pilot.post("/api/me/practice/representation/confirm", "user-a")
    _decide(pilot, "accept")
    metrics = _review(pilot)["metrics"]
    assert metrics["all_time"]["decided"] == 2 and metrics["current_rules"]["decided"] == 1
    assert metrics["current_rules"]["dimensions"]["fit"]["disagreed"] == 0, "the rule change shows the earlier disagreement as past"
    assert len(metrics["by_version"]) == 2
    # Conflict choices are counted from the physician's recorded choices.
    rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"})
    assert pilot.client.put(f"/api/me/practice/rules/{v2['id']}", headers=_h("user-a"), json={**DIABETES_RULE, "modality": "in_person"}).status_code == 200
    pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a")
    assert pilot.post(f"/api/me/practice/referrals/{rid}/correction-conflicts", "user-a", {"field": "suggested_modality", "choice": "keep_correction"}).status_code == 200
    assert _review(pilot)["metrics"]["conflict_choices"] == {"keep_correction": 1, "apply_rule": 0}


def test_percent_only_at_or_above_the_minimum(pilot: Pilot, monkeypatch: pytest.MonkeyPatch) -> None:
    _ready(pilot)
    for _ in range(2):
        _decide(pilot, "accept")
    assert _review(pilot)["metrics"]["all_time"]["dimensions"]["fit"]["percent"] is None
    monkeypatch.setenv("LAMINA_REVIEW_MIN_FOR_PERCENT", "2")
    fit = _review(pilot)["metrics"]["all_time"]["dimensions"]["fit"]
    assert fit["percent"] == 100 and fit["text"] == "agreed on 2 of 2"
    assert "accuracy" not in json.dumps(_review(pilot)).lower() and "score" not in json.dumps(_review(pilot)["metrics"]).lower()


# ----------------------------------------------------------------- eligibility


def test_eligibility_reasons_for_each_criterion(pilot: Pilot, monkeypatch: pytest.MonkeyPatch) -> None:
    _ready(pilot)
    _decide(pilot)
    reasons = _cap(_review(pilot))["eligibility"]["reasons"]
    assert "Needs 2 more decided referrals" in reasons
    monkeypatch.setenv("LAMINA_READINESS_MIN_SHADOW_DAYS", "3")
    assert any(reason.endswith("of shadowing left") for reason in _cap(_review(pilot))["eligibility"]["reasons"])
    monkeypatch.setenv("LAMINA_READINESS_MIN_SHADOW_DAYS", "0")
    for _ in range(2):
        _decide(pilot)
    cap = _cap(_review(pilot))
    assert cap["eligibility"]["eligible"] and cap["state"] == "shadow", "eligible never means on"
    assert cap["eligibility"]["coverage"]["covered"] == ["Diabetes management"]
    services = _services(pilot)
    monkeypatch.setattr(services.activation, "_representation_conflicts", lambda *_: [{"kind": "scope_policy"}])
    assert "Your representation has an open conflict to resolve first" in _cap(_review(pilot))["eligibility"]["reasons"]


def test_coverage_gaps_are_excluded_on_activation(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    _decide(pilot, referral_type="Thyroid nodule", reason="Nodule")
    cap = _cap(_review(pilot))
    assert cap["eligibility"]["coverage"]["gaps"] == ["Thyroid nodule"]
    assert _activate(pilot).status_code == 200
    assert _cap(_review(pilot))["config"]["excluded_types"] == ["Thyroid nodule"]


# -------------------------------------------------------------------- registry


def test_registry_holds_only_capabilities_that_exist() -> None:
    assert set(CAPABILITIES) == {"auto_draft_requests", "learning_questions"}
    assert CAPABILITIES["auto_draft_requests"]["states"] == ["off", "shadow", "active"]
    assert CAPABILITIES["learning_questions"]["states"] == ["off", "active"]


# ------------------------------------------------------------- gating & drafts


def _missing_referral(pilot: Pilot, user: str = "user-c") -> str:
    return pilot.referral(user, submitted_items=[COMPLETE[0]])["referral"]["id"]  # renal function missing


def _prepared(pilot: Pilot, rid: str) -> list[dict]:
    return _services(pilot).store.fetch_all("SELECT * FROM agent_prepared_items WHERE referral_id = ?", (rid,))


def test_off_never_runs_shadow_records_only_active_drafts(pilot: Pilot) -> None:
    _ready(pilot)
    # Default is shadow: a "would have drafted" record, never sent, no request created.
    shadow_rid = _missing_referral(pilot)
    [record] = _prepared(pilot, shadow_rid)
    assert record["mode"] == "shadow" and record["never_sent"] == 1
    assert pilot.get(f"/api/me/practice/referrals/{shadow_rid}", "user-c").json()["information_requests"] == []
    assert _cap(_review(pilot))["shadow_examples"][0]["items"] == ["Renal function"]
    # Off: nothing runs at all.
    pilot.client.put(f"/api/me/practice/activation/capabilities/{CAP}", headers=_h("user-a"), json={"state": "off"})
    off_rid = _missing_referral(pilot)
    assert _prepared(pilot, off_rid) == []
    # Active (after enough decided referrals): the draft lands in the staff queue, attributed.
    for _ in range(3):
        _decide(pilot)
    assert _activate(pilot).status_code == 200
    active_rid = _missing_referral(pilot)
    detail = pilot.get(f"/api/me/practice/referrals/{active_rid}", "user-c").json()
    [request] = detail["information_requests"]
    assert request["status"] == "draft" and request["created_by_name"].endswith("’s agent")
    # Decision 1: the agent's draft doesn't change the status until staff send it.
    assert detail["referral"]["status"] == "triaged"
    assert detail["standing"]["status_label"] == "Triaged · draft request ready for staff"
    assert detail["agent_items"][request["id"]]["capability"] == CAP
    [record] = _prepared(pilot, active_rid)
    assert record["mode"] == "active" and record["object_id"] == request["id"] and record["never_sent"] == 0
    assert not pilot.store.fetch_all("SELECT 1 FROM outbound_messages"), "nothing was sent"
    staff_home = pilot.get("/api/me/practice/home", "user-c").json()
    assert any(item["kind"] == "draft_request" and item["referral_id"] == active_rid for item in staff_home["prepared"])


def test_turning_on_needs_confirmation_and_eligibility(pilot: Pilot) -> None:
    _ready(pilot)
    assert _activate(pilot).status_code == 409, "not eligible yet"
    for _ in range(3):
        _decide(pilot)
    unconfirmed = pilot.client.put(f"/api/me/practice/activation/capabilities/{CAP}", headers=_h("user-a"), json={"state": "active"})
    assert unconfirmed.status_code == 409 and unconfirmed.json()["detail"]["code"] == "confirmation_required"
    review = _activate(pilot).json()
    assert _cap(review)["state"] == "active" and review["status"]["line"] == "Partly active · drafting requests on"
    summary = pilot.get("/api/me/practice/representation/summary", "user-a").json()
    assert summary["lifecycle"]["capabilities_line"] == "Partly active · drafting requests on"


def test_learning_questions_off_means_no_question(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(2):
        rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-a", {"suggested_modality": "econsult"})
    assert pilot.get("/api/me/practice/teach", "user-a").json()["question"] is not None
    pilot.client.put("/api/me/practice/activation/capabilities/learning_questions", headers=_h("user-a"), json={"state": "off"})
    assert pilot.get("/api/me/practice/teach", "user-a").json()["question"] is None
    assert not any(item["kind"] == "learning_question" for item in pilot.get("/api/me/practice/home", "user-a").json()["needs_you"])


# ------------------------------------------------------------ roles & limits


def test_staff_read_only_and_cannot_activate(pilot: Pilot) -> None:
    _ready(pilot)
    staff = _review(pilot, "user-c")
    assert "metrics" not in staff and staff["physician_view"] is False
    assert {cap["key"] for cap in staff["capabilities"]} == set(CAPABILITIES)
    assert _activate(pilot, "user-c").status_code == 403
    assert pilot.post("/api/me/practice/activation/pause-all", "user-c").status_code == 403


def test_practice_maximum_caps_physicians_and_lowers_active(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    assert _activate(pilot).status_code == 200
    limit = pilot.client.put(f"/api/me/practice/activation/limits/{CAP}", headers=_h("user-a"), json={"max_state": "shadow"})
    assert limit.status_code == 200
    assert _cap(_review(pilot))["state"] == "shadow", "lowered by the practice maximum"
    assert _activate(pilot).status_code == 403
    assert pilot.client.put(f"/api/me/practice/activation/limits/{CAP}", headers=_h("user-c"), json={"max_state": "active"}).status_code == 403


def test_non_admin_physician_controls_only_their_own_agent(pilot: Pilot) -> None:
    _ready(pilot)
    services = _services(pilot)
    pilot.ready_physician("user-b", NPI_B)  # a second physician, own practice, then moved in as non-admin
    a_practice = services.store.membership_for_user("user-a")["practice_id"]
    services.store.execute([("UPDATE practice_members SET practice_id = ?, is_admin = 0 WHERE user_id = 'user-b'", (a_practice,))])
    pilot.client.put(f"/api/me/practice/activation/capabilities/{CAP}", headers=_h("user-b"), json={"state": "off"})
    b_owner = services.store.membership_for_user("user-b")["physician_owner_scope_id"]
    a_owner = services.store.membership_for_user("user-a")["physician_owner_scope_id"]
    assert services.activation.state(a_practice, b_owner, CAP)["state"] == "off"
    assert services.activation.state(a_practice, a_owner, CAP)["state"] == "shadow", "user-a's agent is untouched"
    assert pilot.client.put(f"/api/me/practice/activation/limits/{CAP}", headers=_h("user-b"), json={"max_state": "off"}).status_code == 403


# ---------------------------------------------------------- pause, flag, audit


def test_pause_all_and_per_capability_revoke(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    _activate(pilot)
    review = pilot.post("/api/me/practice/activation/pause-all", "user-a").json()
    assert _cap(review)["state"] == "shadow" and review["status"]["line"] == "Shadow mode"
    _activate(pilot)
    off = pilot.client.put(f"/api/me/practice/activation/capabilities/{CAP}", headers=_h("user-a"), json={"state": "off"}).json()
    assert _cap(off)["state"] == "off"
    events = [row["event_type"] for row in pilot.store.fetch_all("SELECT event_type FROM capability_events ORDER BY created_at")]
    assert events == ["activated", "paused", "pause_all", "activated", "turned_off"]


def test_serious_flag_returns_to_shadow_and_is_on_home(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    _activate(pilot)
    rid = _missing_referral(pilot)
    request_id = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["information_requests"][0]["id"]
    item_id = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["agent_items"][request_id]["item_id"]
    # Staff can flag, but not as serious; a non-serious flag changes nothing yet appears in the review.
    assert pilot.post(f"/api/me/practice/activation/items/{item_id}/flag", "user-c", {"serious": True}).status_code == 403
    assert pilot.post(f"/api/me/practice/activation/items/{item_id}/flag", "user-c", {"note": "Wrong item"}).json()["state"] == "active"
    assert _cap(_review(pilot))["flags"][0]["note"] == "Wrong item"
    flagged = pilot.post(f"/api/me/practice/activation/items/{item_id}/flag", "user-a", {"serious": True, "note": "Asked for the wrong thing"})
    assert flagged.json()["state"] == "shadow"
    needs = pilot.get("/api/me/practice/home", "user-a").json()["needs_you"]
    assert needs[0]["kind"] == "capability_returned"
    assert "unresolved" in " ".join(_cap(_review(pilot))["eligibility"]["reasons"])
    assert _activate(pilot).status_code == 409, "a serious flag blocks turning it back on until resolved"
    flag_id = needs[0]["flag_id"]
    resolve = f"/api/me/practice/activation/flags/{flag_id}/resolve"
    assert pilot.post(resolve, "user-a", {}).status_code == 422, "resolving a flag takes a note"
    assert pilot.post(resolve, "user-a", {"note": "  "}).status_code == 422
    assert pilot.post(resolve, "user-a", {"note": "Checked the rule; fixed (synthetic)"}).status_code == 200
    assert _activate(pilot).status_code == 200
    rows = pilot.store.fetch_all("SELECT event_type, actor_role, representation_version_id FROM capability_events ORDER BY created_at")
    assert [row["event_type"] for row in rows] == ["activated", "flagged", "flagged", "auto_returned", "flag_resolved", "activated"]
    assert all(row["actor_role"] in {"physician", "staff"} for row in rows)
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        pilot.store.execute([("UPDATE capability_events SET reason = 'x'", ())])


def test_isolation_between_practices(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    _activate(pilot)
    rid = _missing_referral(pilot)
    request_id = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["information_requests"][0]["id"]
    item_id = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["agent_items"][request_id]["item_id"]
    pilot.ready_physician("user-b", NPI_B)
    other = _review(pilot, "user-b")
    assert other["metrics"]["all_time"]["decided"] == 0 and _cap(other)["state"] == "shadow"
    assert pilot.post(f"/api/me/practice/activation/items/{item_id}/flag", "user-b", {"serious": True}).status_code == 404


def test_metrics_are_reproducible_from_stored_data(pilot: Pilot) -> None:
    _ready(pilot)
    _decide(pilot, "decline")
    services = _services(pilot)
    member = services.store.membership_for_user("user-a")
    recomputed = compute_metrics(services.store, member["practice_id"], member["physician_owner_scope_id"], "user-a", None)
    assert recomputed["all_time"]["dimensions"] == _review(pilot)["metrics"]["all_time"]["dimensions"]


def test_shadow_period_counts_from_entering_shadow(pilot: Pilot, monkeypatch: pytest.MonkeyPatch) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    monkeypatch.setenv("LAMINA_READINESS_MIN_SHADOW_DAYS", "3")
    assert not _cap(_review(pilot))["eligibility"]["eligible"]
    services = _services(pilot)
    four_days_ago = (datetime.now(UTC) - timedelta(days=4)).isoformat(timespec="seconds")
    services.store.execute([("UPDATE agent_lifecycle SET shadow_at = ?", (four_days_ago,))])
    assert _cap(_review(pilot))["eligibility"]["eligible"]


def test_recompute_script_matches_the_review_read_only(pilot: Pilot, capsys: pytest.CaptureFixture) -> None:
    from scripts import activation_metrics

    _ready(pilot)
    _decide(pilot, "decline")
    _decide(pilot, "accept")
    services = _services(pilot)
    member = services.store.membership_for_user("user-a")
    code = activation_metrics.main(["--practice", member["practice_id"], "--owner", member["physician_owner_scope_id"],
                                    "--db", str(services.store.path)])
    assert code == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["all_time"]["dimensions"] == _review(pilot)["metrics"]["all_time"]["dimensions"]


# ------------------------------------------------------------ Step 18 decisions


def _active_with_draft(pilot: Pilot) -> tuple[str, str, str]:
    """Drafting on, then one agent-drafted request. Returns (referral, request, agent item)."""
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    assert _activate(pilot).status_code == 200
    rid = _missing_referral(pilot)
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()
    request_id = detail["information_requests"][0]["id"]
    return rid, request_id, detail["agent_items"][request_id]["item_id"]


def test_agent_draft_keeps_status_until_staff_send_and_history_says_so(pilot: Pilot) -> None:
    rid, request_id, _item = _active_with_draft(pilot)
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()
    drafted = [event for event in detail["history"] if event["event_type"] == "information_requested"]
    assert len(drafted) == 1 and drafted[0]["metadata"]["by_agent"] is True
    assert drafted[0]["actor_name"].endswith("’s agent")
    created = [event for event in detail["history"] if event["event_type"] == "missing_information_request_created"]
    assert not created, "one history row per draft"
    assert not [event for event in detail["history"] if event["event_type"] == "referral_status_changed"
                and event["metadata"]["to"] == "needs_information"]
    listed = next(item for item in pilot.get("/api/me/practice/referrals", "user-c").json() if item["id"] == rid)
    assert listed["status"] == "triaged"
    assert listed["standing"]["status_label"] == "Triaged · draft request ready for staff"
    # Staff Home lists the draft once (prepared), not also as "check and mark ready".
    home = pilot.get("/api/me/practice/home", "user-c").json()
    assert not [item for item in home["needs_you"] if item.get("referral_id") == rid]
    assert [item["kind"] for item in home["prepared"] if item["referral_id"] == rid] == ["draft_request"]
    # Staff send it: now it needs information.
    sent = pilot.post(f"/api/me/practice/information-requests/{request_id}/send", "user-c", {"mode": "mark_sent"})
    assert sent.status_code == 200, sent.text
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()
    assert detail["referral"]["status"] == "needs_information" and detail["standing"]["status_label"] is None


def test_staff_request_still_moves_status_at_draft(pilot: Pilot) -> None:
    _ready(pilot)
    rid = _missing_referral(pilot)  # drafting is in shadow: no agent draft
    pilot.post(f"/api/me/practice/referrals/{rid}/request-information", "user-c", {"items": ["Renal function"]})
    assert pilot.get(f"/api/me/practice/referrals/{rid}", "user-c").json()["referral"]["status"] == "needs_information"


def test_ready_with_missing_items_needs_a_confirmation_naming_them(pilot: Pilot) -> None:
    _ready(pilot)
    rid = _missing_referral(pilot)
    refused = pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-c", {"note": "Checked"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "missing_items_unconfirmed"
    assert "Renal function" in refused.json()["detail"]["message"]
    wrong = pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-c", {"confirm_missing": ["Recent HbA1c"]})
    assert wrong.status_code == 409, "the confirmation must name what is actually missing"
    ok = pilot.post(f"/api/me/practice/referrals/{rid}/mark-ready", "user-c",
                    {"note": "Office is faxing it (synthetic)", "confirm_missing": ["Renal function"]})
    assert ok.status_code == 200, ok.text
    detail = ok.json()
    assert detail["referral"]["status"] == "ready_for_review"
    assert detail["referral"]["handoff"]["missing_items"] == ["Renal function"]
    event = next(event for event in detail["history"] if event["event_type"] == "referral_marked_ready")
    assert event["metadata"]["missing_items"] == ["Renal function"]
    assert event["summary"] == "Marked ready while still missing Renal function"
    # Nothing missing: no confirmation needed (unchanged behaviour).
    complete = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
    assert pilot.post(f"/api/me/practice/referrals/{complete}/mark-ready", "user-c", {}).status_code == 200


def test_possible_fit_declined_is_its_own_row(pilot: Pilot) -> None:
    _ready(pilot)
    possible = _decide(pilot, "decline", reason="Prediabetes question (synthetic)")
    redirected = _decide(pilot, "redirect", reason="Prediabetes follow-up (synthetic)")
    accepted = _decide(pilot, "accept", reason="Prediabetes, wants advice (synthetic)")
    hard = _decide(pilot, "decline")  # strong fit + decline: a real disagreement
    metrics = _review(pilot)["metrics"]
    fit = metrics["all_time"]["dimensions"]["fit"]
    assert (fit["agreed"], fit["disagreed"], fit["possible_not_accepted"]) == (1, 1, 2)
    assert fit["text"] == "agreed on 1 of 2", "possible → declined is neither agreement nor disagreement"
    assert {item["referral_id"] for item in metrics["possible_not_accepted"]} == {possible, redirected}
    fit_rows = {item["referral_id"] for item in metrics["disagreements"] if item["dimension"] == "fit"}
    assert fit_rows == {hard}
    assert accepted not in {item["referral_id"] for item in metrics["possible_not_accepted"]}


def test_three_flags_in_seven_days_return_to_shadow_with_a_home_item(pilot: Pilot) -> None:
    _rid, _request, item = _active_with_draft(pilot)
    for n in range(2):
        flagged = pilot.post(f"/api/me/practice/activation/items/{item}/flag", "user-c", {"note": f"Off {n}"})
        assert flagged.json()["state"] == "active"
    # Older flags (outside 7 days) don't count.
    services = _services(pilot)
    old = (datetime.now(UTC) - timedelta(days=8)).isoformat()
    services.store.execute([("UPDATE agent_item_flags SET created_at = ? WHERE note = 'Off 0'", (old,))])
    assert pilot.post(f"/api/me/practice/activation/items/{item}/flag", "user-c", {"note": "Off 2"}).json()["state"] == "active"
    third = pilot.post(f"/api/me/practice/activation/items/{item}/flag", "user-a", {"note": "Off 3"}).json()
    assert third["state"] == "shadow", "three non-serious flags within 7 days"
    home = pilot.get("/api/me/practice/home", "user-a").json()
    notice = next(entry for entry in home["needs_you"] if entry["kind"] == "capability_notice")
    assert notice["title"] == "Draft missing-information requests went back to shadow"
    assert "3 “this was wrong” flags in 7 days" in notice["detail"]
    assert "change was made to what your agent may do" in home["briefing"]["detail"]
    review = _review(pilot)
    assert review["notices"][0]["id"] == notice["notice_id"]
    assert review["summary"]["recommended"]["target"] == "readiness-notices"
    # Acknowledged by the physician (not staff): gone from Home; recorded (append-only).
    path = f"/api/me/practice/activation/notices/{notice['notice_id']}/acknowledge"
    assert pilot.post(path, "user-c").status_code == 403
    assert pilot.post(path, "user-a").status_code == 200
    assert not [e for e in pilot.get("/api/me/practice/home", "user-a").json()["needs_you"] if e["kind"] == "capability_notice"]
    events = [row["event_type"] for row in services.store.fetch_all("SELECT event_type FROM capability_events ORDER BY created_at")]
    assert "auto_returned_repeated_flags" in events and events[-1] == "notice_acknowledged"
    # Turning it back on needs each flag behind the return resolved, with a note (follow-up).
    cap = _cap(_review(pilot))
    blocking = [flag for flag in cap["flags"] if flag["blocking"]]
    assert {flag["note"] for flag in blocking} == {"Off 1", "Off 2", "Off 3"}, "the old flag outside 7 days isn't one of them"
    assert any("resolve each with a note" in reason for reason in cap["eligibility"]["reasons"])
    assert _review(pilot)["summary"]["recommended"]["label"] == "Review the flags"
    refused = _activate(pilot)
    assert refused.status_code == 409 and "3 “this was wrong” flags" in refused.json()["detail"]["message"]
    assert pilot.post(f"/api/me/practice/activation/flags/{blocking[0]['id']}/resolve", "user-c", {"note": "x"}).status_code == 403
    for flag in blocking:
        done = pilot.post(f"/api/me/practice/activation/flags/{flag['id']}/resolve", "user-a", {"note": f"Reviewed {flag['note']}"})
        assert done.status_code == 200, done.text
    assert all(flag["resolution_note"] for flag in _cap(_review(pilot))["flags"] if flag["note"] != "Off 0")
    # Turned back on: earlier flags no longer count.
    assert _activate(pilot).status_code == 200
    assert pilot.post(f"/api/me/practice/activation/items/{item}/flag", "user-c", {"note": "Again"}).json()["state"] == "active"


def test_lowered_practice_limit_tells_the_affected_physician(pilot: Pilot) -> None:
    _ready(pilot)
    services = _services(pilot)
    pilot.ready_physician("user-b", NPI_B)
    a_practice = services.store.membership_for_user("user-a")["practice_id"]
    services.store.execute([("UPDATE practice_members SET practice_id = ?, is_admin = 0 WHERE user_id = 'user-b'", (a_practice,))])
    b_owner = services.store.membership_for_user("user-b")["physician_owner_scope_id"]
    # user-b's drafting is in shadow (the default); the admin turns it off for everyone.
    limit = pilot.client.put(f"/api/me/practice/activation/limits/{CAP}", headers=_h("user-a"), json={"max_state": "off"})
    assert limit.status_code == 200
    assert services.activation.state(a_practice, b_owner, CAP)["state"] == "off"
    b_home = pilot.get("/api/me/practice/home", "user-b").json()["needs_you"]
    notice = next(item for item in b_home if item["kind"] == "capability_notice")
    assert notice["title"] == "Draft missing-information requests was lowered to off"
    assert "set the practice maximum to off" in notice["detail"] and "from shadow to off" in notice["detail"]
    # The admin who set it isn't told about their own change.
    a_home = pilot.get("/api/me/practice/home", "user-a").json()["needs_you"]
    assert not [item for item in a_home if item["kind"] == "capability_notice"]
    row = services.store.fetch_one("SELECT from_state, to_state FROM capability_events WHERE owner_scope_id = ? "
                                   "AND event_type = 'lowered_by_practice_limit'", (b_owner,))
    assert (row["from_state"], row["to_state"]) == ("shadow", "off")


def test_readiness_summary_has_status_eligibility_and_one_action(pilot: Pilot) -> None:
    _ready(pilot)
    summary = _review(pilot)["summary"]
    assert summary["eligible"] == [] and summary["not_eligible"][0]["reasons"] == ["Needs 3 more decided referrals"]
    assert summary["recommended"]["text"].startswith("Keep deciding referrals as usual — needs 3 more")
    assert summary["recommended"]["label"] is None
    for _ in range(3):
        _decide(pilot)
    summary = _review(pilot)["summary"]
    assert summary["eligible"] == ["Draft missing-information requests"] and summary["status"] == "Shadow mode"
    assert summary["recommended"]["target"] == "readiness-disagreed"
    assert "nothing changes until you choose" in summary["recommended"]["text"]
    _activate(pilot)
    summary = _review(pilot)["summary"]
    assert summary["active"] == ["Draft missing-information requests"] and summary["recommended"]["label"] is None
    assert "summary" not in _review(pilot, "user-c"), "staff get the read-only view"


def test_staff_view_names_who_made_the_last_change(pilot: Pilot) -> None:
    _ready(pilot)
    for _ in range(3):
        _decide(pilot)
    _activate(pilot)
    staff_cap = _cap(_review(pilot, "user-c"))
    assert staff_cap["updated_by_name"]
    assert _cap(_review(pilot))["updated_by_name"] == staff_cap["updated_by_name"]
    assert staff_cap["updated_by_name"] == pilot.get("/api/me/practice/activation", "user-a").json()["capabilities"][0]["updated_by_name"]


# ------------------------------------------------------- Step 18 follow-ups (run 1)


def test_ready_check_separates_received_but_unverified_from_missing(pilot: Pilot) -> None:
    from tests.test_pilot_agent import _request_and_send, _token

    _ready(pilot)
    rid = pilot.referral("user-c")["referral"]["id"]  # nothing submitted: A1c and renal both missing
    token = _token(_request_and_send(pilot, rid, "user-c")["status_link"])
    responded = pilot.client.post(f"/api/public/r/{token}/response", json={
        "message": "Renal panel below (synthetic).",
        "items": [{"key": "renal_function", "value": "Cr 0.9 eGFR 88", "observed_date": RECENT}],
    })
    assert responded.status_code == 200, responded.text
    path = f"/api/me/practice/referrals/{rid}/mark-ready"
    refused = pilot.post(path, "user-c", {"note": "Checked"})
    assert refused.status_code == 409
    message = refused.json()["detail"]["message"]
    assert "Still missing: Recent HbA1c" in message and "Received, not verified: Renal function" in message
    # The confirmation must name both kinds; naming only the missing one isn't enough.
    assert pilot.post(path, "user-c", {"confirm_missing": ["Recent HbA1c"]}).status_code == 409
    ok = pilot.post(path, "user-c", {"note": "Office says the A1c is coming (synthetic)",
                                    "confirm_missing": ["Recent HbA1c", "Renal function"]})
    assert ok.status_code == 200, ok.text
    handoff = ok.json()["referral"]["handoff"]
    assert handoff["missing_items"] == ["Recent HbA1c"] and handoff["unverified_items"] == ["Renal function"]
    event = next(e for e in ok.json()["history"] if e["event_type"] == "referral_marked_ready")
    assert event["summary"] == "Marked ready while still missing Recent HbA1c; received, not verified: Renal function"
