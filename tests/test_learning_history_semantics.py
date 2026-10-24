"""Learning-history semantics pass: new teachings are ADDITIVE. A confirmed
learning is superseded only by an explicit revision (Edit) or when every
representation path it contributed is now contributed by later learnings --
never merely because it shares a case family, specialty, or disease.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import StructuredReferralPreference
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    clarification_opportunities,
    contribution_paths,
    effective_confirmed_rules,
    shadowed_preference_ids,
)
from backend.synthetic_data import PHYSICIAN_CHEN
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import document_chen_consultation

CHEN_ID = PHYSICIAN_CHEN.id
PREFERENCES = "/api/workspace/physician/chen/referral-preferences"
ECONSULT_LEARNING = (
    "For focused diabetes medication questions, I'm happy to start with an e-consult when the recent A1c, "
    "current medications, and kidney function are available. If diabetes is continuing to worsen despite "
    "treatment escalation, I generally prefer an in-person evaluation."
)
MEDICATION_HISTORY = (
    "If a patient has tried other diabetes medications before, I'd like the reason they were stopped "
    "included when it's available."
)
REVERSAL = (
    "If diabetes medication questions are focused, I generally prefer an in-person evaluation."
)
THYROID = "For new thyroid referrals, I prefer the most recent TSH and free T4 available before review."


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


def _teach(client: TestClient, text: str, **extra) -> dict:
    draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": text, **extra}).json()
    confirmed = client.post(f"{PREFERENCES}/{draft['id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


def _status(client: TestClient, preference_id: str) -> str:
    return next(item["status"] for item in client.get(PREFERENCES).json() if item["id"] == preference_id)


# ----------------------------------------------------------------- ADDITIVE 1-7


def test_a_referral_information_learning_never_supersedes_a_modality_learning(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        document_chen_consultation(store, ws)
        card = clarification_opportunities(store, ws, CHEN_ID)[0]
        modality = _teach(client, card["yes_statement"], clarifies="modality")
        information = _teach(client, MEDICATION_HISTORY)
        statuses = {modality["id"]: _status(client, modality["id"]), information["id"]: _status(client, information["id"])}
        sections = client.get("/api/workspace/physician/agent-representation?perspective=chen").json()["sections"]
        # Learning History offers Edit only for confirmed learnings; both accept a revision.
        revisable = [
            client.post(f"{PREFERENCES}/interpret", json={"source_text": "Anything.", "revises": learning["id"]}).status_code
            for learning in (modality, information)
        ]
    assert statuses == {modality["id"]: "confirmed", information["id"]: "confirmed"}
    assert modality["case_family"] == information["case_family"] == CHEN_SEED_CASE_FAMILY
    effective = effective_confirmed_rules(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert {rule.modality for rule in effective.modality_rules} == {"econsult", "in_person"}
    assert {item.key for item in effective.helpful} >= {"prior_diabetes_medication_trials", "diabetes_medication_discontinuation_reason"}
    assert sections["modality_preference"]
    assert {"Prior diabetes medication trials", "Reason each diabetes medication was stopped, when known"} <= set(sections["preferred_workup"])
    assert revisable == [200, 200]


def test_the_rehearsal_sentences_taught_directly_are_also_additive(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        first = _teach(client, ECONSULT_LEARNING)
        second = _teach(client, MEDICATION_HISTORY)
        assert _status(client, first["id"]) == "confirmed"
        assert _status(client, second["id"]) == "confirmed"


# ------------------------------------------------------------ REPLACEMENT 8-12


def test_an_explicit_edit_supersedes_only_the_version_it_replaces(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        modality = _teach(client, ECONSULT_LEARNING)
        information = _teach(client, MEDICATION_HISTORY)
        replacement = _teach(client, REVERSAL, revises=modality["id"])
        assert _status(client, modality["id"]) == "superseded"
        assert _status(client, replacement["id"]) == "confirmed"
        assert _status(client, information["id"]) == "confirmed"
    effective = effective_confirmed_rules(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert [rule.modality for rule in effective.modality_rules] == ["in_person"]
    assert "diabetes_medication_discontinuation_reason" in {item.key for item in effective.helpful}


def test_a_new_teaching_that_replaces_every_contribution_supersedes_the_earlier_learning(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        modality = _teach(client, ECONSULT_LEARNING)
        information = _teach(client, MEDICATION_HISTORY)
        reversal = _teach(client, REVERSAL)  # restates the whole modality boundary
        assert _status(client, modality["id"]) == "superseded"
        assert _status(client, reversal["id"]) == "confirmed"
        assert _status(client, information["id"]) == "confirmed"


# ------------------------------------------------------------------- SCOPE 13-15


def test_same_case_family_alone_never_supersedes() -> None:
    rows = [
        {"id": "a", "structured_rules_json": StructuredReferralPreference(good_fit=["Complex type 2 diabetes."]).model_dump_json()},
        {"id": "b", "structured_rules_json": StructuredReferralPreference(redirect=["Uncomplicated prediabetes."]).model_dump_json()},
    ]
    assert shadowed_preference_ids(rows) == set()


def test_same_specialty_alone_never_supersedes(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        diabetes = _teach(client, MEDICATION_HISTORY)
        thyroid = _teach(client, THYROID)
        assert _status(client, diabetes["id"]) == "confirmed"
        assert _status(client, thyroid["id"]) == "confirmed"


def test_partially_overlapping_learnings_stay_active_and_later_wins_on_the_overlap() -> None:
    from backend.models import ReferralRequirement

    early = StructuredReferralPreference(
        required=[ReferralRequirement(key="recent_hba1c", label="Recent A1c", required=True)],
        helpful=[ReferralRequirement(key="glucose_log", label="Glucose log", required=False)],
    )
    late = StructuredReferralPreference(
        helpful=[ReferralRequirement(key="recent_hba1c", label="Recent A1c", required=False)],
    )
    rows = [{"id": "early", "structured_rules_json": early.model_dump_json()}, {"id": "late", "structured_rules_json": late.model_dump_json()}]
    assert shadowed_preference_ids(rows) == set()
    assert contribution_paths(early) & contribution_paths(late) == {"item:recent_hba1c"}
    fully = [rows[1], {"id": "later", "structured_rules_json": early.model_dump_json()}]
    assert shadowed_preference_ids(fully) == {"late"}
