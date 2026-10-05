"""Controlled synthetic physician engagement fixtures and read projections.

This module deliberately does not participate in clinical candidate evaluation or
ranking.  Engagement improves representation detail only.
"""

from __future__ import annotations

from typing import Any

from backend.demo_identity import PCP_AGENT_ID, PCP_AGENT_NAME, PCP_NAME
from backend.synthetic_data import ALL_PHYSICIANS, SYNTHETIC_PHYSICIAN_NPIS, synthetic_agent_id

PROFILE_CATEGORIES = (
    "about",
    "training",
    "experience",
    "affiliations",
    "clinical_interests",
    "skills_or_procedures",
    "research",
    "publications",
    "teaching",
    "languages",
    "locations",
    "professional_links",
)
BASE_TIMESTAMP = "2026-01-01T00:00:00+00:00"

PHYSICIANS_BY_ID = {physician.id: physician for physician in ALL_PHYSICIANS}
PERSONA_BY_PHYSICIAN_ID = {
    "physician-jung": "iain",
    "physician-onadeko": "onadeko",
    "physician-alvarez": "sofia",
}
PERSONA_BY_NPI = {
    SYNTHETIC_PHYSICIAN_NPIS[physician_id]: persona_id
    for physician_id, persona_id in PERSONA_BY_PHYSICIAN_ID.items()
}

PERSONAS: dict[str, dict[str, Any]] = {
    "lucy": {
        "id": "lucy",
        "physician_id": None,
        "npi": None,
        "name": PCP_NAME,
        "specialty": "Primary Care",
        "location": "Oakland, CA",
        "agent_id": PCP_AGENT_ID,
        "agent_name": PCP_AGENT_NAME,
        "synthetic": True,
    },
    "iain": {
        "id": "iain",
        "physician_id": "physician-jung",
        "npi": SYNTHETIC_PHYSICIAN_NPIS["physician-jung"],
        "name": "Dr. Iain Jung",
        "specialty": "Nephrology",
        "location": "Oakland, CA",
        "agent_id": synthetic_agent_id("physician-jung"),
        "agent_name": "Dr. Iain Jung's Agent",
        "synthetic": True,
    },
    "onadeko": {
        "id": "onadeko",
        "physician_id": "physician-onadeko",
        "npi": SYNTHETIC_PHYSICIAN_NPIS["physician-onadeko"],
        "name": "Dr. Matthew Onadeko",
        "specialty": "Cardiology",
        "location": "San Francisco, CA",
        "agent_id": synthetic_agent_id("physician-onadeko"),
        "agent_name": "Dr. Matthew Onadeko's Agent",
        "synthetic": True,
    },
    "sofia": {
        "id": "sofia",
        "physician_id": "physician-alvarez",
        "npi": SYNTHETIC_PHYSICIAN_NPIS["physician-alvarez"],
        "name": "Dr. Sofia Alvarez",
        "specialty": "Gastroenterology",
        "location": "Oakland, CA",
        "agent_id": synthetic_agent_id("physician-alvarez"),
        "agent_name": "Dr. Sofia Alvarez's Agent",
        "synthetic": True,
    },
}
EDITABLE_PERSONAS = {"lucy", "iain"}
PERSONA_BY_AGENT_ID = {
    persona["agent_id"]: persona_id for persona_id, persona in PERSONAS.items()
}


def _item(
    item_id: str,
    category: str,
    title: str,
    detail: str | None = None,
    provenance: str = "synthetic_demo",
    shareable: bool = True,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "category": category,
        "title": title,
        "detail": detail,
        "provenance": provenance,
        "shareable": shareable,
        "created_at": BASE_TIMESTAMP,
        "updated_at": BASE_TIMESTAMP,
    }


BASE_PROFILE_ITEMS: dict[str, list[dict[str, Any]]] = {
    "lucy": [
        _item(
            "lucy-about",
            "about",
            "Primary care physician focused on longitudinal care and specialty-care coordination.",
        ),
        _item("lucy-interest-coordination", "clinical_interests", "Specialty-care coordination"),
        _item("lucy-location-oakland", "locations", "Oakland, CA"),
    ],
    "iain": [
        _item(
            "iain-about",
            "about",
            "Nephrologist focused on hypertension and cardiorenal medicine.",
        ),
        _item("iain-interest-ckd", "clinical_interests", "CKD stage 3–4"),
        _item("iain-interest-htn", "clinical_interests", "Resistant hypertension"),
        _item("iain-interest-proteinuria", "clinical_interests", "Proteinuria"),
        _item("iain-interest-cardiorenal", "clinical_interests", "Cardiorenal disease"),
        _item("iain-location-oakland", "locations", "Oakland, CA"),
    ],
    "onadeko": [
        _item(
            "onadeko-about",
            "about",
            "Cardiologist with a synthetic demo focus in hypertension cardiology.",
        ),
        _item("onadeko-interest-htn", "clinical_interests", "Resistant hypertension"),
        _item("onadeko-location-sf", "locations", "San Francisco, CA"),
    ],
    "sofia": [
        _item(
            "sofia-about",
            "about",
            "Gastroenterologist with a synthetic demo focus on occult gastrointestinal blood loss.",
        ),
        _item(
            "sofia-interest-ida",
            "clinical_interests",
            "Iron-deficiency anaemia source evaluation",
        ),
        _item("sofia-location-oakland", "locations", "Oakland, CA"),
    ],
}


TRAINING_QUESTIONS: dict[str, list[dict[str, Any]]] = {
    "iain": [
        {
            "id": "iain-resistant-htn-normal-kidney",
            "physician_persona": "iain",
            "source_type": "network_question",
            "source_reference": "synthetic-network-resistant-htn",
            "prompt": "Do you see resistant hypertension when kidney function is still normal?",
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Helps referring agents distinguish hypertension-only referrals from cardiorenal referrals.",
            "asked_count": 3,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
        {
            "id": "iain-upcr-requirement",
            "physician_persona": "iain",
            "source_type": "existing_practice_rule",
            "source_reference": "physician-jung-required-workup",
            "prompt": "For progressive CKD referrals, is a current UPCR required?",
            "question_type": "single_choice",
            "answer_options": ["Required", "Preferred", "Not required"],
            "why_this_matters": "Clarifies whether missing protein quantification should delay a referral.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
        {
            "id": "iain-jordan-fit",
            "physician_persona": "iain",
            "source_type": "canonical_case",
            "source_reference": "patient-ckd-htn-001",
            "prompt": "Would you see this type of case: progressive stage 3b CKD with resistant hypertension?",
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Tests whether the current Jordan-like case representation matches the physician's practice.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
        {
            "id": "iain-pre-referral-information",
            "physician_persona": "iain",
            "source_type": "explicit_synthetic_demo",
            "source_reference": "physician-jung-workup-options",
            "prompt": "Which information is most useful before referral?",
            "question_type": "multi_select",
            "answer_options": ["BMP", "UPCR", "Urinalysis", "Home BP log"],
            "why_this_matters": "Makes pre-referral information needs explicit without blocking referral.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
    ],
    "lucy": [
        {
            "id": "lucy-progressive-ckd-routing",
            "physician_persona": "lucy",
            "source_type": "existing_practice_rule",
            "source_reference": "renal-routing",
            "prompt": "Does progressive CKD with resistant hypertension usually lead you to nephrology first?",
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Clarifies the referring physician's specialty-routing preference.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
        {
            "id": "lucy-ida-routing",
            "physician_persona": "lucy",
            "source_type": "existing_practice_rule",
            "source_reference": "anaemia-routing",
            "prompt": "For persistent iron deficiency without source evaluation, do you usually refer to gastroenterology first?",
            "question_type": "yes_no",
            "answer_options": ["Yes", "No"],
            "why_this_matters": "Clarifies sequencing between gastroenterology and haematology.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
        {
            "id": "lucy-referral-context",
            "physician_persona": "lucy",
            "source_type": "profile_confirmation",
            "source_reference": "referral-context-fields",
            "prompt": "Which context do you most want your agent to include in referral questions?",
            "question_type": "multi_select",
            "answer_options": ["Clinical trajectory", "Prior workup", "Access needs", "Insurance"],
            "why_this_matters": "Improves how the agent represents referral intent.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
    ],
}

SYNTHETIC_FEED_FIXTURES = [
    {
        "id": "fixture-onadeko-referral-guidance",
        "physician_persona": "onadeko",
        "type": "referral_guidance",
        "title": "Updated referral guidance for resistant hypertension",
        "body": "Progressive renal dysfunction should prompt nephrology-first evaluation; hypertension cardiology can follow or co-manage.",
        "provenance": "synthetic_demo",
        "status": "published",
        "created_at": "2026-09-12T16:00:00+00:00",
        "published_at": "2026-09-12T16:00:00+00:00",
        "synthetic": True,
    },
    {
        "id": "fixture-sofia-publication",
        "physician_persona": "sofia",
        "type": "publication",
        "title": "New synthetic-demo publication on iron-deficiency source evaluation",
        "body": "A controlled demo update about gastrointestinal source evaluation for persistent iron deficiency.",
        "provenance": "synthetic_demo",
        "status": "published",
        "created_at": "2026-09-10T16:00:00+00:00",
        "published_at": "2026-09-10T16:00:00+00:00",
        "synthetic": True,
    },
    {
        "id": "fixture-iain-workup-guidance",
        "physician_persona": "iain",
        "type": "referral_guidance",
        "title": "Updated CKD referral workup guidance",
        "body": "Current BMP and UPCR are useful before review of progressive CKD referrals.",
        "provenance": "synthetic_demo",
        "status": "published",
        "created_at": "2026-09-15T16:00:00+00:00",
        "published_at": "2026-09-15T16:00:00+00:00",
        "synthetic": True,
    },
]


def profile_items(persona_id: str, overlays: list[dict]) -> list[dict]:
    merged = {item["id"]: item for item in BASE_PROFILE_ITEMS[persona_id]}
    merged.update({item["id"]: item for item in overlays})
    return sorted(merged.values(), key=lambda item: (item["category"], item["id"]))


def project_professional_profile(persona_id: str, overlays: list[dict]) -> dict:
    items = profile_items(persona_id, overlays)
    completed = sorted({item["category"] for item in items})
    incomplete = [category for category in PROFILE_CATEGORIES if category not in completed]
    return {
        "physician": PERSONAS[persona_id],
        "items": items,
        "sections": {
            category: [item for item in items if item["category"] == category]
            for category in PROFILE_CATEGORIES
        },
        "completeness": {
            "completed_section_count": len(completed),
            "total_section_count": len(PROFILE_CATEGORIES),
            "incomplete_sections": incomplete,
            "meaning": "Professional profile completeness only; not physician quality or referral rank.",
        },
        "synthetic": True,
    }


def question_by_id(persona_id: str, question_id: str) -> dict | None:
    return next(
        (item for item in TRAINING_QUESTIONS[persona_id] if item["id"] == question_id),
        None,
    )


def project_training_questions(persona_id: str, responses: list[dict]) -> list[dict]:
    latest: dict[str, dict] = {}
    for response in responses:
        latest[response["question_id"]] = response
    return [
        {
            **question,
            "status": (
                "skipped"
                if latest.get(question["id"], {}).get("skipped")
                else "answered"
                if question["id"] in latest
                else "unanswered"
            ),
        }
        for question in TRAINING_QUESTIONS[persona_id]
    ]


def proposed_learning_statement(question_id: str, answer: str | list[str]) -> str:
    if question_id == "iain-resistant-htn-normal-kidney":
        return {
            "Yes": "Dr. Jung sees resistant hypertension even when kidney function is normal.",
            "Depends": "Dr. Jung considers resistant hypertension without renal dysfunction on a case-by-case basis.",
            "No": "Dr. Jung generally does not see resistant hypertension when kidney function is normal.",
        }[str(answer)]
    if question_id == "iain-upcr-requirement":
        return f"For progressive CKD referrals, a current UPCR is {str(answer).casefold()}."
    if question_id == "iain-jordan-fit":
        return {
            "Yes": "Progressive stage 3b CKD with resistant hypertension is a good fit for Dr. Jung's practice.",
            "Depends": "Dr. Jung considers progressive stage 3b CKD with resistant hypertension case by case.",
            "No": "Progressive stage 3b CKD with resistant hypertension is not usually a fit for Dr. Jung's practice.",
        }[str(answer)]
    if question_id == "iain-pre-referral-information":
        return f"Useful information before referral includes {', '.join(answer)}."
    if question_id == "lucy-progressive-ckd-routing":
        return f"For Dr. Saru, nephrology-first routing for progressive CKD with resistant hypertension: {answer}."
    if question_id == "lucy-ida-routing":
        return f"Dr. Saru uses gastroenterology-first routing for persistent iron deficiency without source evaluation: {answer}."
    if question_id == "lucy-referral-context":
        return f"Dr. Saru wants referral questions to include {', '.join(answer)}."
    raise KeyError(question_id)


def base_practice_representation(persona_id: str) -> dict:
    if persona_id == "lucy":
        return {
            "specialty": "Primary Care",
            "clinical_focus": ["Primary care", "Specialty-care coordination"],
            "good_fit": [],
            "not_a_fit": [],
            "referral_requirements": [],
            "preferred_workup": [],
            "access_facts": [],
            "explicit_rules": [
                "Progressive CKD with resistant hypertension usually leads to nephrology first.",
                "Persistent iron deficiency without GI source evaluation usually leads to gastroenterology first.",
            ],
        }
    physician_id = PERSONAS[persona_id]["physician_id"]
    profile = PHYSICIANS_BY_ID[physician_id]
    return {
        "specialty": profile.specialty,
        "clinical_focus": profile.focus_areas,
        "good_fit": profile.accepts_signals,
        "not_a_fit": [],
        "referral_requirements": profile.required_workup,
        "preferred_workup": profile.required_workup,
        "access_facts": [f"Approximately {profile.availability_days} days"],
        "explicit_rules": profile.explicit_rules,
    }


def _practice_learning(item: dict, source_type: str) -> dict:
    identifier = item.get("id") or item.get("key") or item.get("learning_key")
    return {
        "id": identifier,
        "statement": item["statement"],
        "provenance": item["provenance"],
        "status": item["status"],
        "source_type": source_type,
        "source_reference": item.get("source_reference")
        or (
            str(item["consultation_record_id"])
            if item.get("consultation_record_id") is not None
            else str(identifier)
        ),
        "updated_at": item.get("updated_at"),
    }


def project_practice_representation(
    persona_id: str,
    questions: list[dict],
    learnings: list[dict],
    profile: dict,
    existing_learnings: list[dict] | None = None,
) -> dict:
    base = base_practice_representation(persona_id)
    confirmed = [item for item in learnings if item["status"] == "confirmed"]
    suggested = [item for item in learnings if item["status"] == "suggested"]
    existing = existing_learnings or []
    confirmed_existing = [item for item in existing if item["status"] == "confirmed"]
    suggested_existing = [item for item in existing if item["status"] == "suggested"]
    waiting = [item for item in questions if item["status"] == "unanswered"]
    return {
        "physician": PERSONAS[persona_id],
        "sections": {
            **base,
            "confirmed_learnings": [
                *[_practice_learning(item, "existing_calibration") for item in confirmed_existing],
                *[_practice_learning(item, "training_response") for item in confirmed],
            ],
        },
        "gaps": {
            "unanswered_questions": waiting,
            "unconfirmed_rules": [
                *[_practice_learning(item, "existing_calibration") for item in suggested_existing],
                *[_practice_learning(item, "training_response") for item in suggested],
            ],
            "practice_areas_needing_input": [item["prompt"] for item in waiting],
        },
        "completeness": {
            "confirmed_practice_item_count": len(base["clinical_focus"])
            + len(base["explicit_rules"])
            + len(confirmed_existing)
            + len(confirmed),
            "questions_waiting": len(waiting),
            "profile_sections_incomplete": len(profile["completeness"]["incomplete_sections"]),
            "meaning": "Representation completeness only; not quality, ranking, competence, or referral likelihood.",
        },
        "ranking_effect": "none",
    }


def related_personas(
    perspective: str, records: list[dict], members: list[dict]
) -> set[str]:
    related = {
        persona
        for member in members
        if (persona := PERSONA_BY_NPI.get(member["npi"])) is not None
    }
    for record in records:
        result = record["result"]
        participants = {
            PERSONA_BY_AGENT_ID[agent_id]
            for message in result.get("messages", [])
            for agent_id in (message.get("sender_agent_id"), message.get("recipient_agent_id"))
            if agent_id in PERSONA_BY_AGENT_ID and agent_id != PCP_AGENT_ID
        }
        if perspective == "lucy":
            related.update(participants)
        elif perspective == "iain" and "iain" in participants:
            related.add("lucy")
            related.update(participants)
    related.discard(perspective)
    return related


def profile_update_draft(item: dict) -> dict:
    update_type = "publication" if item["category"] == "publications" else "professional_update"
    return {
        "type": update_type,
        "title": (
            f"New research: {item['title']}"
            if update_type == "publication"
            else f"Professional profile update: {item['title']}"
        ),
        "body": item.get("detail") or item["title"],
    }

