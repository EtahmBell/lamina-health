import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.provider_network.api import provider_network
from backend.provider_network.directory import NppesDirectory
from backend.provider_network.models import AgentPreferencesInput, AgentStatus
from backend.provider_network.service import (
    DemoVerificationForbiddenError,
    ProviderNetwork,
)
from backend.synthetic_data import SYNTHETIC_PHYSICIAN_NPIS


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
    network = ProviderNetwork(build_directory(tmp_path / "providers.sqlite"))
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
    network = ProviderNetwork(build_directory(tmp_path / "providers.sqlite"))
    claimed = network.claim("1234567890")
    assert claimed.agent.status == AgentStatus.VERIFICATION_PENDING
    with pytest.raises(DemoVerificationForbiddenError):
        network.verify_demo("1234567890")


def test_synthetic_profile_completes_structured_activation() -> None:
    network = ProviderNetwork(NppesDirectory(Path("missing.sqlite")))
    npi = SYNTHETIC_PHYSICIAN_NPIS["physician-jung"]

    assert network.claim(npi).agent.status == AgentStatus.VERIFICATION_PENDING
    assert network.verify_demo(npi).agent.status == AgentStatus.VERIFIED
    configured = network.configure(
        npi,
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
    assert network.activate(npi).agent.status == AgentStatus.ACTIVE


def test_provider_api_search_and_status() -> None:
    provider_network.reset_demo_state()
    client = TestClient(app)
    response = client.get("/api/providers/search", params={"q": "Mina Jung"})
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["source"] == "SYNTHETIC"
    assert result["agent"]["status"] == "reserved"
    assert result["consult_physician_id"] == "physician-jung"
