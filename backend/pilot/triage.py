"""Referral/intake triage: practice fit, readiness, missing information, priority,
modality, and next step. NOT diagnosis or treatment.

Order of operations (each later step can only ADD proposals, never override an
earlier deterministic result):

1. Select the practice's operational rules (confirmed / inferred-active) for the
   referral type from the canonical rule store.
2. Deterministic requirement checks against structured submitted items
   (presence + freshness).
3. Deterministic document search: a document mention is only a *proposal* with
   page provenance; it never satisfies a requirement.
4. Optional LLM extraction for still-missing items -- validated so the quoted
   evidence must appear verbatim on the cited page, and still only a proposal.
5. Schema validation of the result; anything unknown stays missing / needs a human.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol

from backend.config import environment

from .models import (
    IntakeReferral,
    PracticeRule,
    RationaleItem,
    RationaleSource,
    RequirementAssessment,
    TriageRecommendation,
)
from .rules import rules_snapshot
from .store import new_id, now_iso

_STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "are", "was", "has", "have",
    "not", "any", "all", "who", "of", "to", "in", "on", "or", "a", "an", "be", "is",
    "patients", "patient", "referral", "referrals", "recent", "within", "last", "at",
    "as", "by", "it", "per", "please", "evaluate", "evaluation", "see",
}
FIT_MATCH_THRESHOLD = 0.75


@dataclass(frozen=True)
class DocumentText:
    document_id: str
    filename: str
    pages: list[str]


@dataclass(frozen=True)
class EvidenceProposal:
    key: str
    document_id: str
    page: int
    quote: str


class EvidenceExtractor(Protocol):
    model_id: str

    def propose(
        self, requirements: list[dict[str, str]], documents: list[DocumentText]
    ) -> list[EvidenceProposal]: ...


def _tokens(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", text.casefold())
        if (len(token) >= 2 or token.isdigit()) and token not in _STOPWORDS
    }


def _phrase_match(phrase: str, haystack_tokens: set[str]) -> tuple[bool, list[str]]:
    wanted = _tokens(phrase)
    if not wanted:
        return False, []
    hits = sorted(wanted & haystack_tokens)
    # Numbers are discriminating ("type 1" vs "type 2", "stage 4"): all must match.
    numbers_match = all(token in haystack_tokens for token in wanted if token.isdigit())
    return numbers_match and len(hits) / len(wanted) >= FIT_MATCH_THRESHOLD, hits


def _normalize_ws(text: str) -> str:
    return " ".join(text.split()).casefold()


def _is_fresh(observed: str | None, freshness_days: int | None, today: date) -> bool:
    if freshness_days is None:
        return True
    if observed is None:
        return False
    return (today - date.fromisoformat(observed)).days <= freshness_days


def _document_mention(label: str, key: str, documents: list[DocumentText]) -> RationaleSource | None:
    wanted = _tokens(label) or _tokens(key.replace("_", " "))
    if not wanted:
        return None
    for document in documents:
        for index, page in enumerate(document.pages, start=1):
            if wanted <= _tokens(page):
                line = next(
                    (
                        candidate.strip()
                        for candidate in page.splitlines()
                        if wanted & _tokens(candidate)
                    ),
                    page.strip()[:200],
                )
                return RationaleSource(
                    kind="document", document_id=document.document_id, page=index,
                    quote=line[:300], item_key=key,
                )
    return None


def _validated_proposals(
    proposals: list[EvidenceProposal], documents: list[DocumentText], allowed_keys: set[str]
) -> dict[str, RationaleSource]:
    """Drop any proposal whose quote is not verbatim on the cited page."""
    by_id = {document.document_id: document for document in documents}
    accepted: dict[str, RationaleSource] = {}
    for proposal in proposals:
        document = by_id.get(proposal.document_id)
        if (
            proposal.key not in allowed_keys
            or proposal.key in accepted
            or document is None
            or not 1 <= proposal.page <= len(document.pages)
            or len(_normalize_ws(proposal.quote)) < 4
            or _normalize_ws(proposal.quote) not in _normalize_ws(document.pages[proposal.page - 1])
        ):
            continue
        accepted[proposal.key] = RationaleSource(
            kind="document", document_id=proposal.document_id, page=proposal.page,
            quote=proposal.quote.strip()[:300], item_key=proposal.key,
        )
    return accepted


def triage_referral(
    referral: IntakeReferral,
    rules: list[PracticeRule],
    documents: list[DocumentText],
    *,
    today: date | None = None,
    extractor: EvidenceExtractor | None = None,
) -> tuple[TriageRecommendation, dict[str, Any]]:
    """Pure function: returns the recommendation and the rules snapshot it used."""
    reference_day = today or datetime.now(UTC).date()
    snapshot_id, snapshot = rules_snapshot(rules)
    rationale: list[RationaleItem] = []
    # Criteria are matched against the clinical text only; the referral-type label
    # selects which rules apply and must not inflate fit or urgency matches.
    text_tokens = _tokens(" ".join(filter(None, [referral.reason, referral.clinical_context])))

    def rule_source(rule: PracticeRule) -> RationaleSource:
        return RationaleSource(kind="practice_rule", rule_id=rule.id, rule_version=rule.version)

    # ---------------------------------------------------------------- fit
    if not rules:
        fit = "unknown"
        rationale.append(RationaleItem(
            statement=(
                f"No confirmed practice rule covers “{referral.referral_type}”, so fit and "
                "required information cannot be assessed automatically."
            ),
            source=RationaleSource(kind="no_rule"),
        ))
    else:
        outside = [
            (rule, phrase, hits) for rule in rules for phrase in rule.content.redirect
            for matched, hits in [_phrase_match(phrase, text_tokens)] if matched
        ]
        good = [
            (rule, phrase, hits) for rule in rules for phrase in rule.content.good_fit
            for matched, hits in [_phrase_match(phrase, text_tokens)] if matched
        ]
        if outside:
            fit = "outside_scope"
            for rule, phrase, hits in outside:
                rationale.append(RationaleItem(
                    statement=f"Referral text matches your outside-scope criterion “{phrase}” "
                              f"(matched: {', '.join(hits)}).",
                    source=rule_source(rule),
                ))
        elif good:
            fit = "strong"
            for rule, phrase, hits in good:
                rationale.append(RationaleItem(
                    statement=f"Referral text matches your fit criterion “{phrase}” "
                              f"(matched: {', '.join(hits)}).",
                    source=rule_source(rule),
                ))
        else:
            fit = "possible"
            rationale.append(RationaleItem(
                statement=(
                    f"Your rule for “{rules[0].referral_type}” applies, but the referral text "
                    "does not clearly match any stated fit or outside-scope criterion."
                ),
                source=rule_source(rules[0]),
            ))

    # -------------------------------------------------------- requirements
    requirements: list[RequirementAssessment] = []
    seen: set[str] = set()
    submitted = {item.key: item for item in referral.submitted_items}
    pending_lookup: list[tuple[int, Any, PracticeRule]] = []
    for rule in rules:
        for requirement in [*rule.content.required, *rule.content.helpful]:
            if requirement.key in seen:
                continue
            seen.add(requirement.key)
            item = submitted.get(requirement.key)
            if item is not None and item.value.strip() and _is_fresh(
                item.observed_date, requirement.freshness_days, reference_day
            ):
                evidence = RationaleSource(
                    kind="document" if item.source == "document_confirmed" else "submitted_item",
                    item_key=item.key, document_id=item.document_id, page=item.page,
                )
                requirements.append(RequirementAssessment(
                    key=requirement.key, label=requirement.label, required=requirement.required,
                    freshness_days=requirement.freshness_days, state="satisfied",
                    rule_id=rule.id, rule_version=rule.version, evidence=evidence,
                    detail=f"Provided ({item.source.replace('_', ' ')})"
                           + (f", dated {item.observed_date}" if item.observed_date else ""),
                ))
                continue
            if item is not None and requirement.freshness_days is not None:
                detail = (
                    "Provided without a date, so recency cannot be confirmed"
                    if not item.observed_date
                    else f"Provided, but older than {requirement.freshness_days} days"
                )
            else:
                detail = "Not found in the submitted referral"
            requirements.append(RequirementAssessment(
                key=requirement.key, label=requirement.label, required=requirement.required,
                freshness_days=requirement.freshness_days,
                state="missing" if requirement.required else "optional_missing",
                rule_id=rule.id, rule_version=rule.version, detail=detail,
            ))
            pending_lookup.append((len(requirements) - 1, requirement, rule))

    # Deterministic document mentions -> proposals only.
    for index, requirement, _rule in pending_lookup:
        mention = _document_mention(requirement.label, requirement.key, documents)
        if mention is not None:
            requirements[index] = requirements[index].model_copy(update={
                "state": "proposed_from_document", "evidence": mention,
                "detail": f"Possibly in a document (page {mention.page}); needs confirmation",
            })

    generator, model_id = "deterministic", None
    still_missing = [
        (index, requirement) for index, requirement, _ in pending_lookup
        if requirements[index].state in {"missing", "optional_missing"}
    ]
    if extractor is not None and documents and still_missing:
        generator, model_id = "deterministic+llm_extraction", extractor.model_id
        try:
            proposals = extractor.propose(
                [{"key": requirement.key, "label": requirement.label}
                 for _, requirement in still_missing],
                documents,
            )
        except Exception:  # noqa: BLE001 -- extraction is optional; failure leaves items missing
            proposals = []
        validated = _validated_proposals(
            proposals, documents, {requirement.key for _, requirement in still_missing}
        )
        for index, requirement in still_missing:
            evidence = validated.get(requirement.key)
            if evidence is not None:
                requirements[index] = requirements[index].model_copy(update={
                    "state": "proposed_from_document", "evidence": evidence,
                    "detail": f"Model-extracted from a document (page {evidence.page}); "
                              "needs confirmation",
                })

    for requirement in requirements:
        if requirement.state == "satisfied":
            continue
        rationale.append(RationaleItem(
            statement=f"{requirement.label}: {requirement.detail}."
                      + ("" if requirement.required else " (helpful, not required)"),
            source=requirement.evidence
            if requirement.state == "proposed_from_document"
            else RationaleSource(
                kind="requirement_logic", rule_id=requirement.rule_id,
                rule_version=requirement.rule_version, item_key=requirement.key,
            ),
        ))

    required_open = [item for item in requirements if item.required and item.state != "satisfied"]
    proposed = [item for item in requirements if item.state == "proposed_from_document"]
    if not rules:
        readiness = "unknown"
    elif required_open:
        readiness = "missing_information"
    else:
        readiness = "ready"
    if rules and not required_open:
        rationale.append(RationaleItem(
            statement="Every required item in your rule is present and recent enough.",
            source=RationaleSource(
                kind="requirement_logic", rule_id=rules[0].id, rule_version=rules[0].version
            ),
        ))

    # ------------------------------------------------------------ priority
    urgent_hits = [
        (rule, phrase) for rule in rules for phrase in rule.content.urgent_signals
        if _phrase_match(phrase, text_tokens)[0]
    ]
    if urgent_hits:
        priority = "urgent"
        for rule, phrase in urgent_hits:
            rationale.append(RationaleItem(
                statement=f"Matches your urgency signal “{phrase}”.", source=rule_source(rule)
            ))
    elif referral.sender_priority:
        priority = referral.sender_priority
        rationale.append(RationaleItem(
            statement=f"The referring clinician marked this {referral.sender_priority}.",
            source=RationaleSource(kind="submitted_item", item_key="sender_priority"),
        ))
    else:
        priority = "routine"
    if referral.sender_priority == "urgent":
        priority = "urgent"  # Never downgrade a sender's urgent flag automatically.

    # ------------------------------------------------------------ modality
    modalities = {rule.content.modality for rule in rules if rule.content.modality != "unspecified"}
    modality = modalities.pop() if len(modalities) == 1 else "unspecified"
    if modality != "unspecified":
        source_rule = next(rule for rule in rules if rule.content.modality == modality)
        rationale.append(RationaleItem(
            statement=f"Your rule sets the default modality to {modality.replace('_', '-')}.",
            source=rule_source(source_rule),
        ))

    # ---------------------------------------------------- next step / flags
    requires_physician = fit != "strong" or priority == "urgent" or readiness == "unknown"
    if fit == "outside_scope":
        next_step = "consider_redirect"
    elif proposed and any(item.required for item in proposed):
        next_step = "confirm_document_evidence"
    elif required_open:
        next_step = "request_information"
    else:
        next_step = "physician_review"

    recommendation = TriageRecommendation(
        id=new_id("rec"),
        referral_id=referral.id,
        practice_id=referral.practice_id,
        fit=fit,
        readiness=readiness,
        requirements=requirements,
        missing_items=[item.label for item in required_open],
        suggested_priority=priority,
        suggested_modality=modality,
        requires_physician=requires_physician,
        next_step=next_step,
        rationale=rationale,
        generator=generator,
        model_id=model_id,
        rules_snapshot_id=snapshot_id,
        created_at=now_iso(),
    )
    return TriageRecommendation.model_validate(recommendation.model_dump()), snapshot


# --------------------------------------------------------------- LLM adapter

_EXTRACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["proposals"],
    "properties": {
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["key", "document_id", "page", "quote"],
                "properties": {
                    "key": {"type": "string"},
                    "document_id": {"type": "string"},
                    "page": {"type": "integer"},
                    "quote": {"type": "string"},
                },
            },
        }
    },
}
_EXTRACTION_INSTRUCTIONS = (
    "You locate evidence for referral intake requirements in referral documents. "
    "For each requirement, return a proposal ONLY if the document text contains it, "
    "quoting the exact supporting text verbatim from the cited page. Never infer, "
    "summarize, or guess. Return no proposal when unsure. Do not give clinical advice."
)


def llm_extraction_enabled() -> bool:
    """Separate, default-off switch: sending referral documents to a model provider is
    a PHI disclosure and requires a BAA/zero-retention agreement first."""
    return environment.get("LAMINA_PILOT_LLM_EXTRACTION_ENABLED", "false").strip().casefold() in {
        "1", "true", "yes", "on",
    }


class ResponsesEvidenceExtractor:
    def __init__(self, client: Any) -> None:
        self.client = client
        self.model_id = getattr(client, "model", "") or "unknown"

    def propose(
        self, requirements: list[dict[str, str]], documents: list[DocumentText]
    ) -> list[EvidenceProposal]:
        result = self.client.structured(
            _EXTRACTION_INSTRUCTIONS,
            {
                "requirements": requirements,
                "documents": [
                    {"document_id": document.document_id, "pages": [
                        {"page": index, "text": text[:6000]}
                        for index, text in enumerate(document.pages, start=1)
                    ]}
                    for document in documents
                ],
            },
            _EXTRACTION_SCHEMA,
            use_case="pilot_referral_evidence_extraction",
            schema_name="referral_evidence",
        )
        return [
            EvidenceProposal(
                key=str(item["key"]), document_id=str(item["document_id"]),
                page=int(item["page"]), quote=str(item["quote"]),
            )
            for item in result.get("proposals", [])
            if isinstance(item, dict)
        ]


def default_extractor() -> EvidenceExtractor | None:
    if not llm_extraction_enabled():
        return None
    from backend.professional_services import ResponsesApiClient

    client = ResponsesApiClient()
    return ResponsesEvidenceExtractor(client) if client.available else None
