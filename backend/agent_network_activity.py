""""Your agent in the network" (My Agent cleanup pass, Part G).

Patient/workflow work the physician's agent actually performed -- kept
strictly separate from physician-representation learning ("What your agent
learned this week", backend.referral_preferences.recent_representation_
learnings). Built from real persisted referral events, plus one explicitly
SYNTHETIC demo fixture for background routing that has no backing workflow
in this demo. Nothing here is presented as production analytics, and
nothing here is ever treated as training.
"""

from __future__ import annotations

from typing import Any

from backend.demo_identity import LUCY_AGENT_ID
from backend.models import AutonomyLevel, CoordinationEventType, ReferralStatus
from backend.synthetic_data import PATIENTS
from backend.synthetic_data.fixtures import SYNTHETIC_AUTO_ROUTED_REQUESTS
from backend.workflow import WorkflowStore

_REFERRING_AGENT_NAMES = {LUCY_AGENT_ID: "Dr. Lucy Saruhashi's agent"}
_VISIBLE_STATUSES = {
    ReferralStatus.SUBMITTED, ReferralStatus.ACCEPTED, ReferralStatus.SCHEDULED, ReferralStatus.CONSULT_RETURNED,
}


def _patient_name(patient_id: str) -> str:
    patient = PATIENTS.get(patient_id)
    return patient.display_name.replace(" (synthetic)", "") if patient else "A patient"


def agent_network_activity(workflow_store: WorkflowStore, workspace_id: str, physician_id: str | None) -> list[dict[str, Any]]:
    """Ordered most recent first. Empty for a physician with no receiving
    work in this demo, so the caller can fall back to its own view."""
    if physician_id is None:
        return []
    items: list[dict[str, Any]] = []
    automatic_tasks = 0
    for referral in reversed(workflow_store.list_referrals(workspace_id, receiving_physician_id=physician_id)):
        if referral.status not in _VISIBLE_STATUSES:
            continue
        labels = {item.key: item.label for item in referral.receiving_requirements}
        outcomes = [
            f"{labels.get(str(event.metadata.get('requirement', '')), 'Missing information')} found and attached automatically"
            for event in referral.coordination_events
            if event.event_type == CoordinationEventType.INFORMATION_ATTACHED
        ]
        if any(event.event_type == CoordinationEventType.APPOINTMENT_SCHEDULED for event in referral.coordination_events):
            outcomes.append("Appointment scheduled without physician interruption")
        automatic_tasks += sum(
            event.autonomy == AutonomyLevel.AUTOMATIC and event.event_type in (
                CoordinationEventType.INFORMATION_ATTACHED,
                CoordinationEventType.SCHEDULING_OPTIONS_FOUND,
                CoordinationEventType.SCHEDULING_OPTIONS_SENT,
                CoordinationEventType.APPOINTMENT_SCHEDULED,
            )
            for event in referral.coordination_events
        )
        items.append({
            "id": f"referral-{referral.id}",
            "kind": "coordination",
            "title": f"Coordinated with {_REFERRING_AGENT_NAMES.get(referral.referring_physician_id, 'a referring physician agent')}",
            "detail": f"{_patient_name(referral.patient_id)} · {referral.specialty} referral",
            "outcomes": outcomes,
            "patient_id": referral.patient_id,
            "synthetic_fixture": False,
        })
    if automatic_tasks:
        items.append({
            "id": "coordination-tasks",
            "kind": "tasks",
            "title": f"{automatic_tasks} coordination task{'' if automatic_tasks == 1 else 's'} handled",
            "detail": "Routine referral work completed without physician interruption",
            "outcomes": [],
            "patient_id": None,
            "synthetic_fixture": False,
        })
    routed = [item for item in SYNTHETIC_AUTO_ROUTED_REQUESTS if item["receiving_physician_id"] == physician_id]
    if routed:
        visits = sum(item["modality"] == "in_person" for item in routed)
        econsults = len(routed) - visits
        items.append({
            "id": "synthetic-auto-routed",
            "kind": "routing",
            "title": f"{len(routed)} requests routed automatically",
            "detail": (
                f"By practice fit, availability, and appropriate modality · {visits} visit{'' if visits == 1 else 's'}"
                f" · {econsults} e-consult{'' if econsults == 1 else 's'}"
            ),
            "outcomes": [],
            "patient_ids": [item["patient_id"] for item in routed],
            "patient_id": None,
            "synthetic_fixture": True,
        })
    return items
