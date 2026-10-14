"""Agent correction mechanic (demo-consolidation pass, Part 23-31): a
physician-owned, durable training-source artifact, separate from the
ephemeral chat and the immutable coordination-event audit trail. See Part
43 of the request for the full checklist.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.demo_identity import LUCY_AGENT_ID
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.synthetic_data import TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(referrals_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    return TestClient(app)


def _accepted_referral(client: TestClient) -> dict:
    created = client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    client.post(f"/api/referrals/{created['id']}/preflight")
    client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})
    return client.get(f"/api/referrals/{created['id']}").json()


def _sequence_for_actor(referral: dict, actor: str) -> int:
    return next(event["sequence"] for event in referral["coordination_events"] if event["actor"] == actor)


def test_lucy_can_correct_a_referring_agent_event(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    response = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "I don't require CGM data before reviewing a diabetes referral.",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending_training"
    assert body["physician_id"] == LUCY_AGENT_ID


def test_lucy_cannot_directly_correct_a_receiving_agent_event(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "receiving_agent")
    response = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "Should not have requested this.",
        },
    )
    assert response.status_code == 403


def test_chen_can_correct_a_receiving_agent_event(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "receiving_agent")
    response = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": CHEN_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "CGM data is helpful but optional, not required.",
        },
    )
    assert response.status_code == 200
    assert response.json()["physician_id"] == CHEN_ID


def test_chen_cannot_directly_correct_a_referring_agent_event(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    response = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": CHEN_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "Should not have assembled this.",
        },
    )
    assert response.status_code == 403


def test_selected_text_is_captured_when_provided(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    body = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "selected_text": "Initial referral packet assembled with 2 item(s).",
            "correction_text": "This should mention which items specifically.",
        },
    ).json()
    assert body["selected_text"] == "Initial referral packet assembled with 2 item(s)."


def test_correction_text_persists_and_is_retrievable(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "Be more specific about which labs were included.",
        },
    )
    corrections = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/corrections").json()
    assert any(item["correction_text"] == "Be more specific about which labs were included." for item in corrections)


def test_the_source_coordination_event_remains_unchanged_after_a_correction(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    event_before = next(e for e in referral["coordination_events"] if e["sequence"] == sequence)
    api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "This should change.",
        },
    )
    after = api_client.get(f"/api/referrals/{referral['id']}").json()
    event_after = next(e for e in after["coordination_events"] if e["sequence"] == sequence)
    assert event_before == event_after


def test_correction_status_is_pending_training_and_never_immediately_applied(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    body = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "This should change.",
        },
    ).json()
    assert body["status"] == "pending_training"


def test_patient_and_referral_provenance_is_retained(api_client: TestClient) -> None:
    referral = _accepted_referral(api_client)
    sequence = _sequence_for_actor(referral, "referring_agent")
    body = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={
            "physician_id": LUCY_AGENT_ID,
            "referral_id": referral["id"],
            "source_event_sequence": sequence,
            "correction_text": "This should change.",
        },
    ).json()
    assert body["patient_id"] == TONJIT_PATIENT_ID
    assert body["referral_id"] == referral["id"]
    assert body["source_event_sequence"] == sequence


def test_a_bare_match_recommendation_correction_with_no_referral_is_self_correction_and_always_allowed(
    api_client: TestClient,
) -> None:
    response = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={"physician_id": LUCY_AGENT_ID, "correction_text": "Wrong specialty recommended."},
    )
    assert response.status_code == 200
    assert response.json()["referral_id"] is None
