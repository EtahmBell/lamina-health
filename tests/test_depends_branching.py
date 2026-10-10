"""Every structured-choice training question needs a contextual escape hatch that
is a real branch trigger, not decorative UI -- yes/no questions expose
Depends, single-choice questions expose an "It depends on the context" option,
and multi-select questions expose the same option alongside concrete choices.
Selecting any of these must materialize a real follow-up via the existing
branch architecture (backend/engagement.py's is_depends_answer /
deterministic_branch_question), capped at MAX_BRANCH_DEPTH with a short-text
fallback instead of an infinite or forced-binary chain. See
backend/api/engagement.py's answer_training_question.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import engagement as engagement_api
from backend.engagement import DEPENDS_OPTION, MAX_BRANCH_DEPTH
from backend.main import app
from backend.professional_services import ResponsesApiClient, TrainingBranchService
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    # These tests assert exact deterministic-fallback shapes (prompt text,
    # provider, branch depth); force the fallback so a live model API key
    # present in the environment can't make them flaky.
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
        _url(
            f"/api/workspace/physician/training/sessions/{session_id}/responses/{question_id}"
        ),
        json={"answer": answer},
    ).json()


def test_single_choice_depends_equivalent_materializes_a_branch(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        response = _respond(client, session["id"], "iain-upcr-requirement", DEPENDS_OPTION)
    child = response["next_question"]
    assert child is not None, "selecting the Depends-equivalent must produce a real follow-up"
    assert child["parent_question_id"] == "iain-upcr-requirement"
    assert child["branch_depth"] == 1
    assert child["question_type"] == "yes_no_depends"
    assert child["generation_provider"] == "deterministic_fallback"


def test_multi_select_depends_equivalent_coexists_with_concrete_choices_and_branches(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        response = _respond(
            client,
            session["id"],
            "iain-pre-referral-information",
            ["BMP", "UPCR", DEPENDS_OPTION],
        )
    assert response["answer"] == ["BMP", "UPCR", DEPENDS_OPTION]
    child = response["next_question"]
    assert child is not None, "Depends may coexist with concrete multi-select choices and still branch"
    assert child["parent_question_id"] == "iain-pre-referral-information"
    assert child["branch_depth"] == 1


def test_multi_select_without_depends_does_not_branch(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        response = _respond(client, session["id"], "iain-pre-referral-information", ["BMP", "UPCR"])
    assert response["next_question"] is None


def test_branch_chain_stops_at_max_depth_with_a_short_text_fallback_not_a_forced_binary(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        session_id = session["id"]

        first = _respond(client, session_id, "iain-upcr-requirement", DEPENDS_OPTION)
        depth_1 = first["next_question"]
        assert depth_1["branch_depth"] == 1
        assert depth_1["question_type"] == "yes_no_depends"

        second = _respond(client, session_id, depth_1["id"], "Depends")
        depth_2 = second["next_question"]
        assert depth_2["branch_depth"] == 2
        assert depth_2["question_type"] == "yes_no_depends"

        third = _respond(client, session_id, depth_2["id"], "Depends")
        depth_3 = third["next_question"]
        assert depth_3 is not None
        assert depth_3["branch_depth"] == MAX_BRANCH_DEPTH
        assert depth_3["question_type"] == "short_text", (
            "the generic generated chain must fall back to short text at the cap, "
            "not another forced yes/no choice"
        )
        assert depth_3["answer_options"] == []
        assert depth_3["prompt"] == "Tell your agent what this usually depends on."
        assert depth_3["terminal"] is True

        fourth = _respond(
            client,
            session_id,
            depth_3["id"],
            "It mostly comes down to whether nephrology already has a relationship with the patient.",
        )
        assert fourth["next_question"] is None, "the chain must not continue past the branch depth cap"


def test_the_hand_authored_clinical_terminal_branch_is_unchanged(store: WorkflowStore) -> None:
    """The one hand-authored, clinically specific max-depth branch question
    (iain-branch-declining-egfr-normal-upcr) is intentionally left as a
    meaningful binary rather than converted to short text -- it's a precise
    clinical boundary question, not a generic "what does this depend on"
    filler the short-text fallback is meant to replace."""
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        session_id = session["id"]
        _respond(client, session_id, "iain-resistant-htn-normal-kidney", "Depends")
        _respond(client, session_id, "iain-branch-progressive-renal", "Yes")
        leaf = _respond(client, session_id, "iain-branch-proteinuria-absence", "Depends")
        terminal = leaf["next_question"]
    assert terminal["id"] == "iain-branch-declining-egfr-normal-upcr"
    assert terminal["question_type"] == "yes_no"
    assert terminal["answer_options"] == ["Yes", "No"]


def test_quick_progress_excludes_clarifiers_regardless_of_the_top_level_question_type(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        quick = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "quick", "limit": 3},
        ).json()
        session_id = quick["id"]
        top_level = quick["questions"]
        choice_question = next(
            (q for q in top_level if q["question_type"] in {"single_choice", "multi_select"}),
            None,
        )
        assert choice_question is not None, (
            "a quick session should be able to select a single_choice/multi_select "
            "top-level question, not only yes_no_depends"
        )
        answer = (
            [choice_question["answer_options"][0], DEPENDS_OPTION]
            if choice_question["question_type"] == "multi_select"
            else DEPENDS_OPTION
        )

        after_depends = _respond(client, session_id, choice_question["id"], answer)
        assert after_depends["answered_count"] == 1
        clarifier = after_depends["next_question"]
        assert clarifier is not None

        after_clarifier = _respond(client, session_id, clarifier["id"], "Depends")
        assert after_clarifier["answered_count"] == 1, (
            "a branch clarifier must never increment quick top-level progress, "
            "regardless of whether its root question was single_choice/multi_select"
        )
        assert after_clarifier["questions_complete"] is False
