from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import engagement as engagement_api
from backend.main import app
from backend.professional_services import AgentChatService, ResponsesApiClient
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    return value


def _url(path: str, persona: str = "iain") -> str:
    return f"{path}?perspective={persona}"


def _answer(question: dict, preferred: str = "Yes") -> str | list[str]:
    if question["question_type"] == "multi_select":
        return [question["answer_options"][0]]
    if preferred in question["answer_options"]:
        return preferred
    return question["answer_options"][0]


def _complete_questions(
    client: TestClient,
    session: dict,
    answers: list[str] | None = None,
    persona: str = "iain",
):
    last = None
    for index, question in enumerate(session["questions"]):
        preferred = answers[index] if answers and index < len(answers) else "Yes"
        last = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                f"/responses/{question['id']}",
                persona,
            ),
            json={"answer": _answer(question, preferred)},
        ).json()
        if last.get("questions_complete"):
            break
    return last


def test_ten_answer_budget_defers_tenth_depends_and_prioritizes_next_session(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        assert session["answer_target"] == 10
        assert len(session["questions"]) == 10

        ternary_last = next(
            item
            for item in reversed(session["questions"])
            if item["question_type"] == "yes_no_depends"
        )
        first_nine = [item for item in session["questions"] if item["id"] != ternary_last["id"]][
            :9
        ]
        progress = []
        for question in first_nine:
            result = client.put(
                _url(
                    f"/api/workspace/physician/training/sessions/{session['id']}"
                    f"/responses/{question['id']}"
                ),
                json={"answer": _answer(question)},
            ).json()
            progress.append(result["answered_count"])
            assert result["answer_target"] == 10
            assert result["questions_complete"] is False

        tenth = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                f"/responses/{ternary_last['id']}"
            ),
            json={"answer": "Depends"},
        ).json()
        assert progress == list(range(1, 10))
        assert tenth["answered_count"] == 10
        assert tenth["questions_complete"] is True
        assert tenth["next_question"] is None
        assert tenth["deferred_branch"] is not None
        assert tenth["completion_summary"]["unresolved_question_count"] == 1

        next_session = client.post(
            _url("/api/workspace/physician/training/sessions")
        ).json()
        assert next_session["id"] != session["id"]
        assert next_session["questions"][0]["id"] == tenth["deferred_branch"]["id"]
        assert next_session["answer_target"] == 10

        history = client.get(_url("/api/workspace/physician/training/history")).json()
        previous = next(
            item for item in history["recent_training_history"] if item["session_id"] == session["id"]
        )
        assert previous["answered_count"] == 10
        assert previous["target_count"] == 10
        assert previous["deferred_branch_count"] == 1


def test_learning_review_lifecycle_and_practice_truth(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        session = client.post(
            _url("/api/workspace/physician/training/sessions"),
            json={"mode": "daily"},
        ).json()
        final = _complete_questions(client, session)
        assert final["questions_complete"] is True
        finished = client.post(
            _url(f"/api/workspace/physician/training/sessions/{session['id']}/finish")
        ).json()
        assert finished["lifecycle_state"] == "questions_complete"
        assert finished["completion_summary"]["proposed_learning_count"] == 10
        first, second, *remaining = finished["proposed_learnings"]

        confirmed = client.put(
            _url(f"/api/workspace/physician/training/learnings/{first['id']}"),
            json={"action": "confirm"},
        ).json()
        assert confirmed["session"] is None
        rejected = client.put(
            _url(f"/api/workspace/physician/training/learnings/{second['id']}"),
            json={"action": "reject"},
        ).json()
        for learning in remaining:
            rejected = client.put(
                _url(f"/api/workspace/physician/training/learnings/{learning['id']}"),
                json={"action": "reject"},
            ).json()
        assert rejected["session"]["lifecycle_state"] == "review_complete"

        practice = client.get(
            _url("/api/workspace/physician/agent-representation")
        ).json()
        confirmed_statements = {
            item["statement"] for item in practice["sections"]["confirmed_learnings"]
        }
        assert first["statement"] in confirmed_statements
        assert second["statement"] not in confirmed_statements

        history = client.get(_url("/api/workspace/physician/training/history")).json()[
            "recent_training_history"
        ][0]
        assert history["confirmed_count"] == 1
        assert history["rejected_count"] == 9


def test_initialization_is_persisted_once_and_reset_deliberately_clears_it(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        before = client.get(_url("/api/workspace/physician/initialization", "lucy")).json()
        assert before["status"] == "in_progress"
        assert before["initialized"] is False
        assert len(before["completed_steps"]) == 3

        session = client.post(
            _url("/api/workspace/physician/training/sessions", "lucy"),
            json={"mode": "initialization"},
        ).json()
        _complete_questions(client, session, persona="lucy")
        initialized = client.get(
            _url("/api/workspace/physician/initialization", "lucy")
        ).json()
        assert initialized["status"] == "initialized"
        assert initialized["initialized_at"] is not None

        client.put(
            _url("/api/workspace/physician/profile/items/lucy-optional-teaching", "lucy"),
            json={
                "category": "teaching",
                "title": "Optional teaching item",
                "shareable": False,
            },
        )
        still_initialized = client.get(
            _url("/api/workspace/physician/initialization", "lucy")
        ).json()
        assert still_initialized["initialized"] is True
        assert still_initialized["initialized_at"] == initialized["initialized_at"]

        reset = client.post(_url("/api/workspace/physician/training/reset", "lucy")).json()
        assert reset["deleted"]["initialization"] == 1
        after_reset = client.get(
            _url("/api/workspace/physician/initialization", "lucy")
        ).json()
        assert after_reset["initialized"] is False
        assert any(
            item["title"] == "Optional teaching item"
            for item in client.get(_url("/api/workspace/physician/profile", "lucy")).json()[
                "items"
            ]
        )


def test_agent_overview_portraits_and_stats_exclude_unconfirmed_truth(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        lucy = client.get(_url("/api/workspace/physician/agent-overview", "lucy")).json()
        iain = client.get(_url("/api/workspace/physician/agent-overview", "iain")).json()

    assert lucy["portrait"] == (
        "Primary care physician in Oakland focused on coordinating specialty care. "
        "Your agent understands that progressive renal dysfunction often shifts "
        "resistant-hypertension referrals toward nephrology and that persistent iron "
        "deficiency without source evaluation generally starts with gastroenterology."
    )
    assert iain["portrait"] == (
        "Nephrologist in Oakland with interests in proteinuric CKD, cardiorenal disease, "
        "and difficult-to-control blood pressure in CKD. Your agent understands your "
        "preferred CKD workup and the situations that make resistant hypertension a good "
        "fit for your practice."
    )
    assert iain["stats"]["case_interests_count"] == 4
    assert iain["stats"]["questions_answered_total"] == 0
    assert iain["stats"]["network_cases_count"] == 0
    assert iain["ranking_effect"] == "none"
    assert not any("score" in key for key in iain["stats"])


def test_practice_chat_uncertainty_and_synthetic_cases_are_side_effect_free(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        cases = client.get(_url("/api/workspace/physician/agent-test-cases", "lucy")).json()
        assert len(cases) == 4
        assert all("correction_prompt" not in item for item in cases)

        interests = client.post(
            _url("/api/workspace/physician/agent-chat", "iain"),
            json={"mode": "practice_question", "message": "What kinds of cases am I interested in?"},
        ).json()
        assert "Proteinuric CKD" in interests["answer"]
        assert interests["provider"] == "deterministic_fallback"

        uncertain = client.post(
            _url("/api/workspace/physician/agent-chat", "lucy"),
            json={"mode": "practice_question", "message": "Do I prefer morning procedures?"},
        ).json()
        assert uncertain["coverage"] == "uncertain"
        assert uncertain["uncertainty"]

        workspace_id = client.cookies.get("lamina_demo_workspace")
        assert workspace_id
        before_history = store.history(workspace_id)
        before_members = store.network_members(workspace_id)
        synthetic = client.post(
            _url("/api/workspace/physician/agent-chat", "lucy"),
            json={
                "mode": "synthetic_case",
                "origin": "synthetic_demo",
                "controlled_test_case_id": "lucy-test-progressive-ckd",
                "message": "Where would I refer?",
            },
        ).json()
        assert "nephrology" in synthetic["answer"].casefold()
        assert store.history(workspace_id) == before_history
        assert store.network_members(workspace_id) == before_members

        rejected = client.post(
            _url("/api/workspace/physician/agent-chat", "lucy"),
            json={
                "mode": "synthetic_case",
                "origin": "real_patient",
                "controlled_test_case_id": "lucy-test-progressive-ckd",
                "message": "Review this real patient",
            },
        )
        assert rejected.status_code == 422


def test_not_quite_starts_same_training_engine_and_updates_practice(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        chat = client.post(
            _url("/api/workspace/physician/agent-chat", "iain"),
            json={
                "mode": "synthetic_case",
                "origin": "synthetic_demo",
                "controlled_test_case_id": "iain-test-normal-renal-function",
                "message": "Does this fit my practice?",
            },
        ).json()
        feedback = client.post(
            _url(
                f"/api/workspace/physician/agent-chat/{chat['response_id']}/feedback",
                "iain",
            ),
            json={"feedback": "not_quite"},
        ).json()
        seed = feedback["focused_training_seed"]
        assert seed["question"]["question_type"] == "yes_no_depends"

        focused = client.post(
            _url("/api/workspace/physician/training/focused", "iain"),
            json={"seed_id": seed["seed_id"]},
        ).json()
        first = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{focused['id']}"
                f"/responses/{focused['questions'][0]['id']}",
                "iain",
            ),
            json={"answer": "Depends"},
        ).json()
        assert first["questions_complete"] is False
        assert first["next_question"] is not None
        resolved = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{focused['id']}"
                f"/responses/{first['next_question']['id']}",
                "iain",
            ),
            json={"answer": "Yes"},
        ).json()
        assert resolved["questions_complete"] is True

        finished = client.post(
            _url(
                f"/api/workspace/physician/training/sessions/{focused['id']}/finish",
                "iain",
            )
        ).json()
        assert finished["completion_summary"]["answered_count"] == 2
        assert finished["completion_summary"]["target_count"] == 10
        learning = finished["proposed_learnings"][0]
        client.put(
            _url(f"/api/workspace/physician/training/learnings/{learning['id']}", "iain"),
            json={"action": "confirm"},
        )
        practice = client.get(
            _url("/api/workspace/physician/agent-representation", "iain")
        ).json()
        assert learning["statement"] in {
            item["statement"] for item in practice["sections"]["confirmed_learnings"]
        }


class _FakeResponses:
    def __init__(self, payload: dict):
        self.payload = payload
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(output_text=json.dumps(self.payload))


def test_agent_chat_responses_structured_output_and_fallback() -> None:
    payload = {
        "answer": "Your confirmed interests include proteinuric CKD.",
        "evidence_summary": ["Proteinuric CKD"],
        "based_on": ["interest:iain-case-interest-2"],
        "coverage": "confirmed_representation",
        "uncertainty": None,
        "can_train_from_this": False,
    }
    responses = _FakeResponses(payload)
    client = ResponsesApiClient(
        SimpleNamespace(responses=responses), enabled=True, model="test-model"
    )
    result, provider = AgentChatService(client).respond(
        {
            "allowed_references": ["interest:iain-case-interest-2"],
            "message": "What cases interest me?",
            "confirmed_representation": {"interests": ["Proteinuric CKD"]},
        },
        {**payload, "answer": "Fallback"},
    )
    assert provider == "responses_api"
    assert result["answer"].startswith("Your confirmed")
    assert responses.calls[0]["text"]["format"]["name"] == "lamina_agent_chat"

    invalid = _FakeResponses({**payload, "based_on": ["invented:rule"]})
    fallback, fallback_provider = AgentChatService(
        ResponsesApiClient(
            SimpleNamespace(responses=invalid), enabled=True, model="test-model"
        )
    ).respond(
        {"allowed_references": [], "message": "Unknown"},
        {**payload, "answer": "I do not know.", "based_on": [], "coverage": "uncertain", "uncertainty": "No confirmed rule."},
    )
    assert fallback_provider == "deterministic_fallback"
    assert fallback["answer"] == "I do not know."
