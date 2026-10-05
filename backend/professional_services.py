"""Optional AI boundaries with deterministic, no-network demo fallbacks."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import httpx

from backend.config import environment
from backend.engagement import PERSONAS


def _enabled(value: str) -> bool:
    return value.strip().casefold() in {"1", "true", "yes", "on"}


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
    """Small backend-only Responses API client; never required during boot."""

    def __init__(self) -> None:
        self.api_key = environment.get("OPENAI_API_KEY", "")
        self.model = environment.get("LAMINA_OPENAI_MODEL", "").strip()
        self.enabled = _enabled(environment.get("LAMINA_RESPONSES_ENABLED", "false"))

    @property
    def available(self) -> bool:
        return bool(self.enabled and self.api_key and self.model)

    def structured(
        self,
        instructions: str,
        payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        web_search: bool = False,
    ) -> dict:
        if not self.available:
            raise RuntimeError("AI service is not configured")
        try:
            response = httpx.post(
                "https://api.openai.com/v1/responses",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "instructions": instructions,
                    "input": json.dumps(payload),
                    "tools": [{"type": "web_search"}] if web_search else [],
                    "text": {
                        "format": {
                            "type": "json_schema",
                            "name": "lamina_professional_content",
                            "strict": True,
                            "schema": schema,
                        }
                    },
                },
                timeout=20,
            )
            response.raise_for_status()
            data = response.json()
            text = data.get("output_text") or next(
                (
                    content.get("text")
                    for item in data.get("output", [])
                    if item.get("type") == "message"
                    for content in item.get("content", [])
                    if content.get("type") == "output_text"
                ),
                None,
            )
            if not isinstance(text, str):
                raise TypeError("No structured response")
            return json.loads(text)
        except Exception as error:
            raise RuntimeError("AI service is temporarily unavailable") from error


class ProfileEnrichmentService:
    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    def candidates(self, persona_id: str) -> tuple[str, list[dict], str | None]:
        # Controlled personas intentionally use controlled facts, even when AI is configured.
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

    def public_candidates(self, identity: dict[str, str]) -> list[dict]:
        """Research a future verified identity, retaining candidates only."""
        required = {"full_name", "specialty", "geography"}
        if not required.issubset(identity) or not (
            identity.get("npi") or identity.get("institution")
        ):
            raise ValueError("Strong physician identity context is required")
        candidate_schema = {
            "type": "object",
            "properties": {
                "candidates": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "category": {"type": "string"},
                            "proposed_title": {"type": "string"},
                            "proposed_detail": {"type": "string"},
                            "source_title": {"type": "string"},
                            "source_url": {"type": "string"},
                            "confidence": {"type": "string"},
                        },
                        "required": [
                            "category",
                            "proposed_title",
                            "proposed_detail",
                            "source_title",
                            "source_url",
                            "confidence",
                        ],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["candidates"],
            "additionalProperties": False,
        }
        result = self.client.structured(
            """Find public professional facts only when every supplied identity
            signal matches. Exclude ambiguous people. Return unconfirmed candidate
            facts, never verified claims.""",
            identity,
            candidate_schema,
            web_search=True,
        )
        return result["candidates"]


class PostDraftService:
    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    def draft(self, persona_id: str, post_type: str, source: dict[str, Any]) -> dict:
        if self.client.available:
            try:
                result = self.client.structured(
                    """Format only the supplied physician facts as a concise professional post.
                    Do not invent credentials, results, clinical claims, identifiers,
                    endorsements, acceptance rules, or rankings. Return JSON with title and body.""",
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
                )
                if result.get("title") and result.get("body"):
                    return {
                        "title": result["title"],
                        "body": result["body"],
                        "provider": "responses_api",
                    }
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


profile_enrichment_service = ProfileEnrichmentService()
post_draft_service = PostDraftService()
