from backend.models import (
    ClinicalFit,
    ClinicalRepresentation,
    ConsultationMessage,
    ConsultationMessageType,
    EvidenceKind,
    PhysicianEvaluation,
    PhysicianProfile,
)
from backend.synthetic_data import synthetic_agent_id

PCP_AGENT_ID = "agent-pcp-cha"
NETWORK_AGENT_ID = "agent-network-orchestrator"


def _message(
    *,
    consultation_id: str,
    sequence: int,
    sender_agent_id: str,
    sender_name: str,
    sender_role: str,
    recipient_agent_id: str,
    message_type: ConsultationMessageType,
    summary: str,
    evidence,
    related_patient_facts: list[str],
    metadata: dict[str, str | int | bool] | None = None,
) -> ConsultationMessage:
    return ConsultationMessage(
        id=f"{consultation_id}-message-{sequence:02d}",
        consultation_id=consultation_id,
        sequence=sequence,
        sender_agent_id=sender_agent_id,
        sender_name=sender_name,
        sender_role=sender_role,
        recipient_agent_id=recipient_agent_id,
        message_type=message_type,
        summary=summary,
        evidence=list(evidence),
        related_patient_facts=related_patient_facts,
        metadata=metadata or {},
    )


def build_consultation_messages(
    consultation_id: str,
    context: ClinicalRepresentation,
    profiles: list[PhysicianProfile],
    evaluations: list[PhysicianEvaluation],
    recommended: PhysicianEvaluation,
) -> list[ConsultationMessage]:
    profiles_by_id = {profile.id: profile for profile in profiles}
    messages = [
        _message(
            consultation_id=consultation_id,
            sequence=1,
            sender_agent_id=PCP_AGENT_ID,
            sender_name="Dr. Cha Agent",
            sender_role="Primary Care",
            recipient_agent_id="network",
            message_type=ConsultationMessageType.CONSULT_REQUEST,
            summary=f"Requests specialty guidance for {context.summary}",
            evidence=[],
            related_patient_facts=context.facts,
        )
    ]
    sequence = 2
    for evaluation in evaluations:
        profile = profiles_by_id[evaluation.physician_id]
        relevant_evidence = [
            item
            for item in evaluation.evidence
            if item.kind
            in {
                EvidenceKind.EXPLICIT_RULE,
                EvidenceKind.PRACTICE_SIMILARITY,
                EvidenceKind.OPERATIONAL,
            }
        ]
        related_facts = [
            fact
            for fact in context.facts
            if any(term in fact.casefold() for term in ("hypertension", "creatinine", "egfr", "ckd"))
        ]
        messages.append(
            _message(
                consultation_id=consultation_id,
                sequence=sequence,
                sender_agent_id=synthetic_agent_id(evaluation.physician_id),
                sender_name=f"{evaluation.physician_name.replace(' (synthetic)', '')} Agent",
                sender_role=profile.subspecialty,
                recipient_agent_id=PCP_AGENT_ID,
                message_type=(
                    ConsultationMessageType.FIT_RESPONSE
                    if evaluation.accepts_case
                    else ConsultationMessageType.REDIRECT
                ),
                summary=evaluation.reason,
                evidence=relevant_evidence,
                related_patient_facts=related_facts,
                metadata={
                    "clinical_fit": evaluation.clinical_fit.value,
                    "accepts_case": evaluation.accepts_case,
                    "availability": evaluation.availability,
                    "required_workup": " · ".join(evaluation.required_workup) or "None specified",
                },
            )
        )
        sequence += 1

    jung = next(item for item in evaluations if item.physician_id == "physician-jung")
    messages.append(
        _message(
            consultation_id=consultation_id,
            sequence=sequence,
            sender_agent_id=synthetic_agent_id("physician-jung"),
            sender_name="Dr. Mina Jung Agent",
            sender_role="Nephrology",
            recipient_agent_id=PCP_AGENT_ID,
            message_type=ConsultationMessageType.REFERRAL_REQUIREMENT,
            summary="Requests a current BMP and urine protein/creatinine ratio before the visit.",
            evidence=[item for item in jung.evidence if item.kind == EvidenceKind.EXPLICIT_RULE],
            related_patient_facts=[fact for fact in context.facts if "CKD" in fact or "eGFR" in fact],
            metadata={"required_workup": "BMP · UPCR"},
        )
    )
    sequence += 1
    messages.append(
        _message(
            consultation_id=consultation_id,
            sequence=sequence,
            sender_agent_id=PCP_AGENT_ID,
            sender_name="Dr. Cha Agent",
            sender_role="Primary Care",
            recipient_agent_id=synthetic_agent_id("physician-onadeko"),
            message_type=ConsultationMessageType.FOLLOW_UP_QUESTION,
            summary=(
                "Does progressive renal dysfunction alter willingness to accept this patient "
                "as the initial specialist?"
            ),
            evidence=[],
            related_patient_facts=[
                fact for fact in context.facts if "Creatinine" in fact or "eGFR" in fact
            ],
        )
    )
    sequence += 1
    onadeko = next(item for item in evaluations if item.physician_id == "physician-onadeko")
    explicit_rule = [
        item for item in onadeko.evidence if item.kind == EvidenceKind.EXPLICIT_RULE
    ]
    messages.append(
        _message(
            consultation_id=consultation_id,
            sequence=sequence,
            sender_agent_id=synthetic_agent_id("physician-onadeko"),
            sender_name="Dr. Tayo Onadeko Agent",
            sender_role="Hypertension Cardiology",
            recipient_agent_id=PCP_AGENT_ID,
            message_type=ConsultationMessageType.FOLLOW_UP_ANSWER,
            summary=(
                "Yes. Current referral criteria favour nephrology first when progressive renal "
                "dysfunction is prominent; hypertension cardiology can follow or co-manage."
            ),
            evidence=explicit_rule,
            related_patient_facts=[
                fact for fact in context.facts if "Creatinine" in fact or "eGFR" in fact
            ],
            metadata={"redirects_first_evaluation": True},
        )
    )
    sequence += 1
    messages.append(
        _message(
            consultation_id=consultation_id,
            sequence=sequence,
            sender_agent_id=NETWORK_AGENT_ID,
            sender_name="Network Orchestrator",
            sender_role="Recommendation synthesis",
            recipient_agent_id=PCP_AGENT_ID,
            message_type=ConsultationMessageType.SYNTHESIS,
            summary=(
                "Recommends Dr. Mina Jung in nephrology first: strongest clinical fit, explicit "
                "criteria match, relevant practice footprint, known workup, and earliest "
                "strong-fit access."
            ),
            evidence=recommended.evidence,
            related_patient_facts=context.facts,
            metadata={
                "recommended_physician_id": recommended.physician_id,
                "clinical_fit": ClinicalFit.STRONG.value,
            },
        )
    )
    return messages

