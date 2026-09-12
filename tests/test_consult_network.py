from fastapi.testclient import TestClient

from backend.agents import consult_network, evaluate_physician
from backend.clinical import build_patient_context, generate_candidates
from backend.main import app
from backend.models import ClinicalFit, EvidenceKind
from backend.synthetic_data import PATIENTS, PHYSICIANS, PRIMARY_PATIENT_ID


def patient_and_context():
    patient = PATIENTS[PRIMARY_PATIENT_ID]
    return patient, build_patient_context(patient)


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
            "physician_id", "physician_name", "specialty", "clinical_fit",
            "accepts_case", "reason", "evidence", "required_workup", "urgency",
            "availability", "insurance_status", "confidence",
        }
    assert len({result.reason for result in results}) == 5
    assert {result.clinical_fit for result in results} == {
        ClinicalFit.STRONG, ClinicalFit.MODERATE, ClinicalFit.POOR
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
    assert result.alternatives[0].physician_id == "physician-onadeko"
    ep = next(item for item in result.consultation if item.physician_id == "physician-rossi")
    assert ep.clinical_fit == ClinicalFit.POOR
    assert ep.accepts_case is False
    assert any("BMP" in item for item in result.before_referral)
    assert any("UPCR" in item for item in result.before_referral)
    assert result.patient_facts_used
    assert all(item.evidence for item in result.consultation)


def test_api_runs_without_credentials_or_network():
    client = TestClient(app)
    assert client.get("/health").json() == {"status": "ok", "data_mode": "synthetic"}
    patient = client.get(f"/api/patients/{PRIMARY_PATIENT_ID}")
    assert patient.status_code == 200
    result = client.post(
        f"/api/patients/{PRIMARY_PATIENT_ID}/consultations",
        json={"pcp_guidance": "Thinking nephrology vs cardiology"},
    )
    assert result.status_code == 200
    assert result.json()["recommended_physician"]["physician_name"].startswith("Dr. Mina Jung")

