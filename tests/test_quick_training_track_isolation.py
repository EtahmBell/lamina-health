"""Dashboard quick training must be its own session track, isolated from the full
My Agent -> Train flow (daily/extended/initialization/focused) -- see
backend/api/engagement.py's _mode_track/_progress_count. Covers two bugs:
1. the quick modal could resume whatever session happened to be globally active,
   including a full session (e.g. "Question 10 of 25" appearing inside the quick
   modal);
2. a Depends clarifier was counted as a full top-level question, corrupting the
   "N of 3" progress math and the session's actual completion point.
"""

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


def _url(path: str, persona: str = "lucy") -> str:
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}perspective={persona}"


def _init(client: TestClient, store: WorkflowStore, persona: str = "lucy") -> str:
    client.get(_url("/api/workspace/physician/initialization", persona))
    workspace_id = client.cookies.get("lamina_demo_workspace")
    assert workspace_id
    store.mark_initialized(workspace_id, persona)
    return workspace_id


def _answer_for(question: dict) -> str | list[str]:
    if question["question_type"] == "multi_select":
        return [question["answer_options"][0]]
    return question["answer_options"][0]


def _respond(client: TestClient, session_id: int, question_id: str, answer, persona: str = "lucy") -> dict:
    return client.put(
        _url(f"/api/workspace/physician/training/sessions/{session_id}/responses/{question_id}", persona),
        json={"answer": answer},
    ).json()


def test_quick_session_starts_at_a_3_question_target(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _init(client, store)
        quick = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "quick", "limit": 3},
        ).json()
    assert quick["mode"] == "quick"
    assert quick["answer_target"] == 3
    assert len(quick["questions"]) == 3


def test_quick_session_never_resumes_a_full_session_already_in_progress(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _init(client, store)
        full = client.post(_url("/api/workspace/physician/training/sessions")).json()
        assert full["answer_target"] == 10
        _respond(client, full["id"], full["questions"][0]["id"], _answer_for(full["questions"][0]))

        quick = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "quick", "limit": 3},
        ).json()
        assert quick["id"] != full["id"], "quick training must never inherit the full session"
        assert quick["mode"] == "quick"
        assert quick["answer_target"] == 3

        standard_state = client.get(_url("/api/workspace/physician/training/history")).json()
        quick_state = client.get(_url("/api/workspace/physician/training/history?track=quick")).json()
    assert standard_state["active_session_id"] == full["id"]
    assert standard_state["answer_target"] == 10
    assert quick_state["active_session_id"] == quick["id"]
    assert quick_state["answer_target"] == 3


def test_quick_history_track_is_empty_while_only_a_full_session_is_active(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _init(client, store)
        client.post(_url("/api/workspace/physician/training/sessions"))
        quick_state = client.get(_url("/api/workspace/physician/training/history?track=quick")).json()
    assert quick_state["active_session_id"] is None


def test_closing_and_reopening_the_quick_modal_resumes_the_same_quick_session(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _init(client, store)
        started = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "quick", "limit": 3},
        ).json()
        first_question = started["questions"][0]
        _respond(client, started["id"], first_question["id"], _answer_for(first_question))

        reopened = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "quick", "limit": 3},
        ).json()
    assert reopened["id"] == started["id"]
    assert len(reopened["responses"]) == 1
    assert len(reopened["questions"]) == 3, "the remaining top-level question budget must not shrink"


def test_depends_clarifier_does_not_corrupt_quick_session_progress(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _init(client, store)
        quick = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "quick", "limit": 3},
        ).json()
        session_id = quick["id"]
        questions = quick["questions"]
        depends_question = next(q for q in questions if q["question_type"] == "yes_no_depends")
        others = [q for q in questions if q["id"] != depends_question["id"]]

        after_depends = _respond(client, session_id, depends_question["id"], "Depends")
        assert after_depends["answered_count"] == 1, "a top-level Depends answer is Question 1, not 2"
        assert after_depends["questions_complete"] is False
        clarifier = after_depends["next_question"]
        assert clarifier is not None
        assert clarifier["branch_depth"] > 0

        after_clarifier = _respond(client, session_id, clarifier["id"], "Yes")
        assert after_clarifier["answered_count"] == 1, "answering the clarifier must not consume a top-level slot"
        assert after_clarifier["questions_complete"] is False

        after_second = _respond(client, session_id, others[0]["id"], _answer_for(others[0]))
        assert after_second["answered_count"] == 2
        assert after_second["questions_complete"] is False

        after_third = _respond(client, session_id, others[1]["id"], _answer_for(others[1]))
        assert after_third["answered_count"] == 3, "the session finishes after exactly 3 top-level questions"
        assert after_third["questions_complete"] is True


def test_full_train_flow_is_unaffected_by_quick_track_isolation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _init(client, store)
        full = client.post(_url("/api/workspace/physician/training/sessions")).json()
        assert full["mode"] == "daily"
        assert full["answer_target"] == 10
        assert len(full["questions"]) == 10
        for question in full["questions"]:
            result = _respond(client, full["id"], question["id"], _answer_for(question))
        assert result["answered_count"] == 10
        assert result["questions_complete"] is True
