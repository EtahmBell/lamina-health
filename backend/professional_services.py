"""Optional Responses API services with deterministic, no-network fallbacks."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from backend.config import environment
from backend.engagement import (
    MAX_BRANCH_DEPTH,
    PERSONAS,
    PROFILE_CATEGORIES,
    deterministic_branch_question,
)

logger = logging.getLogger(__name__)


def _enabled(value: str) -> bool:
    return value.strip().casefold() in {"1", "true", "yes", "on"}


def _log_validation_fallback(use_case: str, model: str) -> None:
    logger.warning(
        "lamina_ai_call",
        extra={
            "use_case": use_case,
            "success": False,
            "model": model,
            "latency_ms": 0,
            "fallback_used": True,
            "error_type": "output_validation",
        },
    )


DEMO_ENRICHMENT = {
    "iain": [
        ("training", "Synthetic nephrology training background"),
        ("research", "Cardiorenal medicine research interest"),
        ("publications", "Synthetic publication on resistant hypertension"),
        ("teaching", "Clinical teaching in CKD referral assessment"),
        ("clinical_interests", "Progressive CKD and resistant hypertension"),
    ],
    "chen": [
        ("training", "Synthetic endocrinology training background"),
        ("research", "Type 2 diabetes treatment intensification research interest"),
        ("teaching", "Clinical teaching in complex diabetes management"),
        ("clinical_interests", "Complex diabetes and metabolic disease"),
    ],
    "lucy": [
        ("clinical_interests", "Primary-care specialty coordination"),
        ("teaching", "Teaching on longitudinal care transitions"),
        ("experience", "Care-coordination background"),
    ],
}


class ResponsesApiClient:
    """The existing model wrapper, now over one provider interface (backend/model_provider.py):
    OpenAI (Responses API, never stored), Anthropic Claude via Amazon Bedrock, or disabled.
    Callers say whether a call carries patient data; production refuses such a call unless the
    provider is approved for patient data (BAA). Lazy: never required during app boot."""

    def __init__(
        self,
        sdk_client: Any | None = None,
        *,
        enabled: bool | None = None,
        model: str | None = None,
        provider: Any | None = None,
    ) -> None:
        from backend.model_provider import (
            configured_provider_name,
            provider_from_environment,
        )

        self.api_key = environment.get("OPENAI_API_KEY", "")
        self.model = (model or environment.get("LAMINA_OPENAI_MODEL", "")).strip()
        explicit = environment.get("LAMINA_MODEL_PROVIDER", "").strip().casefold()
        configured = environment.get(
            "LAMINA_OPENAI_ENABLED",
            environment.get("LAMINA_RESPONSES_ENABLED", "false"),
        )
        default_enabled = (explicit == "openai") if explicit else _enabled(configured)
        self.enabled = default_enabled if enabled is None else enabled
        self._sdk_client = sdk_client
        self._explicit_provider = provider
        # An explicit provider wins outright: the environment's provider setting is not consulted.
        self._openai = provider is None and (sdk_client is not None or enabled is not None or model is not None
                                             or configured_provider_name() == "openai")
        self._environment_provider = None if self._openai or provider is not None else provider_from_environment()

    @property
    def provider(self) -> Any:
        """Resolved from the current settings (callers and tests may change enabled/model/api_key)."""
        from backend.model_provider import OpenAIProvider

        if self._explicit_provider is not None:
            return self._explicit_provider
        if self._openai or self.enabled:
            return OpenAIProvider(self._sdk_client, model=self.model, api_key=self.api_key, enabled=self.enabled)
        return self._environment_provider

    @property
    def available(self) -> bool:
        return bool(self.provider.available)

    def structured(
        self,
        instructions: str,
        payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        use_case: str,
        schema_name: str,
        web_search: bool = False,
        contains_patient_data: bool = False,
    ) -> dict:
        from backend.model_provider import guarded_call

        return guarded_call(self.provider, instructions, payload, schema, use_case=use_case, schema_name=schema_name,
                            contains_patient_data=contains_patient_data, web_search=web_search)


_CANDIDATE_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "proposed_title": {"type": "string"},
                    "proposed_detail": {"type": ["string", "null"]},
                    "source_title": {"type": "string"},
                    "source_url": {"type": "string"},
                    "identity_confidence": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                    },
                },
                "required": [
                    "category",
                    "proposed_title",
                    "proposed_detail",
                    "source_title",
                    "source_url",
                    "identity_confidence",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["candidates"],
    "additionalProperties": False,
}


class ProfileEnrichmentService:
    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    @staticmethod
    def _deterministic(persona_id: str) -> tuple[str, list[dict], str | None]:
        now = datetime.now(UTC).isoformat(timespec="seconds")
        candidates = [
            {
                "candidate_id": f"{persona_id}-enrichment-{index}",
                "category": category,
                "proposed_title": title,
                "proposed_detail": "Controlled fixture for profile-review UX.",
                "source_type": "synthetic_demo",
                "source_title": "Synthetic demo source",
                "source_url": None,
                "retrieved_at": now,
                "model_generated_summary": False,
                "confidence": "controlled_demo",
            }
            for index, (category, title) in enumerate(DEMO_ENRICHMENT[persona_id], start=1)
        ]
        return "deterministic_demo", candidates, None

    def candidates(self, persona_id: str) -> tuple[str, list[dict], str | None]:
        if self.client.available:
            try:
                candidates = self.public_candidates(
                    {
                        "full_name": PERSONAS[persona_id]["name"],
                        "npi": PERSONAS[persona_id]["npi"] or "synthetic-pcp",
                        "specialty": PERSONAS[persona_id]["specialty"],
                        "geography": PERSONAS[persona_id]["location"],
                        "identity_note": "Controlled synthetic demo identity",
                    }
                )
                if candidates:
                    return "responses_api", candidates, None
                _log_validation_fallback("profile_enrichment", self.client.model)
            except (RuntimeError, ValueError):
                pass
        return self._deterministic(persona_id)

    def public_candidates(self, identity: dict[str, str]) -> list[dict]:
        """Research a controlled or future verified identity, retaining candidates only."""
        required = {"full_name", "specialty", "geography"}
        if not required.issubset(identity) or not (
            identity.get("npi") or identity.get("institution")
        ):
            raise ValueError("Strong physician identity context is required")
        result = self.client.structured(
            """Research public professional information only when every supplied identity
            signal matches. Omit ambiguous or low-confidence facts. Return candidate facts
            for physician review, never verified claims. Preserve the source page title and
            exact public URL. Do not infer credentials, appointments, or affiliations.""",
            identity,
            _CANDIDATE_SCHEMA,
            use_case="profile_enrichment",
            schema_name="lamina_profile_candidates",
            web_search=True,
        )
        now = datetime.now(UTC).isoformat(timespec="seconds")
        accepted: list[dict] = []
        for index, candidate in enumerate(result.get("candidates", []), start=1):
            parsed = urlparse(str(candidate.get("source_url", "")))
            if (
                candidate.get("identity_confidence") != "high"
                or candidate.get("category") not in PROFILE_CATEGORIES
                or parsed.scheme not in {"http", "https"}
            ):
                continue
            accepted.append(
                {
                    "candidate_id": f"ai-{index}",
                    "category": candidate["category"],
                    "proposed_title": candidate["proposed_title"],
                    "proposed_detail": candidate.get("proposed_detail"),
                    "source_type": "public_web",
                    "source_title": candidate["source_title"],
                    "source_url": candidate["source_url"],
                    "retrieved_at": now,
                    "model_generated_summary": True,
                    "confidence": candidate["identity_confidence"],
                }
            )
        return accepted


class PostDraftService:
    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    def draft(self, persona_id: str, post_type: str, source: dict[str, Any]) -> dict:
        return self.draft_for_identity(PERSONAS[persona_id], post_type, source)

    def draft_for_identity(
        self, physician: dict[str, Any], post_type: str, source: dict[str, Any]
    ) -> dict:
        if self.client.available:
            try:
                result = self.client.structured(
                    """Draft a concise professional post using only supplied facts. Do not
                    invent credentials, outcomes, study conclusions, referral rules, or
                    rankings. For a paper, distinguish the supplied citation from the
                    physician's own note. The physician remains the author.""",
                    {"physician": physician, "post_type": post_type, "source": source},
                    {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "body": {"type": "string"},
                        },
                        "required": ["title", "body"],
                        "additionalProperties": False,
                    },
                    use_case="professional_post_draft",
                    schema_name="lamina_professional_post",
                )
                if result.get("title") and result.get("body"):
                    return {
                        "title": result["title"],
                        "body": result["body"],
                        "provider": "responses_api",
                    }
                _log_validation_fallback("professional_post_draft", self.client.model)
            except RuntimeError:
                pass
        title = str(
            source.get("title") or source.get("citation") or post_type.replace("_", " ").title()
        )
        raw = (
            source.get("note")
            or source.get("guidance")
            or source.get("summary")
            or source.get("text")
        )
        body = str(raw or title)
        if post_type == "interesting_case":
            body = f"Clinical case reflection — Synthetic/demo case. {body}"
        return {"title": title, "body": body, "provider": "deterministic_template"}


_BRANCH_SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "string"},
        "question_type": {"type": "string", "enum": ["yes_no_depends", "short_text"]},
        "answer_options": {"type": "array", "items": {"type": "string"}},
        "why_this_matters": {"type": "string"},
        "dimension_being_narrowed": {"type": "string"},
        "terminal_candidate": {"type": "boolean"},
        "source_references": {"type": "array", "items": {"type": "string"}},
        "source_type": {"type": "string", "enum": ["bounded_practice_context"]},
        "proposed_boundary_rationale": {"type": "string"},
    },
    "required": [
        "question",
        "question_type",
        "answer_options",
        "why_this_matters",
        "dimension_being_narrowed",
        "terminal_candidate",
        "source_references",
        "source_type",
        "proposed_boundary_rationale",
    ],
    "additionalProperties": False,
}


class TrainingBranchService:
    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    @staticmethod
    def valid(candidate: dict, context: dict) -> bool:
        depth = int(context["branch_depth"]) + 1
        expected = (
            []
            if candidate.get("question_type") == "short_text"
            else ["Yes", "Depends", "No"]
        )
        normalized = " ".join(str(candidate.get("question", "")).casefold().split())
        answered = {
            " ".join(str(item).casefold().split())
            for item in [context["parent_question"], *context.get("answered_questions", [])]
        }
        candidate_terms = set(re.findall(r"[a-z]{4,}", normalized))
        semantically_repeated = any(
            candidate_terms
            and len(candidate_terms & set(re.findall(r"[a-z]{4,}", prior)))
            / len(candidate_terms | set(re.findall(r"[a-z]{4,}", prior)))
            >= 0.75
            for prior in answered
        )
        allowed_refs = set(context.get("source_references", []))
        supplied_refs = set(candidate.get("source_references", []))
        bounded_text = json.dumps(context, sort_keys=True).casefold()
        significant = {
            token
            for token in re.findall(r"[a-z]{5,}", normalized)
            if token
            not in {
                "would",
                "patient",
                "practice",
                "appropriate",
                "question",
                "depends",
            }
        }
        grounded_terms = {token for token in significant if token in bounded_text}
        contains_identifier = bool(
            re.search(r"\b(?:mrn|medical record|ssn|date of birth|dob)\b", normalized)
            or re.search(r"\b\d{3}-\d{2}-\d{4}\b", normalized)
        )
        asks_out_of_scope_action = bool(
            re.search(r"\b(?:diagnose|prescribe|start treatment|stop treatment)\b", normalized)
        )
        return bool(
            normalized
            and normalized not in answered
            and not semantically_repeated
            and depth <= MAX_BRANCH_DEPTH
            and candidate.get("answer_options") == expected
            and candidate.get("dimension_being_narrowed") == context.get("dimension")
            and candidate.get("source_type") == "bounded_practice_context"
            and supplied_refs
            and supplied_refs.issubset(allowed_refs)
            and grounded_terms
            and not contains_identifier
            and not asks_out_of_scope_action
            and (
                depth < MAX_BRANCH_DEPTH
                or (
                    candidate.get("question_type") == "short_text"
                    and candidate.get("terminal_candidate") is True
                )
            )
        )

    def generate(self, context: dict, assigned_ids: set[str]) -> tuple[dict | None, str]:
        if self.client.available:
            try:
                candidate = self.client.structured(
                    """Generate exactly one narrower practice-calibration question after a
                    physician indicated the answer depends on context. Stay within the stated
                    objective, dimension, practice representation, and supplied synthetic facts.
                    Do not diagnose, recommend treatment, add patient facts, request
                    identifiers, or reveal reasoning. Prefer yes_no_depends; use short_text
                    (with empty answer_options) only for a terminal boundary that should stop
                    branching rather than ask another forced choice.""",
                    context,
                    _BRANCH_SCHEMA,
                    use_case="training_branch",
                    schema_name="lamina_training_branch",
                )
                if self.valid(candidate, context):
                    return candidate, "responses_api"
                _log_validation_fallback("training_branch", self.client.model)
            except RuntimeError:
                pass
        parent = context["parent"]
        fallback = deterministic_branch_question(context["persona_id"], parent, assigned_ids)
        return fallback, "deterministic_fallback"


_CHAT_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "evidence_summary": {"type": "array", "items": {"type": "string"}},
        "based_on": {"type": "array", "items": {"type": "string"}},
        "coverage": {
            "type": "string",
            "enum": ["represented", "confirmed_representation", "confirmed_training", "uncertain"],
        },
        "uncertainty": {"type": ["string", "null"]},
        "can_train_from_this": {"type": "boolean"},
    },
    "required": [
        "answer",
        "evidence_summary",
        "based_on",
        "coverage",
        "uncertainty",
        "can_train_from_this",
    ],
    "additionalProperties": False,
}


class AgentChatService:
    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    @staticmethod
    def valid(result: dict, allowed_references: set[str]) -> bool:
        answer = str(result.get("answer", ""))
        references = set(result.get("based_on", []))
        contains_identifier = bool(
            re.search(r"\b(?:mrn|medical record|ssn|date of birth|dob)\b", answer.casefold())
            or re.search(r"\b\d{3}-\d{2}-\d{4}\b", answer)
        )
        return bool(
            answer.strip()
            and references.issubset(allowed_references)
            and not contains_identifier
            and result.get("coverage")
            in {"represented", "confirmed_representation", "confirmed_training", "uncertain"}
            and (result.get("coverage") != "uncertain" or result.get("uncertainty"))
        )

    def respond(self, payload: dict, fallback: dict) -> tuple[dict, str]:
        if self.client.available:
            try:
                result = self.client.structured(
                    """Represent only how this physician has configured and trained their
                    Lamina agent. Answer concisely from supplied canonical facts and the
                    optional controlled synthetic scenario. Explicitly state uncertainty
                    when no confirmed representation answers the question. Do not invent
                    preferences, diagnose, give individualized medical advice, promise how
                    the physician would treat a real patient, or expose hidden reasoning.""",
                    payload,
                    _CHAT_SCHEMA,
                    use_case="agent_chat",
                    schema_name="lamina_agent_chat",
                )
                if self.valid(result, set(payload["allowed_references"])):
                    return result, "responses_api"
                _log_validation_fallback("agent_chat", self.client.model)
            except RuntimeError:
                pass
        return fallback, "deterministic_fallback"


profile_enrichment_service = ProfileEnrichmentService()
post_draft_service = PostDraftService()
training_branch_service = TrainingBranchService()
agent_chat_service = AgentChatService()
