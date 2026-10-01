"""Recorded referral relationships are workspace state, separate from agent activation."""

import pytest
from fastapi.testclient import TestClient

from backend.api import workspace as workspace_api
from backend.main import app
from backend.network_projection import project_agent_network
from backend.provider_network import provider_network
from backend.provider_network.directory import NppesDirectory
from backend.provider_network.service import ProviderNetwork
from backend.workflow import WorkflowStore

JUNG_NPI = "9900000001"
WU_NPI = "9900000008"


def _setup(tmp_path):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    providers = ProviderNetwork(NppesDirectory(tmp_path / "missing-nppes.sqlite"))
    return store, providers


@pytest.fixture
def client(tmp_path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    provider_network.reset_demo_state()
    yield TestClient(app)
    provider_network.reset_demo_state()


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
    assert network["members"] == [], "synthetic roster members stay on their graph node"
    others = [node for node in network["nodes"] if node["npi"] != WU_NPI]
    assert all(node["in_network"] is False for node in others)


def test_membership_does_not_alter_recorded_consultation_edges(tmp_path):
    store, providers = _setup(tmp_path)
    baseline = project_agent_network(store.history(), providers)
    store.add_network_member(WU_NPI)
    after = project_agent_network(store.history(), providers, store.network_members())
    assert [node["relationship"] for node in baseline["nodes"]] == [
        node["relationship"] for node in after["nodes"]
    ]


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
