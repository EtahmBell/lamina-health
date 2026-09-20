"""Read-only physician-agent network view over completed Lamina demo consultations."""

from __future__ import annotations

from backend.demo_identity import PCP_AGENT_ID, PCP_AGENT_NAME
from backend.provider_network.service import ProviderNetwork
from backend.synthetic_data import ALL_PHYSICIANS, PATIENTS, SYNTHETIC_PHYSICIAN_NPIS

CENTER_AGENT = {
    "id": PCP_AGENT_ID,
    "name": PCP_AGENT_NAME,
    "specialty": "Primary Care",
    "location": "Oakland, CA",
    "status": "active",
    "source": "Configured synthetic demo profile",
}


def project_agent_network(records: list[dict], providers: ProviderNetwork) -> dict:
    """Only saved structured consult outcomes create edges; roster alone creates none."""
    relationships: dict[str, dict] = {}
    for record in records:
        result = record["result"]
        recommended_id = result["recommended_physician"]["physician_id"]
        patient_id = record["patient_id"]
        patient_name = (
            PATIENTS[patient_id].display_name.replace(" (synthetic)", "")
            if patient_id in PATIENTS else patient_id
        )
        for evaluation in result["consultation"]:
            physician_id = evaluation["physician_id"]
            if physician_id not in SYNTHETIC_PHYSICIAN_NPIS:
                continue
            relation = relationships.setdefault(
                physician_id,
                {
                    "source_agent": CENTER_AGENT["id"],
                    "target_agent": f"agent-{SYNTHETIC_PHYSICIAN_NPIS[physician_id]}",
                    "consultation_count": 0,
                    "recommended_count": 0,
                    "redirect_count": 0,
                    "most_recent_interaction": None,
                    "last_patient_id": None,
                    "last_patient_name": None,
                    "last_record_id": None,
                    "associated_consultation_ids": [],
                },
            )
            relation["consultation_count"] += 1
            relation["recommended_count"] += int(physician_id == recommended_id)
            relation["redirect_count"] += int(not evaluation["accepts_case"])
            relation["associated_consultation_ids"].append(record["id"])
            if relation["most_recent_interaction"] is None:
                relation["most_recent_interaction"] = record["completed_at"]
                relation["last_patient_id"] = patient_id
                relation["last_patient_name"] = patient_name
                relation["last_record_id"] = record["id"]

    for relation in relationships.values():
        relation["relationship_type"] = (
            "recommended" if relation["recommended_count"] else
            "redirected" if relation["redirect_count"] == relation["consultation_count"] else
            "consulted"
        )

    nodes = []
    for footprint in ALL_PHYSICIANS:
        npi = SYNTHETIC_PHYSICIAN_NPIS[footprint.id]
        profile = providers.get(npi)
        nodes.append({
            "id": profile.agent.id,
            "physician_id": footprint.id,
            "npi": npi,
            "name": profile.display_name,
            "specialty": profile.specialty,
            "subspecialty": footprint.subspecialty,
            "location": footprint.location,
            "status": profile.agent.status.value,
            "source": "SYNTHETIC",
            "focus_areas": footprint.focus_areas,
            "required_workup": footprint.required_workup,
            "explicit_rules": footprint.explicit_rules,
            "confirmed_preferences": (
                profile.agent.preferences.model_dump(mode="json")
                if profile.agent.practice_confirmed and profile.agent.preferences else None
            ),
            "provenance": (
                "Physician-confirmed synthetic demo preferences"
                if profile.agent.practice_confirmed and profile.agent.preferences
                else "Configured synthetic demo practice footprint · not physician-confirmed"
            ),
            "relationship": relationships.get(footprint.id),
        })

    return {
        "center": CENTER_AGENT,
        "nodes": nodes,
        "record_count": len(records),
        "relationship_source": "Completed Lamina synthetic consultation records only",
        "status_note": (
            "Synthetic consult representatives may participate in the deterministic demo "
            "while their separate profile activation state remains Reserved."
        ),
    }
