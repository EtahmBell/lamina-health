"""Network relationships come from completed Lamina records, never decorative links."""

from fastapi.testclient import TestClient

from backend.agents import consult_network
from backend.api import workspace as workspace_api
from backend.main import app
from backend.network_projection import project_agent_network
from backend.provider_network.directory import NppesDirectory
from backend.provider_network.models import AgentPreferencesInput
from backend.provider_network.service import ProviderNetwork
from backend.synthetic_data import (
    MARIA_PATIENT_ID,
    MARIA_PHYSICIANS,
    PATIENTS,
    PHYSICIANS,
    PRIMARY_PATIENT_ID,
)
from backend.workflow import WorkflowStore


def _setup(tmp_path):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    providers = ProviderNetwork(NppesDirectory(tmp_path / "missing-nppes.sqlite"))
    return store, providers


def test_network_starts_with_center_and_no_invented_relationships(tmp_path):
    store, providers = _setup(tmp_path)
    network = project_agent_network(store.history(), providers)
    assert network["center"]["name"] == "Dr. Lucy Saru's Agent"
    assert network["center"]["status"] == "active"
    assert network["record_count"] == 0
    assert all(node["relationship"] is None for node in network["nodes"])
    jung = next(node for node in network["nodes"] if node["physician_id"] == "physician-jung")
    assert jung["status"] == "reserved"
    assert "not physician-confirmed" in jung["provenance"]
    cha = next(node for node in network["nodes"] if node["physician_id"] == "physician-cha")
    assert cha["name"] == "Dr. Lianne Cha"
    assert cha["specialty"] == "Primary Care"
    assert cha["relationship"] is None


def test_jordan_and_maria_consults_project_real_edges_and_records(tmp_path, monkeypatch):
    store, providers = _setup(tmp_path)
    jordan_id = store.completed(consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS))
    maria_id = store.completed(consult_network(PATIENTS[MARIA_PATIENT_ID], MARIA_PHYSICIANS))
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "provider_network", providers)

    response = TestClient(app).get("/api/workspace/network")
    assert response.status_code == 200
    network = response.json()
    assert network["record_count"] == 2
    nodes = {node["physician_id"]: node for node in network["nodes"]}
    jung = nodes["physician-jung"]
    assert jung["name"] == "Dr. Iain Jung"
    assert jung["relationship"]["relationship_type"] == "recommended"
    assert jung["relationship"]["last_patient_name"] == "Jordan Lee"
    assert jung["relationship"]["associated_consultation_ids"] == [jordan_id]
    assert jung["relationship"]["last_record_id"] == jordan_id
    assert jung["status"] == "reserved"  # Consult demo participation is not activation.

    alvarez = nodes["physician-alvarez"]
    assert alvarez["relationship"]["last_patient_name"] == "Maria Santos"
    assert alvarez["relationship"]["associated_consultation_ids"] == [maria_id]
    assert alvarez["relationship"]["recommended_count"] == 1
    assert nodes["physician-rossi"]["relationship"]["relationship_type"] == "redirected"
    assert nodes["physician-patel"]["specialty"] == "Cardiology"
    assert nodes["physician-patel"]["name"] == "Dr. Celeste Bell"


def test_activation_state_is_read_from_existing_overlay(tmp_path):
    store, providers = _setup(tmp_path)
    npi = "9900000001"
    assert providers.get(npi).agent.status.value == "reserved"
    providers.claim(npi)
    claimed = project_agent_network(store.history(), providers)
    assert next(node for node in claimed["nodes"] if node["npi"] == npi)["status"] == "verification_pending"
    providers.verify_demo(npi)
    verified = project_agent_network(store.history(), providers)
    assert next(node for node in verified["nodes"] if node["npi"] == npi)["status"] == "verified"
    providers.configure(npi, AgentPreferencesInput(
        practice_confirmed=True,
        areas_of_focus=["Progressive CKD"],
        preferred_pre_referral_workup=["BMP", "UPCR"],
    ))
    providers.activate(npi)
    active = project_agent_network(store.history(), providers)
    jung = next(node for node in active["nodes"] if node["npi"] == npi)
    assert jung["status"] == "active"
    assert jung["confirmed_preferences"]["areas_of_focus"] == ["Progressive CKD"]
    assert "Physician-confirmed" in jung["provenance"]
