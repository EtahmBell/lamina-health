"""Final demo hardening pass: clarification timing, referral idempotency
under concurrency, access/slot coherence, and deterministic reset/replay.
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.agents.care_routing import PHYSICIAN_ACCESS_PROFILES
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import ReferralPreferenceInterpretationService, clarification_opportunities
from backend.referrals import build_referral, find_active_referral_for_pair
from backend.referrals.scheduling import synthetic_chen_availability
from backend.synthetic_data import PATIENTS, PHYSICIAN_CHEN, TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = PHYSICIAN_CHEN.id
PREFERENCES = "/api/workspace/physician/chen/referral-preferences"


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    for module in (referral_preferences_api, referrals_api, consult_api, engagement_api, workspace_api, specialist_api, demo_workspace_module):
        monkeypatch.setattr(module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(
        referral_preferences_api,
        "referral_preference_interpretation_service",
        ReferralPreferenceInterpretationService(ResponsesApiClient(enabled=False)),
    )
    return value


def _bootstrap(client: TestClient) -> str:
    client.get("/api/patients")
    return client.cookies[DEFAULT_COOKIE_NAME]


def _overview_clarifications(client: TestClient) -> list[dict]:
    return client.get("/api/workspace/physician/agent-overview?perspective=chen").json()["learning_opportunities"]


def _run_tonjit_to_scheduled(client: TestClient) -> int:
    referral = client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID, "priority": "soon"}
    ).json()
    client.post(f"/api/referrals/{referral['id']}/preflight")
    return referral["id"]


# ---------------------------------------------------------- CLARIFICATION TIMING 1-6


def test_the_econsult_clarification_appears_only_after_the_consultation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        client.post("/api/workspace/demo/reset/tonjit")
        assert _overview_clarifications(client) == []  # 1. reset

        referral_id = _run_tonjit_to_scheduled(client)
        assert _overview_clarifications(client) == []  # 2. referral created + ready

        accepted = client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID}).json()
        assert accepted["status"] == "scheduled"  # acceptance schedules automatically
        assert _overview_clarifications(client) == []  # 3/4. accepted + scheduled

        ingested = client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
        assert ingested.status_code == 200
        clarifications = _overview_clarifications(client)  # 5. consultation completed
        assert [item["id"] for item in clarifications] == ["chen-econsult-modality-gap"]
        assert clarifications[0]["source"] == "recent_work"
        assert clarification_opportunities(store, ws, CHEN_ID) == clarifications


def test_a_resolved_clarification_does_not_reappear(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        referral_id = _run_tonjit_to_scheduled(client)
        client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
        client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
        card = _overview_clarifications(client)[0]
        draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": card["yes_statement"], "clarifies": "modality"}).json()
        assert len(_overview_clarifications(client)) == 1  # a draft resolves nothing
        client.post(f"{PREFERENCES}/{draft['id']}/confirm")
        assert _overview_clarifications(client) == []
        # Further work does not resurrect an answered boundary.
        client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
        assert _overview_clarifications(client) == []


def test_other_physicians_never_get_the_chen_clarification(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        assert client.get("/api/workspace/physician/agent-overview?perspective=iain").json()["learning_opportunities"] == []


# --------------------------------------------------------- REFERRAL IDEMPOTENCY 18-19


def test_concurrent_equivalent_creates_produce_exactly_one_active_referral(store: WorkflowStore) -> None:
    """Many threads race the same atomic get-or-create; the write lock must
    serialize them so exactly one row is inserted and all get its id."""
    workspace_id = "ws-concurrent-create"
    template = build_referral(PATIENTS[TONJIT_PATIENT_ID], CHEN_ID, "Endocrinology", priority="soon")
    barrier = threading.Barrier(8)
    results: list[tuple[int, bool]] = []
    errors: list[BaseException] = []

    def create() -> None:
        try:
            barrier.wait()
            saved, created = store.create_referral_unless_active(
                workspace_id, template, lambda rows: find_active_referral_for_pair(rows, CHEN_ID)
            )
            results.append((saved.id, created))
        except BaseException as error:  # noqa: BLE001 -- surfaced by the assertion below
            errors.append(error)

    threads = [threading.Thread(target=create) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len({referral_id for referral_id, _ in results}) == 1
    assert sum(created for _, created in results) == 1
    assert len(store.list_referrals(workspace_id, patient_id=TONJIT_PATIENT_ID)) == 1


def test_repeated_start_referral_reuses_the_active_referral(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        first = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
        second = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
        submitted = client.get(f"/api/physicians/{CHEN_ID}/referrals?status=submitted").json()
    assert first["id"] == second["id"]
    assert len(store.list_referrals(ws, patient_id=TONJIT_PATIENT_ID)) == 1
    assert len(submitted) <= 1


# ------------------------------------------------------------------ SCHEDULING 22-23


def test_chens_synthetic_visit_slots_match_his_displayed_access() -> None:
    access = PHYSICIAN_ACCESS_PROFILES[CHEN_ID]
    now = datetime(2026, 10, 23, 8, 0, tzinfo=UTC)
    offsets = [
        (datetime.fromisoformat(slot.starts_at).date() - now.date()).days
        for slot in synthetic_chen_availability(now)
    ]
    assert abs(offsets[0] - access.in_person_wait_days) <= 2, "the first offered slot sits at the displayed ~10-day access"
    assert min(offsets) <= access.in_person_wait_days
    assert PHYSICIAN_CHEN.availability_days == access.in_person_wait_days
    # E-consult capacity stays a separate channel with its own response time.
    assert (access.econsult_available, access.econsult_response_days) == (True, 2)


def test_the_auto_scheduled_appointment_is_the_10_day_slot(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        referral_id = _run_tonjit_to_scheduled(client)
        client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
        scheduling = client.get(f"/api/referrals/{referral_id}/scheduling").json()
    booked = datetime.fromisoformat(scheduling["selected_option"]["starts_at"]).date()
    assert abs((booked - datetime.now().date()).days - PHYSICIAN_ACCESS_PROFILES[CHEN_ID].in_person_wait_days) <= 2


# -------------------------------------------------------------------- RESET / REPLAY 30


def test_reset_then_replay_is_clean_and_deterministic(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        for _ in range(2):
            referral_id = _run_tonjit_to_scheduled(client)
            client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
            client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
            card = _overview_clarifications(client)[0]
            draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": card["no_statement"], "clarifies": "modality"}).json()
            assert draft["status"] == "draft"

            assert client.post("/api/workspace/demo/reset/tonjit").status_code == 200
            assert store.list_referrals(ws, patient_id=TONJIT_PATIENT_ID) == []
            assert store.list_encounters_for_patient(ws, TONJIT_PATIENT_ID) == []
            assert store.list_referral_preferences(ws, CHEN_ID) == []  # drafts and confirmations
            assert _overview_clarifications(client) == []

            fresh = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
            assert len(store.list_referrals(ws, patient_id=TONJIT_PATIENT_ID)) == 1
            # The baseline representation the primary demo needs is intact.
            assert any(item["key"] == "recent_renal_function" for item in fresh["receiving_requirements"])
            client.post("/api/workspace/demo/reset/tonjit")
