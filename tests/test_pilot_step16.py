"""Step 16: referral safety, correctness, and workflow reliability.

1. Sender access tokens never persist in stored text, events, or logs (template + redaction,
   reissue/revoke, expiry, legacy scrub, authorization boundaries).
2. Sender free-text values are unverified assertions until a practice member verifies them.
3. Canonical referral types: normalization, controlled aliases, escalation on uncertainty.
4. Teaching: per-item qualifiers, conjunctions, modifiers, negation, exceptions.
5. Approvals carry forward across non-material re-triage; material change needs review.

Synthetic data only; offline and deterministic.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from backend.pilot.log_redaction import (
    SenderTokenRedactionFilter,
    install_sender_token_log_redaction,
)
from backend.pilot.models import PracticeRuleInput, SubmittedItem
from backend.pilot.public_api import limiter
from backend.pilot.rules import PracticeRules
from backend.pilot.store import PilotStore, hash_token, redact_sender_links
from backend.pilot.teaching import deterministic_interpret
from backend.pilot.triage import triage_referral
from backend.pilot.vocabulary import canonical_word, referral_type_key
from tests.test_pilot_foundation import (  # noqa: F401
    DIABETES_RULE,
    NPI_B,
    RECENT,
    STALE,
    TODAY,
    Pilot,
    _event_types,
    _referral_model,
    pilot,
)
from tests.test_pilot_onboarding import _h

THYROID_RULE = {
    "referral_type": "Thyroid nodule",
    "good_fit": ["nodule larger than 1 cm"],
    "outside_scope": ["hyperthyroidism in pregnancy"],
    "required": [{"key": "thyroid_ultrasound", "label": "Thyroid ultrasound", "required": True, "freshness_days": None},
                 {"key": "recent_tsh", "label": "Recent TSH", "required": True, "freshness_days": 90}],
    "helpful": [], "urgent_signals": [], "modality": "unspecified",
}


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    limiter.reset()
    yield
    limiter.reset()


def _ready(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()


def _send_request(pilot: Pilot, rid: str, user: str = "user-a", mode: str = "mark_sent", recipient: str | None = None) -> dict:
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/request-information", user, {}).json()
    request = detail["information_requests"][-1]
    if recipient:
        pilot.client.put(f"/api/me/practice/information-requests/{request['id']}",
                         headers=_h(user), json={"recipient": recipient})
    sent = pilot.post(f"/api/me/practice/information-requests/{request['id']}/send", user, {"mode": mode})
    assert sent.status_code == 200, sent.text
    return sent.json()


def _token(link: str) -> str:
    return link.rsplit("/r/", 1)[1]


def _all_text(store: PilotStore) -> str:
    """Every stored text column a token could hide in."""
    with sqlite3.connect(store.path) as db:
        rows = []
        for table, columns in {
            "missing_information_requests": "draft_message, evidence_json",
            "outbound_messages": "body", "pilot_events": "metadata_json",
            "intake_referrals": "submitted_items_json, review_json, information_request_json",
            "sender_responses": "message, items_json",
        }.items():
            rows += [json.dumps(row) for row in db.execute(f"SELECT {columns} FROM {table}")]
    return "\n".join(rows)


# ======================================================== 1. sender access tokens


def test_sent_request_never_stores_or_redisplays_the_raw_token(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    sent = _send_request(pilot, rid, mode="send", recipient="office@clinic.test")
    token = _token(sent["status_link"])
    assert "{status_link}" in sent["draft_message"] and token not in sent["draft_message"]
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()
    assert token not in json.dumps(detail), "general referral view must not expose the token"
    assert token not in _all_text(pilot.store), "no stored text may contain the token"
    events = pilot.get("/api/me/practice/events", "user-a").json()
    assert token not in json.dumps(events)
    assert pilot.client.get(f"/api/public/r/{token}").status_code == 200, "the delivered link still works"


def test_reissue_revokes_the_old_link_and_the_new_one_is_returned_once(pilot: Pilot) -> None:
    _ready(pilot)
    pilot.add_staff()
    rid = pilot.referral()["referral"]["id"]
    sent = _send_request(pilot, rid)
    old = _token(sent["status_link"])
    again = pilot.post(f"/api/me/practice/information-requests/{sent['id']}/reissue-link", "user-c", {"mode": "mark_sent"})
    assert again.status_code == 200, again.text
    new = _token(again.json()["status_link"])
    assert new != old
    assert pilot.client.get(f"/api/public/r/{old}").status_code == 404, "revoked"
    assert pilot.client.get(f"/api/public/r/{new}").status_code == 200
    assert new not in _all_text(pilot.store)
    assert "sender_link_reissued" in _event_types(pilot.store, referral_id=rid)
    # Only open (sent) requests can be reissued; a cancelled one cannot.
    pilot.post(f"/api/me/practice/information-requests/{sent['id']}/cancel", "user-a")
    assert pilot.client.get(f"/api/public/r/{new}").status_code == 404
    closed = pilot.post(f"/api/me/practice/information-requests/{sent['id']}/reissue-link", "user-a", {"mode": "mark_sent"})
    assert closed.status_code == 409


def test_expired_link_is_refused(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    token = _token(_send_request(pilot, rid)["status_link"])
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat(timespec="seconds")
    with sqlite3.connect(pilot.store.path) as db:
        db.execute("UPDATE sender_links SET expires_at = ? WHERE token_hash = ?", (past, hash_token(token)))
    assert pilot.client.get(f"/api/public/r/{token}").status_code == 404
    upload = pilot.client.post(f"/api/public/r/{token}/documents", headers={"Content-Type": "text/plain"}, content=b"x")
    assert upload.status_code == 404


def test_link_and_reissue_respect_practice_boundaries(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    sent = _send_request(pilot, rid)
    pilot.confirm_physician("user-b", NPI_B)
    pilot.create_practice("user-b", "Doe Cardiology")
    pilot.approve("user-b")
    assert pilot.post(f"/api/me/practice/information-requests/{sent['id']}/reissue-link", "user-b",
                      {"mode": "mark_sent"}).status_code == 404
    assert pilot.post(f"/api/me/practice/referrals/{rid}/items/recent_a1c/verify", "user-b", {}).status_code == 404
    assert pilot.post(f"/api/me/practice/referrals/{rid}/referral-type", "user-b",
                      {"referral_type": "Diabetes management"}).status_code == 404
    # The sender link is bound to its own referral only; it reveals no internal ids.
    body = pilot.client.get(f"/api/public/r/{_token(sent['status_link'])}").json()
    assert rid not in json.dumps(body)


def test_sender_responses_carry_no_store_and_no_referrer_headers(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    token = _token(_send_request(pilot, rid)["status_link"])
    response = pilot.client.get(f"/api/public/r/{token}")
    assert response.headers["cache-control"] == "no-store, private"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_access_log_redacts_sender_tokens() -> None:
    token = "A" * 43
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:1", "GET", f"/api/public/r/{token}/documents", "1.1", 200), None)
    SenderTokenRedactionFilter().filter(record)
    assert token not in record.getMessage() and "/r/[secure link removed]/documents" in record.getMessage()
    install_sender_token_log_redaction()
    install_sender_token_log_redaction()  # idempotent
    assert sum(isinstance(f, SenderTokenRedactionFilter) for f in logging.getLogger("uvicorn.access").filters) == 1
    assert redact_sender_links(f"see http://x/r/{token} ok") == "see http://x/r/[secure link removed] ok"


def test_legacy_rows_with_raw_tokens_are_scrubbed_and_their_links_revoked(pilot: Pilot) -> None:
    """Simulates data written before Step 16: the rendered body (with the raw link) was saved."""
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    sent = _send_request(pilot, rid, mode="send", recipient="office@clinic.test")
    link = sent["status_link"]
    token = _token(link)
    with sqlite3.connect(pilot.store.path) as db:
        db.execute("UPDATE missing_information_requests SET draft_message = ? WHERE id = ?",
                   (sent["draft_message"].replace("{status_link}", link), sent["id"]))
        db.execute("DROP TRIGGER outbound_messages_no_update")
        db.execute("UPDATE outbound_messages SET body = ?", (f"legacy body {link}",))
        db.execute("CREATE TRIGGER outbound_messages_no_update BEFORE UPDATE ON outbound_messages "
                   "BEGIN SELECT RAISE(ABORT, 'outbound messages are immutable'); END")
    assert token in _all_text(pilot.store)
    PilotStore(workflow=pilot.workflow)  # startup migration
    assert token not in _all_text(pilot.store)
    with sqlite3.connect(pilot.store.path) as db:
        draft = db.execute("SELECT draft_message FROM missing_information_requests WHERE id = ?", (sent["id"],)).fetchone()[0]
        with pytest.raises(sqlite3.DatabaseError):
            db.execute("UPDATE outbound_messages SET body = 'x'")  # immutability restored
    assert "{status_link}" in draft
    assert pilot.client.get(f"/api/public/r/{token}").status_code == 404, "an exposed link is revoked"
    assert "sender_tokens_redacted" in _event_types(pilot.store)
    PilotStore(workflow=pilot.workflow)  # idempotent: nothing left to scrub
    assert _event_types(pilot.store).count("sender_tokens_redacted") == 1


# ================================================ 2. sender assertions vs evidence


def test_sender_value_is_received_not_satisfied_until_verified(tmp_path) -> None:
    store = PilotStore(tmp_path / "w.sqlite")
    rules = PracticeRules(store)
    rules.create("prc_test", "phys", PracticeRuleInput.model_validate(DIABETES_RULE), actor="user:x")
    rule_list = rules.operational("prc_test", "Diabetes management")
    sender = SubmittedItem(key="recent_a1c", value="8.1%", observed_date=RECENT, source="sender_submitted",
                           recorded_by="sender:lnk_1")
    renal = SubmittedItem(key="renal_function", value="eGFR 88", observed_date=RECENT, source="staff_entered")
    rec, _ = triage_referral(_referral_model(submitted_items=[sender, renal]), rule_list, [], today=TODAY)
    state = {item.key: item for item in rec.requirements}
    assert state["recent_a1c"].state == "sender_reported" and "not yet verified" in state["recent_a1c"].detail
    assert rec.readiness == "missing_information" and rec.next_step == "review_sender_information"
    verified = sender.model_copy(update={"verified_by": "user:staff", "verified_at": "2026-11-09T00:00:00+00:00"})
    rec, _ = triage_referral(_referral_model(submitted_items=[verified, renal]), rule_list, [], today=TODAY)
    assert rec.readiness == "ready"
    assert "verified by your team" in {i.key: i for i in rec.requirements}["recent_a1c"].detail
    # Verified but too old: verified is not the same as satisfied.
    stale = verified.model_copy(update={"observed_date": STALE})
    rec, _ = triage_referral(_referral_model(submitted_items=[stale, renal]), rule_list, [], today=TODAY)
    assert {i.key: i.state for i in rec.requirements}["recent_a1c"] == "missing"
    # Staff transcription at intake (recorded by a practice member) counts as the team's record.
    transcribed = SubmittedItem(key="recent_a1c", value="8.1%", observed_date=RECENT, source="sender_submitted",
                                recorded_by="user:staff")
    rec, _ = triage_referral(_referral_model(submitted_items=[transcribed, renal]), rule_list, [], today=TODAY)
    assert rec.readiness == "ready"


def test_staff_can_verify_and_verification_is_audited(pilot: Pilot) -> None:
    _ready(pilot)
    pilot.add_staff()
    rid = pilot.referral()["referral"]["id"]
    token = _token(_send_request(pilot, rid)["status_link"])
    pilot.client.post(f"/api/public/r/{token}/response", json={"message": "both attached", "items": [
        {"key": "recent_a1c", "value": "8.1%", "observed_date": RECENT}]})
    home = pilot.get("/api/me/practice/home", "user-c").json()
    assert any(item["kind"] == "verify_sender_information" for item in home["needs_you"])
    assert pilot.post(f"/api/me/practice/referrals/{rid}/items/renal_function/verify", "user-c", {}).status_code == 404
    ok = pilot.post(f"/api/me/practice/referrals/{rid}/items/recent_a1c/verify", "user-c", {})
    assert ok.status_code == 200, ok.text
    again = pilot.post(f"/api/me/practice/referrals/{rid}/items/recent_a1c/verify", "user-c", {})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_verified"
    events = pilot.get("/api/me/practice/events?event_type=referral_item_verified", "user-a").json()
    assert events[0]["metadata"]["key"] == "recent_a1c" and events[0]["metadata"]["role"] == "staff"
    detail = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()
    assert detail["referral"]["status"] == "needs_information", "renal function is still missing"


# =================================================== 3. canonical referral types


def test_vocabulary_is_explicit_and_conservative() -> None:
    assert canonical_word("pregnant") == canonical_word("pregnancy")
    assert canonical_word("nodules") == canonical_word("nodule")
    assert canonical_word("diabetes") == "diabetes" and canonical_word("masses") == canonical_word("mass")
    assert referral_type_key("Thyroid nodules referral") == referral_type_key("thyroid  nodule")
    assert referral_type_key("Thyroid nodule") != referral_type_key("Thyroid cancer")
    assert referral_type_key("Renal") != referral_type_key("Kidney"), "no cross-concept synonyms"


def test_type_resolution_exact_normalized_alias_ambiguous_none(tmp_path) -> None:
    store = PilotStore(tmp_path / "w.sqlite")
    rules = PracticeRules(store)
    rules.create("p", "phys", PracticeRuleInput.model_validate({**THYROID_RULE, "aliases": ["Thyroid mass"]}), actor="user:x")
    rules.create("p", "phys", PracticeRuleInput.model_validate(DIABETES_RULE), actor="user:x")
    assert rules.resolve_type("p", "thyroid NODULE")[1]["kind"] == "exact"
    found, info = rules.resolve_type("p", "Thyroid nodules")
    assert info["kind"] == "normalized" and found[0].referral_type == "Thyroid nodule"
    alias = rules.resolve_type("p", "Thyroid masses")[1]
    assert alias["kind"] == "alias" and alias["matched_alias"] == "Thyroid mass"
    found, info = rules.resolve_type("p", "Endocrinology - thyroid nodule (benign)")
    assert found == [] and info["kind"] == "none" and info["suggestions"] == ["Thyroid nodule"]
    assert rules.resolve_type("p", "Cardiology")[1]["suggestions"] == []
    # An alias may only name one practice type.
    from backend.pilot.rules import RuleConflictError
    with pytest.raises(RuleConflictError):
        rules.create("p", "phys", PracticeRuleInput.model_validate({**DIABETES_RULE, "referral_type": "Endocrine",
                                                                     "aliases": ["Thyroid nodules"]}), actor="user:x")


def test_uncertain_type_escalates_and_confirmation_keeps_original_wording(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule(rule=THYROID_RULE)
    plural = pilot.referral(referral_type="Thyroid nodules", reason="1.5 cm nodule larger than 1 cm")
    rec = plural["recommendation"]
    assert rec["type_match"]["kind"] == "normalized" and rec["fit"] == "strong"
    vague = pilot.referral(referral_type="Endocrinology - thyroid nodule (benign)", reason="nodule")
    rid = vague["referral"]["id"]
    rec = vague["recommendation"]
    assert rec["next_step"] == "confirm_referral_type" and rec["fit"] == "unknown" and rec["requires_physician"]
    assert rec["requirements"] == [], "no rule is applied on an uncertain type"
    assert "set_referral_type" in vague["allowed_actions"]
    pilot.add_staff()
    confirmed = pilot.post(f"/api/me/practice/referrals/{rid}/referral-type", "user-c", {"referral_type": "Thyroid nodule"}).json()
    assert confirmed["referral"]["referral_type"] == "Thyroid nodule"
    assert confirmed["referral"]["submitted_referral_type"] == "Endocrinology - thyroid nodule (benign)"
    assert confirmed["recommendation"]["type_match"]["kind"] == "exact"
    assert len(confirmed["recommendation"]["requirements"]) == 2
    assert "referral_type_confirmed" in _event_types(pilot.store, referral_id=rid)


def test_scope_matching_normalizes_forms_and_escalates_partial_matches(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule(rule=THYROID_RULE)
    pregnant = pilot.referral(referral_type="Thyroid nodule", reason="Hyperthyroid, currently pregnant, 24 weeks")
    assert pregnant["recommendation"]["fit"] == "outside_scope"
    # The rule's own type words ("thyroid nodule") never inflate a criterion match.
    partial = pilot.referral(referral_type="Thyroid nodule", reason="Thyroid nodule; patient is pregnant")
    rec = partial["recommendation"]
    assert rec["fit"] != "outside_scope" and rec["requires_physician"]
    assert any("Partly matches your outside-scope criterion" in r["statement"] for r in rec["rationale"])


# ===================================================================== 4. teaching

TYPES = ["Thyroid nodule", "Diabetes management"]


def _req(text: str) -> tuple[list, list, dict]:
    result = deterministic_interpret(text, TYPES)
    content = result["content"]
    return ([(i["label"], i["freshness_days"]) for i in content["required"]],
            [(i["label"], i["freshness_days"]) for i in content["helpful"]], result)


@pytest.mark.parametrize("text, required, helpful", [
    # Conjunction: the window belongs only to the item it follows.
    ("For thyroid nodule referrals I always need a thyroid ultrasound and a recent TSH within 90 days.",
     [("Thyroid ultrasound", None), ("Recent TSH", 90)], []),
    # Shared modifier: "both" applies the window to every item.
    ("For thyroid nodule referrals I need a TSH and an ultrasound, both within 3 months.",
     [("TSH", 90), ("Ultrasound", 90)], []),
    # Different windows per item and different phrasings.
    ("For thyroid nodule referrals I need a TSH no older than 90 days and an ultrasound within the last 12 months.",
     [("TSH", 90), ("Ultrasound", 365)], []),
    # Per-item helpful modifier inside a list.
    ("For diabetes management referrals I need an A1c from the last 6 months, a lipid panel, and ideally a glucose log.",
     [("A1c", 180), ("Lipid panel", None)], [("Glucose log", None)]),
])
def test_teaching_attaches_conditions_to_the_right_item(text, required, helpful) -> None:
    got_required, got_helpful, result = _req(text)
    assert got_required == required and got_helpful == helpful
    assert result["referral_type"] in TYPES


def test_teaching_never_turns_negation_or_exceptions_into_rules() -> None:
    required, _, result = _req("For thyroid nodule referrals I don't need a CT scan.")
    assert required == [] and "CT scan" in result["content"]["note"]
    assert any("not needed" in note for note in result["review_notes"])
    required, _, result = _req("For thyroid nodule referrals I need a TSH unless the patient is on levothyroxine.")
    assert required == [("TSH", None)]
    assert any("unless the patient is on levothyroxine" in note for note in result["review_notes"])
    _, _, result = _req("I don't see thyroid nodules unless they are larger than 1 cm.")
    assert result["content"]["outside_scope"] == [], "an exception-qualified scope rule is not applied"
    assert "larger than 1 cm" in result["content"]["note"]
    _, _, result = _req("Thyroid nodule referrals with hyperthyroidism in pregnancy are outside our scope.")
    assert result["content"]["outside_scope"] == ["hyperthyroidism in pregnancy"]
    _, _, result = _req("For diabetes management referrals I need a recent A1c.")
    assert any("no time window" in note for note in result["review_notes"])


def test_multiple_requirements_across_sentences_and_versioned_confirmation(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule(rule=THYROID_RULE)
    proposal = pilot.post("/api/me/practice/teach", "user-a", {
        "text": "For thyroid nodules referrals I need a calcium level. I also want a neck CT within 6 months."}).json()
    assert proposal["referral_type"] == "Thyroid nodule", "plural wording maps to the existing type"
    required = [(i["label"], i["freshness_days"]) for i in proposal["content"]["required"]]
    assert required == [("Calcium level", None), ("Neck CT", 180)]
    edited = {**THYROID_RULE, "required": [
        {"key": "calcium", "label": "Calcium level", "required": True, "freshness_days": 30},
        {"key": "neck_ct", "label": "Neck CT", "required": True, "freshness_days": 180}]}
    confirmed = pilot.post(f"/api/me/practice/teach/{proposal['id']}/confirm", "user-a", {"edits": edited})
    assert confirmed.status_code == 200, confirmed.text
    rule = confirmed.json()["rule"]
    assert rule["version"] == 2
    history = pilot.get(f"/api/me/practice/rules/{rule['id']}/history", "user-a").json()
    assert [r["version"] for r in history] == [1, 2] and history[0]["operational_status"] == "superseded"
    labels = {item["label"]: item["freshness_days"] for item in rule["content"]["required"]}
    assert labels["Calcium level"] == 30 and labels["Recent TSH"] == 90, "existing items keep their own windows"


# =================================================================== 5. approvals


def test_unchanged_recommendation_keeps_its_approval(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    approved = pilot.post(f"/api/me/practice/referrals/{rid}/approve", "user-a").json()
    assert "approve" not in approved["allowed_actions"]
    token = _token(_send_request(pilot, rid)["status_link"])
    pilot.client.post(f"/api/public/r/{token}/response", json={"items": [
        {"key": "recent_a1c", "value": "8.1%", "observed_date": RECENT},
        {"key": "renal_function", "value": "eGFR 88", "observed_date": RECENT}]})
    for key in ("recent_a1c", "renal_function"):
        detail = pilot.post(f"/api/me/practice/referrals/{rid}/items/{key}/verify", "user-a", {}).json()
    assert detail["referral"]["status"] == "ready_for_review"
    assert "approve" not in detail["allowed_actions"], "same recommendation: no second approval"
    assert detail["decision"]["carried_forward"] and detail["approval"]["state"] == "carried_forward"
    assert "readiness" in detail["approval"]["nonmaterial_changes"]
    events = _event_types(pilot.store, referral_id=rid)
    assert "recommendation_approval_carried_forward" in events
    with sqlite3.connect(pilot.store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM recommendation_decisions WHERE referral_id = ?", (rid,)).fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM recommendation_carryovers WHERE referral_id = ?", (rid,)).fetchone()[0] >= 1
    metrics = pilot.get("/api/me/practice/metrics", "user-a").json()["all_time"]
    assert metrics["agent_trust"]["accepted"] == 1, "carry-overs are not counted as new human decisions"


def test_material_change_requires_a_fresh_review_with_the_reason(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral(reason="Referred for diabetes follow-up")["referral"]["id"]
    first = pilot.post(f"/api/me/practice/referrals/{rid}/approve", "user-a").json()
    assert first["recommendation"]["fit"] == "possible"
    rule = pilot.get("/api/me/practice/rules", "user-a").json()[0]
    pilot.client.put(f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"),
                     json={**DIABETES_RULE, "good_fit": ["diabetes follow-up"]})
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    assert detail["recommendation"]["fit"] == "strong"
    assert "approve" in detail["allowed_actions"], "a consequential change needs a new review"
    assert detail["approval"]["state"] == "needs_review_changed"
    assert detail["approval"]["changed"]["fit"] == {"from": "possible", "to": "strong"}
    assert "recommendation_changed_after_approval" in _event_types(pilot.store, referral_id=rid)


def test_carryover_keeps_human_edits(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral()["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/edit", "user-a", {"suggested_modality": "econsult", "reason": "stable"})
    detail = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    assert detail["decision"]["carried_forward"] and detail["effective_triage"]["suggested_modality"] == "econsult"


def test_legacy_recommendation_without_type_match_is_not_a_material_change(tmp_path) -> None:
    """Recommendations stored before Step 16 have no type_match; that alone must not
    re-open an approval (found in browser verification on legacy synthetic data)."""
    from backend.pilot.intake import material_changes

    store = PilotStore(tmp_path / "w.sqlite")
    rules = PracticeRules(store)
    rules.create("prc_test", "phys", PracticeRuleInput.model_validate(DIABETES_RULE), actor="user:x")
    found, match = rules.resolve_type("prc_test", "Diabetes management")
    current, _ = triage_referral(_referral_model(), found, [], today=TODAY, type_match=match)
    legacy = current.model_copy(update={"type_match": None})
    assert material_changes(legacy, current) == {}
    moved = current.model_copy(update={"type_match": {**match, "rule_type": "Other"}})
    assert "rule_type" in material_changes(moved, current)


def test_carryover_survives_an_intermediate_unreviewed_recommendation(pilot: Pilot) -> None:
    _ready(pilot)
    rid = pilot.referral(reason="Referred for diabetes follow-up")["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/approve", "user-a")
    rule = pilot.get("/api/me/practice/rules", "user-a").json()[0]
    pilot.client.put(f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"),
                     json={**DIABETES_RULE, "good_fit": ["diabetes follow-up"]})
    changed = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    assert "approve" in changed["allowed_actions"]  # fit changed: unreviewed version
    revised = pilot.get("/api/me/practice/rules", "user-a").json()[0]
    pilot.client.put(f"/api/me/practice/rules/{revised['id']}", headers=_h("user-a"), json=DIABETES_RULE)
    back = pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a").json()
    assert back["recommendation"]["fit"] == "possible"
    assert "approve" not in back["allowed_actions"] and back["decision"]["carried_forward"], \
        "identical to the approved recommendation again: the original approval applies"
