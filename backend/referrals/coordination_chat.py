"""Patient-scoped physician-agent-to-physician-agent coordination chat
(ongoing-coordination pass, Part H-T). A bounded coordination channel, never
an unconstrained medical chatbot (Part I): answers are deterministically
grounded in this referral's own persisted artifacts (Referral/
SchedulingCoordination/ConsultationEncounter/HandoffSummary), never invented
clinical judgment. Anything outside that grounding escalates instead of being
answered (Part J/Q).

Demo-reliability note (Part O): this first implementation is fully
deterministic/keyword-grounded, mirroring backend/agent_experience.py's
existing deterministic_agent_chat pattern -- no live LLM call is wired here.
A future pass could add a model-capable path (reusing the
ResponsesApiClient.structured()/validate/fallback pattern already
established in backend/professional_services.py's AgentChatService) without
changing this function's signature or callers.
"""

from __future__ import annotations

from datetime import datetime

from backend.demo_identity import LUCY_AGENT_ID
from backend.models import (
    AppointmentSlot,
    ConsultationEncounter,
    HandoffStatus,
    HandoffSummary,
    Referral,
    SchedulingCoordination,
    SchedulingStatus,
)
from backend.synthetic_data import synthetic_agent_id

_ACCEPTED_OR_LATER = ("accepted", "scheduled", "consult_returned")


def represented_agent_id(physician_id: str) -> str:
    """Lucy's canonical agent identity IS her referral-domain physician id
    already (see backend/demo_identity.py's LUCY_AGENT_ID comment) -- never
    pass it through synthetic_agent_id, which only resolves real
    `physician-*` ids against the synthetic NPI directory."""
    if physician_id == LUCY_AGENT_ID:
        return physician_id
    return synthetic_agent_id(physician_id)


def authorize_coordination_chat(
    referral: Referral, requesting_physician_id: str, represented_physician_id: str
) -> None:
    """Part N's authorization requirements: both physicians must be the
    real, named parties on an accepted-or-later referral for this exact
    patient -- never a third physician, never a draft/pre-acceptance
    referral, and the two ids must actually be distinct."""
    parties = {referral.referring_physician_id, referral.receiving_physician_id}
    if referral.status not in _ACCEPTED_OR_LATER:
        raise ValueError("This referral has not been accepted yet; coordination chat is not available.")
    if requesting_physician_id == represented_physician_id:
        raise ValueError("A physician cannot ask their own agent through this channel.")
    if requesting_physician_id not in parties or represented_physician_id not in parties:
        raise ValueError("Only the two physicians on this accepted referral may use this channel.")


def _format_slot(slot: AppointmentSlot) -> str:
    try:
        when = datetime.fromisoformat(slot.starts_at).strftime("%b %d, %I:%M %p")
    except ValueError:
        when = slot.starts_at
    return f"{when} ({slot.appointment_type})"


def answer_coordination_question(
    referral: Referral,
    scheduling: SchedulingCoordination | None,
    encounter: ConsultationEncounter | None,
    handoff: HandoffSummary | None,
    requesting_physician_id: str,
    represented_physician_id: str,
    represented_physician_name: str,
    question: str,
) -> tuple[str, list[str], bool]:
    """Returns (answer, based_on, requires_physician_input). Deterministic,
    keyword-grounded (Part O) -- every branch cites the real field(s) it
    read from in `based_on`; the final branch is the explicit escalation
    required by Part J/Q whenever the question falls outside documented,
    shared-record territory."""
    lower = question.lower()
    # A draft handoff is never shared through chat either (Part Q/AP's
    # existing access-gate invariant) -- only once Chen has explicitly sent
    # it does its content become fair game for Lucy's side to ask about.
    visible_handoff = handoff if handoff and handoff.status == HandoffStatus.SENT else None

    if any(keyword in lower for keyword in ("follow up", "follow-up", "return to", "next visit", "next follow")):
        if visible_handoff and visible_handoff.follow_up:
            return visible_handoff.follow_up, ["the sent consultation handoff"], False
        if encounter and encounter.follow_up:
            return encounter.follow_up, ["the documented consultation encounter"], False
        return (
            "No follow-up timing has been documented yet for this referral.",
            [],
            False,
        )

    if any(keyword in lower for keyword in ("recommend", "treatment", "what did the consultation change", "what changed")):
        if visible_handoff and visible_handoff.recommendations:
            return visible_handoff.recommendations, ["the sent consultation handoff"], False
        if encounter and encounter.plan:
            return encounter.plan, ["the documented consultation encounter"], False
        return (
            "No specialist recommendations have been documented yet for this referral.",
            [],
            False,
        )

    if any(keyword in lower for keyword in ("schedul", "appointment", "when is", "when was the consult")):
        if scheduling and scheduling.status == SchedulingStatus.SCHEDULED and scheduling.selected_option:
            return (
                f"The consultation is scheduled for {_format_slot(scheduling.selected_option)}.",
                ["the confirmed scheduling coordination"],
                False,
            )
        return ("No appointment has been scheduled yet for this referral.", [], False)

    if any(keyword in lower for keyword in ("what information", "what did you need", "requirement", "missing", "additional information", "anything else")):
        satisfied = [item.label for item in referral.requirement_results if item.status == "satisfied"]
        missing = [item.label for item in referral.requirement_results if item.status == "missing_from_packet"]
        if missing:
            return (
                f"The referral packet still needs: {', '.join(missing)}.",
                ["the referral's requirement checklist"],
                False,
            )
        return (
            f"All of {represented_physician_name}'s referral requirements were satisfied"
            + (f" ({', '.join(satisfied)})" if satisfied else "")
            + ", and no additional information has been requested.",
            ["the referral's requirement checklist"],
            False,
        )

    if any(keyword in lower for keyword in ("referral concern", "why was", "referral question", "what was included", "packet", "original referral")):
        included = ", ".join(item.label for item in referral.packet.items)
        return (
            f"The referral question was: \"{referral.referral_question}\"."
            + (f" The packet included: {included}." if included else ""),
            ["the referral packet"],
            False,
        )

    if any(keyword in lower for keyword in ("assessment", "finding", "trajectory", "labs", "lab result")):
        if encounter:
            findings = ", ".join(encounter.key_findings)
            return (
                encounter.assessment + (f" Documented findings: {findings}." if findings else ""),
                ["the documented consultation encounter"],
                False,
            )
        return (
            f"This requires {represented_physician_name}'s input -- no consultation has been documented yet.",
            [],
            True,
        )

    if any(keyword in lower for keyword in ("status", "what's happening", "where are we", "update")):
        if visible_handoff:
            summary = "The consultation handoff has been sent back to primary care."
        elif encounter:
            summary = "The consultation has been documented and a handoff is being prepared."
        elif scheduling and scheduling.status == SchedulingStatus.SCHEDULED:
            summary = "The consultation is scheduled and has not yet occurred."
        else:
            summary = "The referral has been accepted; scheduling is in progress."
        return (summary, ["the referral's current status"], False)

    return (
        f"I'd need {represented_physician_name} to answer that directly.",
        [],
        True,
    )
