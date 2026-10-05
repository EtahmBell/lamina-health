"""Controlled synthetic physician engagement fixtures and read projections.

This module deliberately does not participate in clinical candidate evaluation or
ranking.  Engagement improves representation detail only.
"""

from __future__ import annotations

from datetime import UTC, datetime
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
INTEREST_TYPES = {
    "clinical_interest",
    "case_interest",
    "research_interest",
    "teaching_interest",
}
INITIALIZATION_SECTIONS = (
    "professional_identity",
    "clinical_focus",
    "case_interests",
    "referral_preferences",
    "workup_preferences",
    "access_practice_context",
)
TRAINING_DAILY_LIMIT = 5
TRAINING_EXTENDED_LIMIT = 25
MAX_BRANCH_DEPTH = 3
QUESTION_BANK_AVAILABLE = 128
_CALIBRATION_TOPICS = (
    "clinical trajectory",
    "case severity",
    "diagnostic uncertainty",
    "prior workup",
    "medication response",
    "comorbidity context",
    "access constraints",
    "referral timing",
    "co-management",
    "follow-up expectations",
    "redirection boundary",
    "communication preference",
)
_CALIBRATION_CONTEXTS = (
    "a new referral",
    "an urgent question",
    "a stable chronic case",
    "a progressively worsening case",
    "a case with incomplete records",
    "a case after initial treatment",
    "a remote consultation",
    "a co-managed case",
    "a case with access barriers",
    "a follow-up consultation",
)
PERSONA_BY_AGENT_ID = {persona["agent_id"]: persona_id for persona_id, persona in PERSONAS.items()}


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

BASE_INTERESTS: dict[str, list[dict[str, Any]]] = {
    "lucy": [
        {
            "id": "lucy-care-coordination",
            "interest_type": "clinical_interest",
            "title": "Specialty-care coordination",
            "detail": "Longitudinal coordination across primary and specialty care.",
            "provenance": "synthetic_demo",
            "confirmed": True,
            "shareable": True,
            "created_at": BASE_TIMESTAMP,
            "updated_at": BASE_TIMESTAMP,
        }
    ],
    "iain": [
        {
            "id": f"iain-case-interest-{index}",
            "interest_type": "case_interest",
            "title": title,
            "detail": None,
            "provenance": "synthetic_demo",
            "confirmed": True,
            "shareable": True,
            "created_at": BASE_TIMESTAMP,
            "updated_at": BASE_TIMESTAMP,
        }
        for index, title in enumerate(
            (
                "Resistant hypertension with renal dysfunction",
                "Proteinuric CKD",
                "Cardiorenal disease",
                "Difficult-to-control blood pressure in CKD",
            ),
            start=1,
        )
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

BRANCH_QUESTIONS: dict[str, dict[str, Any]] = {
    "iain-branch-progressive-renal": {
        "id": "iain-branch-progressive-renal",
        "physician_persona": "iain",
        "root_question_id": "iain-resistant-htn-normal-kidney",
        "parent_question_id": "iain-resistant-htn-normal-kidney",
        "branch_depth": 1,
        "branch_path": ["iain-resistant-htn-normal-kidney:Depends"],
        "branch_condition": "Depends",
        "source_type": "unresolved_branch",
        "source_reference": "synthetic-network-resistant-htn",
        "prompt": "Does progressive renal dysfunction make the case appropriate?",
        "question_type": "yes_no_depends",
        "answer_options": ["Yes", "Depends", "No"],
        "why_this_matters": "Narrows the renal feature that changes referral fit.",
        "terminal": False,
        "synthetic": True,
        "created_at": BASE_TIMESTAMP,
    },
    "iain-branch-proteinuria-absence": {
        "id": "iain-branch-proteinuria-absence",
        "physician_persona": "iain",
        "root_question_id": "iain-resistant-htn-normal-kidney",
        "parent_question_id": "iain-branch-progressive-renal",
        "branch_depth": 2,
        "branch_path": [
            "iain-resistant-htn-normal-kidney:Depends",
            "iain-branch-progressive-renal:Yes",
        ],
        "branch_condition": "Yes",
        "source_type": "unresolved_branch",
        "source_reference": "synthetic-network-resistant-htn",
        "prompt": "Does absence of proteinuria change that?",
        "question_type": "yes_no_depends",
        "answer_options": ["Yes", "Depends", "No"],
        "why_this_matters": "Clarifies whether proteinuria is a boundary or merely context.",
        "terminal": False,
        "synthetic": True,
        "created_at": BASE_TIMESTAMP,
    },
    "iain-branch-declining-egfr-normal-upcr": {
        "id": "iain-branch-declining-egfr-normal-upcr",
        "physician_persona": "iain",
        "root_question_id": "iain-resistant-htn-normal-kidney",
        "parent_question_id": "iain-branch-proteinuria-absence",
        "branch_depth": 3,
        "branch_path": [
            "iain-resistant-htn-normal-kidney:Depends",
            "iain-branch-progressive-renal:Yes",
            "iain-branch-proteinuria-absence:Depends",
        ],
        "branch_condition": "Depends",
        "source_type": "unresolved_branch",
        "source_reference": "synthetic-network-resistant-htn",
        "prompt": "If eGFR is declining but UPCR is normal, would you still see the patient?",
        "question_type": "yes_no",
        "answer_options": ["Yes", "No"],
        "why_this_matters": "Locates the final referral boundary without assuming proteinuria.",
        "terminal": True,
        "synthetic": True,
        "created_at": BASE_TIMESTAMP,
    },
}

INITIALIZATION_QUESTIONS: dict[str, list[dict[str, Any]]] = {}
_INITIALIZATION_PROMPTS = {
    "lucy": (
        ("identity", "How should your agent describe your primary-care practice?"),
        ("focus", "Which clinical focus should your agent emphasize first?"),
        ("case-interest", "Which case types are you especially interested in coordinating?"),
        ("good-fit", "What makes a specialty referral a good fit for your workflow?"),
        ("redirect", "Which cases do you usually redirect before specialist outreach?"),
        ("workup", "What information should be gathered before a referral question?"),
        ("trajectory", "How should clinical trajectory affect referral urgency?"),
        ("access", "Which access constraints should your agent represent?"),
        ("communication", "What communication style do you prefer from specialists?"),
        ("follow-up", "What follow-up information should return to primary care?"),
    ),
    "iain": (
        ("identity", "How should your agent describe your nephrology practice?"),
        ("focus", "Which nephrology focus should your agent emphasize first?"),
        ("case-interest", "Which renal case types are you especially interested in seeing?"),
        ("good-fit", "What makes a CKD referral a particularly good fit?"),
        ("redirect", "Which hypertension cases do you usually redirect?"),
        ("workup", "Which studies are most useful before nephrology review?"),
        ("trajectory", "How should eGFR trajectory affect referral fit?"),
        ("proteinuria", "How should proteinuria affect referral fit?"),
        ("access", "Which access constraints should your agent represent?"),
        ("co-management", "When is cardiology co-management most useful?"),
    ),
}
for _persona_id, _prompts in _INITIALIZATION_PROMPTS.items():
    INITIALIZATION_QUESTIONS[_persona_id] = [
        {
            "id": f"{_persona_id}-initialization-{key}",
            "physician_persona": _persona_id,
            "source_type": "initialization",
            "source_reference": f"initialization:{key}",
            "prompt": prompt,
            "question_type": "short_text",
            "answer_options": [],
            "why_this_matters": "Fills a high-value agent initialization gap.",
            "asked_count": None,
            "synthetic": True,
            "terminal": True,
            "created_at": BASE_TIMESTAMP,
        }
        for key, prompt in _prompts
    ]

BRANCH_TRANSITIONS = {
    ("iain-resistant-htn-normal-kidney", "Depends"): "iain-branch-progressive-renal",
    ("iain-branch-progressive-renal", "Yes"): "iain-branch-proteinuria-absence",
    ("iain-branch-progressive-renal", "Depends"): "iain-branch-proteinuria-absence",
    ("iain-branch-proteinuria-absence", "Depends"): "iain-branch-declining-egfr-normal-upcr",
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


def physician_interests(persona_id: str, overlays: list[dict]) -> list[dict]:
    merged = {item["id"]: item for item in BASE_INTERESTS.get(persona_id, [])}
    merged.update({item["id"]: item for item in overlays})
    return sorted(merged.values(), key=lambda item: (item["interest_type"], item["id"]))


def project_professional_profile(
    persona_id: str, overlays: list[dict], interest_overlays: list[dict] | None = None
) -> dict:
    items = profile_items(persona_id, overlays)
    interests = physician_interests(persona_id, interest_overlays or [])
    completed = sorted({item["category"] for item in items})
    incomplete = [category for category in PROFILE_CATEGORIES if category not in completed]
    return {
        "physician": PERSONAS[persona_id],
        "items": items,
        "interests": interests,
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
    question = next(
        (item for item in TRAINING_QUESTIONS[persona_id] if item["id"] == question_id),
        None,
    )
    if question is None:
        question = BRANCH_QUESTIONS.get(question_id)
    if question is None:
        question = next(
            (item for item in INITIALIZATION_QUESTIONS[persona_id] if item["id"] == question_id),
            None,
        )
    if question is None and question_id.startswith(f"{persona_id}-bank-"):
        question = next(
            (
                item
                for item in generated_training_questions(persona_id)
                if item["id"] == question_id
            ),
            None,
        )
    if question and question["physician_persona"] == persona_id:
        return normalize_question(question)
    return None


def generated_training_questions(persona_id: str):
    """Yield a large deterministic bank from grounded calibration dimensions."""
    for topic_index, topic in enumerate(_CALIBRATION_TOPICS):
        for context_index, context in enumerate(_CALIBRATION_CONTEXTS):
            yield {
                "id": f"{persona_id}-bank-{topic_index:02d}-{context_index:02d}",
                "physician_persona": persona_id,
                "source_type": "practice_gap",
                "source_reference": f"calibration:{topic}:{context}",
                "prompt": f"For {context}, how should your agent represent {topic}?",
                "question_type": "short_text",
                "answer_options": [],
                "why_this_matters": (
                    "Clarifies a bounded representation gap using a reusable "
                    "practice-calibration dimension."
                ),
                "asked_count": None,
                "synthetic": True,
                "terminal": True,
                "created_at": BASE_TIMESTAMP,
            }


def normalize_question(question: dict) -> dict:
    source_priority = {
        "unresolved_branch": 95,
        "canonical_case": 90,
        "network_question": 85,
        "existing_practice_rule": 70,
        "initialization": 60,
        "practice_gap": 55,
        "profile_confirmation": 40,
        "explicit_synthetic_demo": 35,
    }
    return {
        **question,
        "root_question_id": question.get("root_question_id", question["id"]),
        "parent_question_id": question.get("parent_question_id"),
        "branch_depth": question.get("branch_depth", 0),
        "branch_path": question.get("branch_path", []),
        "branch_condition": question.get("branch_condition"),
        "terminal": question.get("terminal", True),
        "generated_from": question.get("source_type"),
        "priority": source_priority.get(question.get("source_type", ""), 50),
    }


def project_training_questions(persona_id: str, responses: list[dict]) -> list[dict]:
    latest: dict[str, dict] = {}
    for response in responses:
        latest[response["question_id"]] = response
    return [
        {
            **normalize_question(question),
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


def next_branch_question(
    persona_id: str, question_id: str, answer: str, assigned_ids: set[str]
) -> dict | None:
    child_id = BRANCH_TRANSITIONS.get((question_id, answer))
    if not child_id or child_id in assigned_ids:
        return None
    child = question_by_id(persona_id, child_id)
    if not child or child["branch_depth"] > MAX_BRANCH_DEPTH:
        return None
    if child_id in {part.split(":", 1)[0] for part in child["branch_path"]}:
        return None
    return child


def training_queue_summary(questions: list[dict], responses: list[dict]) -> dict:
    unanswered = [item for item in questions if item["status"] == "unanswered"]
    today = datetime.now(UTC).date().isoformat()
    answered_today = sum(
        1 for item in responses if str(item.get("answered_at", "")).startswith(today)
    )
    return {
        "recommended_today": min(TRAINING_DAILY_LIMIT, len(unanswered)),
        "unanswered_total": len(unanswered),
        "available_total": QUESTION_BANK_AVAILABLE,
        "answered_today": answered_today,
        "daily_limit": TRAINING_DAILY_LIMIT,
        "extended_limit": TRAINING_EXTENDED_LIMIT,
        "availability_model": "lazy_grounded_sources",
    }


def project_initialization(profile: dict, interests: list[dict], questions: list[dict]) -> dict:
    completed = {"professional_identity", "clinical_focus"}
    if any(item["interest_type"] == "case_interest" for item in interests):
        completed.add("case_interests")
    if profile["sections"].get("locations"):
        completed.add("access_practice_context")
    answered = {item["id"] for item in questions if item["status"] == "answered"}
    if answered:
        completed.update({"referral_preferences", "workup_preferences"})
    incomplete = [item for item in INITIALIZATION_SECTIONS if item not in completed]
    return {
        "initialized_sections": [item for item in INITIALIZATION_SECTIONS if item in completed],
        "incomplete_sections": incomplete,
        "high_value_questions_remaining": sum(
            1 for item in questions if item["status"] == "unanswered"
        ),
        "blocking": False,
        "meaning": "Progressive representation setup; incomplete sections do not block Lamina use.",
    }


def proposed_learning_statement(question_id: str, answer: str | list[str]) -> str:
    if question_id == "iain-branch-declining-egfr-normal-upcr":
        return {
            "Yes": (
                "Progressive renal dysfunction can make resistant-hypertension "
                "cases appropriate for nephrology even without proteinuria."
            ),
            "No": (
                "Normal protein quantification may change the fit of resistant-"
                "hypertension cases despite declining eGFR."
            ),
        }[str(answer)]
    if question_id in {
        "iain-branch-progressive-renal",
        "iain-branch-proteinuria-absence",
    }:
        return f"Branch response for {question_id}: {answer}."
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
    question = next(
        (
            item
            for items in INITIALIZATION_QUESTIONS.values()
            for item in items
            if item["id"] == question_id
        ),
        None,
    )
    if question:
        return f"For {question['prompt']} The physician answered: {answer}."
    if "-bank-" in question_id:
        return f"The physician supplied this practice-calibration guidance: {answer}."
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
    interests: list[dict] | None = None,
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
            "interests": [
                item for item in (interests or profile.get("interests", [])) if item["confirmed"]
            ],
            "interest_safety": (
                "Interests describe cases the physician wants to see; they are not "
                "acceptance rules, guarantees, expertise claims, or ranking signals."
            ),
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

