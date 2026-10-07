from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import engagement as engagement_api
from backend.main import app
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    return value


def _url(path: str, persona: str = "iain") -> str:
    return f"{path}?perspective={persona}"


def _workspace(client: TestClient, store: WorkflowStore, persona: str = "iain") -> str:
    client.get(_url("/api/workspace/physician/initialization", persona))
    workspace_id = client.cookies.get("lamina_demo_workspace")
    assert workspace_id
    store.mark_initialized(workspace_id, persona)
    return workspace_id


def _answer(question: dict) -> str | list[str]:
    if question["question_type"] == "multi_select":
        return [question["answer_options"][0]]
    if "Yes" in question["answer_options"]:
        return "Yes"
    return question["answer_options"][0]


def _projection(client: TestClient, persona: str = "iain") -> dict:
    return client.get(_url("/api/workspace/physician/training/history", persona)).json()


def test_zero_answer_session_is_canonical_and_start_is_idempotent(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _workspace(client, store)
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        state = _projection(client)
        overview = client.get(_url("/api/workspace/physician/agent-overview")).json()
        repeated = client.post(_url("/api/workspace/physician/training/sessions")).json()
        resumed = client.get(
            _url(f"/api/workspace/physician/training/sessions/{session['id']}")
        ).json()

    assert state["state"] == "active_unstarted"
    assert state["action"] == "start_training"
    assert state["answered_count"] == 0
    assert state["answer_target"] == 10
    assert overview["training"] == state
    assert overview["next_action"] == "start_training"
    assert repeated["id"] == session["id"]
    assert resumed["questions"]


def test_partial_then_review_then_ready_uses_one_state_machine(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _workspace(client, store)
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        for question in session["questions"][:4]:
            client.put(
                _url(
                    f"/api/workspace/physician/training/sessions/{session['id']}"
                    f"/responses/{question['id']}"
                ),
                json={"answer": _answer(question)},
            )
        partial = _projection(client)
        assert partial["state"] == "active_in_progress"
        assert partial["action"] == "resume_training"
        assert partial["answered_count"] == 4
        assert partial["answer_target"] == 10

        for question in session["questions"][4:]:
            client.put(
                _url(
                    f"/api/workspace/physician/training/sessions/{session['id']}"
                    f"/responses/{question['id']}"
                ),
                json={"answer": _answer(question)},
            )
        review = _projection(client)
        assert review["state"] == "review_pending"
        assert review["action"] == "review_training"
        assert review["review_session_id"] == session["id"]

        finished = client.post(
            _url(f"/api/workspace/physician/training/sessions/{session['id']}/finish")
        ).json()
        for learning in finished["proposed_learnings"]:
            client.put(
                _url(f"/api/workspace/physician/training/learnings/{learning['id']}"),
                json={"action": "confirm"},
            )
        ready = _projection(client)
        assert ready["state"] == "ready"
        assert ready["action"] == "start_training"
        assert ready["more_training_available"] is True

        next_session = client.post(
            _url("/api/workspace/physician/training/sessions")
        ).json()
        assert next_session["id"] != session["id"]
        assert next_session["answer_target"] == 10


def test_caught_up_comes_only_from_canonical_planner(
    store: WorkflowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    with TestClient(app) as client:
        _workspace(client, store)

        def no_availability(questions: list[dict], responses: list[dict]) -> dict:
            del questions, responses
            return {
                "recommended_today": 0,
                "unanswered_total": 0,
                "available_total": 0,
                "answered_today": 0,
                "daily_limit": 10,
                "extended_limit": 25,
                "availability_model": "lazy_grounded_sources",
            }

        monkeypatch.setattr(engagement_api, "training_queue_summary", no_availability)
        state = _projection(client)

    assert state["state"] == "caught_up"
    assert state["action"] == "none"
    assert state["active_session_id"] is None
    assert state["review_pending"] is False


def test_legacy_unstarted_target_is_normalized_but_partial_target_is_preserved(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as unstarted_client:
        workspace_id = _workspace(unstarted_client, store)
        legacy = store.start_training_session(workspace_id, "iain", "extended", 15)
        for question in engagement_api._questions(workspace_id, "iain")[:15]:
            store.assign_training_question(
                workspace_id, "iain", legacy["id"], question, question["priority"]
            )
        normalized = _projection(unstarted_client)

    assert normalized["state"] == "active_unstarted"
    assert normalized["answer_target"] == 10
    assert normalized["current_session"]["answer_target"] == 10

    with TestClient(app) as partial_client:
        workspace_id = _workspace(partial_client, store)
        legacy = store.start_training_session(workspace_id, "iain", "extended", 15)
        questions = engagement_api._questions(workspace_id, "iain")[:15]
        for question in questions:
            store.assign_training_question(
                workspace_id, "iain", legacy["id"], question, question["priority"]
            )
        for question in questions[:3]:
            store.save_training_response(
                workspace_id, "iain", legacy["id"], question["id"], "Yes", False
            )
        preserved = _projection(partial_client)

    assert preserved["state"] == "active_in_progress"
    assert preserved["action"] == "resume_training"
    assert preserved["answered_count"] == 3
    assert preserved["answer_target"] == 15


def test_initialization_state_precedes_normal_training_state(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        before = _projection(client, "lucy")
        assert before["state"] == "initialization_needed"
        assert before["action"] == "continue_setup"
        session = client.post(
            _url("/api/workspace/physician/training/sessions", "lucy"),
            json={"mode": "initialization", "limit": 25},
        ).json()
        assert session["answer_target"] == 10
        for question in session["questions"]:
            client.put(
                _url(
                    f"/api/workspace/physician/training/sessions/{session['id']}"
                    f"/responses/{question['id']}",
                    "lucy",
                ),
                json={"answer": _answer(question)},
            )
        after = _projection(client, "lucy")

    assert after["initialized"] is True
    assert after["initialization_required"] is False
    assert after["state"] == "review_pending"
