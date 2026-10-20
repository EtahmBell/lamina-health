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
    "ckd_hypertension", "iron_deficiency_anemia", "type_2_diabetes"
]
ReferralPreferenceModality = Literal["in_person", "econsult", "either", "unspecified"]


class ReferralPreferenceStatus(StrEnum):
    DRAFT = "draft"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class StructuredReferralPreference(StrictModel):
    """The structured rule types a physician-receiving preference can express
    (Part E). `required`/`helpful` reuse the existing ReferralRequirement
    model directly (required=True/False) rather than inventing a second,
    competing requirement shape. `freshness_days=None` on an item means the
    physician only said "recent" -- never an invented freshness window."""

    good_fit: list[str] = Field(default_factory=list)
    required: list[ReferralRequirement] = Field(default_factory=list)
    helpful: list[ReferralRequirement] = Field(default_factory=list)
    redirect: list[str] = Field(default_factory=list)
    modality: ReferralPreferenceModality = "unspecified"


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
    source: Literal["physician_authored_nlp", "migrated_fixture"] = "physician_authored_nlp"
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
    source_text: str = Field(min_length=1, max_length=4000)
    case_family: ReferralPreferenceCaseFamily | None = None


class ReferralPreferenceEditRequest(StrictModel):
    structured_rules: StructuredReferralPreference
