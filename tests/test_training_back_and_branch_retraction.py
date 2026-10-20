"""Pre-NLP physician-representation cleanup pass, Part R-T: training cards
support going back and revising an answer. The backend-side half of that
is this file's focus -- re-answering a question must never create a
duplicate response (the existing save_training_response upsert already
guarantees this) and must retract any branch question the OLD answer
previously triggered, so a changed answer never leaves a stale/conflicting
follow-up response finalized alongside the new one."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import engagement as engagement_api
from backend.engagement import DEPENDS_OPTION
from backend.main import app
from backend.professional_services import ResponsesApiClient, TrainingBranchService
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    monkeypatch.setattr(
        engagement_api,
        "training_branch_service",
        TrainingBranchService(ResponsesApiClient(enabled=False)),
    )
    return value


def _url(path: str, persona: str = "iain") -> str:
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}perspective={persona}"


def _respond(client: TestClient, session_id: int, question_id: str, answer) -> dict:
    return client.put(
        _url(f"/api/workspace/physician/training/sessions/{session_id}/responses/{question_id}"),
        json={"answer": answer},
    ).json()


def test_reanswering_the_same_question_updates_in_place_never_duplicates(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        _respond(client, session["id"], "iain-upcr-requirement", "Preferred")
        _respond(client, session["id"], "iain-upcr-requirement", "Required")
        responses = client.get(_url(f"/api/workspace/physician/training/sessions/{session['id']}")).json()["responses"]
    matching = [item for item in responses if item["question_id"] == "iain-upcr-requirement"]
    assert len(matching) == 1, "re-answering must update the existing response, never append a duplicate"
    assert matching[0]["answer"] == "Required"


def test_changing_an_answer_away_from_depends_retracts_the_now_stale_branch_and_its_response(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        first = _respond(client, session["id"], "iain-upcr-requirement", DEPENDS_OPTION)
        branch_id = first["next_question"]["id"]
        assert branch_id is not None
        # Answer the branch too, simulating a physician who continued forward.
        _respond(client, session["id"], branch_id, "Yes")

        # Now go back (the frontend's Back affordance) and change the
        # original answer to something that no longer triggers that branch.
        second = _respond(client, session["id"], "iain-upcr-requirement", "Required")

        detail = client.get(_url(f"/api/workspace/physician/training/sessions/{session['id']}")).json()
        responses = detail["responses"]
        assigned_ids = {item["id"] for item in detail["questions"]}

    assert second["next_question"] is None, "the new answer no longer triggers a branch"
    assert branch_id not in assigned_ids, "the stale branch question is no longer assigned to the session"
    assert all(item["question_id"] != branch_id for item in responses), (
        "the stale branch's own response must be retracted, never finalized alongside the new answer"
    )


def test_changing_an_answer_to_a_different_depends_equivalent_still_retriggers_a_fresh_branch(
    store: WorkflowStore,
) -> None:
    """Re-selecting Depends after already having a (now-stale) Depends
    branch assigned must not be silently suppressed by the branch id still
    sitting in assigned_ids from the first answer."""
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        first = _respond(client, session["id"], "iain-upcr-requirement", DEPENDS_OPTION)
        first_branch_id = first["next_question"]["id"]
        _respond(client, session["id"], "iain-upcr-requirement", "Required")
        second = _respond(client, session["id"], "iain-upcr-requirement", DEPENDS_OPTION)

    assert second["next_question"] is not None, "re-selecting Depends must retrigger a real branch, not be swallowed"
    assert second["next_question"]["id"] == first_branch_id, "the deterministic branch for this question is stable"
