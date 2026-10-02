"""Recorded referral relationships are workspace state, separate from agent activation."""

import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.agents import consult_network
from backend.api import workspace as workspace_api
from backend.main import app
from backend.network_projection import project_agent_network
from backend.provider_network.directory import NppesDirectory
from backend.provider_network.service import ProviderNetwork
from backend.synthetic_data import PATIENTS, PHYSICIANS, PRIMARY_PATIENT_ID
from backend.workflow import WorkflowStore

JUNG_NPI = "9900000001"
WU_NPI = "9900000008"
NPPES_NPI = "1234567890"


def _setup(tmp_path):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    providers = ProviderNetwork(NppesDirectory(tmp_path / "missing-nppes.sqlite"), store)
    return store, providers


def _nppes_providers(path, store):
    with sqlite3.connect(path) as db:
        db.executescript(
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
    return ProviderNetwork(NppesDirectory(path), store)


@pytest.fixture
def client(tmp_path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    providers = ProviderNetwork(NppesDirectory(tmp_path / "missing-nppes.sqlite"), store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "provider_network", providers)
    yield TestClient(app)


def test_adding_a_relationship_is_idempotent_and_removable(tmp_path):
    store, _ = _setup(tmp_path)
    assert store.network_members() == []
    first = store.add_network_member(JUNG_NPI)
    again = store.add_network_member(JUNG_NPI)
    assert first["added_at"] == again["added_at"], "re-adding keeps the original relationship"
    assert [member["npi"] for member in store.network_members()] == [JUNG_NPI]
    assert store.remove_network_member(JUNG_NPI) is True
    assert store.remove_network_member(JUNG_NPI) is False
    assert store.network_members() == []


def test_membership_marks_a_node_without_creating_an_edge(tmp_path):
    store, providers = _setup(tmp_path)
    store.add_network_member(WU_NPI)
    network = project_agent_network(store.history(), providers, store.network_members())
    wu = next(node for node in network["nodes"] if node["npi"] == WU_NPI)
    assert wu["in_network"] is True
    assert wu["relationship"] is None, "a recorded relationship must never fabricate an edge"
    assert wu["status"] == "reserved", "membership must not change activation state"
    assert all(node["relationship"] is None for node in network["nodes"])
    assert network["edges"] == [], "membership must never create an interaction edge"
    assert network["members"] == [], "synthetic roster members stay on their graph node"
    others = [node for node in network["nodes"] if node["npi"] != WU_NPI]
    assert all(node["in_network"] is False for node in others)


def test_added_nppes_physician_appears_without_a_graph_node(tmp_path):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    providers = _nppes_providers(tmp_path / "providers.sqlite", store)
    store.add_network_member(NPPES_NPI)

    network = project_agent_network(store.history(), providers, store.network_members())

    assert len(network["members"]) == 1
    member = network["members"][0]
    assert member["npi"] == NPPES_NPI
    assert member["name"] == "JANE SMITH, MD"
    assert member["specialty"] == "Nephrology Physician"
    assert member["status"] == "reserved"
    assert all(node["npi"] != NPPES_NPI for node in network["nodes"])


def test_membership_does_not_alter_recorded_consultation_edges(tmp_path):
    store, providers = _setup(tmp_path)
    baseline = project_agent_network(store.history(), providers)
    store.add_network_member(WU_NPI)
    after = project_agent_network(store.history(), providers, store.network_members())
    assert [node["relationship"] for node in baseline["nodes"]] == [
        node["relationship"] for node in after["nodes"]
    ]
    store.remove_network_member(WU_NPI)
    removed = project_agent_network(store.history(), providers, store.network_members())
    assert [node["relationship"] for node in baseline["nodes"]] == [
        node["relationship"] for node in removed["nodes"]
    ]


def test_removing_manual_source_keeps_recommended_destination(tmp_path):
    store, providers = _setup(tmp_path)
    record_id = store.completed(consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS))
    store.add_network_member(JUNG_NPI)

    both = project_agent_network(store.history(), providers, store.network_members())
    jung = next(node for node in both["nodes"] if node["npi"] == JUNG_NPI)
    assert jung["in_network"] is True
    assert jung["relationship"]["last_recommendation_record_id"] == record_id

    assert store.remove_network_member(JUNG_NPI) is True
    recommended_only = project_agent_network(store.history(), providers, store.network_members())
    jung = next(node for node in recommended_only["nodes"] if node["npi"] == JUNG_NPI)
    assert jung["in_network"] is False
    assert jung["relationship"]["recommended_count"] == 1


def test_membership_leaves_recommendation_output_and_activation_unchanged(tmp_path):
    store, providers = _setup(tmp_path)
    before = consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS)
    initial_status = providers.get(WU_NPI).agent.status

    store.add_network_member(WU_NPI)
    after_add = consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS)
    store.remove_network_member(WU_NPI)
    after_remove = consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS)

    assert before.recommended_physician == after_add.recommended_physician
    assert before.recommended_physician == after_remove.recommended_physician
    assert providers.get(WU_NPI).agent.status == initial_status


def test_an_unresolvable_directory_record_is_reported_not_invented(tmp_path):
    store, providers = _setup(tmp_path)
    store.add_network_member("1234567893")
    network = project_agent_network(store.history(), providers, store.network_members())
    member = network["members"][0]
    assert member["resolved"] is False
    assert member["status"] is None, "no activation state may be assumed for an unknown record"
    assert member["specialty"] == "Specialty unavailable"


def test_network_member_endpoints_round_trip(client: TestClient):
    assert client.get("/api/workspace/network/members").json() == []

    created = client.post("/api/workspace/network/members", json={"npi": JUNG_NPI})
    assert created.status_code == 201
    assert created.json()["npi"] == JUNG_NPI

    repeat = client.post("/api/workspace/network/members", json={"npi": JUNG_NPI})
    assert repeat.status_code == 201
    assert repeat.json()["added_at"] == created.json()["added_at"]
    assert len(client.get("/api/workspace/network/members").json()) == 1

    network = client.get("/api/workspace/network").json()
    jung = next(node for node in network["nodes"] if node["npi"] == JUNG_NPI)
    assert jung["in_network"] is True
    assert jung["status"] == "reserved"
    assert jung["relationship"] is None

    assert client.delete(f"/api/workspace/network/members/{JUNG_NPI}").status_code == 204
    assert client.delete(f"/api/workspace/network/members/{JUNG_NPI}").status_code == 404
    assert client.get("/api/workspace/network/members").json() == []


def test_unknown_physician_cannot_be_added(client: TestClient):
    assert client.post("/api/workspace/network/members", json={"npi": "0000000000"}).status_code == 404
    assert client.post("/api/workspace/network/members", json={"npi": "not-an-npi"}).status_code == 422
    assert client.get("/api/workspace/network/members").json() == []
