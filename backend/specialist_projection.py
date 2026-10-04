"""Specialist-facing reads over canonical consultation records.

Participation is derived exclusively from canonical consultation messages.  The
projection never creates or persists a parallel specialist case.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from backend.demo_identity import PCP_AGENT_ID, PCP_AGENT_NAME, PCP_NAME
from backend.synthetic_data import (
    ALL_PHYSICIANS,
    PATIENTS,
    SYNTHETIC_PHYSICIAN_NPIS,
    synthetic_agent_id,
)


class SpecialistOutcome(StrEnum):
    RECOMMENDED = "recommended"
    ALTERNATIVE = "alternative"
    REDIRECTED = "redirected"
    CONSULTED_NOT_SELECTED = "consulted_not_selected"


PHYSICIANS_BY_ID = {profile.id: profile for profile in ALL_PHYSICIANS}
PHYSICIAN_IDS_BY_NPI = {npi: physician_id for physician_id, npi in SYNTHETIC_PHYSICIAN_NPIS.items()}
PHYSICIAN_IDS_BY_AGENT = {
    synthetic_agent_id(physician_id): physician_id for physician_id in SYNTHETIC_PHYSICIAN_NPIS
}


def _clean_name(name: str) -> str:
    return name.replace(" (synthetic)", "")


def _participant_event_ids(result: dict[str, Any], agent_id: str) -> list[str]:
    return [
        message["id"]
        for message in result.get("messages", [])
        if agent_id in {message.get("sender_agent_id"), message.get("recipient_agent_id")}
    ]


def specialist_participated(result: dict[str, Any], specialist_npi: str) -> bool:
    physician_id = PHYSICIAN_IDS_BY_NPI.get(specialist_npi)
    return bool(
        physician_id
        and _participant_event_ids(result, synthetic_agent_id(physician_id))
    )


def _evaluation(result: dict[str, Any], physician_id: str) -> dict[str, Any]:
    return next(
        item for item in result.get("consultation", []) if item["physician_id"] == physician_id
    )


def _outcome(result: dict[str, Any], physician_id: str) -> SpecialistOutcome:
    if result["recommended_physician"]["physician_id"] == physician_id:
        return SpecialistOutcome.RECOMMENDED
    if any(item["physician_id"] == physician_id for item in result.get("alternatives", [])):
        return SpecialistOutcome.ALTERNATIVE
    agent_id = synthetic_agent_id(physician_id)
    authored = [
        message
        for message in result.get("messages", [])
        if message.get("sender_agent_id") == agent_id
    ]
    if any(message.get("message_type") == "redirect" for message in authored):
        return SpecialistOutcome.REDIRECTED
    return SpecialistOutcome.CONSULTED_NOT_SELECTED


def _agent_response_summary(result: dict[str, Any], agent_id: str) -> str:
    authored = [
        message
        for message in result.get("messages", [])
        if message.get("sender_agent_id") == agent_id
        and message.get("message_type") in {"fit_response", "redirect"}
    ]
    return authored[0]["summary"] if authored else "Agent participated in this consultation."


def _review_state(record_id: int, reviews: dict[int, str]) -> dict[str, Any]:
    reviewed_at = reviews.get(record_id)
    return {"reviewed": reviewed_at is not None, "reviewed_at": reviewed_at}


def project_specialist_case_summary(
    record: dict[str, Any], specialist_npi: str, reviews: dict[int, str]
) -> dict[str, Any] | None:
    result = record["result"]
    physician_id = PHYSICIAN_IDS_BY_NPI.get(specialist_npi)
    if not physician_id:
        return None
    agent_id = synthetic_agent_id(physician_id)
    event_ids = _participant_event_ids(result, agent_id)
    if not event_ids:
        return None
    patient = PATIENTS.get(result["patient_id"])
    evaluation = _evaluation(result, physician_id)
    outcome = _outcome(result, physician_id)
    request = next(
        (message for message in result.get("messages", []) if message["message_type"] == "consult_request"),
        None,
    )
    clarification_count = sum(
        1
        for message in result.get("messages", [])
        if message.get("message_type") in {"follow_up_question", "follow_up_answer"}
        and agent_id in {message.get("sender_agent_id"), message.get("recipient_agent_id")}
    )
    return {
        "consultation_id": result["consultation_id"],
        "consultation_record_id": record["id"],
        "patient_id": result["patient_id"],
        "patient_name": _clean_name(patient.display_name) if patient else result["patient_id"],
        "patient_age": patient.age if patient else None,
        "patient_location": patient.location if patient else None,
        "referring_physician": PCP_NAME,
        "referring_agent": PCP_AGENT_NAME,
        "consulted_at": record["completed_at"],
        "referral_question": request["summary"] if request else result["patient_context"]["summary"],
        "specialist_outcome": outcome.value,
        "specialist_response_summary": _agent_response_summary(result, agent_id),
        "recommendation_physician": _clean_name(result["recommended_physician"]["physician_name"]),
        "recommendation_specialty": result["recommended_physician"]["specialty"],
        "was_recommended": outcome == SpecialistOutcome.RECOMMENDED,
        "clarification_count": clarification_count,
        **_review_state(record["id"], reviews),
        "event_ids": event_ids,
        "availability": evaluation["availability"],
    }


def project_specialist_cases(
    records: list[dict[str, Any]], specialist_npi: str, reviews: dict[int, str]
) -> list[dict[str, Any]]:
    projected = [
        project_specialist_case_summary(record, specialist_npi, reviews) for record in records
    ]
    return [case for case in projected if case is not None]


def _interaction(message: dict[str, Any], agent_id: str) -> dict[str, Any]:
    return {
        "event_id": message["id"],
        "sequence": message["sequence"],
        "direction": "from_specialist_agent"
        if message["sender_agent_id"] == agent_id
        else "to_specialist_agent",
        "message_type": message["message_type"],
        "summary": message["summary"],
        "supporting_evidence": message.get("evidence", []),
        "related_patient_facts": message.get("related_patient_facts", []),
        "metadata": message.get("metadata", {}),
    }


def _network_participants(result: dict[str, Any]) -> list[dict[str, Any]]:
    participants: list[dict[str, Any]] = []
    for agent_id, physician_id in PHYSICIAN_IDS_BY_AGENT.items():
        event_ids = _participant_event_ids(result, agent_id)
        if not event_ids:
            continue
        evaluation = _evaluation(result, physician_id)
        participants.append(
            {
                "agent_id": agent_id,
                "physician_id": physician_id,
                "physician_name": _clean_name(evaluation["physician_name"]),
                "specialty": evaluation["specialty"],
                "interaction_outcome": _outcome(result, physician_id).value,
                "agent_response_summary": _agent_response_summary(result, agent_id),
                "event_ids": event_ids,
            }
        )
    return participants


def _proposed_learning(
    record_id: int, evaluation: dict[str, Any], authored: list[dict[str, Any]]
) -> dict[str, Any]:
    rules = [
        evidence["detail"]
        for message in authored
        for evidence in message.get("evidence", [])
        if evidence.get("kind") == "explicit_physician_rule"
    ]
    workup = evaluation.get("required_workup", [])
    parts = [evaluation["reason"]]
    if workup:
        parts.append(f"Required workup: {', '.join(workup)}.")
    if evaluation.get("availability"):
        parts.append(f"Access: {evaluation['availability']}.")
    return {
        "key": "case-practice-response",
        "consultation_record_id": record_id,
        "question": "Does this reflect how you would practice?",
        "statement": " ".join(parts),
        "based_on": rules or ["Canonical structured agent response"],
        "status": "suggested",
        "provenance": "Suggested from this synthetic consultation · not confirmed",
        "updated_at": None,
    }


def project_specialist_case_detail(
    record: dict[str, Any],
    specialist_npi: str,
    reviews: dict[int, str],
    calibrations: list[dict[str, Any]],
) -> dict[str, Any] | None:
    summary = project_specialist_case_summary(record, specialist_npi, reviews)
    if summary is None:
        return None
    result = record["result"]
    physician_id = PHYSICIAN_IDS_BY_NPI[specialist_npi]
    agent_id = synthetic_agent_id(physician_id)
    evaluation = _evaluation(result, physician_id)
    messages = result.get("messages", [])
    interactions = [
        _interaction(message, agent_id)
        for message in messages
        if agent_id in {message.get("sender_agent_id"), message.get("recipient_agent_id")}
    ]
    authored = [
        message for message in messages if message.get("sender_agent_id") == agent_id
    ]
    request = next(
        (message for message in messages if message.get("message_type") == "consult_request"),
        None,
    )
    synthesis = next(
        (message for message in messages if message.get("message_type") == "synthesis"),
        None,
    )
    patient = PATIENTS.get(result["patient_id"])
    explicit_rules = list(
        dict.fromkeys(
            evidence["detail"]
            for message in authored
            for evidence in message.get("evidence", [])
            if evidence.get("kind") == "explicit_physician_rule"
        )
    )
    saved_calibration = next(
        (
            item
            for item in calibrations
            if item["consultation_record_id"] == record["id"]
            and item["learning_key"] == "case-practice-response"
        ),
        None,
    )
    calibration = _proposed_learning(record["id"], evaluation, authored)
    if saved_calibration:
        calibration.update(
            {
                "statement": saved_calibration["statement"],
                "status": saved_calibration["status"],
                "provenance": saved_calibration["provenance"],
                "updated_at": saved_calibration["updated_at"],
            }
        )
    return {
        **summary,
        "case_context": {
            "patient": {
                "id": result["patient_id"],
                "name": _clean_name(patient.display_name) if patient else result["patient_id"],
                "age": patient.age if patient else None,
                "location": patient.location if patient else None,
                "synthetic": True,
            },
            "referring_physician": {
                "name": PCP_NAME,
                "specialty": "Primary Care",
                "agent_id": PCP_AGENT_ID,
                "agent_name": PCP_AGENT_NAME,
            },
            "consultation_purpose": request["summary"] if request else result["patient_context"]["summary"],
            "referral_question": request["summary"] if request else None,
        },
        "agent_received": {
            "summary": result["patient_context"]["summary"],
            "facts": result["patient_context"]["facts"],
            "signals": result["patient_context"]["signals"],
            "source": "Bounded synthetic consultation context",
        },
        "agent_response": {
            "interactions": interactions,
            "fit": evaluation["clinical_fit"],
            "accepts_case": evaluation["accepts_case"],
            "required_workup": evaluation["required_workup"],
            "access": evaluation["availability"],
            "explicit_rules_used": explicit_rules,
        },
        "network_outcome": {
            "specialist_outcome": summary["specialist_outcome"],
            "recommended_physician": summary["recommendation_physician"],
            "recommended_specialty": summary["recommendation_specialty"],
            "was_recommended": summary["was_recommended"],
            "final_synthesis": synthesis["summary"] if synthesis else result["why"],
            "recommendation_rationale": result["why"],
            "synthesis_event_id": synthesis["id"] if synthesis else None,
        },
        "network_context": {
            "participants": _network_participants(result),
            "source": "Canonical structured consultation events",
        },
        "calibration": calibration,
        "disclaimer": "Synthetic specialist demo · no PHI",
    }

