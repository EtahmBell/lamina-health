"""Where a referral stands: ONE statement used by the referral page, Home, For you and the
patient list, so no surface can call a referral "complete" while anything is open.

Readiness is read from the recommendation's requirements (missing, received-but-unverified,
possibly-in-a-document) and the open information requests -- never from the workflow status
alone. A referral staff marked ready can still have items open; that is said, every time.
"""

from __future__ import annotations

from .voice import Voice

NEXT_STEP_LABELS = {
    "request_information": "Request missing information",
    "confirm_document_evidence": "Confirm what the documents show",
    "physician_review": "Physician review",
    "consider_redirect": "Consider redirecting",
    "review_sender_information": "Verify what the referring office sent",
    "confirm_referral_type": "Confirm the referral type",
}
_OPEN_REQUEST = {"draft", "approved", "sent", "partially_resolved"}
_CLOSED = {"accepted", "redirected", "declined"}


def referral_standing(*, status: str, recommendation: dict | None, next_step: str | None,
                      requests: list[dict], voice: Voice) -> dict:
    """`recommendation` and `requests` are their JSON views (as the detail response carries them)."""
    requirements = (recommendation or {}).get("requirements") or []
    required = [item for item in requirements if item.get("required")]
    unverified = [item["label"] for item in requirements if item.get("state") == "sender_reported"]
    in_documents = [item["label"] for item in required if item.get("state") == "proposed_from_document"]
    missing = [item["label"] for item in required if item.get("state") not in {"satisfied", "sender_reported", "proposed_from_document"}]
    open_items = [item["label"] for item in required if item.get("state") != "satisfied"]
    open_requests = [request for request in requests if request.get("status") in _OPEN_REQUEST]
    has_draft = any(request["status"] == "draft" for request in open_requests)
    waiting_on_office = any(request["status"] in {"sent", "partially_resolved"} for request in open_requests)
    readiness = (recommendation or {}).get("readiness")
    no_requirements = recommendation is not None and readiness != "unknown" and not required
    complete = recommendation is not None and readiness != "unknown" and bool(required) and not open_items

    if recommendation is None:
        readiness_text = "Not triaged yet"
    elif readiness == "unknown":
        readiness_text = "Unknown — no rule for this type"
    elif no_requirements:
        readiness_text = "No requirements set — completeness not checked"
    elif complete:
        readiness_text = f"Complete per {voice.whose} rule"
    else:
        parts = []
        if missing:
            parts.append(f"Missing {', '.join(missing)}")
        if unverified:
            parts.append(f"Received, not yet verified: {', '.join(unverified)}")
        if in_documents:
            parts.append(f"Possibly in a document: {', '.join(in_documents)}")
        readiness_text = "; ".join(parts)

    listed = ", ".join(missing + in_documents)
    still_open = None
    if listed:
        still_open = (f"Still open: {listed} — requested from the referring office, not received yet" if waiting_on_office
                      else f"Still open: {listed} — request drafted, not sent" if has_draft
                      else f"Still open: {listed} — not requested yet")
    if unverified:
        heading = "Verify what the referring office sent"
    elif status == "ready_for_review":
        heading = "Ready for your decision" if voice.physician else f"Ready for {voice.doctor}’s decision"
    elif has_draft:
        heading, still_open = "Review and send the information request", None
    elif waiting_on_office:
        heading = "Waiting on the referring office"
    elif not voice.physician and next_step == "physician_review":
        # Staff don't do the physician's review: their step is the check before it.
        heading, still_open = f"Check, then mark ready for {voice.doctor}", None
    else:
        heading, still_open = (NEXT_STEP_LABELS.get(next_step or "", "Waiting for triage") if next_step else "Waiting for triage"), None
    # The step that is next NOW -- never the agent's original suggestion once things have moved
    # on (a request went out, the referral was decided or closed). None when nothing is next.
    if status in _CLOSED:
        next_step_now = None
    elif unverified:
        next_step_now = "Verify what the referring office sent"
    elif has_draft:
        next_step_now = "Review and send the information request"
    elif waiting_on_office:
        next_step_now = "Wait for the referring office (request sent)"
    elif status == "ready_for_review":
        next_step_now = "Physician decision" if not voice.physician else "Your decision"
    else:
        next_step_now = NEXT_STEP_LABELS.get(next_step or "")
    # A drafted request doesn't change the status until staff send it; say what's waiting.
    status_label = "Triaged · draft request ready for staff" if status in {"triaged", "received"} and has_draft else None
    return {
        "heading": heading, "still_open": still_open, "readiness_text": readiness_text, "next_step_now": next_step_now,
        "status_label": status_label,
        "complete": complete, "no_requirements": no_requirements, "open_items": open_items,
        "unverified_items": unverified, "waiting_on_office": waiting_on_office, "has_draft": has_draft,
    }


def queue_detail(referral_type: str, standing: dict, voice: Voice, *, flagged: bool = False,
                 marked_ready_by: str | None = None) -> str:
    """The one-line subtitle a queue row shows for a referral awaiting the physician."""
    parts = [referral_type]
    if flagged:
        parts.append("flagged for your review" if voice.physician else f"flagged for {voice.doctor}")
    elif marked_ready_by:
        parts.append(f"marked ready by {marked_ready_by}")
    if standing["complete"]:
        parts.append(f"complete per {voice.whose} rules")
    elif standing["no_requirements"]:
        parts.append("no requirements set")
    elif standing["readiness_text"] and standing["readiness_text"] != "Not triaged yet":
        parts.append(standing["readiness_text"][:1].lower() + standing["readiness_text"][1:]
                     if not standing["readiness_text"].startswith("Unknown") else "no rule for this type")
    return " · ".join(parts)
