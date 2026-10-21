"""Natural-language physician referral preferences: the first NLP physician-
representation feature (Part A-AB).

Core loop: physician natural language -> structured DRAFT interpretation ->
physician review -> confirm/edit/reject -> confirmed PhysicianReferralPreference
-> PhysicianRepresentation changes -> future agent behavior changes. A DRAFT
never touches resolve_case_rules()/requirements_for()/build_candidate_routes()
-- only a CONFIRMED preference is ever looked up by the small set of
"confirmed_*" functions below, which the API layer (and the evaluation
harness, Part O) call before invoking the SAME production domain functions
every other physician already uses. Nothing here duplicates that logic.
"""

from __future__ import annotations

import re
from typing import Any

from backend.models import (
    PhysicianCaseRules,
    ReferralRequirement,
    StructuredReferralPreference,
)
from backend.professional_services import ResponsesApiClient, _log_validation_fallback
from backend.synthetic_data.fixtures import PHYSICIAN_CHEN
from backend.workflow import WorkflowStore

CHEN_SEED_CASE_FAMILY = "type_2_diabetes"

# Bounded keyword classification (Part C: "a bounded structured model call,
# not a large autonomous agent workflow") -- never a broad free-text
# classifier. Extend this dict, not a new conditional chain, for a future
# case family.
_CASE_FAMILY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "type_2_diabetes": ("diabetes", "a1c", "hba1c", "glycemic", "glucose"),
    "ckd_hypertension": ("kidney", "renal", "ckd", "hypertension", "blood pressure"),
    "iron_deficiency_anemia": ("anemia", "anaemia", "iron deficiency", "iron-deficiency"),
}

_REQUIREMENT_KEY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "recent_hba1c": ("a1c", "hba1c"),
    "current_medications": ("medication",),
    "recent_renal_function": ("kidney function", "renal function", "creatinine", "egfr"),
    "glucose_log": ("glucose log", "cgm", "continuous glucose"),
}


def _classify_case_family(text: str) -> str:
    lower = text.casefold()
    best_family, best_hits = "type_2_diabetes", 0
    for family, keywords in _CASE_FAMILY_KEYWORDS.items():
        hits = sum(1 for keyword in keywords if keyword in lower)
        if hits > best_hits:
            best_family, best_hits = family, hits
    return best_family


_FRESHNESS_PATTERN = re.compile(r"within\s+(\d+)\s+days?", re.IGNORECASE)


def _freshness_days(sentence: str) -> int | None:
    """`None` ("unspecified") unless the physician gave an explicit number of
    days -- never inferred from a bare word like "recent" (Part E)."""
    match = _FRESHNESS_PATTERN.search(sentence)
    return int(match.group(1)) if match else None


def _requirement_key_and_label(phrase: str) -> tuple[str, str]:
    lower = phrase.casefold()
    for key, keywords in _REQUIREMENT_KEY_KEYWORDS.items():
        if any(keyword in lower for keyword in keywords):
            return key, phrase.strip().capitalize()
    slug = re.sub(r"[^a-z0-9]+", "_", lower).strip("_") or "requirement"
    return f"custom_{slug}", phrase.strip().capitalize()


def _split_sentences(text: str) -> list[str]:
    return [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+", text) if sentence.strip()]


def _extract_list_phrases(sentence: str) -> list[str]:
    """Split "a recent A1c, current diabetes medications, and recent kidney
    function" into separate item phrases."""
    body = re.sub(r"^.*?(?:need|want|require)s?\s+", "", sentence, flags=re.IGNORECASE)
    body = body.rstrip(".!? ")
    body = re.sub(r"\band\b", ",", body, flags=re.IGNORECASE)
    return [part.strip() for part in body.split(",") if part.strip()]


_HELPFUL_AVAILABILITY_CLAUSE = re.compile(
    r"\s*,?\s*(?:is|are)\s+(?:useful|helpful)\s+when\s+available", re.IGNORECASE
)
_HELPFUL_NOT_REQUIRED_CLAUSE = re.compile(
    r"\s*,?\s*(?:but\s+)?(?:they|it)?\s*(?:aren'?t|are\s+not|is\s+not)\s+required", re.IGNORECASE
)
_HELPFUL_OPTIONAL_CLAUSE = re.compile(r"\s*,?\s*optional\b", re.IGNORECASE)


def _extract_helpful_item_phrases(sentence: str) -> list[str]:
    """A helpful sentence's own qualifier clause (e.g. "...are useful when
    available, but aren't required") describes optionality -- it is never
    itself a separate item. Stripping it before splitting on commas keeps
    deterministic_interpret honest to its own stated contract: never
    inventing a phantom "Custom: but aren't required" item the physician
    never actually described."""
    trimmed = _HELPFUL_AVAILABILITY_CLAUSE.sub("", sentence)
    trimmed = _HELPFUL_NOT_REQUIRED_CLAUSE.sub("", trimmed)
    trimmed = _HELPFUL_OPTIONAL_CLAUSE.sub("", trimmed)
    return _extract_list_phrases(trimmed)


_LEADING_CONDITIONAL_PATTERN = re.compile(r"^\s*if\s+(.+?),\s*(.+)$", re.IGNORECASE)
_TRAILING_CONDITIONAL_PATTERN = re.compile(r"(.+?)\b(?:when|if)\b\s+(.+)$", re.IGNORECASE)


def _modality_condition(sentence: str) -> str | None:
    """Extracts the clause describing WHEN a modality applies -- never the
    whole sentence verbatim -- so "E-consult can be appropriate when X" and
    "If X, I generally prefer an in-person evaluation" both yield just X,
    never a copy of the trigger phrase itself. `None` when the sentence
    mentions a modality but states no actual condition (Part 7: never
    invent a condition the physician didn't give)."""
    text = sentence.rstrip(".!? ")
    leading = _LEADING_CONDITIONAL_PATTERN.match(text)
    if leading:
        return leading.group(1).strip().capitalize()
    trailing = _TRAILING_CONDITIONAL_PATTERN.match(text)
    if trailing:
        return trailing.group(2).strip().capitalize()
    return None


def deterministic_interpret(source_text: str, case_family: str) -> StructuredReferralPreference:
    """A bounded, honest keyword/phrase heuristic -- the safety-net fallback
    when a live structured model call isn't configured or fails validation
    (mirrors every other ResponsesApiClient-backed service in this codebase,
    e.g. TrainingBranchService). Never invents a rule the text doesn't
    actually contain; unmatched structure is simply left empty."""
    good_fit: list[str] = []
    required: list[ReferralRequirement] = []
    helpful: list[ReferralRequirement] = []
    redirect: list[str] = []
    modality_rules: list[dict[str, str]] = []
    modality = "unspecified"
    lower = source_text.casefold()

    for sentence in _split_sentences(source_text):
        sentence_lower = sentence.casefold()
        # Demo UX + semantic polish pass, Part 7: a sentence describing a
        # modality (e-consult/in-person) is about MODALITY, never about
        # fit/requirements/redirect -- classify it below and skip the rest
        # of this loop entirely, so e.g. "...the required recent workup is
        # already available" never gets mistaken for a REQUIRED item, and
        # "...I generally prefer an in-person evaluation" never gets
        # mistaken for a redirect just because it contains "prefer".
        if "e-consult" in sentence_lower or "econsult" in sentence_lower:
            condition = _modality_condition(sentence)
            if condition:
                modality_rules.append({"modality": "econsult", "condition": condition})
            continue
        if "in-person" in sentence_lower or "in person" in sentence_lower:
            condition = _modality_condition(sentence)
            if condition:
                modality_rules.append({"modality": "in_person", "condition": condition})
            continue
        is_helpful_sentence = any(
            phrase in sentence_lower
            for phrase in ("useful when available", "aren't required", "are not required", "optional", "not required")
        )
        if any(keyword in sentence_lower for keyword in ("need", "require", "want")) and not is_helpful_sentence:
            for phrase in _extract_list_phrases(sentence):
                key, label = _requirement_key_and_label(phrase)
                if not any(item.key == key for item in required):
                    required.append(
                        ReferralRequirement(
                            key=key, label=label, required=True, freshness_days=_freshness_days(sentence)
                        )
                    )
        elif is_helpful_sentence:
            for phrase in _extract_helpful_item_phrases(sentence):
                key, label = _requirement_key_and_label(phrase)
                if not any(item.key == key for item in helpful):
                    helpful.append(
                        ReferralRequirement(
                            key=key, label=label, required=False, freshness_days=_freshness_days(sentence)
                        )
                    )
        elif any(phrase in sentence_lower for phrase in ("commonly see", "usually see", "good fit", "good-fit")):
            good_fit.append(sentence.rstrip(".!? "))
        # Demo UX + semantic polish pass, Part 7: a bare "prefer" is NOT a
        # redirect signal (that broke "I generally prefer an in-person
        # evaluation" before modality sentences were excluded above, and
        # would break it again for anyone who says "I'd prefer X" about
        # their own practice) -- only an explicit redirect-to-another-
        # specialty/provider phrase counts.
        elif any(phrase in sentence_lower for phrase in (
            "routed elsewhere", "prefer to redirect", "refer elsewhere", "redirect",
            "do not usually see", "don't usually see",
        )):
            redirect.append(sentence.rstrip(".!? "))

    econsult_conditions = [rule["condition"] for rule in modality_rules if rule["modality"] == "econsult"]
    in_person_conditions = [rule["condition"] for rule in modality_rules if rule["modality"] == "in_person"]
    if econsult_conditions and in_person_conditions:
        modality = "either"
    elif econsult_conditions:
        modality = "econsult"
    elif in_person_conditions:
        modality = "in_person"
    elif "e-consult" in lower or "econsult" in lower:
        modality = "either" if ("in-person" in lower or "in person" in lower) else "econsult"
    elif "in-person" in lower or "in person" in lower:
        modality = "in_person"

    # modality_notes is now only a fallback free-text summary for the rare
    # case modality_rules extraction found no clean condition at all --
    # modality_rules itself is the preferred, structured source (Part 7).
    modality_notes: str | None = None
    if modality == "either" and not modality_rules:
        sentences_mentioning_modality = [
            sentence.rstrip(".!? ") for sentence in _split_sentences(source_text)
            if any(phrase in sentence.casefold() for phrase in ("e-consult", "econsult", "in-person", "in person"))
        ]
        modality_notes = (
            ". ".join(dict.fromkeys(sentences_mentioning_modality)) + "."
            if sentences_mentioning_modality else None
        )

    return StructuredReferralPreference(
        good_fit=good_fit, required=required, helpful=helpful, redirect=redirect,
        modality=modality, modality_notes=modality_notes, modality_rules=modality_rules,
    )


_INTERPRET_SCHEMA = {
    "type": "object",
    "properties": {
        "case_family": {
            "type": "string",
            "enum": ["type_2_diabetes", "ckd_hypertension", "iron_deficiency_anemia"],
        },
        "good_fit": {"type": "array", "items": {"type": "string"}},
        "required": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "label": {"type": "string"},
                    "freshness_days": {"type": ["integer", "null"]},
                },
                "required": ["key", "label", "freshness_days"],
                "additionalProperties": False,
            },
        },
        "helpful": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "label": {"type": "string"},
                    "freshness_days": {"type": ["integer", "null"]},
                },
                "required": ["key", "label", "freshness_days"],
                "additionalProperties": False,
            },
        },
        "redirect": {"type": "array", "items": {"type": "string"}},
        "modality": {"type": "string", "enum": ["in_person", "econsult", "either", "unspecified"]},
    },
    "required": ["case_family", "good_fit", "required", "helpful", "redirect", "modality"],
    "additionalProperties": False,
}


class ReferralPreferenceInterpretationService:
    """Bounded structured extraction (Part C) -- a single Responses-style
    call, with the deterministic heuristic above as the no-network fallback.
    Mirrors backend.professional_services.TrainingBranchService's own
    available/.structured()/fallback shape exactly, rather than inventing a
    second pattern for talking to the model."""

    def __init__(self, client: ResponsesApiClient | None = None) -> None:
        self.client = client or ResponsesApiClient()

    @staticmethod
    def _valid(result: dict) -> bool:
        return bool(
            isinstance(result, dict)
            and result.get("case_family") in _CASE_FAMILY_KEYWORDS
            and result.get("modality") in {"in_person", "econsult", "either", "unspecified"}
            and isinstance(result.get("good_fit"), list)
            and isinstance(result.get("required"), list)
            and isinstance(result.get("helpful"), list)
            and isinstance(result.get("redirect"), list)
        )

    def interpret(
        self, source_text: str, specialty: str, case_family_hint: str | None
    ) -> tuple[str, StructuredReferralPreference, str]:
        """Returns (case_family, structured_rules, provider)."""
        if self.client.available:
            try:
                result = self.client.structured(
                    """Interpret a physician's own plain-language description of how they
                    prefer to receive referrals into structured rules. Only represent what
                    the physician actually said. Never invent a required item, a case-fit
                    description, a redirect, or a modality preference the text does not
                    support. If the physician only says a workup item should be "recent",
                    leave freshness_days null -- never guess a specific number of days.""",
                    {
                        "source_text": source_text,
                        "specialty": specialty,
                        "case_family_hint": case_family_hint,
                    },
                    _INTERPRET_SCHEMA,
                    use_case="referral_preference_interpretation",
                    schema_name="lamina_referral_preference",
                )
                if self._valid(result):
                    structured = StructuredReferralPreference(
                        good_fit=result["good_fit"],
                        required=[
                            ReferralRequirement(
                                key=item["key"], label=item["label"], required=True,
                                freshness_days=item.get("freshness_days"),
                            )
                            for item in result["required"]
                        ],
                        helpful=[
                            ReferralRequirement(
                                key=item["key"], label=item["label"], required=False,
                                freshness_days=item.get("freshness_days"),
                            )
                            for item in result["helpful"]
                        ],
                        redirect=result["redirect"],
                        modality=result["modality"],
                    )
                    return result["case_family"], structured, "responses_api"
                _log_validation_fallback("referral_preference_interpretation", self.client.model)
            except RuntimeError:
                pass
        case_family = case_family_hint or _classify_case_family(source_text)
        return case_family, deterministic_interpret(source_text, case_family), "deterministic_fallback"


referral_preference_interpretation_service = ReferralPreferenceInterpretationService()


def preference_requirement_items(structured: StructuredReferralPreference) -> list[ReferralRequirement]:
    return [*structured.required, *structured.helpful]


_MODALITY_RULE_VERB = {"econsult": "E-consult can be appropriate", "in_person": "In-person is preferred"}


def modality_guidance_sentences(structured: StructuredReferralPreference) -> list[str]:
    """One readable sentence per structured modality_rules entry -- the
    preferred, non-misleading source for any flat-text context (Ask Their
    Agent's answer string, Practice Representation's one-line summary)
    that can't render ModalityRule as its own UI block. Never a single
    "Either; no strong preference" line once real conditional guidance
    exists (Part 7/10)."""
    return [
        f"{_MODALITY_RULE_VERB[rule.modality]} when {rule.condition.rstrip('.').lower()}."
        for rule in structured.modality_rules
    ]


def preference_modality_label(structured: StructuredReferralPreference) -> str | None:
    if structured.modality_rules:
        return " ".join(modality_guidance_sentences(structured))
    if structured.modality == "either" and structured.modality_notes:
        return structured.modality_notes
    labels = {
        "in_person": "In-person review preferred.",
        "econsult": "E-consult preferred.",
        "either": "In-person or e-consult; no strong preference.",
    }
    return labels.get(structured.modality)


def case_rules_from_preference(
    physician_id: str, case_family: str, structured: StructuredReferralPreference, fallback: PhysicianCaseRules
) -> PhysicianCaseRules:
    """Converts a confirmed preference into the existing PhysicianCaseRules
    shape resolve_case_rules()/evaluate_physician() already consume --
    `accepts_signals`/`historical_cases` are preserved from the fallback
    fixture (this pass represents good-fit/required/helpful/redirect/
    modality through the new model; it does not yet reinterpret
    signal-matching/historical-case machinery from free text -- Part X: no
    broad guideline ingestion)."""
    explicit_rules = [f"Accepts: {item.rstrip('.')}." for item in structured.good_fit]
    explicit_rules += [
        f"Generally prefers routed elsewhere: {item.rstrip('.')}." for item in structured.redirect
    ]
    required_workup = [item.label for item in structured.required]
    return PhysicianCaseRules(
        physician_id=physician_id,
        case_family=case_family,
        accepts_signals=fallback.accepts_signals,
        explicit_rules=explicit_rules or fallback.explicit_rules,
        required_workup=required_workup or fallback.required_workup,
        historical_cases=fallback.historical_cases,
    )


def _fallback_case_rules(physician_id: str, case_family: str) -> PhysicianCaseRules:
    from backend.synthetic_data import ALL_PHYSICIANS
    from backend.synthetic_data.fixtures import PHYSICIAN_CASE_RULES_BY_KEY

    override = PHYSICIAN_CASE_RULES_BY_KEY.get((physician_id, case_family))
    if override is not None:
        return override
    profile = next(item for item in ALL_PHYSICIANS if item.id == physician_id)
    return PhysicianCaseRules(
        physician_id=physician_id,
        case_family=case_family,
        accepts_signals=profile.accepts_signals,
        explicit_rules=profile.explicit_rules,
        required_workup=profile.required_workup,
        historical_cases=profile.historical_cases,
    )


def _structured_from_row(row: dict[str, Any]) -> StructuredReferralPreference:
    return StructuredReferralPreference.model_validate_json(row["structured_rules_json"])


def ensure_seed_preferences(workflow_store: WorkflowStore, workspace_id: str) -> None:
    """Demo-coherence causality fix: this used to lazily migrate Dr. Chen's
    pre-existing static practice fixture into an auto-CONFIRMED referral
    preference the first time anything touched his workspace. That broke
    the feature's own causal story -- his receiving requirements (recent
    HbA1c, current medications, recent renal function) were already
    operational before he had ever taught his agent anything through this
    flow, so "physician teaches -> representation changes -> agent behavior
    changes" wasn't actually true for the one physician this pass exists to
    demonstrate it for.

    No physician, including Chen, is ever auto-confirmed into anything.
    Every physician starts with zero confirmed referral preferences for
    every case family until they actually teach and confirm one through the
    real NLP flow (backend/api/referral_preferences.py). The old fixture
    text/structure still exists (backend/referrals/requirements.py
    REFERRAL_REQUIREMENTS_BY_KEY) as demo/test reference material -- see
    requirements_for()'s _SUPERSEDED_BY_CONFIRMED_PREFERENCE guard -- it is
    simply never read as a stand-in for Chen's own confirmed preference
    anymore.

    Kept as a no-op, rather than deleted, so the several call sites that
    call this before reading a confirmed preference don't need to change;
    it documents, at every one of those call sites, that no seeding
    happens there."""
    return


def confirmed_case_rules_override(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str, case_family: str
) -> PhysicianCaseRules | None:
    """A pure read -- never seeds/mutates (callers that need Chen's migrated
    preference seeded call ensure_seed_preferences() first; see its
    docstring for why that must not happen here)."""
    row = workflow_store.confirmed_referral_preference(workspace_id, physician_id, case_family)
    if row is None:
        return None
    structured = _structured_from_row(row)
    fallback = _fallback_case_rules(physician_id, case_family)
    return case_rules_from_preference(physician_id, case_family, structured, fallback)


def confirmed_requirement_items(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str, case_family: str
) -> list[ReferralRequirement] | None:
    row = workflow_store.confirmed_referral_preference(workspace_id, physician_id, case_family)
    if row is None:
        return None
    return preference_requirement_items(_structured_from_row(row))


# Demo-coherence causality fix: once a (physician, case_family) pair has its
# own confirmed-preference system, the static REFERRAL_REQUIREMENTS_BY_KEY
# fixture (backend/referrals/requirements.py) must never operate as an
# unconfirmed substitute for that physician's real receiving requirements
# -- that would silently make them "operational" before the physician ever
# confirmed anything, breaking the causal "physician teaches ->
# representation changes -> agent behavior changes" story the NLP flow
# exists to demonstrate. Extend this set, never silently repurpose the
# fixture dict itself, the next time another physician/case-family pair
# gets its own confirmed-preference flow.
SUPERSEDES_STATIC_REQUIREMENTS_FIXTURE: frozenset[tuple[str, str]] = frozenset({
    (PHYSICIAN_CHEN.id, CHEN_SEED_CASE_FAMILY),
})


def requirement_override_for_referral(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str, case_family: str
) -> list[ReferralRequirement] | None:
    """The requirement_override a NEW referral's packet assembly should use
    (backend.referrals.requirements.requirements_for() itself stays
    untouched -- see its own docstring -- so the many unrelated,
    pre-existing callers that call build_referral()/requirements_for()
    directly, without ever looking up a confirmed preference, are
    completely unaffected). Returns the physician's own confirmed
    required+helpful items when they've confirmed one; an explicit empty
    list (deliberately never `None`, so requirements_for()'s static-fixture
    fallback can never silently apply) once this (physician, case_family)
    pair has graduated to the confirmed-preference system with nothing yet
    confirmed; `None` for every other physician/case-family pair, exactly
    like before, so requirements_for()'s pre-existing fixture fallback
    remains their only source, unaffected."""
    items = confirmed_requirement_items(workflow_store, workspace_id, physician_id, case_family)
    if items is not None:
        return items
    if (physician_id, case_family) in SUPERSEDES_STATIC_REQUIREMENTS_FIXTURE:
        return []
    return None


def confirmed_modality(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str, case_family: str
) -> str | None:
    row = workflow_store.confirmed_referral_preference(workspace_id, physician_id, case_family)
    if row is None:
        return None
    structured = _structured_from_row(row)
    return None if structured.modality == "unspecified" else structured.modality


def clarification_opportunities(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str
) -> list[dict[str, Any]]:
    """Demo coherence pass, Part H/I/Y: a small, deterministic, demo-scoped
    detector of ONE genuinely useful representation gap -- never a general
    learning-ranking engine (Part Y explicitly defers that). Chen's recent
    diabetes work is valid and safe either way; this only ever says "you
    haven't yet confirmed X," never "your agent got this wrong." Resolves
    itself the moment Chen confirms a modality preference (Part K: this is
    read-only -- confirming happens through the normal referral-preference
    confirm flow, never automatically from this detector itself).

    Requires a confirmed baseline preference to already exist (`row is
    None` below is the common case before Chen has taught his agent
    anything at all -- there is no gap to surface in a representation that
    doesn't exist yet; see ensure_seed_preferences' docstring)."""
    if physician_id != PHYSICIAN_CHEN.id:
        return []
    row = workflow_store.confirmed_referral_preference(workspace_id, physician_id, CHEN_SEED_CASE_FAMILY)
    if row is None:
        return []
    structured = _structured_from_row(row)
    if structured.modality != "unspecified":
        return []
    return [
        {
            "id": "chen-econsult-modality-gap",
            "case_family": CHEN_SEED_CASE_FAMILY,
            "title": "A recent diabetes referral surfaced one useful gap in your agent's representation.",
            "body": "You haven't yet confirmed when you prefer e-consult for focused diabetes questions.",
            # Demo UX + semantic polish pass, Part 8: short enough to never
            # wrap into a heavy multi-line modal title.
            "clarifying_question": "When would you start with an e-consult?",
            "supporting_text": (
                "Your agent knows you prefer in-person care when diabetes continues to worsen "
                "despite treatment escalation. It does not yet know when e-consult is appropriate."
            ),
        }
    ]


def confirmed_referral_preference_sections(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str
) -> dict[str, Any] | None:
    """Merges every confirmed preference (across case families) for one
    physician into the Practice Representation overlay shape (Part Q) --
    `good_fit`/`referral_requirements`/`preferred_workup`/`explicit_rules`
    match backend.engagement.base_practice_representation()'s own section
    keys exactly, so project_practice_representation() can simply overlay
    them. `None` when nothing is confirmed yet, so the caller leaves the
    existing fixture-derived sections untouched. A pure read -- see
    ensure_seed_preferences()."""
    rows = workflow_store.confirmed_referral_preferences_for_physician(workspace_id, physician_id)
    if not rows:
        return None
    good_fit: list[str] = []
    required_labels: list[str] = []
    helpful_labels: list[str] = []
    explicit_rules: list[str] = []
    modality_label: str | None = None
    provenance: list[str] = []
    for row in rows:
        structured = _structured_from_row(row)
        good_fit.extend(structured.good_fit)
        required_labels.extend(item.label for item in structured.required)
        helpful_labels.extend(item.label for item in structured.helpful)
        # Demo UX + semantic polish pass, Part 3: never restate the same
        # good-fit sentence here -- it is already shown under "Referral
        # fit." Only a genuinely distinct redirect-to-another-specialty
        # statement belongs in Practice Rules; an empty structured.redirect
        # means there is nothing additional to show, not that this
        # physician was told to redirect everything.
        explicit_rules.extend(
            f"Generally prefers routed elsewhere: {item.rstrip('.')}." for item in structured.redirect
        )
        label = preference_modality_label(structured)
        if label:
            modality_label = label
        confirmed_at = row.get("confirmed_at") or ""
        when = confirmed_at.split("T", 1)[0] if confirmed_at else "an earlier date"
        provenance.append(
            f"Confirmed on {when} from a physician-authored referral preference."
        )
    return {
        "good_fit": list(dict.fromkeys(good_fit)),
        # Demo UX + semantic polish pass, Part 3: "Required before review"
        # and "Helpful when available" are now mutually exclusive sections
        # -- referral_requirements carries only required items,
        # preferred_workup only helpful ones -- so the same item is never
        # rendered under two neighboring columns.
        "referral_requirements": list(dict.fromkeys(required_labels)),
        "preferred_workup": list(dict.fromkeys(helpful_labels)),
        "explicit_rules": list(dict.fromkeys(explicit_rules)),
        "modality_preference": modality_label,
        "referral_preference_provenance": provenance,
    }
