"""Pilot metrics computed from append-only events and pilot tables.

Every number is a count or a duration derived from stored timestamps. There is no
"time saved" metric: we have no defensible baseline for it yet.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import UTC, datetime, timedelta
from statistics import median

from .store import PilotStore


def _hours(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 3600, 2)


def _median(values: list[float | None]) -> float | None:
    clean = [value for value in values if value is not None and value >= 0]
    return round(median(clean), 2) if clean else None


def _sender_key(sender: dict) -> str | None:
    """Pseudonymous referring-clinician key (NPI, else normalized name+practice)."""
    raw = sender.get("npi") or " ".join(filter(None, [sender.get("name", ""), sender.get("practice") or ""])).casefold()
    raw = " ".join(raw.split())
    return hashlib.sha256(raw.encode()).hexdigest()[:16] if raw else None


def practice_metrics(store: PilotStore, practice_id: str, *, since: str | None = None) -> dict:
    events = [e for e in store.events(practice_id=practice_id) if not since or e["created_at"] >= since]
    by_type = Counter(event["event_type"] for event in events)
    referrals = [r for r in store.fetch_all("SELECT * FROM intake_referrals WHERE practice_id = ?", (practice_id,))
                 if not since or r["entered_at"] >= since]
    referral_ids = {r["id"] for r in referrals}
    recommendations = store.fetch_all(
        "SELECT referral_id, recommendation_json, created_at FROM triage_recommendations WHERE practice_id = ? "
        "ORDER BY created_at, rowid", (practice_id,))
    first_rec: dict[str, dict] = {}
    for row in recommendations:
        first_rec.setdefault(row["referral_id"], row)
    decisions = [d for d in store.fetch_all("SELECT * FROM recommendation_decisions WHERE practice_id = ?", (practice_id,))
                 if d["referral_id"] in referral_ids]
    decision_counts = Counter(d["decision"] for d in decisions)
    correction_types = Counter(
        field for d in decisions if d["decision"] == "edited" for field in json.loads(d["changed_fields_json"]))
    requests = [m for m in store.fetch_all("SELECT * FROM missing_information_requests WHERE practice_id = ?", (practice_id,))
                if m["referral_id"] in referral_ids]
    ready_events = {}
    for event in events:
        if event["event_type"] == "referral_became_ready" and event["referral_id"] not in ready_events:
            ready_events[event["referral_id"]] = event["created_at"]
    human_days = {e["created_at"][:10] for e in events if e["autonomy"] == "human" and e["actor"].startswith("user:")}
    sign_ins = Counter((e["event_type"], e["created_at"][:10]) for e in events
                       if e["event_type"] in {"physician_signed_in", "staff_signed_in"})
    senders = Counter(key for key in (_sender_key(json.loads(r["sender_json"])) for r in referrals) if key)
    public_senders = Counter(key for key in (_sender_key(json.loads(r["sender_json"])) for r in referrals
                                             if r["source"] == "public_form") if key)
    detected = {e["referral_id"] for e in events if e["event_type"] == "missing_information_detected"}
    ready_first = sum(1 for rid in referral_ids if rid in first_rec and
                      json.loads(first_rec[rid]["recommendation_json"])["readiness"] == "ready")
    sent_request_referrals = {m["referral_id"] for m in requests if m["sent_at"]}
    total_decisions = sum(decision_counts.values())
    statuses = Counter(r["status"] for r in referrals)
    return {
        "window_start": since,
        "usage": {
            "referrals_received": len(referrals),
            "referrals_by_source": dict(Counter(r["source"] for r in referrals)),
            "referrals_triaged": len({rid for rid in referral_ids if rid in first_rec}),
            "active_days": len(human_days),
            "physician_active_days": sum(1 for (kind, _day) in sign_ins if kind == "physician_signed_in"),
            "staff_active_days": sum(1 for (kind, _day) in sign_ins if kind == "staff_signed_in"),
        },
        "referral_quality": {
            "missing_information_detected": len(detected & referral_ids),
            "ready_on_first_submission": ready_first,
            "made_ready_after_missing_info_request": len(set(ready_events) & sent_request_referrals),
            "information_requests_sent": sum(1 for m in requests if m["sent_at"]),
            "information_requests_resolved": sum(1 for m in requests if m["status"] == "resolved"),
            "accepted": statuses.get("accepted", 0), "redirected": statuses.get("redirected", 0),
            "declined": statuses.get("declined", 0),
        },
        "agent_trust": {
            "recommendations_generated": by_type.get("recommendation_generated", 0),
            "accepted": decision_counts.get("accepted", 0), "edited": decision_counts.get("edited", 0),
            "rejected": decision_counts.get("rejected", 0),
            "acceptance_rate": round(decision_counts.get("accepted", 0) / total_decisions, 3) if total_decisions else None,
            "common_correction_fields": dict(correction_types.most_common(5)),
            "escalations": by_type.get("referral_escalated", 0),
        },
        "learning": {
            "proposed": by_type.get("learning_proposed", 0), "confirmed": by_type.get("learning_confirmed", 0),
            "edited": by_type.get("learning_edited", 0), "rejected": by_type.get("learning_rejected", 0),
            "questions_shown": by_type.get("learning_question_shown", 0),
            "repeated_correction_patterns": store.fetch_one(
                "SELECT COUNT(*) AS n FROM learning_questions WHERE practice_id = ?", (practice_id,))["n"],
        },
        "public": {
            "profile_views": by_type.get("public_page_viewed", 0),
            "agent_questions": by_type.get("public_agent_question", 0),
            "agent_out_of_scope": by_type.get("public_agent_out_of_scope", 0),
            "referrals_started": by_type.get("public_agent_referral_started", 0),
            "public_referrals_submitted": sum(1 for r in referrals if r["source"] == "public_form"),
            "unique_referring_clinicians": len(senders),
            "unique_public_referring_clinicians": len(public_senders),
            "returning_referring_clinicians": sum(1 for count in senders.values() if count >= 2),
        },
        "operations": {
            "median_hours_received_to_triaged": _median([_hours(r["received_at"], first_rec[r["id"]]["created_at"])
                                                         for r in referrals if r["id"] in first_rec]),
            "median_hours_received_to_ready": _median([_hours(r["received_at"], ready_events.get(r["id"]))
                                                       for r in referrals]),
            "median_hours_waiting_on_external_information": _median([_hours(m["sent_at"], m["resolved_at"])
                                                                     for m in requests if m["resolved_at"]]),
        },
    }


def weekly_summary(store: PilotStore, practice_id: str, now: datetime | None = None) -> dict:
    current = now or datetime.now(UTC)
    since = (current - timedelta(days=7)).isoformat(timespec="seconds")
    metrics = practice_metrics(store, practice_id, since=since)
    usage, quality, trust, public = metrics["usage"], metrics["referral_quality"], metrics["agent_trust"], metrics["public"]
    lines = [f"This week Lamina processed {usage['referrals_received']} referral{'s' if usage['referrals_received'] != 1 else ''}."]
    if quality["missing_information_detected"]:
        lines.append(f"{quality['missing_information_detected']} arrived incomplete.")
    if quality["made_ready_after_missing_info_request"]:
        lines.append(f"{quality['made_ready_after_missing_info_request']} were made ready after requesting missing information.")
    if trust["accepted"] or trust["edited"] or trust["rejected"]:
        lines.append(f"{trust['accepted']} triage recommendation{'s were' if trust['accepted'] != 1 else ' was'} accepted without changes"
                     f", {trust['edited']} edited, {trust['rejected']} rejected.")
    if metrics["learning"]["confirmed"] or metrics["learning"]["edited"]:
        lines.append(f"You confirmed {metrics['learning']['confirmed'] + metrics['learning']['edited']} new preference(s).")
    if public["unique_public_referring_clinicians"]:
        lines.append(f"{public['unique_public_referring_clinicians']} referring clinician(s) used your public page.")
    elif public["profile_views"]:
        lines.append(f"Your public page was viewed {public['profile_views']} time(s).")
    return {"since": since, "text": " ".join(lines), "metrics": metrics}
