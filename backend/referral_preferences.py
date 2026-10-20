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
from backend.referrals.requirements import REFERRAL_REQUIREMENTS_BY_KEY
from backend.representation import representation_snapshot_id
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
    modality = "unspecified"
    lower = source_text.casefold()

    for sentence in _split_sentences(source_text):
        sentence_lower = sentence.casefold()
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
            for phrase in _extract_list_phrases(sentence):
                key, label = _requirement_key_and_label(phrase)
                if not any(item.key == key for item in helpful):
                    helpful.append(
                        ReferralRequirement(
                            key=key, label=label, required=False, freshness_days=_freshness_days(sentence)
                        )
                    )
        elif any(phrase in sentence_lower for phrase in ("commonly see", "usually see", "good fit", "good-fit")):
            good_fit.append(sentence.rstrip(".!? "))
        elif any(phrase in sentence_lower for phrase in ("prefer", "routed elsewhere", "redirect", "do not usually see", "don't usually see")):
            redirect.append(sentence.rstrip(".!? "))

    if "e-consult" in lower or "econsult" in lower:
        if "in-person" in lower or "in person" in lower:
            modality = "either"
        else:
            modality = "econsult"
    elif "in-person" in lower or "in person" in lower:
        modality = "in_person"

    return StructuredReferralPreference(
        good_fit=good_fit, required=required, helpful=helpful, redirect=redirect, modality=modality
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


def preference_modality_label(structured: StructuredReferralPreference) -> str | None:
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


def ensure_chen_seed_preference(workflow_store: WorkflowStore, workspace_id: str) -> None:
    """Idempotent per-workspace migration (Part K/L): represent Dr. Chen's
    pre-existing diabetes referral rules through this SAME persisted model,
    using only already-established demo facts -- never invents anything new
    to fill the schema. After this runs, his confirmed preference (not the
    static fixture) is the canonical operational source; the fixture remains
    only as the fallback other physicians without a confirmed preference
    still use."""
    if workflow_store.confirmed_referral_preference(
        workspace_id, PHYSICIAN_CHEN.id, CHEN_SEED_CASE_FAMILY
    ):
        return
    fixture_requirements = REFERRAL_REQUIREMENTS_BY_KEY.get((PHYSICIAN_CHEN.id, CHEN_SEED_CASE_FAMILY), [])
    structured = StructuredReferralPreference(
        good_fit=[
            "Persistent, worsening type 2 diabetes despite primary-care medication escalation."
        ],
        required=[item for item in fixture_requirements if item.required],
        helpful=[item for item in fixture_requirements if not item.required],
        redirect=[
            "Progressive CKD with resistant hypertension where diabetes is not the lead referral question."
        ],
        modality="in_person",
    )
    created = workflow_store.create_referral_preference(
        workspace_id,
        PHYSICIAN_CHEN.id,
        CHEN_SEED_CASE_FAMILY,
        source_text=(
            "Migrated from Dr. Chen's existing confirmed practice fixture: persistent, "
            "worsening type 2 diabetes despite medication escalation is a good fit; a recent "
            "HbA1c, current diabetes medication list, and recent renal function are required "
            "before review; a glucose log or CGM is helpful when available; in-person review "
            "is preferred."
        ),
        structured_rules_json=structured.model_dump_json(),
        source="migrated_fixture",
    )
    workflow_store.confirm_referral_preference(workspace_id, created["id"], None)
    snapshot_id = representation_snapshot_id(workflow_store, workspace_id, "chen")
    workflow_store.set_referral_preference_snapshot(workspace_id, created["id"], snapshot_id)


def ensure_seed_preferences(workflow_store: WorkflowStore, workspace_id: str) -> None:
    """The one place product API entry points (never the evaluation harness
    -- Part N: zero side effects, and a mid-suite seed would also make a
    single run's representation snapshot inconsistent with itself) call
    before reading a confirmed preference, so Chen's migrated preference
    exists on first real interaction. Mirrors WorkflowStore's own existing
    lazy per-workspace seed pattern (see `_seed_default_network_members`)."""
    ensure_chen_seed_preference(workflow_store, workspace_id)


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


def confirmed_modality(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str, case_family: str
) -> str | None:
    row = workflow_store.confirmed_referral_preference(workspace_id, physician_id, case_family)
    if row is None:
        return None
    structured = _structured_from_row(row)
    return None if structured.modality == "unspecified" else structured.modality


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
        explicit_rules.extend(f"Accepts: {item.rstrip('.')}." for item in structured.good_fit)
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
        "referral_requirements": list(dict.fromkeys(required_labels)),
        "preferred_workup": list(dict.fromkeys([*required_labels, *helpful_labels])),
        "explicit_rules": list(dict.fromkeys(explicit_rules)),
        "modality_preference": modality_label,
        "referral_preference_provenance": provenance,
    }
