"""Agent coordination, projected for one viewing physician (agent
coordination oversight pass).

One referral is one coordination episode. Its structured record has two
sources, both already persisted and both immutable here:

- the Network consultation that preceded the referral (the case Lucy's
  agent shared, the receiving physician's practice-fit response, the
  clarification exchange) -- only the messages between the two referral
  parties' agents, never other candidates' responses (those belong to
  Match Details, which explains how the destination was chosen);
- the referral's own CoordinationEvent log (workup, acceptance,
  scheduling, handoff).

Both physicians see the SAME episode. What differs per viewer is only
which items they may correct (their own agent's representations) and which
corrections are shown (their own). Nothing here is free-form agent
conversation, evidence internals, prompts or model reasoning -- every item
is a permitted structured output.
"""

from __future__ import annotations

import re
from typing import Any

from backend.demo_identity import PCP_AGENT_ID
from backend.models import (
    AgentCorrection,
    CoordinationActor,
    CoordinationEpisode,
    CoordinationEvent,
    CoordinationEventType,
    CoordinationFact,
    CoordinationItem,
    Referral,
)
from backend.synthetic_data import synthetic_agent_id

CORRECTABLE_KINDS = frozenset({"agent_representation", "practice_representation"})
STAGE_ORDER = ("routing", "clarification", "workup", "acceptance", "scheduling", "handoff")
_PATIENT_RECORD_SOURCE = "Patient record (synthetic)"

# event type -> (stage, title, content kind). Only the agent's own
# judgements are representations; everything else is a recorded fact.
_EVENT_PROJECTION: dict[CoordinationEventType, tuple[str, str, str]] = {
    CoordinationEventType.REFERRAL_CREATED: ("routing", "Route selected", "system_fact"),
    CoordinationEventType.PACKET_ASSEMBLED: ("workup", "Referral packet assembled", "system_fact"),
    CoordinationEventType.PREFLIGHT_STARTED: ("workup", "Preflight started", "system_fact"),
    CoordinationEventType.REQUIREMENT_CHECKED: ("workup", "Requirement checked", "system_fact"),
    CoordinationEventType.INFORMATION_REQUESTED: ("workup", "Requirement identified", "practice_representation"),
    CoordinationEventType.RECORD_SEARCH_STARTED: ("workup", "Record searched", "system_fact"),
    CoordinationEventType.RECORD_FOUND: ("workup", "Record found", "patient_fact"),
    CoordinationEventType.RECORD_NOT_FOUND: ("workup", "Record not found", "system_fact"),
    CoordinationEventType.INFORMATION_ATTACHED: ("workup", "Information attached", "system_fact"),
    CoordinationEventType.REQUIREMENT_RECHECKED: ("workup", "Requirement satisfied", "agent_representation"),
    CoordinationEventType.PHYSICIAN_ACTION_REQUIRED: ("workup", "Physician action required", "system_fact"),
    CoordinationEventType.PREFLIGHT_COMPLETED: ("workup", "Preflight completed", "system_fact"),
    CoordinationEventType.REFERRAL_READY: ("acceptance", "Referral ready for review", "system_fact"),
    CoordinationEventType.REFERRAL_SUBMITTED: ("acceptance", "Referral sent", "system_fact"),
    CoordinationEventType.REFERRAL_ACCEPTED: ("acceptance", "Referral accepted", "system_fact"),
    CoordinationEventType.SCHEDULING_OPTIONS_FOUND: ("scheduling", "Appointment options found", "system_fact"),
    CoordinationEventType.SCHEDULING_OPTIONS_SENT: ("scheduling", "Options sent to scheduling", "system_fact"),
    CoordinationEventType.APPOINTMENT_SCHEDULED: ("scheduling", "Appointment scheduled", "system_fact"),
    CoordinationEventType.CONSULTATION_INGESTED: ("handoff", "Consultation documented", "system_fact"),
    CoordinationEventType.HANDOFF_DRAFTED: ("handoff", "Handoff drafted", "system_fact"),
    CoordinationEventType.HANDOFF_SENT: ("handoff", "Handoff sent", "system_fact"),
}
# consultation message type -> (stage, title, content kind)
_MESSAGE_PROJECTION: dict[str, tuple[str, str, str]] = {
    "consult_request": ("routing", "Case shared with the network", "agent_representation"),
    "fit_response": ("routing", "Practice fit returned", "practice_representation"),
    "redirect": ("routing", "Practice fit returned", "practice_representation"),
    "follow_up_question": ("clarification", "Clarification requested", "agent_representation"),
    "follow_up_answer": ("clarification", "Clarification resolved", "agent_representation"),
    "referral_requirement": ("clarification", "Receiving response", "practice_representation"),
}
_STATUS_WORDS = {
    "satisfied": "included in the packet",
    "missing_from_packet": "not in the packet",
    "optional_not_present": "optional, not included",
}
_FIT_FACTOR_LABELS = {
    "specialty_scope": "specialty",
    "referral_preference": "practice fit",
    "similar_case_experience": "similar-case experience",
    "case_interest": "case interest",
    "modality_policy": "modality",
    "access_capacity": "access",
}


def can_correct_item(viewer_physician_id: str, item: CoordinationItem) -> bool:
    """The one ownership rule: a physician may correct an item only when it
    is their OWN agent's representation -- never a recorded system or chart
    fact, never the other physician's agent."""
    return (
        item.content_kind in CORRECTABLE_KINDS
        and item.actor_kind == "agent"
        and item.actor_physician_id is not None
        and item.actor_physician_id == viewer_physician_id
    )


def _event_actor(referral: Referral, event: CoordinationEvent) -> tuple[str, str | None]:
    if event.actor == CoordinationActor.REFERRING_AGENT:
        return "agent", referral.referring_physician_id
    if event.actor == CoordinationActor.RECEIVING_AGENT:
        return "agent", referral.receiving_physician_id
    if event.actor == CoordinationActor.RECEIVING_PHYSICIAN:
        return "physician", referral.receiving_physician_id
    if event.actor == CoordinationActor.SCHEDULING_WORKFLOW:
        return "scheduling_workflow", None
    return "system", None


def _event_statement(referral: Referral, event: CoordinationEvent) -> str:
    if event.event_type in (CoordinationEventType.REQUIREMENT_CHECKED, CoordinationEventType.REQUIREMENT_RECHECKED):
        # "Recent renal function: missing_from_packet." -> readable words;
        # presentation only, the stored event is untouched.
        return re.sub(
            r":\s*([a-z_]+)\.$",
            lambda match: f": {_STATUS_WORDS.get(match.group(1), match.group(1).replace('_', ' '))}.",
            event.summary,
        )
    if event.event_type == CoordinationEventType.REFERRAL_CREATED:
        route = "e-consult" if referral.modality == "econsult" else "in-person visit"
        return f"{event.summary} Route: {route}."
    return event.summary


def _event_facts(referral: Referral, event: CoordinationEvent) -> list[CoordinationFact]:
    if event.event_type != CoordinationEventType.RECORD_FOUND:
        return []
    item = referral.packet.item(str(event.metadata.get("requirement", "")))
    if item is None:
        return []
    observed = f" · observed {item.provenance.observed_date}" if item.provenance.observed_date else ""
    return [CoordinationFact(text=f"{item.label}: {item.value}", source=f"{_PATIENT_RECORD_SOURCE}{observed}")]


def linked_consultation(referral: Referral, records: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The patient's most recent Network consultation, completed before the
    referral was created, in which the receiving physician's agent took
    part -- the consultation this referral came from."""
    receiving_agent = synthetic_agent_id(referral.receiving_physician_id)
    candidates = [
        record for record in records
        if record["patient_id"] == referral.patient_id
        and record["completed_at"] <= referral.created_at
        and any(message.get("sender_agent_id") == receiving_agent for message in record["result"].get("messages", []))
    ]
    return max(candidates, key=lambda record: record["id"]) if candidates else None


def _routing_result_item(
    referral: Referral, result: dict[str, Any], record: dict[str, Any], receiving_name: str
) -> CoordinationItem:
    fit = next((item for item in result.get("physician_fits", []) if item["physician_id"] == referral.receiving_physician_id), None)
    route = next(
        (item for item in result.get("candidate_routes", [])
         if item["physician_id"] == referral.receiving_physician_id and item.get("recommended")),
        None,
    )
    categories = [item["category"] for item in (fit or {}).get("evidence", [])]
    categories += [item["category"] for item in (route or {}).get("route_evidence", [])]
    factors = list(dict.fromkeys(_FIT_FACTOR_LABELS[category] for category in categories if category in _FIT_FACTOR_LABELS))
    recommended_id = (result.get("recommended_physician") or {}).get("physician_id")
    if recommended_id == referral.receiving_physician_id:
        basis = f" based on {_join(factors)}" if factors else ""
        statement = f"{receiving_name} recommended for {referral.specialty}{basis}."
    else:
        statement = f"{receiving_name} selected by the referring physician for {referral.specialty}."
    return CoordinationItem(
        id=f"consult-{record['id']}-recommendation",
        stage="routing",
        title="Recommendation created",
        actor_kind="network",
        content_kind="system_fact",
        statement=statement,
        occurred_at=record["completed_at"],
    )


def _join(words: list[str]) -> str:
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])}, and {words[-1]}"


def _consultation_items(referral: Referral, record: dict[str, Any], receiving_name: str) -> list[CoordinationItem]:
    result = record["result"]
    receiving_agent = synthetic_agent_id(referral.receiving_physician_id)
    party_agents = {PCP_AGENT_ID: referral.referring_physician_id, receiving_agent: referral.receiving_physician_id}
    items: list[CoordinationItem] = []
    for message in result.get("messages", []):
        projection = _MESSAGE_PROJECTION.get(message["message_type"])
        sender = message["sender_agent_id"]
        if projection is None or sender not in party_agents:
            continue
        # Only what passed between the two parties' agents (or what Lucy's
        # agent shared with the network) -- never another candidate's
        # exchange.
        if message["recipient_agent_id"] not in (*party_agents, "network"):
            continue
        stage, title, kind = projection
        facts = [CoordinationFact(text=fact, source=_PATIENT_RECORD_SOURCE) for fact in message.get("related_patient_facts", [])]
        items.append(CoordinationItem(
            id=f"consult-{record['id']}-{message['sequence']}",
            stage=stage,
            title=title,
            actor_kind="agent",
            actor_physician_id=party_agents[sender],
            content_kind=kind,
            statement=message["summary"],
            # Only the referring side's representations rest on chart facts
            # shown here; the receiving agent's responses are about its own
            # practice.
            patient_facts=facts if sender == PCP_AGENT_ID else [],
            occurred_at=record["completed_at"],
        ))
        if message["message_type"] in ("fit_response", "redirect") and sender == receiving_agent:
            items.append(_routing_result_item(referral, result, record, receiving_name))
    return items


def _event_items(referral: Referral) -> list[CoordinationItem]:
    items: list[CoordinationItem] = []
    requested = {
        event.metadata.get("requirement") for event in referral.coordination_events
        if event.event_type == CoordinationEventType.INFORMATION_REQUESTED
    }
    for event in referral.coordination_events:
        stage, title, kind = _EVENT_PROJECTION.get(event.event_type, ("workup", event.event_type.replace("_", " ").capitalize(), "system_fact"))
        actor_kind, actor_physician_id = _event_actor(referral, event)
        if event.event_type == CoordinationEventType.REQUIREMENT_RECHECKED and (
            event.metadata.get("requirement") not in requested or event.metadata.get("result") != "satisfied"
        ):
            # Only the agent's judgement that information it asked for now
            # satisfies the requirement is a representation; re-confirming
            # what was already included is a recorded check.
            title, kind = "Requirement re-checked", "system_fact"
        if actor_kind != "agent" and kind in CORRECTABLE_KINDS:
            kind = "system_fact"
        items.append(CoordinationItem(
            id=f"event-{event.sequence}",
            stage=stage,
            title=title,
            actor_kind=actor_kind,
            actor_physician_id=actor_physician_id,
            content_kind=kind,
            statement=_event_statement(referral, event),
            patient_facts=_event_facts(referral, event),
            occurred_at=event.created_at,
        ))
    return items


def coordination_items(referral: Referral, consultation_record: dict[str, Any] | None, receiving_name: str) -> list[CoordinationItem]:
    """Every item of the episode, viewer-independent, grouped by stage in
    STAGE_ORDER (stable within a stage)."""
    items = [
        *(_consultation_items(referral, consultation_record, receiving_name) if consultation_record else []),
        *_event_items(referral),
    ]
    return sorted(items, key=lambda item: STAGE_ORDER.index(item.stage))


def project_coordination_episode(
    referral: Referral,
    consultation_record: dict[str, Any] | None,
    corrections: list[AgentCorrection],
    viewer_physician_id: str,
    receiving_name: str,
) -> CoordinationEpisode:
    if viewer_physician_id not in (referral.referring_physician_id, referral.receiving_physician_id):
        raise PermissionError("Only the two physicians on this referral may view its coordination.")
    own = [
        correction for correction in corrections
        if correction.referral_id == referral.id and correction.physician_id == viewer_physician_id
    ]
    items = []
    for item in coordination_items(referral, consultation_record, receiving_name):
        attached = [
            correction for correction in own
            if correction.source_item_id == item.id
            or (correction.source_item_id is None and correction.source_event_sequence is not None
                and item.id == f"event-{correction.source_event_sequence}")
        ]
        items.append(item.model_copy(update={
            "correctable": can_correct_item(viewer_physician_id, item),
            "corrections": attached,
        }))
    return CoordinationEpisode(
        referral_id=referral.id or 0,
        patient_id=referral.patient_id,
        viewer_physician_id=viewer_physician_id,
        viewer_role="referring" if viewer_physician_id == referral.referring_physician_id else "receiving",
        referring_physician_id=referral.referring_physician_id,
        receiving_physician_id=referral.receiving_physician_id,
        items=items,
    )


# ---------------------------------------------------------------------------
# Correction scope (Part I). A correction about THIS patient stays with this
# coordination; one about how the agent should behave generally may become
# a durable learning. When neither is clear, the physician is asked --
# a patient-specific correction is never silently generalized.
# ---------------------------------------------------------------------------
_FUTURE_CUES = re.compile(
    r"\b(?:going\s+forward|in\s+(?:the\s+)?future|from\s+now\s+on|(?:in\s+)?(?:similar|other)\s+(?:cases|patients|situations|referrals)|"
    r"cases\s+like\s+(?:this|these)|patients\s+like\s+(?:this|these)|situations\s+like\s+(?:this|these)|"
    r"(?:my\s+)?agent\s+should|should(?:n't|\s+not)?\s+(?:block|be\s+required|describe|say|represent|treat|ask|request)|"
    r"always|never|in\s+general|generally|as\s+a\s+rule|unless)\b",
    re.IGNORECASE,
)
_EPISODE_CUES = re.compile(
    r"\b(?:this\s+(?:patient|case|referral|coordination|time|episode)|for\s+(?:this|her|him|them)\b|specifically|"
    r"in\s+this\s+instance|here)\b",
    re.IGNORECASE,
)
_BOTH_CUES = re.compile(r"\b(?:both|and\s+(?:also\s+)?(?:going\s+forward|in\s+(?:the\s+)?future|for\s+similar\s+cases))\b", re.IGNORECASE)


def infer_correction_scope(text: str, patient_first_name: str | None = None) -> str | None:
    """`episode`, `future`, `both`, or None (ask). Deterministic."""
    normalized = text.replace("’", "'")
    names_patient = bool(patient_first_name) and re.search(rf"\b{re.escape(patient_first_name)}\b", normalized, re.IGNORECASE) is not None
    episode = names_patient or bool(_EPISODE_CUES.search(normalized))
    future = bool(_FUTURE_CUES.search(normalized))
    if (episode and future) or (future and _BOTH_CUES.search(normalized)):
        return "both"
    if future:
        return "future"
    if episode:
        return "episode"
    return None
