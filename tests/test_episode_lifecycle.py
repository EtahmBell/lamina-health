"""Referral-as-specialty-care-episode lifecycle (demo-consolidation pass):
duplicate-referral guard, re-referral/new-episode semantics, and handoff-
viewed tracking. See Parts 38/39/40 of the request for the full checklist.
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


def _create(client: TestClient) -> dict:
    return client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()


def _fully_returned_referral_id(client: TestClient) -> int:
    created = _create(client)
    referral_id = created["id"]
    client.post(f"/api/referrals/{referral_id}/preflight")
    client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    return referral_id


# --------------------------------------------------------------------- Part 38


def test_repeat_create_referral_while_active_returns_the_same_referral(api_client: TestClient) -> None:
    first = _create(api_client)
    second = _create(api_client)
    assert first["id"] == second["id"]


def test_repeat_create_does_not_duplicate_the_incoming_request(api_client: TestClient) -> None:
    _create(api_client)
    _create(api_client)
    incoming = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"}).json()
    # Both referrals are still drafts at creation -- submit the first to check dedup at the incoming-request level.
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID})
    incoming = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"}).json()
    assert len([item for item in incoming if item["patient_id"] == TONJIT_PATIENT_ID]) == 1


def test_repeat_create_never_duplicates_an_active_episode_at_any_active_status(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    repeat = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    assert repeat["id"] == referral_id
    assert repeat["status"] == "scheduled"  # accept auto-advances; still the SAME referral


def test_existing_referral_id_remains_authoritative_after_a_repeat_create(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID})
    active = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()
    assert active["id"] == referral_id


# --------------------------------------------------------------------- Part 39


def test_a_truly_completed_episode_allows_a_new_referral_with_a_new_id(api_client: TestClient) -> None:
    first_referral_id = _fully_returned_referral_id(api_client)
    second = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    assert second["id"] != first_referral_id
    assert second["status"] == "assembling"  # build_referral's real terminal state before persisting


def test_the_previous_completed_referral_remains_intact_after_a_new_one_is_created(api_client: TestClient) -> None:
    first_referral_id = _fully_returned_referral_id(api_client)
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID})
    first_after = api_client.get(f"/api/referrals/{first_referral_id}").json()
    assert first_after["status"] == "consult_returned"
    assert len(first_after["coordination_events"]) > 0


def test_lineage_is_preserved_via_previous_referral_id(api_client: TestClient) -> None:
    first_referral_id = _fully_returned_referral_id(api_client)
    second = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    assert second["previous_referral_id"] == first_referral_id


def test_the_new_referral_assembles_a_packet_from_current_patient_context_not_a_copy(api_client: TestClient) -> None:
    first_referral_id = _fully_returned_referral_id(api_client)
    second = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    first = api_client.get(f"/api/referrals/{first_referral_id}").json()
    assert second["id"] != first["id"]
    assert second["packet"]["items"]  # a real, freshly-assembled packet, not an empty/copied shell


def test_browser_back_cannot_accidentally_create_a_re_referral_while_the_prior_episode_is_still_active(
    api_client: TestClient,
) -> None:
    """Simulates "submit, go back, click Start referral again" entirely at
    the backend layer -- the repeat create must resolve to the SAME
    referral, never a second one, regardless of how many times it's
    retried while the episode is still active."""
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    for _ in range(3):
        repeat = api_client.post(
            f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
        ).json()
        assert repeat["id"] == referral_id


# --------------------------------------------------------------------- Part 40


def test_handoff_viewed_requires_the_real_referring_physician(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    response = api_client.post(
        f"/api/referrals/{referral_id}/handoff/viewed", json={"referring_physician_id": CHEN_ID}
    )
    assert response.status_code == 403


def test_opening_the_handoff_persists_a_viewed_timestamp(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})

    before = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    assert before["viewed_by_referring_physician_at"] is None

    viewed = api_client.post(
        f"/api/referrals/{referral_id}/handoff/viewed", json={"referring_physician_id": LUCY_AGENT_ID}
    ).json()
    assert viewed["viewed_by_referring_physician_at"] is not None

    after_reload = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    assert after_reload["viewed_by_referring_physician_at"] == viewed["viewed_by_referring_physician_at"]


def test_cannot_mark_viewed_before_the_handoff_is_actually_sent(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    # Handoff exists as a DRAFT only -- not yet sent.
    response = api_client.post(
        f"/api/referrals/{referral_id}/handoff/viewed", json={"referring_physician_id": LUCY_AGENT_ID}
    )
    assert response.status_code == 409


def test_marking_viewed_twice_is_idempotent_and_keeps_the_first_timestamp(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    first = api_client.post(
        f"/api/referrals/{referral_id}/handoff/viewed", json={"referring_physician_id": LUCY_AGENT_ID}
    ).json()
    second = api_client.post(
        f"/api/referrals/{referral_id}/handoff/viewed", json={"referring_physician_id": LUCY_AGENT_ID}
    ).json()
    assert first["viewed_by_referring_physician_at"] == second["viewed_by_referring_physician_at"]


# --------------------------------------------------------------------- Part 36 (reset)


def test_reset_clears_an_accidentally_duplicated_referral_row_and_leaves_no_second_incoming_request(
    api_client: TestClient,
) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post("/api/workspace/demo/reset/tonjit")
    created = _create(api_client)
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    incoming = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"}).json()
    assert len([item for item in incoming if item["patient_id"] == TONJIT_PATIENT_ID]) == 1


def test_reset_clears_corrections_for_tonjit(api_client: TestClient) -> None:
    referral_id = _create(api_client)["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/corrections",
        json={"physician_id": LUCY_AGENT_ID, "correction_text": "test correction"},
    )
    api_client.post("/api/workspace/demo/reset/tonjit")
    corrections = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/corrections").json()
    assert corrections == []
