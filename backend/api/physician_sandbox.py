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
    PhysicianOwnerScope,
    PhysicianSandboxService,
    PilotAccessDeniedError,
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


def require_pilot_scope(user: RequiredUser) -> PhysicianOwnerScope:
    """The one canonical pilot-access guard for private physician routes.

    Resolves authenticated account -> selected owned claim -> owner scope, and
    admits only a confirmed identity with approved pilot access. No request
    input participates in choosing the scope.
    """
    try:
        return sandbox_service.pilot_scope(user.id)
    except PilotAccessDeniedError as error:
        raise HTTPException(403, {"code": error.code, "message": str(error)}) from error


PilotScope = Annotated[PhysicianOwnerScope, Depends(require_pilot_scope)]


@router.get("/status")
def status(user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.status(user.id))


@router.put("/selection/{claim_id}")
def select_identity(claim_id: int, user: RequiredUser) -> dict:
    return _run(lambda: sandbox_service.select(user.id, claim_id))


@router.get("/profile")
def profile(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.profile(scope))


@router.put("/profile/items/{item_id}")
def update_profile_item(item_id: str, update: ProfileItemUpdate, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.upsert_profile_item(scope, item_id, update))


@router.get("/interests")
def interests(scope: PilotScope) -> list[dict]:
    return _run(lambda: sandbox_service.interests(scope))


@router.post("/interests", status_code=201)
def create_interest(update: InterestInput, scope: PilotScope) -> dict:
    return _run(
        lambda: sandbox_service.upsert_interest(
            scope, f"interest-{secrets.token_hex(8)}", update
        )
    )


@router.put("/interests/{interest_id}")
def update_interest(interest_id: str, update: InterestInput, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.upsert_interest(scope, interest_id, update))


@router.get("/initialization")
def initialization(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.initialization(scope))


@router.get("/agent-overview")
def overview(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.overview(scope))


@router.get("/practice-representation")
def representation(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.representation(scope))


@router.get("/training")
def training(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.train_projection(scope))


@router.get("/training/history")
def training_history(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.train_projection(scope))


@router.post("/training/sessions", status_code=201)
def start_training(scope: PilotScope, update: TrainingSessionInput | None = None) -> dict:
    value = update or TrainingSessionInput()
    return _run(lambda: sandbox_service.start_training(scope, value.mode))


@router.get("/training/sessions/{session_id}")
def resume_training(session_id: int, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.resume_training(scope, session_id))


@router.put("/training/sessions/{session_id}/responses/{question_id}")
def answer_training(
    session_id: int, question_id: str, update: TrainingResponseUpdate, scope: PilotScope
) -> dict:
    return _run(
        lambda: sandbox_service.answer_training(scope, session_id, question_id, update)
    )


@router.post("/training/sessions/{session_id}/finish")
def finish_training(session_id: int, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.complete_training(scope, session_id))


@router.put("/training/learnings/{learning_id}")
def review_learning(learning_id: int, update: LearningUpdate, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.review_learning(scope, learning_id, update))


@router.post("/training/sessions/{session_id}/review/complete")
def complete_review(
    session_id: int, update: TrainingReviewCompleteInput, scope: PilotScope
) -> dict:
    return _run(
        lambda: sandbox_service.complete_review(scope, session_id, update.defer_pending)
    )


@router.post("/training/focused", status_code=201)
def focused_training(update: FocusedTrainingInput, scope: PilotScope) -> dict:
    return _run(
        lambda: sandbox_service.start_focused_training(
            scope, update.seed_id, update.answer_target
        )
    )


@router.post("/profile/enrich", status_code=201)
def enrich(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.enrichment(scope))


@router.get("/profile/enrichment")
def enrichment_status(scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.store.latest_enrichment(*scope.key))


@router.put("/profile/enrichment/candidates/{candidate_id}")
def review_candidate(candidate_id: str, update: CandidateReviewInput, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.review_candidate(scope, candidate_id, update))


@router.get("/agent-test-cases")
def test_cases(scope: PilotScope) -> list[dict]:
    del scope
    return sandbox_service.test_cases()


@router.post("/agent-chat", status_code=201)
def agent_chat(update: AgentChatInput, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.chat(scope, update))


@router.post("/agent-chat/{response_id}/feedback")
def agent_chat_feedback(
    response_id: str, update: AgentChatFeedbackInput, scope: PilotScope
) -> dict:
    return _run(lambda: sandbox_service.chat_feedback(scope, response_id, update.feedback))


@router.get("/posts")
def posts(scope: PilotScope) -> list[dict]:
    return _run(lambda: sandbox_service.posts(scope))


@router.post("/posts", status_code=201)
def create_post(update: PostInput, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.create_post(scope, update))


@router.post("/posts/draft", status_code=201)
def draft_post(update: PostDraftInput, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.draft_post(scope, update))


@router.put("/posts/{post_id}")
def edit_post(post_id: int, update: PostInput, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.edit_post(scope, post_id, update))


@router.post("/posts/{post_id}/dismiss")
def dismiss_post(post_id: int, scope: PilotScope) -> dict:
    return _run(lambda: sandbox_service.archive_post(scope, post_id))


@router.post("/posts/{post_id}/publish")
def publish_post(post_id: int, scope: PilotScope) -> None:
    return _run(lambda: sandbox_service.publish_post(scope, post_id))
