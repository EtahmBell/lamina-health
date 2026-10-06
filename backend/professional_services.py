"""Optional Responses API services with deterministic, no-network fallbacks."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from time import perf_counter
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
    "lucy": [
        ("clinical_interests", "Primary-care specialty coordination"),
        ("teaching", "Teaching on longitudinal care transitions"),
        ("experience", "Care-coordination background"),
    ],
}


class ResponsesApiClient:
    """Lazy backend-only OpenAI SDK adapter; never required during app boot."""

    def __init__(
        self,
        sdk_client: Any | None = None,
        *,
        enabled: bool | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = environment.get("OPENAI_API_KEY", "")
        self.model = (model or environment.get("LAMINA_OPENAI_MODEL", "")).strip()
        configured = environment.get(
            "LAMINA_OPENAI_ENABLED",
            environment.get("LAMINA_RESPONSES_ENABLED", "false"),
        )
        self.enabled = _enabled(configured) if enabled is None else enabled
        self._sdk_client = sdk_client

    @property
    def available(self) -> bool:
        return bool(self.enabled and self.model and (self.api_key or self._sdk_client))

    def _client(self) -> Any:
        if self._sdk_client is None:
            from openai import OpenAI

            self._sdk_client = OpenAI(api_key=self.api_key, timeout=20.0, max_retries=1)
        return self._sdk_client

    def structured(
        self,
        instructions: str,
        payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        use_case: str,
        schema_name: str,
        web_search: bool = False,
    ) -> dict:
        if not self.available:
            raise RuntimeError("AI service is not configured")
        started = perf_counter()
        try:
            response = self._client().responses.create(
                model=self.model,
                instructions=instructions,
                input=json.dumps(payload),
                tools=[{"type": "web_search"}] if web_search else [],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": schema_name,
                        "strict": True,
                        "schema": schema,
                    }
                },
            )
            output_text = getattr(response, "output_text", None)
            if output_text is None and isinstance(response, dict):
                output_text = response.get("output_text")
            if not isinstance(output_text, str):
                raise TypeError("No structured response output")
            result = json.loads(output_text)
            logger.info(
                "lamina_ai_call",
                extra={
                    "use_case": use_case,
                    "success": True,
                    "model": self.model,
                    "latency_ms": round((perf_counter() - started) * 1000),
                    "fallback_used": False,
                },
            )
            return result
        except Exception as error:
            logger.warning(
                "lamina_ai_call",
                extra={
                    "use_case": use_case,
                    "success": False,
                    "model": self.model,
                    "latency_ms": round((perf_counter() - started) * 1000),
                    "fallback_used": True,
                    "error_type": type(error).__name__,
                },
            )
            raise RuntimeError("AI service is temporarily unavailable") from error


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
        if self.client.available:
            try:
                result = self.client.structured(
                    """Draft a concise professional post using only supplied facts. Do not
                    invent credentials, outcomes, study conclusions, referral rules, or
                    rankings. For a paper, distinguish the supplied citation from the
                    physician's own note. The physician remains the author.""",
                    {"physician": PERSONAS[persona_id], "post_type": post_type, "source": source},
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
        "question_type": {"type": "string", "enum": ["yes_no_depends", "yes_no"]},
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
            ["Yes", "No"]
            if candidate.get("question_type") == "yes_no"
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
                    candidate.get("question_type") == "yes_no"
                    and candidate.get("terminal_candidate") is True
                )
            )
        )

    def generate(self, context: dict, assigned_ids: set[str]) -> tuple[dict | None, str]:
        if self.client.available:
            try:
                candidate = self.client.structured(
                    """Generate exactly one narrower practice-calibration question after a
                    physician answered Depends. Stay within the stated objective, dimension,
                    practice representation, and supplied synthetic facts. Do not diagnose,
                    recommend treatment, add patient facts, request identifiers, or reveal
                    reasoning. Prefer yes_no_depends; use yes_no for a terminal boundary.""",
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


profile_enrichment_service = ProfileEnrichmentService()
post_draft_service = PostDraftService()
training_branch_service = TrainingBranchService()
