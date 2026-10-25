"""Physician-authored natural-language referral preferences (first NLP
physician-representation pass).

A physician describes, in ordinary language, how they prefer to receive
referrals. Lamina interprets that into a DRAFT structured rule set -- never
operational until the physician explicitly confirms it. Confirmed
preferences become the canonical source resolve_case_rules()/requirements_for()
read from; drafts and rejected preferences never affect routing, fit,
requirements, or agent answers (Part H/W).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field

from .consultation import StrictModel
from .referral import ReferralRequirement

ReferralPreferenceCaseFamily = Literal[
    "ckd_hypertension", "iron_deficiency_anemia", "type_2_diabetes", "thyroid"
]
ReferralPreferenceModality = Literal["in_person", "econsult", "either", "unspecified"]


class ReferralPreferenceStatus(StrEnum):
    DRAFT = "draft"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class ModalityRule(StrictModel):
    """Demo UX + semantic polish pass: a genuinely conditional modality
    preference (e-consult appropriate under one condition, in-person
    preferred under a different one) is NOT a redirect -- "in-person" is a
    modality, never "routed elsewhere" -- and it is not well represented by
    a single flat enum + free-text sentence either. Each rule names ONE
    modality and the ONE condition under which the physician actually said
    it applies, so representation/Ask Their Agent/Test/interpretation UI
    can all show the real conditional guidance instead of collapsing it
    into a misleading "Either; no strong preference" line. Still the
    smallest clean extension -- no routing engine, no scoring, no case
    classifier reads this; it is descriptive grounding text, structured."""

    modality: Literal["econsult", "in_person"]
    condition: str


class StructuredReferralPreference(StrictModel):
    """The structured rule types a physician-receiving preference can express
    (Part E). `required`/`helpful` reuse the existing ReferralRequirement
    model directly (required=True/False) rather than inventing a second,
    competing requirement shape. `freshness_days=None` on an item means the
    physician only said "recent" -- never an invented freshness window."""

    good_fit: list[str] = Field(default_factory=list)
    # Teaching-intent pass: cases the physician is particularly interested
    # in -- a positive, supporting fit signal (the same path confirmed
    # profile case interests already feed), never a requirement, a gate,
    # or an "Accepts" routing rule.
    case_interests: list[str] = Field(default_factory=list)
    required: list[ReferralRequirement] = Field(default_factory=list)
    helpful: list[ReferralRequirement] = Field(default_factory=list)
    redirect: list[str] = Field(default_factory=list)
    modality: ReferralPreferenceModality = "unspecified"
    # Demo coherence pass, Part J: free-text fallback for a conditional
    # modality preference that couldn't be split into clean modality_rules
    # below -- kept for backward compatibility, but modality_rules is now
    # the preferred, structured source whenever it's non-empty.
    modality_notes: str | None = None
    # Demo UX + semantic polish pass, Part 7: the structured conditional
    # modality guidance -- see ModalityRule above. `modality` above still
    # carries a best-effort flat default (kept for backward compatibility
    # with every existing reader of that field); this list is what
    # representation/Ask Their Agent/Test/interpretation UI should actually
    # render once it's non-empty.
    modality_rules: list[ModalityRule] = Field(default_factory=list)
    # Teaching-intent pass: when the interpreter could not safely tell what a
    # statement asks the agent to do, a brief physician-facing explanation
    # of the ambiguity. Never operational -- an interpretation with only a
    # note cannot be confirmed.
    interpretation_note: str | None = None


class PhysicianReferralPreference(StrictModel):
    id: str
    physician_id: str
    case_family: ReferralPreferenceCaseFamily
    source_text: str
    structured_rules: StructuredReferralPreference
    status: ReferralPreferenceStatus = ReferralPreferenceStatus.DRAFT
    # "physician_authored_nlp" is the real new product path; "migrated_fixture"
    # is only ever used once, to represent Dr. Chen's pre-existing fixture
    # rules through this same model (Part K) -- never a second hidden source.
    source: Literal["physician_authored_nlp", "migrated_fixture", "coordination_correction"] = "physician_authored_nlp"
    created_at: str
    updated_at: str
    confirmed_at: str | None = None
    # Part I: an edited confirmed preference creates a NEW confirmed row and
    # marks the prior one superseded, rather than silently mutating history.
    supersedes_id: str | None = None
    # The representation snapshot id (see backend/representation.py) at the
    # moment this preference was confirmed -- lets a future before/after
    # evaluation comparison cite the exact representation state (Part O).
    representation_snapshot_id_at_confirmation: str | None = None


class ReferralPreferenceInterpretRequest(StrictModel):
    """`clarifies` (routing consolidation pass, Part Q): set when this text
    answers a clarification card. The interpretation then refines only what
    the card asked about (modality guidance), merged onto the currently
    confirmed preference -- still a DRAFT until the physician confirms."""

    source_text: str = Field(min_length=1, max_length=4000)
    case_family: ReferralPreferenceCaseFamily | None = None
    clarifies: Literal["modality"] | None = None
    # My Agent cleanup pass, Part C/O: editing a CONFIRMED preference. The
    # edit is interpreted into a new DRAFT that supersedes `revises` only
    # once the physician confirms it; the confirmed version stays
    # operational (and in history) until then.
    revises: str | None = None


class ReferralPreferenceEditRequest(StrictModel):
    structured_rules: StructuredReferralPreference
