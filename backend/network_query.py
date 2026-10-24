"""Ask the Network (evaluation-visibility + active-network pass, Part I-K/S).

A bounded, explainable query over:

- specialty/scope
- confirmed case interests
- confirmed referral preferences (including modality)
- physician-approved network broadcasts

-- never a generic keyword search engine, never a magic numeric score.
Patient-specific queries reuse the EXACT SAME care-routing/candidate-
generation/physician-evaluation pure functions the rest of the product
uses (Part J: "Do NOT create a second independent patient-matching
algorithm"). Nothing here persists anything, creates a referral, or gives
a candidate physician durable patient memory (Part G/K).
"""

from __future__ import annotations

import re
from typing import Any

from backend.agents import build_candidate_routes, build_care_routing, evaluate_physician
from backend.clinical import build_patient_context, generate_candidates
from backend.engagement import (
    EDITABLE_PERSONAS,
    PERSONA_BY_PHYSICIAN_ID,
    PERSONAS,
    SYNTHETIC_FEED_FIXTURES,
    physician_interests,
)
from backend.models import PatientRecord
from backend.referral_preferences import confirmed_referral_preference_sections
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import WorkflowStore

_PHYSICIANS_BY_ID = {profile.id: profile for profile in ALL_PHYSICIANS}
_STOPWORDS = {
    "who", "what", "when", "where", "does", "do", "the", "for", "and", "with",
    "usually", "generally", "before", "about", "their", "your", "network", "want",
    # Generic descriptor words -- never specific enough on their own to
    # ground a match (Part S: "results must not merely keyword-match").
    "difficult", "straightforward", "cases", "case", "managing", "management",
    "treating", "treatment", "complex", "challenging", "routine", "handles",
    "prefers", "prefer", "questions", "question", "updates", "update",
}


# Words too generic to make a network post "directly relevant" grounding for
# one physician's match (My Agent cleanup pass, Part K).
_GROUNDING_STOPWORDS = {"referral", "referrals", "guidance", "updated", "network", "patients", "lately"}


def _tokens(text: str) -> set[str]:
    return {word for word in re.findall(r"[a-z]{3,}", text.casefold()) if word not in _STOPWORDS}


def _eligible_persona(physician_id: str) -> str | None:
    """A physician is an eligible, askable agent only if a real public
    Lamina agent persona exists for them (Part N) -- never an unclaimed/
    external-directory identity."""
    return PERSONA_BY_PHYSICIAN_ID.get(physician_id)


def _physician_agent_candidate(
    workflow_store: WorkflowStore, workspace_id: str, physician_id: str, question_tokens: set[str]
) -> dict[str, Any] | None:
    persona_id = _eligible_persona(physician_id)
    if persona_id is None:
        return None
    profile = _PHYSICIANS_BY_ID[physician_id]
    persona = PERSONAS[persona_id]
    reasons: list[str] = []
    # My Agent cleanup pass, Part J: the same evidence as `reasons`, but
    # structured as labeled reasons the UI renders as WHY THIS MATCH --
    # each one backed by a real profile/representation field, never a
    # numeric value.
    match_reasons: list[dict[str, str]] = []
    evidence_tokens: set[str] = set()

    specialty_tokens = _tokens(profile.specialty) | _tokens(profile.subspecialty)
    if specialty_tokens & question_tokens:
        reasons.append(f"Specialty: {profile.specialty} ({profile.subspecialty})")
        match_reasons.append({"kind": "specialty", "label": "Specialty fit", "detail": f"{profile.specialty} · {profile.subspecialty}"})
        evidence_tokens |= specialty_tokens & question_tokens

    similar = [case.label for case in profile.historical_cases if _tokens(case.label) & question_tokens]
    if similar:
        match_reasons.append({"kind": "similar_history", "label": "Similar patient history", "detail": "; ".join(similar)})
        evidence_tokens |= {token for label in similar for token in _tokens(label)} & question_tokens

    focus = [area for area in profile.focus_areas if _tokens(area) & question_tokens]
    if focus:
        match_reasons.append({"kind": "practice_focus", "label": "Practice focus", "detail": ", ".join(focus)})
        evidence_tokens |= {token for area in focus for token in _tokens(area)} & question_tokens

    interest_overlays = workflow_store.physician_interests(workspace_id, persona_id) if persona_id in EDITABLE_PERSONAS else []
    confirmed_case_interests = [
        item["title"] for item in physician_interests(persona_id, interest_overlays)
        if item["interest_type"] == "case_interest" and item["confirmed"]
    ]
    matched_interests = [interest for interest in confirmed_case_interests if _tokens(interest) & question_tokens]
    for interest in matched_interests:
        reasons.append(f"Confirmed case interest: {interest}")
    if matched_interests:
        match_reasons.append({"kind": "case_interest", "label": "Confirmed case interest", "detail": ", ".join(matched_interests)})
        evidence_tokens |= {token for interest in matched_interests for token in _tokens(interest)} & question_tokens

    referral_sections = confirmed_referral_preference_sections(workflow_store, workspace_id, physician_id)
    confirmed_good_fit: list[str] = []
    modality_preference: str | None = None
    if referral_sections:
        confirmed_good_fit = referral_sections.get("good_fit") or []
        modality_preference = referral_sections.get("modality_preference")
        for item in confirmed_good_fit:
            if _tokens(item) & question_tokens:
                reasons.append(f"Confirmed referral preference: {item}")
                match_reasons.append({"kind": "referral_preference", "label": "Confirmed referral preference", "detail": item})
                evidence_tokens |= _tokens(item) & question_tokens
        if modality_preference and ({"econsult", "virtual", "person"} & question_tokens):
            reasons.append(f"Confirmed modality preference: {modality_preference}")
            match_reasons.append({"kind": "modality", "label": "Modality preference", "detail": modality_preference})

    if not reasons:
        return None
    # Supporting context, never a match reason on its own: what this
    # physician wants before referral (confirmed preference > profile).
    before_referral = (referral_sections or {}).get("referral_requirements") or profile.required_workup
    if before_referral:
        match_reasons.append({"kind": "before_referral", "label": "Before referral", "detail": " + ".join(before_referral)})
    return {
        "physician_id": physician_id,
        "physician_name": profile.name.replace(" (synthetic)", ""),
        "specialty": profile.specialty,
        "agent_name": persona["agent_name"],
        "reasons": reasons,
        "match_reasons": match_reasons,
        "evidence_tokens": sorted(evidence_tokens),
        "confirmed_case_interests": confirmed_case_interests,
        "confirmed_good_fit": confirmed_good_fit,
        "modality_preference": modality_preference,
    }


def _broadcast_matches(
    workflow_store: WorkflowStore, workspace_id: str, question_tokens: set[str]
) -> list[dict[str, Any]]:
    """Only PHYSICIAN-approved, published updates are eligible network
    signal (Part K: never patient-specific, Part Q: a broadcast only ever
    grounds discovery, never operational behavior)."""
    matches: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    candidates = [
        *SYNTHETIC_FEED_FIXTURES,
        *[
            item
            for persona_id in PERSONAS
            for item in workflow_store.practice_updates(workspace_id, persona_id, "published")
        ],
    ]
    for item in candidates:
        item_id = str(item.get("id"))
        if item_id in seen_ids or not item.get("physician_approved", True):
            continue
        text_tokens = _tokens(item.get("title", "")) | _tokens(item.get("body", ""))
        if not (text_tokens & question_tokens):
            continue
        seen_ids.add(item_id)
        persona_id = item.get("physician_persona") or item.get("persona_id")
        matches.append({
            "post_id": item_id,
            "physician_persona": persona_id,
            "physician_name": PERSONAS.get(persona_id, {}).get("name", "Unknown physician"),
            "title": item.get("title", ""),
            "snippet": (item.get("body", "")[:160] + "…") if len(item.get("body", "")) > 160 else item.get("body", ""),
            "provenance_type": item.get("provenance_type", "physician_authored"),
        })
    return matches[:5]


def ask_network(
    workflow_store: WorkflowStore,
    workspace_id: str,
    question: str,
    patient: PatientRecord | None = None,
    candidate_physician_ids: list[str] | None = None,
    exclude_physician_id: str | None = None,
) -> dict[str, Any]:
    """`patient`/`candidate_physician_ids` (Part J), when supplied, add
    structured routing evidence from the SAME care-routing/candidate-
    generation/physician-evaluation functions the rest of the product
    uses -- never a second patient-matching algorithm, never a referral,
    never persisted candidate-agent memory."""
    question_tokens = _tokens(question)
    physician_ids = candidate_physician_ids or list(_PHYSICIANS_BY_ID)
    physician_agents = [
        match
        for physician_id in dict.fromkeys(physician_ids)
        if physician_id != exclude_physician_id
        and (match := _physician_agent_candidate(workflow_store, workspace_id, physician_id, question_tokens))
        is not None
    ]
    broadcasts = _broadcast_matches(workflow_store, workspace_id, question_tokens)
    # My Agent cleanup pass, Part K/L: posts still inform results -- but only
    # as attributed grounding inside the matched physician's OWN result
    # (their post, directly about the question), never as a second results
    # feed. Strength is relative: the match(es) whose evidence covers the
    # most of the question are "strong", the rest "relevant".
    grounding_tokens = question_tokens - _GROUNDING_STOPWORDS
    best_coverage = max((len(match["evidence_tokens"]) for match in physician_agents), default=0)
    for match in physician_agents:
        persona_id = PERSONA_BY_PHYSICIAN_ID.get(match["physician_id"])
        match["grounded_in"] = [
            {"post_id": item["post_id"], "title": item["title"], "provenance_type": item["provenance_type"]}
            for item in broadcasts
            if item["physician_persona"] == persona_id
            and (_tokens(item["title"]) | _tokens(item["snippet"])) & grounding_tokens
        ]
        kinds = {reason["kind"] for reason in match["match_reasons"]} - {"before_referral"}
        match["strength"] = "strong" if len(match["evidence_tokens"]) == best_coverage and len(kinds) >= 2 else "relevant"
        del match["evidence_tokens"]

    routing: dict[str, Any] | None = None
    if patient is not None:
        context = build_patient_context(patient)
        # The patient's REAL candidate roster (Part J: reuse the same
        # candidate-generation architecture, never a keyword-filtered
        # subset of it) -- candidate_physician_ids is this patient's own
        # PHYSICIANS_BY_PATIENT list, passed in by the caller.
        profiles = [_PHYSICIANS_BY_ID[pid] for pid in (candidate_physician_ids or []) if pid in _PHYSICIANS_BY_ID]
        candidates = generate_candidates(context, profiles)
        evaluations = [evaluate_physician(patient, context, profile) for profile in profiles]
        care_routing = build_care_routing(context)
        candidate_routes = build_candidate_routes(context)
        routing = {
            "case_family": context.case_family,
            "candidates": [item.model_dump() for item in candidates],
            "evaluations": [item.model_dump() for item in evaluations],
            "care_routing": care_routing.model_dump() if care_routing else None,
            "candidate_routes": [item.model_dump() for item in candidate_routes],
        }

    return {
        "question": question,
        "physician_agents": physician_agents,
        "broadcasts": broadcasts,
        "routing": routing,
    }
