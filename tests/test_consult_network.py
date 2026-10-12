import pytest
from fastapi.testclient import TestClient

from backend.agents import consult_network, evaluate_physician
from backend.api import consult as consult_api
from backend.clinical import build_patient_context, generate_candidates
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import ClinicalFit, ConsultationMessageType, EvidenceKind
from backend.synthetic_data import (
    ALL_PHYSICIANS,
    MARIA_PATIENT_ID,
    MARIA_PHYSICIANS,
    PATIENTS,
    PHYSICIAN_CHEN,
    PHYSICIANS,
    PRIMARY_PATIENT_ID,
    TONJIT_PATIENT_ID,
    TONJIT_PHYSICIANS,
)
from backend.workflow import WorkflowStore


def patient_and_context():
    patient = PATIENTS[PRIMARY_PATIENT_ID]
    return patient, build_patient_context(patient)


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", WorkflowStore(tmp_path / "workflow.sqlite"))
    return TestClient(app)


def test_patient_context_captures_renal_decline_and_resistant_hypertension():
    patient, context = patient_and_context()
    assert patient.synthetic is True
    assert context.creatinine_trend == [1.1, 1.3, 1.6, 1.8]
    assert context.egfr_trend == [68, 59, 48, 41]
    assert context.progressive_renal_dysfunction is True
    assert context.resistant_hypertension is True
    assert context.ckd_stage == "stage 3b"


def test_candidate_generation_includes_nephrology_cardiology_and_boundary_case():
    _, context = patient_and_context()
    candidates = generate_candidates(context, PHYSICIANS)
    ids = {item.physician_id for item in candidates}
    assert "physician-jung" in ids
    assert "physician-onadeko" in ids
    ep = next(item for item in candidates if item.physician_id == "physician-rossi")
    assert any("boundary" in reason.casefold() for reason in ep.reasons)


def test_agents_return_schema_and_meaningfully_different_responses():
    patient, context = patient_and_context()
    results = [evaluate_physician(patient, context, profile) for profile in PHYSICIANS]
    assert len(results) == 5
    for result in results:
        dumped = result.model_dump(mode="json")
        assert set(dumped) == {
            "physician_id",
            "physician_name",
            "specialty",
            "clinical_fit",
            "accepts_case",
            "reason",
            "evidence",
            "required_workup",
            "urgency",
            "availability",
            "insurance_status",
            "confidence",
        }
    assert len({result.reason for result in results}) == 5
    assert {result.clinical_fit for result in results} == {
        ClinicalFit.STRONG,
        ClinicalFit.MODERATE,
        ClinicalFit.POOR,
    }


def test_explicit_onadeko_rule_overrides_historical_hypertension_similarity():
    patient, context = patient_and_context()
    profile = next(item for item in PHYSICIANS if item.id == "physician-onadeko")
    result = evaluate_physician(patient, context, profile)
    assert result.clinical_fit == ClinicalFit.MODERATE
    assert "nephrology" in result.reason.casefold()
    assert result.evidence[0].kind == EvidenceKind.EXPLICIT_RULE
    assert any(item.kind == EvidenceKind.PRACTICE_SIMILARITY for item in result.evidence)


def test_primary_network_result_is_grounded_and_inspectable():
    patient = PATIENTS[PRIMARY_PATIENT_ID]
    result = consult_network(patient, PHYSICIANS)
    assert result.recommended_physician.physician_id == "physician-jung"
    assert result.recommended_physician.specialty == "Nephrology"
    assert result.recommended_physician.availability == "Approximately 8 days"
    assert result.alternatives[0].physician_id == "physician-onadeko"
    ep = next(item for item in result.consultation if item.physician_id == "physician-rossi")
    assert ep.clinical_fit == ClinicalFit.POOR
    assert ep.accepts_case is False
    assert any("BMP" in item for item in result.before_referral)
    assert any("UPCR" in item for item in result.before_referral)
    assert result.patient_facts_used
    assert all(item.evidence for item in result.consultation)


def test_api_runs_without_credentials_or_network(api_client: TestClient):
    assert api_client.get("/health").json() == {"status": "ok", "data_mode": "synthetic"}
    patient = api_client.get(f"/api/patients/{PRIMARY_PATIENT_ID}")
    assert patient.status_code == 200
    result = api_client.post(
        f"/api/patients/{PRIMARY_PATIENT_ID}/consultations",
        json={"pcp_guidance": "Thinking nephrology vs cardiology"},
    )
    assert result.status_code == 200
    assert result.json()["recommended_physician"]["physician_name"].startswith("Dr. Iain Jung")
    assert result.json()["messages"]


def test_consultation_has_auditable_messages_and_meaningful_follow_up():
    patient = PATIENTS[PRIMARY_PATIENT_ID]
    result = consult_network(patient, PHYSICIANS)
    assert result.messages[0].message_type == ConsultationMessageType.CONSULT_REQUEST

    physician_responses = [
        message
        for message in result.messages
        if message.message_type
        in {ConsultationMessageType.FIT_RESPONSE, ConsultationMessageType.REDIRECT}
    ]
    assert len(physician_responses) == len(PHYSICIANS)
    jung = next(message for message in physician_responses if "Jung" in message.sender_name)
    onadeko = next(message for message in physician_responses if "Onadeko" in message.sender_name)
    electrophysiology = next(
        message for message in physician_responses if "Rossi" in message.sender_name
    )
    assert jung.metadata["clinical_fit"] == "strong"
    assert "nephrology" in onadeko.summary.casefold()
    assert electrophysiology.metadata["clinical_fit"] == "poor"

    follow_up = next(
        message
        for message in result.messages
        if message.message_type == ConsultationMessageType.FOLLOW_UP_ANSWER
    )
    assert "nephrology first" in follow_up.summary.casefold()
    requirement = next(
        message
        for message in result.messages
        if message.message_type == ConsultationMessageType.REFERRAL_REQUIREMENT
    )
    assert requirement.metadata["required_workup"] == "BMP · UPCR"
    assert result.messages[-1].message_type == ConsultationMessageType.SYNTHESIS

    forbidden_fields = {"chain_of_thought", "reasoning_trace", "scratchpad", "tokens"}
    assert all(forbidden_fields.isdisjoint(message.model_dump()) for message in result.messages)


def test_maria_recommends_gastroenterology_first_despite_faster_haematology() -> None:
    result = consult_network(PATIENTS[MARIA_PATIENT_ID], MARIA_PHYSICIANS)

    assert result.recommended_physician.physician_id == "physician-sanchez"
    assert result.recommended_physician.specialty == "Gastroenterology"
    assert result.recommended_physician.availability == "Approximately 9 days"
    assert result.alternatives[0].physician_id == "physician-brooks"
    assert result.alternatives[0].specialty == "Haematology"
    assert result.alternatives[0].availability == "Approximately 8 days"
    assert "appropriate" in result.alternatives[0].reason.casefold()
    assert "first" in result.why.casefold()
    assert result.before_referral == [
        "Recent complete blood count (CBC)",
        "Ferritin",
        "Iron studies",
    ]


def test_maria_consultation_has_gi_clarification_acceptance_and_synthesis() -> None:
    result = consult_network(PATIENTS[MARIA_PATIENT_ID], MARIA_PHYSICIANS)

    question = next(
        message
        for message in result.messages
        if message.message_type == ConsultationMessageType.FOLLOW_UP_QUESTION
    )
    answer = next(
        message
        for message in result.messages
        if message.message_type == ConsultationMessageType.FOLLOW_UP_ANSWER
    )
    acceptance = next(
        message
        for message in result.messages
        if message.message_type == ConsultationMessageType.REFERRAL_REQUIREMENT
    )
    assert question.sender_agent_id.endswith("0000012")
    assert "colonoscopy" in question.summary.casefold()
    assert answer.sender_name == "Dr. Lucy Saruhashi Agent"
    assert "no prior" in answer.summary.casefold()
    assert acceptance.metadata["accepts_after_clarification"] is True
    assert acceptance.metadata["required_workup"] == "CBC · Ferritin · Iron studies"
    assert result.messages[-1].message_type == ConsultationMessageType.SYNTHESIS
    assert "haematology remains appropriate later" in result.messages[-1].summary.casefold()

    forbidden_fields = {"chain_of_thought", "reasoning_trace", "scratchpad", "tokens"}
    assert all(forbidden_fields.isdisjoint(message.model_dump()) for message in result.messages)


def test_api_lists_and_runs_both_demo_cases(api_client: TestClient) -> None:
    patients = api_client.get("/api/patients")
    assert patients.status_code == 200
    assert {patient["id"] for patient in patients.json()} == {
        PRIMARY_PATIENT_ID,
        MARIA_PATIENT_ID,
        TONJIT_PATIENT_ID,
    }

    response = api_client.post(
        f"/api/patients/{MARIA_PATIENT_ID}/consultations",
        json={"pcp_guidance": "Gastroenterology versus haematology"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["recommended_physician"]["specialty"] == "Gastroenterology"
    assert payload["alternatives"][0]["specialty"] == "Haematology"


def test_tonjit_patient_context_captures_worsening_glycemic_control_and_documented_renal_function() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    context = build_patient_context(patient)
    assert patient.synthetic is True
    assert patient.age == 52
    assert patient.location == "Fremont, CA"
    assert context.hba1c_trend == [7.1, 7.8, 8.7, 9.6]
    assert context.fasting_glucose_trend == [128, 154, 183, 214]
    assert context.weight_trend == [91]
    assert context.progressive_glycemic_control is True
    assert context.renal_function_documented is True
    assert context.creatinine_trend == [0.9]
    assert context.egfr_trend == [97]


def test_tonjit_referral_question_is_stored_on_the_patient_record() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    assert patient.referral_question is not None
    assert "treatment intensification" in patient.referral_question.casefold()


def test_tonjit_recommends_endocrinology_and_rejects_internal_medicine_distractor() -> None:
    result = consult_network(PATIENTS[TONJIT_PATIENT_ID], TONJIT_PHYSICIANS)

    assert result.recommended_physician.physician_id == "physician-chen"
    assert result.recommended_physician.specialty == "Endocrinology"
    assert result.recommended_physician.clinical_fit == ClinicalFit.STRONG
    assert result.alternatives[0].physician_id == "physician-okonkwo"
    torres = next(item for item in result.consultation if item.physician_id == "physician-torres")
    assert torres.clinical_fit == ClinicalFit.POOR
    assert torres.accepts_case is False
    assert "endocrinology" in result.why.casefold()
    assert result.messages[-1].message_type == ConsultationMessageType.SYNTHESIS


def test_tonjit_api_run_does_not_crash_and_returns_chen(api_client: TestClient) -> None:
    response = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/consultations",
        json={"pcp_guidance": "Considering an endocrinology referral"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["recommended_physician"]["physician_name"].startswith("Dr. Noah Chen")
    assert payload["messages"]


def test_jordan_and_maria_consults_are_unaffected_by_adding_tonjit() -> None:
    jordan_result = consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS)
    assert jordan_result.recommended_physician.physician_id == "physician-jung"
    chen_for_jordan = next(
        item for item in jordan_result.consultation if item.physician_id == "physician-chen"
    )
    assert chen_for_jordan.clinical_fit == ClinicalFit.POOR
    assert chen_for_jordan.accepts_case is False

    maria_result = consult_network(PATIENTS[MARIA_PATIENT_ID], MARIA_PHYSICIANS)
    assert maria_result.recommended_physician.physician_id == "physician-sanchez"


def test_physician_chen_resolves_to_exactly_one_canonical_identity() -> None:
    jordan_chen = next(item for item in PHYSICIANS if item.id == "physician-chen")
    tonjit_chen = next(item for item in TONJIT_PHYSICIANS if item.id == "physician-chen")
    assert jordan_chen is tonjit_chen is PHYSICIAN_CHEN

    chen_entries_in_directory = [item for item in ALL_PHYSICIANS if item.id == "physician-chen"]
    assert len(chen_entries_in_directory) == 1, "physician-chen must appear exactly once in the directory"
    assert chen_entries_in_directory[0] is PHYSICIAN_CHEN

    assert jordan_chen.name == tonjit_chen.name == "Dr. Noah Chen (synthetic)"
    assert jordan_chen.specialty == tonjit_chen.specialty == "Endocrinology"
    assert jordan_chen.location == tonjit_chen.location == "Oakland, CA"


def test_jordan_physician_chen_rejection_is_unchanged_by_case_family_rules() -> None:
    patient, context = patient_and_context()
    result = evaluate_physician(patient, context, PHYSICIAN_CHEN)
    assert result.clinical_fit == ClinicalFit.POOR
    assert result.accepts_case is False
    assert "progressive CKD" in result.reason
    assert result.required_workup == ["Current HbA1c"]
    assert result.evidence[0].kind == EvidenceKind.EXPLICIT_RULE
    assert "does not make endocrinology the lead service" in result.evidence[0].detail


def test_tonjit_physician_chen_acceptance_is_correct_through_the_shared_identity() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    context = build_patient_context(patient)
    result = evaluate_physician(patient, context, PHYSICIAN_CHEN)
    assert result.clinical_fit == ClinicalFit.STRONG
    assert result.accepts_case is True
    assert result.required_workup == ["Current HbA1c", "Home glucose log"]
    assert "Accept progressive type 2 diabetes" in result.evidence[0].detail
