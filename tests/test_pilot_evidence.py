"""Run 3: document evidence -- negated/pending mentions never count, and every proposed item shows
its date against the rule's window. Pure triage; synthetic data only."""

from __future__ import annotations

from datetime import date

from backend.pilot.models import IntakeReferral, PracticeRule
from backend.pilot.triage import (
    DocumentText,
    EvidenceProposal,
    evidence_date,
    evidence_window,
    is_not_done,
    triage_referral,
)

TODAY = date(2026, 11, 24)
RULE = {
    "good_fit": ["type 2 diabetes not at goal"], "redirect": [], "urgent_signals": [], "modality": "in_person",
    "required": [
        {"key": "recent_hba1c", "label": "HbA1c", "required": True, "freshness_days": 90},
        {"key": "thyroid_ultrasound", "label": "Thyroid ultrasound", "required": True, "freshness_days": None},
        {"key": "renal_function", "label": "Renal function", "required": True, "freshness_days": 365},
    ],
    "helpful": [],
}


def _rule() -> PracticeRule:
    return PracticeRule.model_validate({
        "id": "rule_ev", "practice_id": "prc_ev", "referral_type": "Diabetes management", "content": RULE,
        "source_text": "t", "source": "t", "scope": "practice", "operational_status": "confirmed",
        "physician_confirmed": True, "publishable": False, "version": 4,
        "created_at": "2026-11-01T00:00:00+00:00", "updated_at": "2026-11-01T00:00:00+00:00"})


def _referral() -> IntakeReferral:
    return IntakeReferral.model_validate({
        "id": "ref_ev", "practice_id": "prc_ev", "source": "manual", "status": "received", "sender": {"name": "Dr. Synthetic"},
        "receiver_practice_id": "prc_ev", "patient": {"name": "Synthetic Patient"}, "referral_type": "Diabetes management",
        "reason": "Type 2 diabetes not at goal", "received_at": "2026-11-20T00:00:00+00:00",
        "entered_at": "2026-11-20T00:00:00+00:00", "entered_by": "user:x",
        "created_at": "2026-11-20T00:00:00+00:00", "updated_at": "2026-11-20T00:00:00+00:00"})


def _states(pages: list[str], extractor=None) -> dict:
    recommendation, _ = triage_referral(_referral(), [_rule()], [DocumentText("doc_1", "r.txt", pages)],
                                        today=TODAY, extractor=extractor)
    return {item.key: item for item in recommendation.requirements}


def test_negated_pending_ordered_or_planned_mentions_are_never_evidence() -> None:
    for phrase in ("HbA1c not drawn this year.", "HbA1c pending.", "HbA1c ordered today.", "HbA1c planned for next visit.",
                   "HbA1c to be checked in clinic.", "Patient declined HbA1c.", "HbA1c scheduled for December."):
        assert _states([phrase])["recent_hba1c"].state == "missing", phrase
    assert _states(["Thyroid ultrasound not yet done; renal function panel ordered."])["thyroid_ultrasound"].state == "missing"
    # A clause that does report it still counts, even next to a pending one.
    found = _states(["HbA1c 8.2% (2026-10-01), repeat pending."])["recent_hba1c"]
    assert found.state == "proposed_from_document" and "8.2%" in found.evidence.quote
    assert is_not_done("TSH will be checked next month") and not is_not_done("TSH 1.2 mIU/L")


def test_a_model_quote_from_a_not_done_clause_is_dropped() -> None:
    class Quoting:
        model_id = "fake"

        def propose(self, requirements, documents):
            return [EvidenceProposal("renal_function", "doc_1", 1, "kidney labs ordered")]

    assert _states(["Plan: kidney labs ordered, results to follow."], Quoting())["renal_function"].state == "missing"


def test_every_proposed_item_shows_its_date_against_the_rules_window() -> None:
    items = _states(["HbA1c 7.9% on 2026-06-30.", "Thyroid ultrasound 10/12/2026: 1.8 cm nodule.", "Renal function normal."])
    old = items["recent_hba1c"]
    assert old.state == "proposed_from_document", "still a proposal: a person decides"
    assert old.window_status == "outside" and old.evidence_date == "2026-06-30"
    assert "dated 5 months ago (2026-06-30) — outside the rule’s 90-day window" in old.detail
    assert items["thyroid_ultrasound"].window_status is None, "no window on the rule: nothing to flag"
    assert items["renal_function"].window_status == "undated"
    assert "no date found" in items["renal_function"].detail


def test_dates_are_read_from_quotes_never_guessed() -> None:
    assert evidence_date("TSH 1.2 (10/30/2026)") == date(2026, 10, 30)
    assert evidence_date("DXA Mar 4, 2026: T-score -2.8") == date(2026, 3, 4)
    assert evidence_date("Neck US 10/2026") == date(2026, 10, 1)
    assert evidence_date("HbA1c 8.1%") is None
    assert evidence_window("HbA1c 8.1% (2026-11-01)", 90, TODAY)["window_status"] == "within"
    assert evidence_window("HbA1c 8.1% (2026-12-30)", 90, TODAY)["window_note"].startswith("dated in the future")
