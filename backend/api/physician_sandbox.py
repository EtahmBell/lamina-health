"""Authenticated owner-resolved API for the private physician sandbox."""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from backend.api.engagement import (
    AgentChatFeedbackInput,
    AgentChatInput,
    CandidateReviewInput,
    FocusedTrainingInput,
    InterestInput,
    LearningUpdate,
    PostDraftInput,
    PostInput,
    ProfileItemUpdate,
    TrainingResponseUpdate,
    TrainingReviewCompleteInput,
    TrainingSessionInput,
)
from backend.auth import AuthenticatedUser, require_authenticated_user
from backend.physician_sandbox import (
    NoPhysicianClaimError,
    PhysicianSandboxService,
    PublicationNotEligibleError,
    SandboxConflictError,
    SandboxResourceNotFoundError,
    SandboxValidationError,
)

router = APIRouter(prefix="/api/me/physician", tags=["physician-private-sandbox"])
sandbox_service = PhysicianSandboxService()
RequiredUser = Annotated[AuthenticatedUser, Depends(require_authenticated_user)]


def _run(action):
    try:
        return action()
    except NoPhysicianClaimError as error:
        raise HTTPException(409, str(error)) from error
    except SandboxResourceNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    except (SandboxConflictError, PublicationNotEligibleError) as error:
        raise HTTPException(409, str(error)) from error
    except SandboxValidationError as error:
        raise HTTPException(422, str(error)) from error


def _scope(user: AuthenticatedUser):
    return sandbox_service.current(user.id)


@router.get("/status")
def status(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.status(user.id))


@router.put("/selection/{claim_id}")
def select_identity(claim_id: int, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.select(user.id, claim_id))


@router.get("/profile")
def profile(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.profile(_scope(user)))


@router.put("/profile/items/{item_id}")
def update_profile_item(item_id: str, update: ProfileItemUpdate, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.upsert_profile_item(_scope(user), item_id, update))


@router.get("/interests")
def interests(user: RequiredUser) -> list[dict]:
    return _run(lambda: sandbox_service.interests(_scope(user)))


@router.post("/interests", status_code=201)
def create_interest(update: InterestInput, user: RequiredUser) -> dict:
    return _run(
        lambda: sandbox_service.upsert_interest(
            _scope(user), f"interest-{secrets.token_hex(8)}", update
        )
    )


@router.put("/interests/{interest_id}")
def update_interest(interest_id: str, update: InterestInput, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.upsert_interest(_scope(user), interest_id, update))


@router.get("/initialization")
def initialization(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.initialization(_scope(user)))


@router.get("/agent-overview")
def overview(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.overview(_scope(user)))


@router.get("/practice-representation")
def representation(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.representation(_scope(user)))


@router.get("/training")
def training(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.train_projection(_scope(user)))


@router.get("/training/history")
def training_history(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.train_projection(_scope(user)))


@router.post("/training/sessions", status_code=201)
def start_training(user: RequiredUser, update: TrainingSessionInput | None = None) -> dict:
    value = update or TrainingSessionInput()
    return _run(lambda: sandbox_service.start_training(_scope(user), value.mode))


@router.get("/training/sessions/{session_id}")
def resume_training(session_id: int, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.resume_training(_scope(user), session_id))


@router.put("/training/sessions/{session_id}/responses/{question_id}")
def answer_training(
    session_id: int, question_id: str, update: TrainingResponseUpdate, user: RequiredUser
) -> dict:
    return _run(
        lambda: sandbox_service.answer_training(_scope(user), session_id, question_id, update)
    )


@router.post("/training/sessions/{session_id}/finish")
def finish_training(session_id: int, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.complete_training(_scope(user), session_id))


@router.put("/training/learnings/{learning_id}")
def review_learning(learning_id: int, update: LearningUpdate, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.review_learning(_scope(user), learning_id, update))


@router.post("/training/sessions/{session_id}/review/complete")
def complete_review(
    session_id: int, update: TrainingReviewCompleteInput, user: RequiredUser
) -> dict:
    return _run(
        lambda: sandbox_service.complete_review(_scope(user), session_id, update.defer_pending)
    )


@router.post("/training/focused", status_code=201)
def focused_training(update: FocusedTrainingInput, user: RequiredUser) -> dict:
    return _run(
        lambda: sandbox_service.start_focused_training(
            _scope(user), update.seed_id, update.answer_target
        )
    )


@router.post("/profile/enrich", status_code=201)
def enrich(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.enrichment(_scope(user)))


@router.get("/profile/enrichment")
def enrichment_status(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.store.latest_enrichment(*_scope(user).key))


@router.put("/profile/enrichment/candidates/{candidate_id}")
def review_candidate(candidate_id: str, update: CandidateReviewInput, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.review_candidate(_scope(user), candidate_id, update))


@router.get("/agent-test-cases")
def test_cases(user: RequiredUser) -> list[dict]:
    _run(lambda: _scope(user))
    return sandbox_service.test_cases()


@router.post("/agent-chat", status_code=201)
def agent_chat(update: AgentChatInput, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.chat(_scope(user), update))


@router.post("/agent-chat/{response_id}/feedback")
def agent_chat_feedback(
    response_id: str, update: AgentChatFeedbackInput, user: RequiredUser
) -> dict:
    return _run(lambda: sandbox_service.chat_feedback(_scope(user), response_id, update.feedback))


@router.get("/posts")
def posts(user: RequiredUser) -> list[dict]:
    return _run(lambda: sandbox_service.posts(_scope(user)))


@router.post("/posts", status_code=201)
def create_post(update: PostInput, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.create_post(_scope(user), update))


@router.post("/posts/draft", status_code=201)
def draft_post(update: PostDraftInput, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.draft_post(_scope(user), update))


@router.put("/posts/{post_id}")
def edit_post(post_id: int, update: PostInput, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.edit_post(_scope(user), post_id, update))


@router.post("/posts/{post_id}/dismiss")
def dismiss_post(post_id: int, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.archive_post(_scope(user), post_id))


@router.post("/posts/{post_id}/publish")
def publish_post(post_id: int, user: RequiredUser) -> None:
    return _run(lambda: sandbox_service.publish_post(_scope(user), post_id))
