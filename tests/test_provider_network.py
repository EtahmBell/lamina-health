import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.provider_network import api as provider_api
from backend.provider_network.directory import DirectoryUnavailableError, NppesDirectory
from backend.provider_network.models import AgentPreferencesInput, AgentStatus
from backend.provider_network.service import (
    DemoVerificationForbiddenError,
    ProviderNetwork,
)
from backend.synthetic_data import SYNTHETIC_PHYSICIAN_NPIS
from backend.workflow import WorkflowStore


def build_directory(path: Path) -> NppesDirectory:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE physicians (
              npi TEXT PRIMARY KEY, display_name TEXT, primary_specialty TEXT,
              primary_taxonomy_code TEXT, organization_name TEXT, city TEXT,
              state TEXT, phone TEXT, active INTEGER, source TEXT,
              first_name TEXT, last_name TEXT
            );
            CREATE TABLE agents (physician_npi TEXT, status TEXT);
            CREATE VIRTUAL TABLE physician_fts USING fts5(
              npi UNINDEXED, display_name, primary_specialty, city, state
            );
            INSERT INTO physicians VALUES (
              '1234567890', 'JANE SMITH, MD', 'Nephrology Physician',
              '207RN0300X', 'Bay Kidney Group', 'PALO ALTO', 'CA',
              '6505550100', 1, 'NPPES', 'JANE', 'SMITH'
            );
            INSERT INTO agents VALUES ('1234567890', 'reserved');
            INSERT INTO physician_fts VALUES (
              '1234567890', 'JANE SMITH, MD', 'Nephrology Physician', 'PALO ALTO', 'CA'
            );
            """
        )
    return NppesDirectory(path)


def test_nppes_search_maps_directory_identity_and_reserved_agent(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    network = ProviderNetwork(build_directory(tmp_path / "providers.sqlite"), store)
    response = network.search(specialty="nephrology", location="Palo Alto")

    assert response.directory_available is True
    assert response.directory_records == 1
    assert response.count == 1
    profile = response.results[0]
    assert profile.npi == "1234567890"
    assert profile.city == "Palo Alto"
    assert profile.agent.status == AgentStatus.RESERVED
    assert profile.consult_eligible is False
    assert "does not indicate" in profile.directory_disclaimer


def test_nppes_profile_cannot_use_demo_verification(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    network = ProviderNetwork(build_directory(tmp_path / "providers.sqlite"), store, True)
    claimed = network.claim("1234567890", "user-a")
    network.submit_verification(claimed.id, "user-a")
    assert network.get("1234567890").agent.status == AgentStatus.VERIFICATION_PENDING
    with pytest.raises(DemoVerificationForbiddenError):
        network.verify_demo(claimed.id, "user-a")


def test_synthetic_profile_completes_structured_activation(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    network = ProviderNetwork(NppesDirectory(Path("missing.sqlite")), store, True)
    npi = SYNTHETIC_PHYSICIAN_NPIS["physician-jung"]

    claim = network.claim(npi, "user-a")
    assert network.get(npi).agent.status == AgentStatus.CLAIMED
    network.submit_verification(claim.id, "user-a")
    assert network.verify_demo(claim.id, "user-a").status.value == "verified"
    configured = network.configure(
        npi,
        "user-a",
        AgentPreferencesInput(
            practice_confirmed=True,
            areas_of_focus=["Resistant hypertension", "Progressive CKD"],
            cases_accepted=["Stage 3–4 CKD"],
            cases_redirected=["Dialysis access surgery"],
            preferred_pre_referral_workup=["BMP", "UPCR"],
            notes="Synthetic demo preferences.",
        ),
    )
    assert configured.agent.practice_confirmed is True
    assert configured.agent.preferences is not None
    assert network.activate(claim.id, "user-a").agent.status == AgentStatus.ACTIVE


def test_provider_api_search_and_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    providers = ProviderNetwork(NppesDirectory(Path("missing.sqlite")), store)
    monkeypatch.setattr(provider_api, "provider_network", providers)
    client = TestClient(app)
    response = client.get("/api/providers/search", params={"q": "Iain Jung"})
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["source"] == "SYNTHETIC"
    assert result["agent"]["status"] == "reserved"
    assert result["consult_physician_id"] == "physician-jung"


class MockNppesTransport:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    def search(self, query: str, specialty: str, location: str, limit: int):
        if self.fail:
            raise DirectoryUnavailableError("upstream detail must remain private")
        return ([self._record()], 1)

    def get(self, npi: str):
        if self.fail:
            raise DirectoryUnavailableError("upstream detail must remain private")
        return self._record() if npi == "1234567890" else None

    @staticmethod
    def _record() -> dict:
        return {
            "number": "1234567890",
            "enumeration_type": "NPI-1",
            "basic": {"first_name": "Jane", "last_name": "Smith", "credential": "MD"},
            "taxonomies": [{"primary": True, "code": "207RN0300X", "desc": "Nephrology"}],
            "addresses": [
                {
                    "address_purpose": "LOCATION",
                    "city": "Palo Alto",
                    "state": "CA",
                    "telephone_number": "6505550100",
                }
            ],
        }


def test_live_transport_normalizes_to_reserved_identity(tmp_path: Path) -> None:
    directory = NppesDirectory(None, MockNppesTransport())
    network = ProviderNetwork(directory, WorkflowStore(tmp_path / "workflow.sqlite"))

    response = network.search(query="Jane Smith")

    assert response.directory_backend == "live_api"
    assert response.directory_status == "available"
    assert response.results[0].source == "NPPES"
    assert response.results[0].agent.status == AgentStatus.RESERVED


def test_external_failure_is_explicit_and_never_fabricates_result(tmp_path: Path) -> None:
    directory = NppesDirectory(None, MockNppesTransport(fail=True))
    network = ProviderNetwork(directory, WorkflowStore(tmp_path / "workflow.sqlite"))

    response = network.search(query="A real physician who is not synthetic")

    assert response.results == []
    assert response.directory_status == "unavailable"
    assert response.directory_available is False
    assert response.directory_message == "The NPPES directory is temporarily unavailable"


def test_invalid_and_no_results_are_distinct_directory_states(tmp_path: Path) -> None:
    directory = NppesDirectory(None, MockNppesTransport())
    network = ProviderNetwork(directory, WorkflowStore(tmp_path / "workflow.sqlite"))

    invalid = network.search()
    no_results_directory = NppesDirectory(
        None,
        type(
            "EmptyTransport",
            (),
            {"search": lambda self, *args: ([], 0), "get": lambda self, npi: None},
        )(),
    )
    no_results = ProviderNetwork(
        no_results_directory, WorkflowStore(tmp_path / "empty-workflow.sqlite")
    ).search(query="Nobody Here")

    assert invalid.directory_status == "invalid_query"
    assert no_results.directory_status == "no_results"
