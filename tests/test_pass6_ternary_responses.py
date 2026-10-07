from __future__ import annotations

import json
from collections import Counter
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import engagement as engagement_api
from backend.engagement import (
    INITIALIZATION_QUESTIONS,
    TRAINING_QUESTIONS,
    generated_training_questions,
)
from backend.main import app
from backend.professional_services import (
    PostDraftService,
    ProfileEnrichmentService,
    ResponsesApiClient,
    TrainingBranchService,
)
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    return value


def _url(path: str, persona: str = "iain") -> str:
    return f"{path}?perspective={persona}"


def _answer_for(question: dict) -> str | list[str]:
    if question["question_type"] == "multi_select":
        return [question["answer_options"][0]]
    if question["question_type"] == "short_text":
        return "Optional nuance"
    return question["answer_options"][0]


def test_routine_questions_are_predominantly_ternary_and_do_not_require_typing() -> None:
    for persona_id in ("iain", "lucy"):
        routine = [
            *TRAINING_QUESTIONS[persona_id],
            *INITIALIZATION_QUESTIONS[persona_id],
            *list(generated_training_questions(persona_id)),
        ]
        counts = Counter(item["question_type"] for item in routine)
        assert counts["yes_no_depends"] / len(routine) > 0.85
        assert counts["short_text"] == 0
        assert counts["multi_select"] > 0


def test_yes_no_finish_directly_and_depends_materializes_a_child(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        direct = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                "/responses/iain-jordan-fit"
            ),
            json={"answer": "Yes"},
        ).json()
        assert direct["next_question"] is None

        bank_question = next(
            item for item in session["questions"] if item["source_type"] == "practice_gap"
        )
        branched = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                f"/responses/{bank_question['id']}"
            ),
            json={"answer": "Depends"},
        ).json()
        assert branched["next_question"]["question_type"] == "yes_no_depends"
        assert branched["next_question"]["generation_provider"] == "deterministic_fallback"

        resumed = client.get(
            _url(f"/api/workspace/physician/training/sessions/{session['id']}")
        ).json()
        assert branched["next_question"]["id"] in {item["id"] for item in resumed["questions"]}


def test_daily_then_multiple_extended_batches_need_no_reset(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        daily = client.post(_url("/api/workspace/physician/training/sessions")).json()
        assert len(daily["questions"]) == 10
        for question in daily["questions"]:
            client.put(
                _url(
                    f"/api/workspace/physician/training/sessions/{daily['id']}"
                    f"/responses/{question['id']}"
                ),
                json={"answer": _answer_for(question)},
            )
        client.post(_url(f"/api/workspace/physician/training/sessions/{daily['id']}/finish"))
        assert (
            client.get(_url("/api/workspace/physician/training")).json()["queue_summary"][
                "available_total"
            ]
            > 0
        )

        seen: set[str] = set()
        for _ in range(3):
            session = client.post(
                _url("/api/workspace/physician/training/sessions"),
                json={"mode": "extended", "limit": 12},
            ).json()
            assert len(session["questions"]) == 10
            ids = {item["id"] for item in session["questions"]}
            assert not ids.intersection(seen)
            seen.update(ids)
            for question in session["questions"]:
                client.put(
                    _url(
                        f"/api/workspace/physician/training/sessions/{session['id']}"
                        f"/responses/{question['id']}"
                    ),
                    json={"answer": _answer_for(question)},
                )
            client.post(_url(f"/api/workspace/physician/training/sessions/{session['id']}/finish"))
        assert len(seen) == 30


def test_training_reset_is_persona_and_workspace_scoped(store: WorkflowStore) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        visitor_a.post(
            _url("/api/workspace/physician/interests"),
            json={"interest_type": "case_interest", "title": "Keep this interest"},
        )
        post = visitor_a.post(
            _url("/api/workspace/physician/posts"),
            json={"type": "professional_update", "title": "Keep", "body": "Keep post"},
        ).json()
        session = visitor_a.post(_url("/api/workspace/physician/training/sessions")).json()
        bank_question = next(
            item for item in session["questions"] if item["source_type"] == "practice_gap"
        )
        visitor_a.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                f"/responses/{bank_question['id']}"
            ),
            json={"answer": "Depends"},
        )
        visitor_a.post(_url(f"/api/workspace/physician/training/sessions/{session['id']}/finish"))

        visitor_b_session = visitor_b.post(
            _url("/api/workspace/physician/training/sessions")
        ).json()
        reset = visitor_a.post(_url("/api/workspace/physician/training/reset")).json()

        assert reset["deleted"]["sessions"] == 1
        assert reset["deleted"]["generated_questions"] == 1
        assert reset["proposed_learnings"] == []
        assert all(item["status"] == "unanswered" for item in reset["questions"])
        assert any(
            item["title"] == "Keep this interest"
            for item in visitor_a.get(_url("/api/workspace/physician/interests")).json()
        )
        assert any(
            item["id"] == post["id"]
            for item in visitor_a.get(_url("/api/workspace/physician/posts")).json()
        )
        assert (
            visitor_b.get(
                _url(f"/api/workspace/physician/training/sessions/{visitor_b_session['id']}")
            ).status_code
            == 200
        )


class _FakeResponses:
    def __init__(self, payload: dict):
        self.payload = payload
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(output_text=json.dumps(self.payload))


def _client(payload: dict) -> tuple[ResponsesApiClient, _FakeResponses]:
    responses = _FakeResponses(payload)
    sdk = SimpleNamespace(responses=responses)
    return ResponsesApiClient(sdk, enabled=True, model="test-model"), responses


def test_profile_enrichment_uses_web_search_and_preserves_sources() -> None:
    client, responses = _client(
        {
            "candidates": [
                {
                    "category": "teaching",
                    "proposed_title": "Faculty appointment",
                    "proposed_detail": "Public professional listing.",
                    "source_title": "Institution profile",
                    "source_url": "https://example.edu/physician",
                    "identity_confidence": "high",
                }
            ]
        }
    )
    candidates = ProfileEnrichmentService(client).public_candidates(
        {
            "full_name": "Demo Physician",
            "npi": "1234567890",
            "specialty": "Nephrology",
            "geography": "Oakland, CA",
        }
    )
    assert candidates[0]["source_url"] == "https://example.edu/physician"
    assert candidates[0]["model_generated_summary"] is True
    assert responses.calls[0]["tools"] == [{"type": "web_search"}]
    assert responses.calls[0]["text"]["format"]["strict"] is True


def test_responses_enrichment_is_cached_for_repeat_explicit_action(
    store: WorkflowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Enrichment:
        calls = 0

        def candidates(self, persona_id: str):
            self.calls += 1
            return (
                "responses_api",
                [
                    {
                        "candidate_id": "cached-public-fact",
                        "category": "teaching",
                        "proposed_title": "Public faculty listing",
                        "proposed_detail": None,
                        "source_type": "public_web",
                        "source_title": "Institution profile",
                        "source_url": "https://example.edu/profile",
                        "retrieved_at": "2026-10-05T00:00:00+00:00",
                        "model_generated_summary": True,
                        "confidence": "high",
                    }
                ],
                None,
            )

    service = _Enrichment()
    monkeypatch.setattr(engagement_api, "profile_enrichment_service", service)
    with TestClient(app) as client:
        first = client.post(_url("/api/workspace/physician/profile/enrich")).json()
        second = client.post(_url("/api/workspace/physician/profile/enrich")).json()
    assert first["provider"] == "responses_api"
    assert second["cached"] is True
    assert service.calls == 1


def test_post_draft_and_branch_generation_are_structured_with_fallback() -> None:
    post_client, post_responses = _client(
        {"title": "A supplied title", "body": "Supplied facts only."}
    )
    draft = PostDraftService(post_client).draft(
        "iain", "professional_update", {"title": "A supplied title", "text": "Facts"}
    )
    assert draft["provider"] == "responses_api"
    assert post_responses.calls[0]["tools"] == []

    invalid_client, _ = _client(
        {
            "question": "What is the patient's MRN?",
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Invalid identifier request.",
            "dimension_being_narrowed": "geography_access",
            "terminal_candidate": False,
            "source_references": ["calibration:access"],
            "source_type": "bounded_practice_context",
            "proposed_boundary_rationale": "Invalid.",
        }
    )
    parent = {
        "id": "test-root",
        "question_type": "yes_no_depends",
        "root_question_id": "test-root",
        "branch_depth": 0,
        "branch_path": [],
        "source_reference": "calibration:access",
        "dimension_being_narrowed": "geography_access",
    }
    generated, provider = TrainingBranchService(invalid_client).generate(
        {
            "persona_id": "iain",
            "parent": parent,
            "parent_question": "Would travel distance change fit?",
            "answered_questions": [],
            "branch_depth": 0,
            "dimension": "geography_access",
            "source_references": ["calibration:access"],
        },
        set(),
    )
    assert provider == "deterministic_fallback"
    assert generated is not None
    assert generated["question_type"] == "yes_no_depends"


def test_valid_grounded_branch_is_accepted() -> None:
    valid_client, responses = _client(
        {
            "question": "Would travel distance make a video-first visit appropriate?",
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Narrows the access boundary.",
            "dimension_being_narrowed": "geography_access",
            "terminal_candidate": False,
            "source_references": ["calibration:access"],
            "source_type": "bounded_practice_context",
            "proposed_boundary_rationale": "Travel may change the initial visit modality.",
        }
    )
    parent = {
        "id": "test-root",
        "question_type": "yes_no_depends",
        "root_question_id": "test-root",
        "branch_depth": 0,
        "branch_path": [],
        "source_reference": "calibration:access",
        "dimension_being_narrowed": "geography_access",
    }
    generated, provider = TrainingBranchService(valid_client).generate(
        {
            "persona_id": "iain",
            "parent": parent,
            "parent_question": "Would travel distance change referral fit?",
            "answered_questions": [],
            "branch_depth": 0,
            "dimension": "geography_access",
            "source_references": ["calibration:access"],
        },
        set(),
    )
    assert provider == "responses_api"
    assert generated is not None
    assert responses.calls[0]["text"]["format"]["name"] == "lamina_training_branch"


def test_mocked_responses_branch_is_materialized_and_resumable(
    store: WorkflowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    client_adapter, _ = _client(
        {
            "question": (
                "Would diagnostic clarification make the case fit if the diagnosis "
                "remained unconfirmed?"
            ),
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Narrows the diagnosis boundary.",
            "dimension_being_narrowed": "diagnosis_phenotype",
            "terminal_candidate": False,
            "source_references": ["calibration:diagnosis_phenotype:0"],
            "source_type": "bounded_practice_context",
            "proposed_boundary_rationale": "Diagnostic uncertainty may still fit.",
        }
    )
    monkeypatch.setattr(
        engagement_api,
        "training_branch_service",
        TrainingBranchService(client_adapter),
    )
    with TestClient(app) as client:
        session = client.post(_url("/api/workspace/physician/training/sessions")).json()
        bank_question = next(
            item for item in session["questions"] if item["source_type"] == "practice_gap"
        )
        response = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                f"/responses/{bank_question['id']}"
            ),
            json={"answer": "Depends"},
        ).json()
        child = response["next_question"]
        resumed = client.get(
            _url(f"/api/workspace/physician/training/sessions/{session['id']}")
        ).json()

    assert child["generation_provider"] == "responses_api"
    assert child["source_references"] == ["calibration:diagnosis_phenotype:0"]
    assert next(item for item in resumed["questions"] if item["id"] == child["id"])[
        "proposed_boundary_rationale"
    ] == "Diagnostic uncertainty may still fit."
