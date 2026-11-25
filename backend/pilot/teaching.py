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
from .vocabulary import referral_type_key

logger = logging.getLogger(__name__)
UNASSIGNED_TYPE = "Unassigned"
_GENERIC = {"management", "evaluation", "consult", "consultation", "follow", "up", "care", "new",
            "general", "questions", "question", "issues", "issue", "visit", "clinic", "review"}
_UNITS = {"day": 1, "week": 7, "month": 30, "year": 365}


def _clean_phrase(text: str) -> str:
    text = re.sub(r"\b(usually|typically|generally|normally|really|always|often|first)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"^(a|an|the|any|some)\s+", "", text.strip(" .,;:!"), flags=re.IGNORECASE)
    return " ".join(text.split()).strip(" .,;:!")


_NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                 "nine": 9, "ten": 10, "twelve": 12, "a": 1, "an": 1}
_AMOUNT = r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a|an)"
# Every recency qualifier Lamina understands. Each one attaches ONLY to the item whose
# clause contains it ("an ultrasound and a TSH within 90 days" → only the TSH).
_WINDOW = re.compile(
    r"\b(?:within|in)\s+(?:the\s+)?(?:last\s+|past\s+|prior\s+)?" + _AMOUNT + r"\s+(day|week|month|year)s?"
    r"|\b(?:from|in)\s+the\s+(?:last|past)\s+" + _AMOUNT + r"\s+(day|week|month|year)s?"
    r"|\b(?:no\s+older\s+than|less\s+than|under|not\s+older\s+than)\s+" + _AMOUNT + r"\s+(day|week|month|year)s?(?:\s+old)?"
    r"|\b(?:last|past)\s+" + _AMOUNT + r"\s+(day|week|month|year)s?"
    # "from the past year", "within the last month": one unit. It needs within/from/in, so a bare
    # "last week" elsewhere in a sentence is not a window.
    r"|\b(?:within|from|in)\s+the\s+(?:last|past)\s+(day|week|month|year)\b",
    re.IGNORECASE,
)


def _window_match(text: str) -> re.Match | None:
    return _WINDOW.search(text)


def _freshness(sentence: str) -> int | None:
    match = _window_match(sentence)
    if not match:
        return None
    if match.group(9):
        amount, unit = "1", match.group(9)
    else:
        amount, unit = next((match.group(i), match.group(i + 1)) for i in range(1, 9, 2) if match.group(i))
    number = int(amount) if amount.isdigit() else _NUMBER_WORDS[amount.lower()]
    if unit.lower() == "month" and number % 12 == 0:
        return number // 12 * 365  # "12 months" is a year, not 360 days
    return number * _UNITS[unit.lower()]


_NEGATED_NEED = re.compile(
    r"\b(?:don'?t|do\s+not|doesn'?t|does\s+not|no\s+longer)\s+(?:need|require|want|have\s+to\s+have)\b"
    r"|\bno\s+need\s+for\b|\b(?:is|are)\s+(?:not|n'?t)\s+(?:required|needed|necessary)\b|\bisn'?t\s+(?:required|needed)\b",
    re.IGNORECASE,
)
_EXCEPTION = re.compile(r"\s*,?\s*\b(unless|except(?:\s+(?:if|when|for))?|other\s+than|but\s+not\s+(?:if|when))\b(.*)$",
                        re.IGNORECASE)
_SHARED_WINDOW = re.compile(r"\b(both|each|all(?:\s+of\s+them)?)\b", re.IGNORECASE)
_HELPFUL = re.compile(r"\b(nice to have|helpful|if available|ideally|optionally|if possible)\b", re.IGNORECASE)


_JUDGMENT = re.compile(
    r"\bcase[- ]by[- ]case\b|\bi(?:'ll| will)? (?:decide|make the call)\b|\bi want to (?:review|decide)\b"
    r"|\bleave (?:it|that|those|them) to me\b|\bmy (?:call|decision)\b",
    re.IGNORECASE,
)
_PREFERENCE = re.compile(r"\b(?:i |we )?(?:prefer|would rather|ideally)\b", re.IGNORECASE)


def _split_exception(text: str) -> tuple[str, str | None]:
    """'X unless Y' → ('X', 'unless Y'). Exceptions are never turned into criteria."""
    match = _EXCEPTION.search(text)
    if not match:
        return text, None
    return text[:match.start()].strip(" ,;"), f"{match.group(1)}{match.group(2)}".strip(" .;")


def _strip_type_words(phrase: str, referral_type: str | None) -> str:
    """'Thyroid nodule referrals with hyperthyroidism in pregnancy' → 'hyperthyroidism in
    pregnancy' when the leading words just restate the referral type."""
    match = re.match(r"^(.*?)\s*\breferrals?\b\s*(?:with|for|in|where|involving|about|that\s+(?:are|have|involve))?\s+(.+)$",
                     phrase, re.IGNORECASE)
    if not match:
        return phrase
    prefix = _tokens(match.group(1))
    if not prefix or (referral_type and prefix <= _tokens(referral_type)):
        return _clean_phrase(match.group(2)) or phrase
    return phrase


def _requirement_items(listed: str, sentence_helpful: bool, review: list[str]) -> list[dict]:
    """Split a list of requirements and attach each qualifier to its own item only."""
    shared = None
    shared_match = re.search(r"\b(?:both|each|all(?:\s+of\s+them)?)\b[^.;]*", listed, re.IGNORECASE)
    if shared_match and _window_match(shared_match.group(0)):
        shared = _freshness(shared_match.group(0))
        listed = listed[:shared_match.start()].strip(" ,;")
    items = []
    for part in re.split(r"\s*,\s*(?:and\s+|plus\s+)?|\s+(?:and|plus|as\s+well\s+as)\s+", listed, flags=re.IGNORECASE):
        window = _window_match(part)
        freshness = _freshness(part) if window else shared
        label_text = part[:window.start()] + part[window.end():] if window else part
        helpful = sentence_helpful or bool(_HELPFUL.search(part))
        label_text = _HELPFUL.sub(" ", label_text)
        phrase = _clean_phrase(label_text)
        if not phrase or len(phrase) > 80:
            continue
        label = phrase[:1].upper() + phrase[1:]
        if re.search(r"\brecent\b", phrase, re.IGNORECASE) and freshness is None:
            review.append(f"“{label}” has no time window. Add one (e.g. “within 90 days”) if recency matters.")
        key = "_".join(sorted(_tokens(phrase))) or "item"
        items.append({"key": key[:80], "label": label, "required": not helpful, "freshness_days": freshness})
    return items


def _specific_tokens(text: str) -> set[str]:
    return _tokens(text) - _GENERIC


def match_referral_type(text: str, known: list[str]) -> str | None:
    key = referral_type_key(text)
    exact = [name for name in known if key and referral_type_key(name) == key]
    if len(exact) == 1:
        return exact[0]
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
                               "urgent_signals": [], "modality": "unspecified", "note": None,
                               "preferences": [], "exceptions": [], "judgment": [], "scope_policy": None}
    referral_type = match_referral_type(text, known_types)
    inferred_type = None
    review: list[str] = []  # Plain notes for the physician about what was NOT turned into a rule.
    kept_notes: list[str] = []
    # Sentences, then independent clauses ("…, and I don't need a CT" / "…, but we never see …"):
    # a negation or preference in one clause must not swallow the requirements of another.
    clauses = [clause for sentence in re.split(r"(?<=[.!?;])\s+|\n+", text)
               for clause in re.split(r",?\s+(?:and|but)\s+(?=(?:i|we)\b)", sentence, flags=re.IGNORECASE)]
    for sentence in clauses:
        sentence = sentence.strip()
        if not sentence:
            continue
        lowered = sentence.lower()
        if inferred_type is None:
            match = re.search(r"\b(?:for|before (?:reviewing|seeing|accepting)|on)\s+(?:all\s+|any\s+)?([a-z0-9][a-z0-9 /\-]{2,60}?)\s+referrals?\b", lowered)
            if match:
                inferred_type = _clean_phrase(match.group(1))
        if re.search(r"\be-?consults?\b", lowered) and re.search(r"\b(prefer|default|first|start with|route)\b", lowered):
            condition = re.search(r"\bfor\s+(.+)$", sentence, re.IGNORECASE)
            phrase = _clean_phrase(condition.group(1)) if condition else ""
            # "for thyroid nodule referrals" (or no condition) restates the type: the type's default
            # visit type. A narrower condition ("for stable small nodules") is only a stated
            # preference -- it must not become the suggestion for every referral of the type.
            restates_type = not phrase or re.fullmatch(r".*\breferrals?", phrase, re.IGNORECASE) is not None
            if restates_type:
                content["modality"] = "econsult"
            else:
                content["preferences"].append(f"eConsult first for {phrase}")
            continue
        if _JUDGMENT.search(sentence):
            # The physician keeps this decision. "Case by case" for a type is a scope policy.
            content["judgment"].append(sentence.strip(" ."))
            if re.search(r"case[- ]by[- ]case", sentence, re.IGNORECASE):
                content["scope_policy"] = "case_by_case"
            continue
        if re.search(r"\bin[- ]person\b", lowered) and re.search(r"\b(prefer|want|need|default|always)\b", lowered):
            content["modality"] = "in_person"
            continue
        if _NEGATED_NEED.search(sentence):
            # "I don't need a CT" is NOT a requirement. Never turn a negation into a rule.
            kept_notes.append(sentence.strip(" ."))
            review.append(f"Not turned into a requirement (it says something is not needed): “{sentence.strip(' .')}”.")
            continue
        outside = re.search(r"\b(?:don'?t|do not|doesn'?t|never|no longer|not)\s+(?:usually\s+|typically\s+|generally\s+)?(?:see|take|accept|manage|handle|treat)\s+(.+)$", sentence, re.IGNORECASE) \
            or re.search(r"(.+?)\s+(?:is|are)\s+outside (?:my|our) scope", sentence, re.IGNORECASE)
        if outside:
            scope_text, exception = _split_exception(outside.group(1))
            phrase = _strip_type_words(_clean_phrase(scope_text), referral_type or inferred_type)
            if exception:
                # An exception changes WHEN the scope rule applies. Lamina cannot apply that
                # condition automatically, so it neither adds the scope rule (which would wrongly
                # exclude the excepted cases) nor guesses: it keeps a reviewable exception.
                content["exceptions"].append(sentence.strip(" ."))
                review.append(f"Kept as a note, not applied: “{phrase}” is outside your scope {exception}. "
                              "Add it as an outside-scope criterion if you want those referrals flagged for review.")
                continue
            if phrase:
                content["outside_scope"].append(phrase)
            continue
        urgent = re.search(r"\b(?:urgent(?:ly)?|prioriti[sz]e|expedite|fast[- ]track)\b.*?\b(?:if|when|for|any)\s+(.+)$", sentence, re.IGNORECASE)
        if urgent:
            content["urgent_signals"].append(_clean_phrase(urgent.group(1)))
            continue
        core, exception = _split_exception(sentence)
        required = re.search(r"\b(?:want|need|require|requires|must have|expect|ask for|always get)\b\s+(?:to see\s+|to have\s+)?(.+?)(?:\s+\b(?:before|prior to|with|for|on)\b\s+(?!the\s+(?:last|past))\D.*)?$", core, re.IGNORECASE)
        if required:
            listed = required.group(1)
            if exception:
                content["exceptions"].append(sentence.strip(" ."))
                review.append(f"The exception “{exception}” is kept as a note; Lamina will still ask for these items "
                              "every time. Edit the rule if that’s not what you want.")
            sentence_helpful = bool(re.search(r"\b(nice to have|helpful|if available)\b", lowered)) and not re.search(
                r"\b(and|plus)\b", listed, re.IGNORECASE)
            # "a thyroid ultrasound and a recent TSH within 90 days" is two requirements, and the
            # window belongs only to the TSH.
            for item in _requirement_items(listed, sentence_helpful, review):
                content["required" if item["required"] else "helpful"].append(item)
            continue
        good = re.search(r"\b(?:i (?:do |also )?see|we see|happy to see|interested in|good fit(?: for)?|i (?:like|love) to see|i take)\b\s+(.+)$", sentence, re.IGNORECASE)
        if good:
            content["good_fit"].append(_clean_phrase(good.group(1)))
    if not any(content[key] for key in ("good_fit", "outside_scope", "required", "helpful", "urgent_signals",
                                        "judgment", "preferences", "exceptions")) and content["modality"] == "unspecified" \
            and _PREFERENCE.search(text) and not kept_notes:
        content["preferences"].append(" ".join(text.split()).strip(" ."))
    structured = any(content[key] for key in ("good_fit", "outside_scope", "required", "helpful", "urgent_signals",
                                              "judgment", "preferences", "exceptions")) \
        or content["modality"] != "unspecified" or bool(content["scope_policy"])
    if kept_notes:
        content["note"] = "; ".join(filter(None, [content["note"], *kept_notes]))[:2000]
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
        "review_notes": review,
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
    "otherwise null with a single short clarification_question. This is intake triage, not clinical advice. "
    # Provider eval (docs/PROVIDER_EVAL.md): labels must survive the grounding check and stay clean.
    "Write every label and phrase in the physician's own words (do not expand abbreviations or add "
    "synonyms, e.g. keep 'A1c'). A label names only the item: never put a time window, condition or "
    "exception in it. Conditions and exceptions ('unless ...', 'except ...') are never items. Something "
    "the physician says they don't need is never an item. Give each item only the time window stated "
    "for that item (or one shared window stated for all of them), in days (3 months = 90, a year = 365); "
    "otherwise null. `required`: items the physician needs, requires, wants or asks to be sent before "
    "review (\"I need X\" is required). `helpful`: only items they call helpful, nice to have, optional, "
    "or wanted if available. `good_fit`: only case features they say they are a good fit for or "
    "interested in -- never the referral type itself. `outside_scope`: cases they say they don't see, "
    "take or accept."
)


def stated_windows(text: str) -> set[int]:
    """Every recency window the text states, in days ("an A1c within 3 months and a lipid panel
    from the past year" -> {90, 365}). A model's freshness_days must be one of these."""
    return {days for match in _WINDOW.finditer(text) if (days := _freshness(match.group(0))) is not None}


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
                          "freshness_days": i["freshness_days"] if i["freshness_days"] and (
                              str(i["freshness_days"]) in text or i["freshness_days"] in stated_windows(text)) else None}
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
    required = union_req(base.required, addition["required"])
    helpful = union_req(base.helpful, addition["helpful"])
    # make_optional demotes this rule's own required items to helpful. Keys this rule doesn't
    # require (e.g. a physician loosening a practice requirement) stay as make_optional.
    demote = set(addition.get("make_optional", []))
    moved = [item for item in required if item.key in demote]
    required = [item for item in required if item.key not in demote]
    helpful = [*helpful, *[item.model_copy(update={"required": False}) for item in moved
                           if item.key not in {h.key for h in helpful}]]
    remaining = [key for key in union(base.make_optional, addition.get("make_optional", []))
                 if key not in {item.key for item in moved}]
    return PracticeRuleInput(
        referral_type="placeholder", good_fit=union(base.good_fit, addition["good_fit"]),
        outside_scope=union(base.redirect, addition["outside_scope"]),
        required=required, helpful=helpful,
        urgent_signals=union(base.urgent_signals, addition["urgent_signals"]), modality=modality, note=notes,
        # Aliases are physician-controlled names: a merge keeps every existing one.
        aliases=union(base.aliases, addition.get("aliases", [])),
        scope_policy=addition.get("scope_policy") or base.scope_policy,
        preferences=union(base.preferences, addition.get("preferences", [])),
        exceptions=union(base.exceptions, addition.get("exceptions", [])),
        judgment=union(base.judgment, addition.get("judgment", [])),
        make_optional=remaining,
        answered_topics=union(base.answered_topics, addition.get("answered_topics", [])),
    )


def _input_from(referral_type: str, content: dict, layer: str = "practice") -> PracticeRuleInput:
    return PracticeRuleInput(
        referral_type=referral_type, good_fit=content["good_fit"], outside_scope=content["outside_scope"],
        required=[ReferralRequirement(**item) for item in content["required"]],
        helpful=[ReferralRequirement(**item) for item in content["helpful"]],
        urgent_signals=content["urgent_signals"], modality=content["modality"], note=content.get("note"),
        aliases=content.get("aliases", []), scope_policy=content.get("scope_policy"),
        preferences=content.get("preferences", []), exceptions=content.get("exceptions", []),
        judgment=content.get("judgment", []), make_optional=content.get("make_optional", []),
        answered_topics=content.get("answered_topics", []), layer=layer,
    )


def _content_dict(content: PracticeRuleContent) -> dict:
    """A stored rule's content in the interpretation-dict shape used by propose/confirm."""
    return {
        "good_fit": content.good_fit, "outside_scope": content.redirect,
        "required": [item.model_dump() for item in content.required],
        "helpful": [item.model_dump() for item in content.helpful],
        "urgent_signals": content.urgent_signals, "modality": content.modality,
        "note": content.modality_notes, "aliases": content.aliases, "scope_policy": content.scope_policy,
        "preferences": content.preferences, "exceptions": content.exceptions, "judgment": content.judgment,
        "make_optional": content.make_optional, "answered_topics": content.answered_topics,
    }


def is_practice_admin(context: PracticeContext) -> bool:
    """Practice admin (membership + settings): the creator by default; several are allowed."""
    return context.is_admin


def require_can_edit(context: PracticeContext, rule: PracticeRule) -> None:
    """Clinical statements always need a physician. Practice-level: an ADMIN physician (staff
    can never confirm them, even if a non-physician admin role is added later). Physician-level:
    only that physician, admin or not."""
    if context.role != "physician":
        raise PilotError("physician_required", "Only a physician can confirm or change clinical statements", 403)
    if rule.layer == "physician":
        if rule.owner_scope_id != context.owner_scope_id:
            raise PilotError("rule_not_found", "Rule not found", 404)
    elif not context.is_admin:
        raise PilotError("practice_admin_required",
                         "Only an admin physician can confirm or change practice-wide statements. "
                         "You can add this as your own statement instead", 403)


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
                    # Run 3: treated as patient data. It is a practice rule, but a physician could type a
                    # patient's name or identifiers into it (the Teach input asks them not to).
                    contains_patient_data=True,
                )
                validated = validate_model_interpretation(result, text, known_types)
                if validated is not None:
                    return validated
            except Exception:  # noqa: BLE001 -- model is optional; deterministic fallback below
                logger.warning("teach interpretation model call failed; using deterministic fallback")
        return deterministic_interpret(text, known_types)

    def basis(self, rule: PracticeRule) -> str:
        """What a proposal is based on, in words -- shown instead of a numeric confidence.
        A pattern learned from the team's work says how often it was seen among the decisions
        made on that referral type ("Seen in 3 of the last 4 Osteoporosis decisions")."""
        provenance = rule.provenance or {}
        if rule.source == "correction_pattern":
            evidence = {item.get("referral_id") for item in provenance.get("evidence", []) if item.get("referral_id")}
            store = self.rules.store
            practice_id = rule.practice_id
            wanted = normalize_referral_type(rule.referral_type)
            of_type = {row["id"] for row in store.fetch_all(
                "SELECT id, referral_type FROM intake_referrals WHERE practice_id = ?", (practice_id,))
                if normalize_referral_type(row["referral_type"]) == wanted}
            decided = {row["id"] for row in store.fetch_all(
                "SELECT id FROM intake_referrals WHERE practice_id = ? AND disposition_json IS NOT NULL", (practice_id,))}
            decided |= {row["referral_id"] for row in store.fetch_all(
                "SELECT referral_id FROM triage_corrections WHERE practice_id = ?", (practice_id,))}
            decided |= {row["referral_id"] for row in store.fetch_all(
                "SELECT referral_id FROM recommendation_decisions WHERE practice_id = ? AND actor_role = 'physician'",
                (practice_id,))}
            total = max(len(decided & of_type), len(evidence))
            return f"Seen in {len(evidence)} of the last {total} {rule.referral_type} decisions"
        if provenance.get("suggested_by_role") == "staff":
            return f"Suggested by {provenance.get('suggested_by_name') or 'a staff member'}"
        if rule.source == "onboarding" or provenance.get("setup_stage"):
            return "From a setup answer"
        return "From an instruction"

    def view(self, rule: PracticeRule) -> dict:
        provenance = rule.provenance or {}
        return {
            # Shown instead of the numeric confidence (kept below for older readers).
            "basis": self.basis(rule),
            "id": rule.id, "referral_type": rule.referral_type, "source_text": provenance.get("raw_text", rule.source_text),
            "content": rule.content.model_dump(mode="json"), "confidence": rule.confidence,
            "operational_status": rule.operational_status, "physician_confirmed": rule.physician_confirmed,
            "source": rule.source, "structured": provenance.get("structured", True),
            "clarification": provenance.get("clarification"), "interpreter": provenance.get("interpreter"),
            "question_id": provenance.get("question_id"), "created_at": rule.created_at,
            "review_notes": provenance.get("review_notes", []),
            "layer": rule.layer, "setup_stage": provenance.get("setup_stage"),
            "suggested": bool(provenance.get("suggested")),
            # A staff member's suggestion: pending until a physician confirms it.
            "suggested_by_name": provenance.get("suggested_by_name"),
            "suggested_by_role": provenance.get("suggested_by_role"),
        }

    def _physician_key(self, context: PracticeContext) -> str:
        scope = self.rules.store.workflow.physician_owner_scope(context.owner_scope_id or "")
        return (scope or {}).get("physician_id") or "practice"

    def propose(
        self, context: PracticeContext, text: str, *, source: str = "explicit_instruction",
        interpretation: dict | None = None, extra_provenance: dict | None = None,
        supersedes: PracticeRule | None = None, layer: str | None = None,
    ) -> dict:
        # Correction-pattern proposals come from the team's recorded work (staff included) and
        # are practice-wide observations. A STAFF instruction becomes a pending suggestion for the
        # physician (practice layer, labelled with who suggested it). Every other proposal is a
        # physician teaching. Either way it is only a PROPOSAL: confirming needs the right physician.
        if source == "correction_pattern":
            # Practice-wide by default; a physician's own pattern (several physicians) is theirs.
            layer = layer or "practice"
        elif context.role == "staff":
            from .attribution import ActorDirectory

            layer = "practice"
            who = ActorDirectory(self.rules.store, context.practice_id).describe(context.actor)
            extra_provenance = {**(extra_provenance or {}), "suggested_by": context.actor,
                                "suggested_by_role": "staff", "suggested_by_name": who["name"]}
        else:
            context.require_physician("teach the practice agent")
        # Default layer: the practice admin teaches the practice; another physician teaches
        # only their own (physician-level) representation.
        layer = (supersedes.layer if supersedes is not None else layer) or (
            "practice" if is_practice_admin(context) else "physician")
        text = " ".join(text.split())
        if not 3 <= len(text) <= 2000:
            raise PilotError("invalid_instruction", "Write a short instruction (up to 2,000 characters)", 422)
        known = self.rules.referral_types(context.practice_id)
        interpretation = interpretation or self.interpret(text, known)
        content = interpretation["content"]
        referral_type = interpretation["referral_type"] or UNASSIGNED_TYPE
        rule_input = _input_from(referral_type, content, layer)
        stored_content = PracticeRuleContent(
            good_fit=rule_input.good_fit, redirect=rule_input.outside_scope, required=rule_input.required,
            helpful=rule_input.helpful, urgent_signals=rule_input.urgent_signals, modality=rule_input.modality,
            modality_notes=rule_input.note, aliases=rule_input.aliases, scope_policy=rule_input.scope_policy,
            preferences=rule_input.preferences, exceptions=rule_input.exceptions, judgment=rule_input.judgment,
            make_optional=rule_input.make_optional, answered_topics=rule_input.answered_topics,
            interpretation_note=None if interpretation["structured"] else
            "Kept as a note: Lamina could not turn this into a structured rule.",
        )
        rule = self.rules.create(
            context.practice_id, self._physician_key(context), rule_input, actor=context.actor, source=source,
            operational_status="inferred", confidence=interpretation["confidence"], content=stored_content,
            source_text=text, supersedes=supersedes, event_type="learning_proposed",
            owner_scope_id=context.owner_scope_id,
            provenance={
                "raw_text": text, "interpreter": interpretation["interpreter"],
                "structured": interpretation["structured"], "clarification": interpretation["clarification"],
                "review_notes": interpretation.get("review_notes", []),
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
            "content": _content_dict(proposal.content),
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
        require_can_edit(context, proposal)
        provenance = proposal.provenance or {}
        if not provenance.get("structured", True) and edits is None:
            raise PilotError("unstructured_note", "This was kept as a note. Edit it into a rule to confirm it", 422)
        if provenance.get("clarification") and edits is None:
            raise PilotError("clarification_required", "Answer the clarification question first", 409)
        referral_type = (edits.referral_type if edits else proposal.referral_type).strip()
        if referral_type == UNASSIGNED_TYPE:
            raise PilotError("referral_type_required", "Choose which referral type this applies to", 422)
        addition = _content_dict(proposal.content)
        if edits:
            addition = {
                "good_fit": edits.good_fit, "outside_scope": edits.outside_scope,
                "required": [i.model_dump() for i in edits.required], "helpful": [i.model_dump() for i in edits.helpful],
                "urgent_signals": edits.urgent_signals, "modality": edits.modality, "note": edits.note,
                "aliases": edits.aliases, "scope_policy": edits.scope_policy, "preferences": edits.preferences,
                "exceptions": edits.exceptions, "judgment": edits.judgment, "make_optional": edits.make_optional,
                # Editing a proposal answers the same topics it was asking about.
                "answered_topics": sorted(set(edits.answered_topics) | set(proposal.content.answered_topics)),
            }
        event = "learning_edited" if edits else "learning_confirmed"
        # Merge into the current confirmed rule of the SAME layer (and, for a physician layer,
        # the same physician). Practice and physician statements stay separate rows.
        base = next((rule for rule in self.rules.operational(context.practice_id, referral_type, context.owner_scope_id)
                     if rule.layer == proposal.layer
                     and (rule.layer == "practice" or rule.owner_scope_id == proposal.owner_scope_id)), None)
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
            elif edits is None and not addition.get("make_optional"):
                rule = self.rules.set_status(context.practice_id, proposal.id, "confirmed", actor=context.actor,
                                             event_type=event)
            else:
                rule = self.rules.create(
                    context.practice_id, self._physician_key(context), _input_from(referral_type, addition, proposal.layer),
                    actor=context.actor, source=proposal.source, supersedes=proposal, event_type=event,
                    source_text=lineage["raw_text"], provenance=lineage, confidence=proposal.confidence,
                )
        except RuleConflictError as error:
            raise PilotError("proposal_closed", str(error)) from error
        return {"rule": rule.model_dump(mode="json"), "proposal_id": proposal.id}

    def reject(self, context: PracticeContext, proposal_id: str, reason: str | None = None, event: str = "learning_rejected") -> dict:
        context.require_physician("reject a proposed learning")
        require_can_edit(context, self._proposal(context, proposal_id))
        rule = self.rules.set_status(context.practice_id, proposal_id, "rejected", actor=context.actor,
                                     event_type=event, metadata={"reason": (reason or "")[:500] or None})
        return self.view(rule)
