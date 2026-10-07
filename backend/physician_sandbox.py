"""Authenticated, private physician sandbox over the shared engagement repository."""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from dataclasses import dataclass
from typing import Any

from backend.engagement import (
    BASE_TIMESTAMP,
    INTEREST_TYPES,
    PROFILE_CATEGORIES,
    deterministic_branch_question,
    normalize_question,
    synthesize_branch_learning,
)
from backend.professional_services import (
    agent_chat_service,
    post_draft_service,
    profile_enrichment_service,
)
from backend.provider_network.service import ProviderNetwork
from backend.workflow import WorkflowStore, workflow_store

NORMAL_TRAINING_TARGET = 10
logger = logging.getLogger(__name__)
POST_TYPES = {
    "profile_update",
    "practice_update",
    "referral_guidance",
    "share_paper",
    "research_update",
    "teaching_update",
    "interesting_case",
    "availability",
    "professional_update",
    "other",
    "practice_focus",
    "publication",
    "research",
    "teaching",
    "location",
}


class NoPhysicianClaimError(LookupError):
    pass


class SandboxResourceNotFoundError(LookupError):
    pass


class SandboxConflictError(ValueError):
    pass


class SandboxValidationError(ValueError):
    pass


class PublicationNotEligibleError(PermissionError):
    pass


@dataclass(frozen=True)
class PhysicianOwnerScope:
    id: str
    user_id: str
    provider_claim_id: int
    npi: str
    storage_scope_id: str
    physician_id: str
    provider_identity: dict[str, Any]
    claim_status: str
    publication_status: str
    clinical_access: bool

    @property
    def key(self) -> tuple[str, str]:
        return self.storage_scope_id, self.physician_id


_GENERIC_TEST_CASES = [
    {
        "id": "owner-test-fit",
        "title": "Specialty-fit boundary",
        "summary": "A generic synthetic case testing whether a stable referral fits your practice.",
        "facts": ["Synthetic adult scenario", "Stable presentation", "Clear specialty question"],
        "intended_domain": "practice_fit",
        "source": "controlled_synthetic_generic",
        "correction_prompt": "Would this stable, in-scope synthetic referral usually fit your practice?",
    },
    {
        "id": "owner-test-workup",
        "title": "Incomplete pre-referral workup",
        "summary": "A generic synthetic case with one preferred study unavailable.",
        "facts": ["Synthetic scenario", "No acute instability", "One preferred study unavailable"],
        "intended_domain": "prior_workup",
        "source": "controlled_synthetic_generic",
        "correction_prompt": "Would you proceed when one preferred pre-referral study is unavailable?",
    },
    {
        "id": "owner-test-comanagement",
        "title": "Multidisciplinary co-management",
        "summary": "A generic synthetic case with a competing specialty question.",
        "facts": [
            "Synthetic scenario",
            "Competing specialty question",
            "Stable outpatient setting",
        ],
        "intended_domain": "comorbidity",
        "source": "controlled_synthetic_generic",
        "correction_prompt": "Would this co-management scenario usually fit your practice?",
    },
]

_INITIALIZATION_PROMPTS = [
    (
        "clinical-focus",
        "Would you like your agent to use your confirmed clinical interests when describing practice fit?",
        "interests",
    ),
    (
        "case-fit",
        "Would a case within your specialty and stated interests generally be considered a possible fit?",
        "practice_fit",
    ),
    (
        "incomplete-workup",
        "Would you consider a stable referral when one preferred study is unavailable?",
        "prior_workup",
    ),
    (
        "diagnostic-clarification",
        "Would diagnostic clarification alone be a sufficient reason for a referral?",
        "diagnosis_phenotype",
    ),
    (
        "comanagement",
        "Would you consider cases that require multidisciplinary co-management?",
        "comorbidity",
    ),
    ("telehealth", "Would a video-first evaluation ever fit your practice?", "geography_access"),
    (
        "procedure-question",
        "Would you review a case whose immediate question is whether a procedure is indicated?",
        "procedure_need",
    ),
    ("econsult", "Would an e-consult be an acceptable first step for some cases?", "care_setting"),
    (
        "follow-up",
        "Would explicit follow-up and re-referral triggers be useful in your guidance?",
        "follow_up",
    ),
    (
        "communication",
        "Would a concise recommendation plus rationale match your preferred communication style?",
        "communication_preference",
    ),
]

_ONGOING_PROMPTS = [
    (
        "trajectory",
        "Would documented progression make a stable case more likely to fit your practice?",
        "trajectory",
    ),
    (
        "severity",
        "Would objective disease severity matter more than symptom burden for practice fit?",
        "disease_severity",
    ),
    (
        "treatment-history",
        "Would intolerance of first-line treatment make a referral more appropriate?",
        "treatment_history",
    ),
    (
        "outside-interest",
        "Would an in-scope case outside your stated interests still be a possible fit?",
        "interests",
    ),
    (
        "remote-followup",
        "Would a case fit if all follow-up needed to occur remotely?",
        "geography_access",
    ),
    (
        "competing-diagnosis",
        "Would you wait until a competing diagnosis was excluded before considering the case?",
        "exclusion_conditions",
    ),
    (
        "older-results",
        "Would a documented trend be enough if the newest result were pending?",
        "required_labs",
    ),
    (
        "return-plan",
        "Would a defined return-to-primary-care plan be important for accepting a referral?",
        "follow_up",
    ),
    (
        "procedure-elsewhere",
        "Would a case fit if any required procedure had to occur at another site?",
        "procedure_need",
    ),
    (
        "shared-plan",
        "Would you generally require a shared follow-up plan after an initial consultation?",
        "communication_preference",
    ),
    (
        "functional-status",
        "Would preserved functional status affect your threshold for accepting an older patient?",
        "age_context",
    ),
    (
        "in-person",
        "Would likely need for a later in-person examination change whether you start with e-consult?",
        "care_setting",
    ),
    (
        "basic-testing",
        "Would you prefer all basic testing complete before a routine referral?",
        "prior_workup",
    ),
    (
        "uncertain-diagnosis",
        "Would an unconfirmed diagnosis remain appropriate after a basic workup?",
        "diagnosis_phenotype",
    ),
    (
        "standard-option",
        "Would you usually want another standard treatment tried before referral?",
        "treatment_history",
    ),
]

_SYNTHETIC_QUALIFIERS = [
    "the presentation is stable",
    "the referral question is narrowly defined",
    "the basic workup is complete",
    "one preferred study is still pending",
    "another specialist is already involved",
    "an e-consult is available as a first step",
    "travel makes an in-person first visit difficult",
    "the trajectory is documented across multiple observations",
]


class PhysicianSandboxService:
    def __init__(self, store: WorkflowStore | None = None, network: ProviderNetwork | None = None):
        self.store = store or workflow_store
        self.network = network or ProviderNetwork(store=self.store)

    @staticmethod
    def _identity_payload(profile: Any) -> dict[str, Any]:
        return {
            "npi": profile.npi,
            "display_name": profile.display_name,
            "specialty": profile.specialty,
            "taxonomy_code": profile.taxonomy_code,
            "organization": profile.organization,
            "city": profile.city,
            "state": profile.state,
            "phone": profile.phone,
            "source": profile.source.value,
            "directory_disclaimer": profile.directory_disclaimer,
        }

    def _ensure_legacy_scope(self, user_id: str) -> dict | None:
        active = [
            claim
            for claim in self.store.provider_claims(user_id)
            if claim["status"] in {"claimed", "verification_pending", "verified"}
        ]
        if not active:
            return None
        for claim in active:
            existing = next(
                (
                    item
                    for item in self.store.physician_owner_scopes(user_id)
                    if item["provider_claim_id"] == claim["id"]
                ),
                None,
            )
            if existing:
                continue
            profile = self.network._resolve(claim["npi"])
            self.store.ensure_physician_owner_scope(claim, self._identity_payload(profile))
        return self.store.selected_physician_owner_scope(user_id)

    def current(self, user_id: str, *, required: bool = True) -> PhysicianOwnerScope | None:
        row = self.store.selected_physician_owner_scope(user_id) or self._ensure_legacy_scope(
            user_id
        )
        if not row:
            if required:
                raise NoPhysicianClaimError("No claimed physician identity is selected")
            return None
        claim = self.store.provider_claim(row["provider_claim_id"])
        if (
            not claim
            or claim["auth_user_id"] != user_id
            or claim["status"] not in {"claimed", "verification_pending", "verified"}
        ):
            if required:
                raise NoPhysicianClaimError("No active claimed physician identity is selected")
            return None
        return PhysicianOwnerScope(
            id=row["id"],
            user_id=user_id,
            provider_claim_id=claim["id"],
            npi=claim["npi"],
            storage_scope_id=row["storage_scope_id"],
            physician_id=row["physician_id"],
            provider_identity=row["provider_identity"],
            claim_status=claim["status"],
            publication_status=row["publication_status"],
            clinical_access=row["clinical_access"],
        )

    def select(self, user_id: str, claim_id: int) -> dict:
        row = self.store.select_physician_owner_scope(user_id, claim_id)
        if not row:
            raise SandboxResourceNotFoundError("Owned physician identity not found")
        return self.status(user_id)

    def status(self, user_id: str) -> dict:
        scope = self.current(user_id, required=False)
        capabilities = {
            "can_edit_profile": bool(scope),
            "can_enrich_profile": bool(scope),
            "can_train_agent": bool(scope),
            "can_test_agent": bool(scope),
            "can_draft_posts": bool(scope),
            "can_publish_profile": False,
            "can_publish_posts": False,
            "can_join_network": False,
            "can_access_patients": False,
            "can_access_clinical_cases": False,
        }
        if not scope:
            return {
                "has_claim": False,
                "claim_status": None,
                "verification_status": "unverified",
                "publication_status": "private",
                "clinical_access_status": "unavailable",
                "provider_identity": None,
                "profile_ready": False,
                "initialization_required": True,
                "initialized": False,
                "agent_ready": False,
                "capabilities": capabilities,
            }
        initialization = self.initialization(scope)
        return {
            "has_claim": True,
            "claim_status": scope.claim_status,
            "verification_status": "verified" if scope.claim_status == "verified" else "unverified",
            "publication_status": scope.publication_status,
            "clinical_access_status": "enabled" if scope.clinical_access else "unavailable",
            "provider_identity": scope.provider_identity,
            "profile_ready": True,
            "initialization_required": not initialization["initialized"],
            "initialized": initialization["initialized"],
            "agent_ready": initialization["initialized"],
            "capabilities": capabilities,
        }

    def profile(self, scope: PhysicianOwnerScope) -> dict:
        workspace_id, physician_id = scope.key
        items = self.store.profile_items(workspace_id, physician_id)
        interests = self.store.physician_interests(workspace_id, physician_id)
        sections = {
            category: [item for item in items if item["category"] == category]
            for category in PROFILE_CATEGORIES
        }
        completed = sorted({item["category"] for item in items})
        return {
            "physician": {**scope.provider_identity, "id": scope.physician_id, "synthetic": False},
            "base_identity": scope.provider_identity,
            "items": items,
            "interests": interests,
            "sections": sections,
            "completeness": {
                "completed_section_count": len(completed),
                "total_section_count": len(PROFILE_CATEGORIES),
                "incomplete_sections": [c for c in PROFILE_CATEGORIES if c not in completed],
                "meaning": "Professional profile completeness only; not physician quality or referral rank.",
            },
            "synthetic": False,
        }

    def upsert_profile_item(self, scope: PhysicianOwnerScope, item_id: str, update: Any) -> dict:
        if update.category not in PROFILE_CATEGORIES:
            raise SandboxValidationError("Unsupported professional profile category")
        title = " ".join(update.title.split())
        if not title:
            raise SandboxValidationError("Profile item title cannot be empty")
        item = self.store.upsert_profile_item(
            *scope.key,
            item_id,
            update.category,
            title,
            " ".join(update.detail.split()) if update.detail else None,
            update.shareable,
        )
        return {"profile_item": item}

    def interests(self, scope: PhysicianOwnerScope) -> list[dict]:
        return self.store.physician_interests(*scope.key)

    def upsert_interest(self, scope: PhysicianOwnerScope, interest_id: str, update: Any) -> dict:
        if update.interest_type not in INTEREST_TYPES:
            raise SandboxValidationError("Unsupported physician interest type")
        return self.store.upsert_physician_interest(
            *scope.key,
            interest_id,
            update.interest_type,
            " ".join(update.title.split()),
            " ".join(update.detail.split()) if update.detail else None,
            update.confirmed,
            update.shareable,
        )

    def questions(self, scope: PhysicianOwnerScope) -> list[dict]:
        responses = {
            item["question_id"]: item for item in self.store.training_responses(*scope.key)
        }
        prompts = [("init", *_p) for _p in _INITIALIZATION_PROMPTS]
        prompts.extend(
            (
                "ongoing",
                f"{key}-{qualifier_index}",
                f"{prompt.rstrip('?')} in a synthetic scenario where {qualifier}?",
                dimension,
            )
            for key, prompt, dimension in _ONGOING_PROMPTS
            for qualifier_index, qualifier in enumerate(_SYNTHETIC_QUALIFIERS, start=1)
        )
        questions = []
        for phase, key, prompt, dimension in prompts:
            qid = f"{scope.physician_id}-{phase}-{key}"
            question = normalize_question(
                {
                    "id": qid,
                    "physician_persona": scope.physician_id,
                    "source_type": "initialization" if phase == "init" else "practice_gap",
                    "source_reference": f"confirmed-professional-state:{dimension}",
                    "prompt": prompt,
                    "question_type": "yes_no_depends",
                    "answer_options": ["Yes", "Depends", "No"],
                    "why_this_matters": f"Clarifies the physician's {dimension.replace('_', ' ')} boundary.",
                    "dimension_being_narrowed": dimension,
                    "question_objective": "Locate a bounded practice-fit decision boundary.",
                    "terminal": False,
                    "synthetic": True,
                    "created_at": BASE_TIMESTAMP,
                }
            )
            latest = responses.get(qid)
            questions.append(
                {
                    **question,
                    "status": "skipped"
                    if latest and latest["skipped"]
                    else "answered"
                    if latest
                    else "unanswered",
                }
            )
        return questions

    def question(self, scope: PhysicianOwnerScope, question_id: str) -> dict | None:
        return next(
            (item for item in self.questions(scope) if item["id"] == question_id), None
        ) or self.store.generated_training_question(*scope.key, question_id)

    def initialization(self, scope: PhysicianOwnerScope) -> dict:
        workspace_id, physician_id = scope.key
        state = self.store.initialization_state(workspace_id, physician_id)
        sessions = self.store.training_sessions(workspace_id, physician_id)
        completed = any(
            s["mode"] == "initialization"
            and s["status"] == "completed"
            and s["lifecycle_state"] != "abandoned"
            for s in sessions
        )
        confirmed_interest = any(item["confirmed"] for item in self.interests(scope))
        if state is None and completed and confirmed_interest:
            state = self.store.mark_initialized(workspace_id, physician_id)
        return {
            "status": "initialized" if state else "in_progress",
            "initialized": bool(state),
            "initialized_at": state["initialized_at"] if state else None,
            "required_steps": [
                "professional_identity",
                "practice_context",
                "interests",
                "first_training",
            ],
            "completed_steps": [
                "professional_identity",
                "practice_context",
                *(["interests"] if confirmed_interest else []),
                *(["first_training"] if completed else []),
            ],
            "blocking": False,
        }

    def _active_session(self, scope: PhysicianOwnerScope) -> dict | None:
        return next(
            (
                s
                for s in self.store.training_sessions(*scope.key)
                if s["status"] == "active" and s["lifecycle_state"] == "active"
            ),
            None,
        )

    def _materialize(self, scope: PhysicianOwnerScope, session: dict) -> dict:
        workspace_id, physician_id = scope.key
        assigned = self.store.training_session_questions(workspace_id, physician_id, session["id"])
        responses = self.store.training_responses(workspace_id, physician_id, session["id"])
        answered = {r["question_id"] for r in responses}
        assigned_ids = {a["question_id"] for a in assigned}
        questions = [
            self.question(scope, a["question_id"])
            for a in assigned
            if a["question_id"] not in answered
        ]
        remaining_budget = max(0, session["answer_target"] - len(responses))
        questions = [q for q in questions if q][:remaining_budget]
        needed = max(0, session["answer_target"] - len(responses) - len(questions))
        source = self.questions(scope)
        if session["mode"] == "initialization":
            source = [q for q in source if "-init-" in q["id"]]
        for question in source:
            if needed <= 0:
                break
            if (
                question["id"] in answered
                or question["id"] in assigned_ids
                or question["status"] != "unanswered"
            ):
                continue
            self.store.assign_training_question(
                workspace_id, physician_id, session["id"], question, question["priority"]
            )
            questions.append(question)
            needed -= 1
        return {**session, "questions": questions, "responses": responses}

    def start_training(self, scope: PhysicianOwnerScope, mode: str = "daily") -> dict:
        existing = self._active_session(scope)
        if existing:
            return self._materialize(scope, existing)
        session = self.store.start_training_session(*scope.key, mode, NORMAL_TRAINING_TARGET)
        logger.info(
            "physician_sandbox_training_created scope=%s session=%s mode=%s",
            scope.id,
            session["id"],
            mode,
        )
        return self._materialize(scope, session)

    def resume_training(self, scope: PhysicianOwnerScope, session_id: int) -> dict:
        session = self.store.training_session(*scope.key, session_id)
        if not session:
            raise SandboxResourceNotFoundError("Training session not found")
        return self._materialize(scope, session)

    def answer_training(
        self, scope: PhysicianOwnerScope, session_id: int, question_id: str, update: Any
    ) -> dict:
        workspace_id, physician_id = scope.key
        session = self.store.training_session(workspace_id, physician_id, session_id)
        if not session or session["status"] != "active":
            raise SandboxResourceNotFoundError("Active training session not found")
        assigned = self.store.training_session_questions(workspace_id, physician_id, session_id)
        if question_id not in {a["question_id"] for a in assigned}:
            raise SandboxResourceNotFoundError("Question is not assigned to this session")
        question = self.question(scope, question_id)
        if not question:
            raise SandboxResourceNotFoundError("Training question not found")
        answer = None if update.skipped else update.answer
        if not update.skipped and (
            not isinstance(answer, str) or answer not in question["answer_options"]
        ):
            raise SandboxValidationError("Unsupported answer option")
        response = self.store.save_training_response(
            workspace_id, physician_id, session_id, question_id, answer, update.skipped
        )
        responses = self.store.training_responses(workspace_id, physician_id, session_id)
        next_question = None
        if answer == "Depends" and len(responses) < session["answer_target"]:
            next_question = deterministic_branch_question(
                physician_id, question, {a["question_id"] for a in assigned}
            )
            if next_question:
                next_question = self.store.save_generated_training_question(
                    workspace_id, physician_id, session_id, next_question, "deterministic_fallback"
                )
                self.store.assign_training_question(
                    workspace_id, physician_id, session_id, next_question, next_question["priority"]
                )
        focused_resolved = bool(
            session["mode"] == "focused" and (update.skipped or answer != "Depends")
        )
        complete = len(responses) >= session["answer_target"] or focused_resolved
        completion = self.complete_training(scope, session_id) if complete else None
        return {
            **response,
            "next_question": next_question,
            "answered_count": len(responses),
            "answer_target": session["answer_target"],
            "questions_complete": complete,
            "completion_summary": completion.get("completion_summary") if completion else None,
        }

    def complete_training(self, scope: PhysicianOwnerScope, session_id: int) -> dict:
        workspace_id, physician_id = scope.key
        session = self.store.training_session(workspace_id, physician_id, session_id)
        if not session:
            raise SandboxResourceNotFoundError("Training session not found")
        responses = self.store.training_responses(workspace_id, physician_id, session_id)
        assigned = {
            a["question_id"]: a
            for a in self.store.training_session_questions(workspace_id, physician_id, session_id)
        }
        branches: dict[str, list[tuple[dict, dict]]] = {}
        for response in responses:
            if response["skipped"]:
                continue
            question = self.question(scope, response["question_id"])
            if question:
                root = assigned[response["question_id"]]["root_question_id"]
                branches.setdefault(root, []).append((question, response))
        for root, branch in branches.items():
            self.store.create_proposed_learning(
                workspace_id,
                physician_id,
                "training_response",
                f"session:{session_id}:root:{root}",
                synthesize_branch_learning(root, branch),
            )
        completed = (
            self.store.complete_training_session(workspace_id, physician_id, session_id) or session
        )
        logger.info(
            "physician_sandbox_training_completed scope=%s session=%s answer_count=%s",
            scope.id,
            session_id,
            len(responses),
        )
        if session["mode"] == "initialization" and any(
            i["confirmed"] for i in self.interests(scope)
        ):
            self.store.mark_initialized(workspace_id, physician_id)
        proposed = [
            l
            for l in self.store.proposed_learnings(workspace_id, physician_id)
            if l["source_reference"].startswith(f"session:{session_id}:")
        ]
        return {
            **completed,
            "responses": responses,
            "proposed_learnings": proposed,
            "completion_summary": {
                "answered_count": sum(not r["skipped"] for r in responses),
                "target_count": session["answer_target"],
                "proposed_learning_count": len(proposed),
                "pending_review_count": sum(l.get("review_action") is None for l in proposed),
            },
        }

    def train_projection(self, scope: PhysicianOwnerScope) -> dict:
        workspace_id, physician_id = scope.key
        active = self._active_session(scope)
        sessions = self.store.training_sessions(workspace_id, physician_id)
        responses = self.store.training_responses(workspace_id, physician_id)
        pending = [
            l
            for l in self.store.proposed_learnings(workspace_id, physician_id)
            if l["source_type"] == "training_response" and l.get("review_action") is None
        ]
        review = next(
            (
                s
                for s in sessions
                if s["lifecycle_state"] == "questions_complete"
                and any(l["source_reference"].startswith(f"session:{s['id']}:") for l in pending)
            ),
            None,
        )
        initialized = self.initialization(scope)["initialized"]
        unanswered = sum(q["status"] == "unanswered" for q in self.questions(scope))
        answered_count = (
            len(self.store.training_responses(workspace_id, physician_id, active["id"]))
            if active
            else 0
        )
        if not initialized:
            state, action = "initialization_needed", "continue_setup"
        elif active:
            state, action = (
                ("active_unstarted", "start_training")
                if answered_count == 0
                else ("active_in_progress", "resume_training")
            )
        elif review:
            state, action = "review_pending", "review_training"
        elif unanswered:
            state, action = "ready", "start_training"
        else:
            state, action = "caught_up", "none"
        return {
            "state": state,
            "action": action,
            "active_session_id": active["id"] if active else None,
            "review_session_id": review["id"] if review else None,
            "answered_count": answered_count,
            "answer_target": active["answer_target"] if active else None,
            "review_pending": bool(pending),
            "initialization_required": not initialized,
            "initialized": initialized,
            "training_status": "active" if active else "ready",
            "current_session": self._materialize(scope, active) if active else None,
            "questions_answered_total": sum(not r["skipped"] for r in responses),
            "sessions_completed": sum(
                s["status"] == "completed" and s["lifecycle_state"] != "abandoned" for s in sessions
            ),
            "last_trained_at": max((r["answered_at"] for r in responses), default=None),
            "more_training_available": bool(unanswered),
            "available_total": unanswered,
            "recent_training_history": self.store.training_history(workspace_id, physician_id)[:10],
            "deferred_branch_count": len(
                self.store.deferred_training_questions(workspace_id, physician_id)
            ),
            "pending_training_review_count": len(pending),
        }

    def review_learning(self, scope: PhysicianOwnerScope, learning_id: int, update: Any) -> dict:
        current = next(
            (l for l in self.store.proposed_learnings(*scope.key) if l["id"] == learning_id), None
        )
        if not current:
            raise SandboxResourceNotFoundError("Proposed learning not found")
        if update.action == "edit" and not update.statement:
            raise SandboxValidationError("Edited statement required")
        statement = " ".join((update.statement or current["statement"]).split())
        status = {"confirm": "confirmed", "edit": "suggested", "reject": "rejected"}[update.action]
        learning = self.store.update_proposed_learning(
            *scope.key, learning_id, statement, status, update.action
        )
        return {"learning": learning}

    def complete_review(
        self, scope: PhysicianOwnerScope, session_id: int, defer_pending: bool
    ) -> dict:
        session = self.store.training_session(*scope.key, session_id)
        if not session or session["status"] != "completed":
            raise SandboxResourceNotFoundError("Completed training session not found")
        pending = [
            item
            for item in self.store.proposed_learnings(*scope.key)
            if item["source_reference"].startswith(f"session:{session_id}:")
            and item.get("review_action") is None
        ]
        if pending and not defer_pending:
            raise SandboxConflictError("Pending learnings must be reviewed or explicitly deferred")
        completed = self.store.complete_training_review(
            *scope.key, session_id, deferred=bool(pending)
        )
        return {**(completed or session), "pending_review_count": len(pending)}

    def start_focused_training(
        self, scope: PhysicianOwnerScope, seed_id: str, answer_target: int
    ) -> dict:
        if self._active_session(scope):
            raise SandboxConflictError(
                "Complete the current training session before starting focused training"
            )
        seed = self.store.focused_training_seed(*scope.key, seed_id)
        if not seed or seed["status"] != "pending":
            raise SandboxResourceNotFoundError("Pending focused training seed not found")
        session = self.store.start_training_session(
            *scope.key, "focused", answer_target, focused_seed_id=seed_id
        )
        question = self.store.save_generated_training_question(
            *scope.key, session["id"], seed["question"], "agent_chat_feedback"
        )
        self.store.assign_training_question(*scope.key, session["id"], question, 100)
        self.store.start_focused_training_seed(*scope.key, seed_id, session["id"])
        return {**session, "questions": [question], "responses": []}

    def representation(self, scope: PhysicianOwnerScope) -> dict:
        profile = self.profile(scope)
        interests = [i for i in profile["interests"] if i["confirmed"]]
        learnings = [
            l for l in self.store.proposed_learnings(*scope.key) if l["status"] == "confirmed"
        ]
        unanswered = [q for q in self.questions(scope) if q["status"] == "unanswered"]
        return {
            "physician": profile["physician"],
            "sections": {
                "specialty": scope.provider_identity.get("specialty"),
                "clinical_focus": [
                    i["title"] for i in interests if i["interest_type"] == "clinical_interest"
                ],
                "good_fit": [],
                "not_a_fit": [],
                "referral_requirements": [],
                "preferred_workup": [],
                "access_facts": [],
                "explicit_rules": [],
                "interests": interests,
                "interest_safety": "Interests are preferences, not acceptance rules, guarantees, expertise claims, or ranking signals.",
                "confirmed_learnings": learnings,
            },
            "gaps": {
                "unanswered_questions": unanswered,
                "unconfirmed_rules": [
                    l
                    for l in self.store.proposed_learnings(*scope.key)
                    if l["status"] == "suggested"
                ],
                "practice_areas_needing_input": [q["prompt"] for q in unanswered],
            },
            "completeness": {
                "confirmed_practice_item_count": len(interests) + len(learnings),
                "questions_waiting": len(unanswered),
                "profile_sections_incomplete": len(profile["completeness"]["incomplete_sections"]),
                "meaning": "Representation completeness only; not quality, ranking, competence, or referral likelihood.",
            },
            "ranking_effect": "none",
        }

    def overview(self, scope: PhysicianOwnerScope) -> dict:
        representation = self.representation(scope)
        training = self.train_projection(scope)
        interests = [i["title"] for i in representation["sections"]["interests"]]
        identity = scope.provider_identity
        place = ", ".join(filter(None, [identity.get("city"), identity.get("state")]))
        pieces = [
            f"{identity.get('specialty') or 'Physician'} in {place}"
            if place
            else identity.get("specialty") or "Physician"
        ]
        if interests:
            pieces.append(f"with confirmed interests in {', '.join(interests[:3])}")
        learnings = representation["sections"]["confirmed_learnings"]
        if learnings:
            pieces.append(
                f"Your agent currently includes {len(learnings)} physician-confirmed "
                f"practice {'boundaries' if len(learnings) != 1 else 'boundary'}"
            )
        portrait = ". ".join(pieces) + "."
        return {
            "physician": self.profile(scope)["physician"],
            "specialty": identity.get("specialty"),
            "location": place,
            "portrait": portrait,
            "portrait_confirmed_facts": [l["statement"] for l in learnings],
            "stats": {
                "questions_answered_total": training["questions_answered_total"],
                "training_sessions_completed": training["sessions_completed"],
                "confirmed_practice_learnings": len(learnings),
                "case_interests_count": sum(
                    i["interest_type"] == "case_interest"
                    for i in representation["sections"]["interests"]
                ),
                "network_cases_count": 0,
                "published_updates_count": 0,
                "network_physicians_count": 0,
                "last_trained_at": training["last_trained_at"],
            },
            "initialization": self.initialization(scope),
            "training": training,
            "last_trained_at": training["last_trained_at"],
            "more_training_available": training["more_training_available"],
            "next_action": training["action"],
            "ranking_effect": "none",
        }

    def enrichment(self, scope: PhysicianOwnerScope) -> dict:
        identity = scope.provider_identity
        if not profile_enrichment_service.client.available:
            job = self.store.create_enrichment_job(*scope.key, "unavailable")
            return self.store.complete_enrichment_job(
                *scope.key, job["id"], [], "Public enrichment is not configured"
            )
        job = self.store.create_enrichment_job(*scope.key, "responses_api")
        try:
            candidates = profile_enrichment_service.public_candidates(
                {
                    "full_name": identity["display_name"],
                    "npi": identity["npi"],
                    "specialty": identity.get("specialty") or "Physician",
                    "geography": ", ".join(
                        filter(None, [identity.get("city"), identity.get("state")])
                    ),
                    "institution": identity.get("organization") or "",
                    "identity_note": "Authenticated claimed NPPES identity; omit any ambiguous same-name results",
                }
            )
        except RuntimeError:
            return self.store.complete_enrichment_job(
                *scope.key,
                job["id"],
                [],
                "Public enrichment is temporarily unavailable",
            )
        return self.store.complete_enrichment_job(*scope.key, job["id"], candidates)

    def review_candidate(self, scope: PhysicianOwnerScope, candidate_id: str, update: Any) -> dict:
        status = "confirmed" if update.action in {"confirm", "edit_confirm"} else "rejected"
        candidate = self.store.review_profile_candidate(
            *scope.key, candidate_id, status, update.title, update.detail
        )
        if not candidate:
            raise SandboxResourceNotFoundError("Profile candidate not found")
        item = None
        if status == "confirmed":
            item = self.store.upsert_profile_item(
                *scope.key,
                f"enrichment-{candidate_id}",
                candidate["category"],
                candidate["proposed_title"],
                candidate["proposed_detail"],
                update.shareable,
                provenance=f"confirmed_enrichment:{candidate['source_title']}",
            )
        return {"candidate": candidate, "profile_item": item}

    def test_cases(self) -> list[dict]:
        return [
            {k: v for k, v in case.items() if k != "correction_prompt"}
            for case in _GENERIC_TEST_CASES
        ]

    def chat(self, scope: PhysicianOwnerScope, update: Any) -> dict:
        if update.origin == "real_patient" or re.search(
            r"\b(?:mrn|medical record number|ssn|date of birth|dob)\b", update.message.casefold()
        ):
            raise SandboxValidationError("Patient data is not allowed in the physician sandbox")
        test_case = (
            next(
                (c for c in _GENERIC_TEST_CASES if c["id"] == update.controlled_test_case_id), None
            )
            if update.mode == "synthetic_case"
            else None
        )
        if update.mode == "synthetic_case" and (update.origin != "synthetic_demo" or not test_case):
            raise SandboxValidationError(
                "Synthetic-case chat requires a controlled synthetic test case"
            )
        representation = self.representation(scope)
        confirmed = representation["sections"]["confirmed_learnings"]
        interests = representation["sections"]["interests"]
        evidence = test_case["facts"] if test_case else [i["title"] for i in interests]
        fallback = {
            "answer": f"Based on your confirmed representation: {confirmed[0]['statement']}"
            if confirmed
            else (
                f"Your confirmed interests include {', '.join(i['title'] for i in interests)}."
                if interests
                else "You have not taught me enough to answer that practice boundary yet."
            ),
            "evidence_summary": evidence,
            "based_on": [f"learning:{l['id']}" for l in confirmed]
            or [f"interest:{i['id']}" for i in interests],
            "coverage": "confirmed_representation" if confirmed or interests else "uncertain",
            "uncertainty": None
            if confirmed or interests
            else "No matching confirmed practice fact is available.",
            "can_train_from_this": True,
        }
        payload = {
            "physician": self.profile(scope)["physician"],
            "mode": update.mode,
            "message": update.message,
            "confirmed_representation": representation["sections"],
            "controlled_synthetic_test_case": {
                k: v for k, v in test_case.items() if k != "correction_prompt"
            }
            if test_case
            else None,
            "allowed_references": sorted(
                {
                    *[f"learning:{item['id']}" for item in confirmed],
                    *[f"interest:{item['id']}" for item in interests],
                    *([f"test_case:{test_case['id']}"] if test_case else []),
                }
            ),
            "safety_boundary": "Confirmed professional state and controlled synthetic scenarios only; no patient data or PHI.",
        }
        result, provider = agent_chat_service.respond(payload, fallback)
        if provider != "responses_api":
            logger.info("physician_sandbox_chat_fallback scope=%s mode=%s", scope.id, update.mode)
        response_id = f"chat-{secrets.token_hex(12)}"
        saved = self.store.save_agent_chat_response(
            *scope.key,
            response_id,
            update.mode,
            test_case["id"] if test_case else None,
            update.model_dump(),
            result,
            provider,
        )
        return {
            **saved,
            "mode": update.mode,
            "controlled_test_case_id": test_case["id"] if test_case else None,
            "synthetic_only": True,
        }

    def chat_feedback(self, scope: PhysicianOwnerScope, response_id: str, feedback: str) -> dict:
        response = self.store.agent_chat_response(*scope.key, response_id)
        if not response:
            raise SandboxResourceNotFoundError("Agent chat response not found")
        self.store.set_agent_chat_feedback(*scope.key, response_id, feedback)
        seed = None
        if feedback == "not_quite":
            case = next(
                (c for c in _GENERIC_TEST_CASES if c["id"] == response.get("test_case_id")), None
            )
            prompt = (
                case["correction_prompt"]
                if case
                else "Does this response reflect how you would usually handle this practice boundary?"
            )
            digest = hashlib.sha256(
                f"{scope.physician_id}:{response_id}:{prompt}".encode()
            ).hexdigest()[:12]
            question = normalize_question(
                {
                    "id": f"{scope.physician_id}-focused-{digest}",
                    "physician_persona": scope.physician_id,
                    "source_type": "agent_chat_correction",
                    "source_reference": f"agent-chat:{response_id}",
                    "prompt": prompt,
                    "question_type": "yes_no_depends",
                    "answer_options": ["Yes", "Depends", "No"],
                    "why_this_matters": "Corrects one focused gap in the agent's practice representation.",
                    "dimension_being_narrowed": case["intended_domain"] if case else "practice_fit",
                    "question_objective": "Resolve the practice boundary exposed by agent testing.",
                    "terminal": False,
                    "synthetic": True,
                    "created_at": BASE_TIMESTAMP,
                }
            )
            seed = self.store.create_focused_training_seed(
                *scope.key, f"seed-{secrets.token_hex(10)}", response_id, question
            )
        return {"response_id": response_id, "feedback": feedback, "focused_training_seed": seed}

    def posts(self, scope: PhysicianOwnerScope) -> list[dict]:
        return self.store.practice_updates(*scope.key)

    def create_post(
        self, scope: PhysicianOwnerScope, update: Any, *, drafted: bool = False
    ) -> dict:
        if update.type not in POST_TYPES:
            raise SandboxValidationError("Unsupported professional post type")
        if update.case_origin == "real_patient":
            raise SandboxValidationError("Real-patient posts are disabled")
        if update.type == "interesting_case" and update.case_origin != "synthetic_demo":
            raise SandboxValidationError(
                "Interesting-case drafts require an explicitly synthetic scenario"
            )
        return self.store.create_practice_update(
            *scope.key,
            update.type,
            update.title,
            update.body,
            "physician_private_draft",
            agent_drafted=drafted,
            source_input=getattr(update, "source_material", None),
            synthetic_case=update.case_origin == "synthetic_demo",
            case_safety_label="Synthetic scenario — no real patient data"
            if update.case_origin == "synthetic_demo"
            else None,
            visibility="private",
        )

    def draft_post(self, scope: PhysicianOwnerScope, update: Any) -> dict:
        draft = post_draft_service.draft_for_identity(
            scope.provider_identity, update.type, update.source_material
        )
        payload = type(
            "Draft",
            (),
            {
                "type": update.type,
                "title": draft["title"],
                "body": draft["body"],
                "case_origin": update.case_origin,
                "source_material": update.source_material,
            },
        )()
        return self.create_post(scope, payload, drafted=True)

    def edit_post(self, scope: PhysicianOwnerScope, post_id: int, update: Any) -> dict:
        post = self.store.edit_practice_update(
            *scope.key,
            post_id,
            update.type,
            update.title,
            update.body,
            synthetic_case=update.case_origin == "synthetic_demo" if update.case_origin else None,
        )
        if not post:
            raise SandboxResourceNotFoundError("Private draft post not found")
        return post

    def archive_post(self, scope: PhysicianOwnerScope, post_id: int) -> dict:
        post = self.store.practice_update(*scope.key, post_id)
        if not post:
            raise SandboxResourceNotFoundError("Private draft post not found")
        return self.store.set_practice_update_status(*scope.key, post_id, "archived")

    def publish_post(self, scope: PhysicianOwnerScope, post_id: int) -> None:
        if not self.store.practice_update(*scope.key, post_id):
            raise SandboxResourceNotFoundError("Private draft post not found")
        raise PublicationNotEligibleError(
            "Private physician sandboxes are not eligible for network publication"
        )
