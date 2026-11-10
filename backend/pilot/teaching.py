"""Natural-language teaching → proposed operational rule → physician confirm/edit/reject.

A proposal is a row in the canonical rule store with operational_status='inferred'
and physician_confirmed=0: it never affects triage until a physician confirms it.
Ambiguous instructions get exactly one focused clarification question. If nothing
can be structured, the raw text is kept as an unstructured note and can never be
confirmed as a rule — Lamina never invents structure.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from backend.models.referral import ReferralRequirement

from .models import PracticeRule, PracticeRuleContent, PracticeRuleInput
from .practice import PilotError, PracticeContext
from .rules import PracticeRules, RuleConflictError, normalize_referral_type
from .triage import _tokens

logger = logging.getLogger(__name__)
UNASSIGNED_TYPE = "Unassigned"
_GENERIC = {"management", "evaluation", "consult", "consultation", "follow", "up", "care", "new",
            "general", "questions", "question", "issues", "issue", "visit", "clinic", "review"}
_UNITS = {"day": 1, "week": 7, "month": 30, "year": 365}


def _clean_phrase(text: str) -> str:
    text = re.sub(r"\b(usually|typically|generally|normally|really|always|often|first)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"^(a|an|the|any|some)\s+", "", text.strip(" .,;:!"), flags=re.IGNORECASE)
    return " ".join(text.split()).strip(" .,;:!")


def _freshness(sentence: str) -> int | None:
    match = re.search(r"within\s+(?:the\s+)?(?:last\s+|past\s+)?(\d+)\s+(day|week|month|year)s?", sentence, re.IGNORECASE)
    if match:
        return int(match.group(1)) * _UNITS[match.group(2).lower()]
    match = re.search(r"(?:last|past)\s+(\d+)\s+(day|week|month|year)s?", sentence, re.IGNORECASE)
    return int(match.group(1)) * _UNITS[match.group(2).lower()] if match else None


def _specific_tokens(text: str) -> set[str]:
    return _tokens(text) - _GENERIC


def match_referral_type(text: str, known: list[str]) -> str | None:
    words = _specific_tokens(text)
    best, best_score = None, 0.0
    for name in known:
        wanted = _specific_tokens(name)
        if not wanted:
            continue
        score = len(wanted & words) / len(wanted)
        if score > best_score:
            best, best_score = name, score
    return best if best_score >= 0.5 else None


def deterministic_interpret(text: str, known_types: list[str]) -> dict[str, Any]:
    """Pattern-based interpretation. Returns a normalized interpretation dict."""
    content: dict[str, Any] = {"good_fit": [], "outside_scope": [], "required": [], "helpful": [],
                               "urgent_signals": [], "modality": "unspecified", "note": None}
    referral_type = match_referral_type(text, known_types)
    inferred_type = None
    for sentence in re.split(r"(?<=[.!?;])\s+|\n+", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        lowered = sentence.lower()
        if inferred_type is None:
            match = re.search(r"\b(?:for|before (?:reviewing|seeing|accepting)|on)\s+(?:all\s+|any\s+)?([a-z0-9][a-z0-9 /\-]{2,60}?)\s+referrals?\b", lowered)
            if match:
                inferred_type = _clean_phrase(match.group(1))
        if re.search(r"\be-?consults?\b", lowered) and re.search(r"\b(prefer|default|first|start with|route)\b", lowered):
            content["modality"] = "econsult"
            condition = re.search(r"\bfor\s+(.+)$", sentence, re.IGNORECASE)
            if condition:
                content["note"] = f"eConsult first for {_clean_phrase(condition.group(1))}"
            continue
        if re.search(r"\bin[- ]person\b", lowered) and re.search(r"\b(prefer|want|need|default|always)\b", lowered):
            content["modality"] = "in_person"
            continue
        outside = re.search(r"\b(?:don'?t|do not|doesn'?t|never|no longer|not)\s+(?:usually\s+|typically\s+|generally\s+)?(?:see|take|accept|manage|handle|treat)\s+(.+)$", sentence, re.IGNORECASE) \
            or re.search(r"(.+?)\s+(?:is|are)\s+outside (?:my|our) scope", sentence, re.IGNORECASE)
        if outside:
            phrase = _clean_phrase(outside.group(1))
            if phrase:
                content["outside_scope"].append(phrase)
            continue
        urgent = re.search(r"\b(?:urgent(?:ly)?|prioriti[sz]e|expedite|fast[- ]track)\b.*?\b(?:if|when|for|any)\s+(.+)$", sentence, re.IGNORECASE)
        if urgent:
            content["urgent_signals"].append(_clean_phrase(urgent.group(1)))
            continue
        required = re.search(r"\b(?:want|need|require|requires|must have|expect|ask for|always get)\b\s+(?:to see\s+|to have\s+)?(.+?)(?:\s+\b(?:before|prior to|with|for|on)\b.*)?$", sentence, re.IGNORECASE)
        if required:
            phrase = _clean_phrase(re.sub(r"\bwithin\b.*$", "", required.group(1), flags=re.IGNORECASE))
            if phrase and len(phrase) <= 80:
                helpful = bool(re.search(r"\b(nice to have|helpful|if available|ideally)\b", lowered))
                key = "_".join(sorted(_tokens(phrase))) or "item"
                item = {"key": key[:80], "label": phrase[:1].upper() + phrase[1:], "required": not helpful,
                        "freshness_days": _freshness(sentence)}
                content["helpful" if helpful else "required"].append(item)
            continue
        good = re.search(r"\b(?:i (?:do |also )?see|we see|happy to see|interested in|good fit(?: for)?|i (?:like|love) to see|i take)\b\s+(.+)$", sentence, re.IGNORECASE)
        if good:
            content["good_fit"].append(_clean_phrase(good.group(1)))
    structured = any(content[key] for key in ("good_fit", "outside_scope", "required", "helpful", "urgent_signals")) \
        or content["modality"] != "unspecified"
    if referral_type is None and inferred_type:
        referral_type = match_referral_type(inferred_type, known_types) or inferred_type[:1].upper() + inferred_type[1:]
        confidence = 0.5
    else:
        confidence = 0.7 if referral_type else 0.3
    clarification = None
    if structured and not referral_type:
        clarification = {
            "question": "Which kind of referral should this apply to?",
            "options": known_types,
        }
    return {
        "referral_type": referral_type,
        "content": content,
        "structured": structured,
        "confidence": confidence if structured else 0.0,
        "clarification": clarification,
        "interpreter": "deterministic",
    }


_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["referral_type", "good_fit", "outside_scope", "required", "helpful", "urgent_signals",
                 "modality", "clarification_question", "confidence"],
    "properties": {
        "referral_type": {"type": ["string", "null"]},
        "good_fit": {"type": "array", "items": {"type": "string"}},
        "outside_scope": {"type": "array", "items": {"type": "string"}},
        "required": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                 "required": ["label", "freshness_days"],
                                                 "properties": {"label": {"type": "string"},
                                                                "freshness_days": {"type": ["integer", "null"]}}}},
        "helpful": {"type": "array", "items": {"type": "string"}},
        "urgent_signals": {"type": "array", "items": {"type": "string"}},
        "modality": {"type": "string", "enum": ["in_person", "econsult", "either", "unspecified"]},
        "clarification_question": {"type": ["string", "null"]},
        "confidence": {"type": "number"},
    },
}
_INSTRUCTIONS = (
    "Convert a specialist's instruction about how they want to receive REFERRALS into a structured "
    "intake rule. Only extract what the text explicitly says; never add items, criteria, or timeframes "
    "that are not stated. referral_type must be one of the provided existing types when one applies; "
    "otherwise null with a single short clarification_question. This is intake triage, not clinical advice."
)


def _grounded(phrase: str, source_tokens: set[str]) -> bool:
    wanted = _tokens(phrase)
    return bool(wanted) and len(wanted & source_tokens) / len(wanted) >= 0.6


def validate_model_interpretation(result: dict, text: str, known_types: list[str]) -> dict | None:
    """Schema-checked AND grounded: every extracted phrase must come from the source text,
    and a referral type must be an existing one (or trigger a clarification)."""
    try:
        source = _tokens(text)
        phrases = [*result["good_fit"], *result["outside_scope"], *result["helpful"], *result["urgent_signals"],
                   *[item["label"] for item in result["required"]]]
        if any(not isinstance(phrase, str) or not _grounded(phrase, source) for phrase in phrases):
            return None
        referral_type = result["referral_type"]
        if referral_type and normalize_referral_type(referral_type) not in {normalize_referral_type(k) for k in known_types}:
            referral_type = None
        content = {
            "good_fit": [p.strip() for p in result["good_fit"]], "outside_scope": [p.strip() for p in result["outside_scope"]],
            "required": [{"key": "_".join(sorted(_tokens(i["label"])))[:80], "label": i["label"].strip(), "required": True,
                          "freshness_days": i["freshness_days"] if i["freshness_days"] and str(i["freshness_days"]) in text or
                          (i["freshness_days"] and _freshness(text) == i["freshness_days"]) else None}
                         for i in result["required"]],
            "helpful": [{"key": "_".join(sorted(_tokens(p)))[:80], "label": p.strip(), "required": False, "freshness_days": None}
                        for p in result["helpful"]],
            "urgent_signals": [p.strip() for p in result["urgent_signals"]],
            "modality": result["modality"] if (result["modality"] == "unspecified" or re.search(
                r"e-?consult|in[- ]person|either", text, re.IGNORECASE)) else "unspecified",
            "note": None,
        }
        structured = any(content[k] for k in ("good_fit", "outside_scope", "required", "helpful", "urgent_signals")) \
            or content["modality"] != "unspecified"
        confidence = max(0.0, min(1.0, float(result["confidence"])))
        clarification = None
        if structured and not referral_type:
            clarification = {"question": (result.get("clarification_question") or "Which kind of referral should this apply to?")[:200],
                             "options": known_types}
        return {"referral_type": referral_type, "content": content, "structured": structured,
                "confidence": confidence if structured else 0.0, "clarification": clarification, "interpreter": "model"}
    except (KeyError, TypeError, ValueError):
        return None


def merge_content(base: PracticeRuleContent, addition: dict) -> PracticeRuleInput:
    def union(old: list[str], new: list[str]) -> list[str]:
        seen = {item.casefold() for item in old}
        return [*old, *[item for item in new if item.casefold() not in seen]]

    def union_req(old: list[ReferralRequirement], new: list[dict]) -> list[ReferralRequirement]:
        keys = {item.key for item in old}
        labels = {item.label.casefold() for item in old}
        merged = list(old)
        for item in new:
            if item["key"] not in keys and item["label"].casefold() not in labels:
                merged.append(ReferralRequirement(**item))
        return merged

    modality = addition["modality"] if addition["modality"] != "unspecified" else base.modality
    notes = "; ".join(filter(None, [base.modality_notes, addition.get("note")])) or None
    return PracticeRuleInput(
        referral_type="placeholder", good_fit=union(base.good_fit, addition["good_fit"]),
        outside_scope=union(base.redirect, addition["outside_scope"]),
        required=union_req(base.required, addition["required"]), helpful=union_req(base.helpful, addition["helpful"]),
        urgent_signals=union(base.urgent_signals, addition["urgent_signals"]), modality=modality, note=notes,
    )


def _input_from(referral_type: str, content: dict) -> PracticeRuleInput:
    return PracticeRuleInput(
        referral_type=referral_type, good_fit=content["good_fit"], outside_scope=content["outside_scope"],
        required=[ReferralRequirement(**item) for item in content["required"]],
        helpful=[ReferralRequirement(**item) for item in content["helpful"]],
        urgent_signals=content["urgent_signals"], modality=content["modality"], note=content.get("note"),
    )


class TeachingService:
    def __init__(self, rules: PracticeRules, client: Any = None) -> None:
        self.rules = rules
        self._client = client

    def _model(self) -> Any:
        if self._client is None:
            from backend.professional_services import ResponsesApiClient

            self._client = ResponsesApiClient()
        return self._client if getattr(self._client, "available", False) else None

    def interpret(self, text: str, known_types: list[str]) -> dict:
        client = self._model()
        if client is not None:
            try:
                result = client.structured(
                    _INSTRUCTIONS, {"instruction": text, "existing_referral_types": known_types}, _SCHEMA,
                    use_case="pilot_teach_interpretation", schema_name="practice_rule_interpretation",
                )
                validated = validate_model_interpretation(result, text, known_types)
                if validated is not None:
                    return validated
            except Exception:  # noqa: BLE001 -- model is optional; deterministic fallback below
                logger.warning("teach interpretation model call failed; using deterministic fallback")
        return deterministic_interpret(text, known_types)

    @staticmethod
    def view(rule: PracticeRule) -> dict:
        provenance = rule.provenance or {}
        return {
            "id": rule.id, "referral_type": rule.referral_type, "source_text": provenance.get("raw_text", rule.source_text),
            "content": rule.content.model_dump(mode="json"), "confidence": rule.confidence,
            "operational_status": rule.operational_status, "physician_confirmed": rule.physician_confirmed,
            "source": rule.source, "structured": provenance.get("structured", True),
            "clarification": provenance.get("clarification"), "interpreter": provenance.get("interpreter"),
            "question_id": provenance.get("question_id"), "created_at": rule.created_at,
        }

    def _physician_key(self, context: PracticeContext) -> str:
        scope = self.rules.store.workflow.physician_owner_scope(context.owner_scope_id or "")
        return (scope or {}).get("physician_id") or "practice"

    def propose(
        self, context: PracticeContext, text: str, *, source: str = "explicit_instruction",
        interpretation: dict | None = None, extra_provenance: dict | None = None,
        supersedes: PracticeRule | None = None,
    ) -> dict:
        context.require_physician("teach the practice agent")
        text = " ".join(text.split())
        if not 3 <= len(text) <= 2000:
            raise PilotError("invalid_instruction", "Write a short instruction (up to 2,000 characters)", 422)
        known = self.rules.referral_types(context.practice_id)
        interpretation = interpretation or self.interpret(text, known)
        content = interpretation["content"]
        referral_type = interpretation["referral_type"] or UNASSIGNED_TYPE
        rule_input = _input_from(referral_type, content)
        stored_content = PracticeRuleContent(
            good_fit=rule_input.good_fit, redirect=rule_input.outside_scope, required=rule_input.required,
            helpful=rule_input.helpful, urgent_signals=rule_input.urgent_signals, modality=rule_input.modality,
            modality_notes=rule_input.note,
            interpretation_note=None if interpretation["structured"] else
            "Kept as a note: Lamina could not turn this into a structured rule.",
        )
        rule = self.rules.create(
            context.practice_id, self._physician_key(context), rule_input, actor=context.actor, source=source,
            operational_status="inferred", confidence=interpretation["confidence"], content=stored_content,
            source_text=text, supersedes=supersedes, event_type="learning_proposed",
            provenance={
                "raw_text": text, "interpreter": interpretation["interpreter"],
                "structured": interpretation["structured"], "clarification": interpretation["clarification"],
                **(extra_provenance or {}),
            },
        )
        return self.view(rule)

    def _proposal(self, context: PracticeContext, proposal_id: str) -> PracticeRule:
        rule = self.rules.get(context.practice_id, proposal_id)
        if rule.operational_status != "inferred":
            raise PilotError("proposal_closed", "This proposal has already been reviewed")
        return rule

    def clarify(self, context: PracticeContext, proposal_id: str, answer: str) -> dict:
        """One focused follow-up: the answer names the referral type (or adds detail)."""
        context.require_physician("teach the practice agent")
        proposal = self._proposal(context, proposal_id)
        known = self.rules.referral_types(context.practice_id)
        answer = " ".join(answer.split())
        if not answer:
            raise PilotError("answer_required", "Answer the question to continue", 422)
        provenance = proposal.provenance or {}
        raw = provenance.get("raw_text", proposal.source_text)
        chosen = next((name for name in known if normalize_referral_type(name) == normalize_referral_type(answer)), None) \
            or match_referral_type(answer, known) or answer[:120]
        interpretation = {
            "referral_type": chosen,
            "content": {
                "good_fit": proposal.content.good_fit, "outside_scope": proposal.content.redirect,
                "required": [item.model_dump() for item in proposal.content.required],
                "helpful": [item.model_dump() for item in proposal.content.helpful],
                "urgent_signals": proposal.content.urgent_signals, "modality": proposal.content.modality,
                "note": proposal.content.modality_notes,
            },
            "structured": provenance.get("structured", True), "confidence": max(proposal.confidence or 0.0, 0.6),
            "clarification": None, "interpreter": provenance.get("interpreter", "deterministic"),
        }
        return self.propose(
            context, raw, source=proposal.source, interpretation=interpretation, supersedes=proposal,
            extra_provenance={"clarification_answer": answer, "clarified_from": proposal.id},
        )

    def confirm(self, context: PracticeContext, proposal_id: str, edits: PracticeRuleInput | None = None) -> dict:
        context.require_physician("confirm what the practice agent learned")
        proposal = self._proposal(context, proposal_id)
        provenance = proposal.provenance or {}
        if not provenance.get("structured", True) and edits is None:
            raise PilotError("unstructured_note", "This was kept as a note. Edit it into a rule to confirm it", 422)
        if provenance.get("clarification") and edits is None:
            raise PilotError("clarification_required", "Answer the clarification question first", 409)
        referral_type = (edits.referral_type if edits else proposal.referral_type).strip()
        if referral_type == UNASSIGNED_TYPE:
            raise PilotError("referral_type_required", "Choose which referral type this applies to", 422)
        addition = {
            "good_fit": edits.good_fit if edits else proposal.content.good_fit,
            "outside_scope": edits.outside_scope if edits else proposal.content.redirect,
            "required": [i.model_dump() for i in (edits.required if edits else proposal.content.required)],
            "helpful": [i.model_dump() for i in (edits.helpful if edits else proposal.content.helpful)],
            "urgent_signals": edits.urgent_signals if edits else proposal.content.urgent_signals,
            "modality": edits.modality if edits else proposal.content.modality,
            "note": (edits.note if edits else proposal.content.modality_notes),
        }
        event = "learning_edited" if edits else "learning_confirmed"
        base = next(iter(self.rules.operational(context.practice_id, referral_type)), None)
        lineage = {"from_proposal": proposal.id, "raw_text": provenance.get("raw_text", proposal.source_text),
                   "proposal_source": proposal.source}
        try:
            if base is not None:
                merged = merge_content(base.content, addition).model_copy(update={
                    "referral_type": base.referral_type, "publishable": base.publishable})
                rule = self.rules.create(
                    context.practice_id, self._physician_key(context), merged, actor=context.actor,
                    source=proposal.source, supersedes=base, event_type=event,
                    source_text=lineage["raw_text"], provenance=lineage, confidence=proposal.confidence,
                )
                self.rules.set_status(context.practice_id, proposal.id, "superseded", actor=context.actor,
                                      event_type="learning_merged", metadata={"into_rule_id": rule.id})
            elif edits is None:
                rule = self.rules.set_status(context.practice_id, proposal.id, "confirmed", actor=context.actor,
                                             event_type=event)
            else:
                rule = self.rules.create(
                    context.practice_id, self._physician_key(context), _input_from(referral_type, addition),
                    actor=context.actor, source=proposal.source, supersedes=proposal, event_type=event,
                    source_text=lineage["raw_text"], provenance=lineage, confidence=proposal.confidence,
                )
        except RuleConflictError as error:
            raise PilotError("proposal_closed", str(error)) from error
        return {"rule": rule.model_dump(mode="json"), "proposal_id": proposal.id}

    def reject(self, context: PracticeContext, proposal_id: str, reason: str | None = None, event: str = "learning_rejected") -> dict:
        context.require_physician("reject a proposed learning")
        self._proposal(context, proposal_id)
        rule = self.rules.set_status(context.practice_id, proposal_id, "rejected", actor=context.actor,
                                     event_type=event, metadata={"reason": (reason or "")[:500] or None})
        return self.view(rule)
