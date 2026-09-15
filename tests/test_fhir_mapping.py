from datetime import date
from pathlib import Path

import pytest

from backend.clinical import build_patient_context
from backend.config import load_repository_environment
from backend.fhir import (
    MedplumClinicalDataSource,
    MedplumError,
    MedplumSettings,
    SyntheticClinicalDataSource,
    create_clinical_data_source,
    map_fhir_resources_to_patient,
)
from backend.fhir.demo import (
    jordan_lee_fhir_resources,
    maria_santos_fhir_resources,
    seed_demo_patients,
    seed_jordan_lee,
)
from backend.synthetic_data import MARIA_PATIENT_ID, PATIENTS, PRIMARY_PATIENT_ID


def linked_demo_resources():
    resources = jordan_lee_fhir_resources()
    patient = {**resources["Patient"][0], "id": "medplum-jordan"}
    subject = {"reference": "Patient/medplum-jordan"}
    linked = {
        key: [
            {
                **item,
                "id": f"{key.casefold()}-{index}",
                ("beneficiary" if key == "Coverage" else "subject"): subject,
            }
            for index, item in enumerate(resources[key], 1)
        ]
        for key in ("Condition", "MedicationRequest", "Observation", "Coverage")
    }
    return patient, linked


def mapped_demo_patient():
    patient, linked = linked_demo_resources()
    return map_fhir_resources_to_patient(
        PRIMARY_PATIENT_ID,
        patient,
        linked["Condition"],
        linked["MedicationRequest"],
        linked["Observation"],
        linked["Coverage"],
        as_of=date(2026, 9, 12),
    )


def mapped_maria_patient():
    resources = maria_santos_fhir_resources()
    patient = {**resources["Patient"][0], "id": "medplum-maria"}
    subject = {"reference": "Patient/medplum-maria"}
    linked = {
        key: [
            {
                **item,
                "id": f"{key.casefold()}-{index}",
                ("beneficiary" if key == "Coverage" else "subject"): subject,
            }
            for index, item in enumerate(resources[key], 1)
        ]
        for key in ("Condition", "MedicationRequest", "Observation", "Coverage")
    }
    return map_fhir_resources_to_patient(
        MARIA_PATIENT_ID,
        patient,
        linked["Condition"],
        linked["MedicationRequest"],
        linked["Observation"],
        linked["Coverage"],
        as_of=date(2026, 9, 12),
    )


def test_jordan_fhir_maps_patient_conditions_medications_and_renal_trends() -> None:
    patient = mapped_demo_patient()
    assert patient.display_name == "Jordan Lee (synthetic)"
    assert patient.age == 62
    assert patient.location == "Oakland, CA"
    assert patient.insurance == "Lamina Demo PPO"
    assert patient.diagnoses == [
        "Resistant hypertension",
        "Type 2 diabetes mellitus",
        "Progressive chronic kidney disease",
    ]
    assert patient.medications == ["Lisinopril", "Amlodipine", "Chlorthalidone"]
    assert [lab.value for lab in patient.labs if lab.test == "creatinine"] == [
        1.1,
        1.3,
        1.6,
        1.8,
    ]
    assert [lab.value for lab in patient.labs if lab.test == "eGFR"] == [68, 59, 48, 41]
    assert patient.clinical_data_source == "medplum_fhir"


def test_synthetic_and_fhir_sources_build_equivalent_patient_context() -> None:
    local = PATIENTS[PRIMARY_PATIENT_ID]
    fhir = mapped_demo_patient()
    assert build_patient_context(fhir) == build_patient_context(local)


def test_maria_fhir_maps_anaemia_trend_iron_studies_and_prior_workup() -> None:
    patient = mapped_maria_patient()
    context = build_patient_context(patient)

    assert patient.display_name == "Maria Santos (synthetic)"
    assert patient.age == 54
    assert patient.medications == ["Ferrous sulfate (oral iron)"]
    assert context.hemoglobin_trend == [10.8, 10.1, 9.5]
    assert context.iron_studies == {
        "ferritin": 7,
        "serum_iron": 28,
        "TIBC": 410,
        "transferrin_saturation": 7,
    }
    assert context.microcytic_anemia is True
    assert context.prior_endoscopy_documented is False
    assert any("additional cytopenias" in note for note in patient.clinical_notes)
    assert context == build_patient_context(PATIENTS[MARIA_PATIENT_ID])


class FakeMedplumClient:
    def __init__(self) -> None:
        self.patient, self.linked = linked_demo_resources()

    def search(self, resource_type: str, params: dict[str, str]):
        if resource_type == "Patient":
            return [self.patient]
        return self.linked[resource_type]


class FakeUpsertClient:
    def __init__(self) -> None:
        self.resources: dict[tuple[str, str, str], dict] = {}

    def upsert_by_identifier(self, resource_type, system, value, resource):
        key = (resource_type, system, value)
        stored = {
            **resource,
            "id": self.resources.get(key, {}).get("id", f"id-{len(self.resources) + 1}"),
        }
        self.resources[key] = stored
        return stored


def test_medplum_data_source_returns_same_bounded_patient_record() -> None:
    settings = MedplumSettings(
        base_url="https://example.test",
        token_url="https://example.test/oauth2/token",
        fhir_base_url="https://example.test/fhir/R4",
        client_id="test",
        client_secret="test",
        project_id="test",
    )
    source = MedplumClinicalDataSource(settings, client=FakeMedplumClient())
    assert build_patient_context(source.get_patient(PRIMARY_PATIENT_ID)) == build_patient_context(
        PATIENTS[PRIMARY_PATIENT_ID]
    )


def test_offline_source_needs_no_medplum_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "MEDPLUM_BASE_URL",
        "MEDPLUM_CLIENT_ID",
        "MEDPLUM_CLIENT_SECRET",
        "MEDPLUM_PROJECT_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    assert isinstance(create_clinical_data_source("synthetic"), SyntheticClinicalDataSource)
    with pytest.raises(MedplumError, match="medplum_not_configured"):
        create_clinical_data_source("medplum")


def test_repository_environment_loader_supplies_medplum_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    values = {
        "MEDPLUM_BASE_URL": "https://example.test",
        "MEDPLUM_CLIENT_ID": "test-client",
        "MEDPLUM_CLIENT_SECRET": "test-secret",
        "MEDPLUM_PROJECT_ID": "test-project",
    }
    for name in values:
        monkeypatch.delenv(name, raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(f"{name}={value}" for name, value in values.items()), encoding="utf-8"
    )

    assert load_repository_environment(env_file) is True
    settings = MedplumSettings.from_environment()

    assert settings.base_url == "https://example.test"
    assert settings.client_id == "test-client"
    assert settings.project_id == "test-project"


def test_jordan_seed_is_idempotent_and_never_deletes_resources() -> None:
    client = FakeUpsertClient()
    first = seed_jordan_lee(client)
    second = seed_jordan_lee(client)
    assert first == second
    assert len(client.resources) == 16
    assert {resource_type for resource_type, _, _ in client.resources} == {
        "Patient",
        "Condition",
        "MedicationRequest",
        "Observation",
        "Coverage",
    }


def test_all_demo_patient_seeding_is_idempotent_and_preserves_jordan() -> None:
    client = FakeUpsertClient()
    first = seed_demo_patients(client)
    second = seed_demo_patients(client)

    assert first == second
    assert set(first) == {PRIMARY_PATIENT_ID, MARIA_PATIENT_ID}
    assert len(client.resources) == 31
    assert first[PRIMARY_PATIENT_ID]["Patient"]
    assert first[MARIA_PATIENT_ID]["Patient"]
