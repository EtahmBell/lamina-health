"""Controlled synthetic physician engagement fixtures and read projections.

This module deliberately does not participate in clinical candidate evaluation or
ranking.  Engagement improves representation detail only.
"""

from __future__ import annotations

import hashlib
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
QUESTION_BANK_AVAILABLE = 106
_CALIBRATION_DIMENSIONS = {
    "diagnosis_phenotype": (
        "the suspected diagnosis is not yet confirmed",
        "the phenotype is atypical",
        "the referral question spans two specialties",
        "the main diagnosis changed recently",
        "the presentation is recurrent",
        "the diagnosis is established but the cause is unclear",
        "the presentation does not match the usual pattern",
        "the referring clinician is asking for diagnostic clarification",
    ),
    "disease_severity": (
        "symptoms are mild but persistent",
        "objective findings are moderate",
        "severity is increasing despite stable symptoms",
        "the case is stable but clinically complex",
        "there is a marked abnormality without acute symptoms",
        "severity has crossed the usual referral threshold",
        "the record contains conflicting severity signals",
        "severity is uncertain because testing is incomplete",
    ),
    "trajectory": (
        "the condition is worsening quickly",
        "the condition is worsening slowly",
        "the condition is stable after a recent decline",
        "measurements fluctuate without a clear trend",
        "a previously stable condition has changed",
        "the trend is concerning despite one reassuring result",
        "the trajectory is unknown because prior records are missing",
        "the referring clinician reports progression before repeat testing",
    ),
    "comorbidity": (
        "a major cardiovascular comorbidity is present",
        "multiple chronic conditions complicate the question",
        "pregnancy changes the care context",
        "frailty changes the practical care plan",
        "another specialist is already involved",
        "medication choices are limited by comorbidity",
        "the comorbidity may explain part of the presentation",
        "the main condition is stable but the comorbidity is worsening",
    ),
    "prior_workup": (
        "the basic workup is complete",
        "one preferred study is missing",
        "outside records are not yet available",
        "the workup is old but otherwise complete",
        "initial testing was inconclusive",
        "the referring clinician cannot obtain a preferred test",
        "a prior specialist evaluation reached no conclusion",
        "the workup suggests more than one plausible cause",
    ),
    "required_labs": (
        "current baseline labs are available",
        "a key trend is available but the latest value is missing",
        "the latest result is normal despite a concerning trend",
        "a preferred confirmatory test is pending",
        "results come from different laboratories",
        "only a single measurement is available",
        "the requested laboratory study is difficult to obtain",
        "the core laboratory set is complete but imaging is pending",
    ),
    "treatment_history": (
        "first-line treatment has not been tried",
        "first-line treatment was not tolerated",
        "several standard options have failed",
        "the response to treatment is unclear",
        "treatment adherence is uncertain",
        "a recent treatment change has not had time to take effect",
        "treatment improved symptoms but not objective findings",
        "the current regimen is constrained by adverse effects",
    ),
    "geography_access": (
        "the patient lives far from the practice",
        "only a video visit is practical initially",
        "transportation is unreliable",
        "the preferred site has a long wait",
        "an alternate site can see the patient sooner",
        "insurance limits the available location",
        "the patient can travel once but not repeatedly",
        "local testing is available but specialist travel is difficult",
    ),
    "procedure_need": (
        "a procedure may be needed soon",
        "the referral is only for a procedure",
        "a procedure was attempted previously",
        "the need for a procedure is uncertain",
        "the procedure is available only at one site",
        "the patient wants a discussion before deciding on a procedure",
        "another specialist recommended a procedure",
        "the procedure question depends on updated testing",
    ),
    "care_setting": (
        "the question arises after an emergency visit",
        "the patient was recently discharged",
        "the patient is currently managed in primary care",
        "the request comes from another specialist",
        "the case is suitable for an e-consult",
        "the patient may need in-person assessment",
        "the care team is asking for co-management",
        "the question concerns transition back to primary care",
    ),
    "age_context": (
        "the patient is a young adult",
        "the patient is an older adult with preserved function",
        "age changes the likely differential",
        "life stage affects treatment priorities",
        "the presentation began much earlier than usual",
        "the condition is newly recognized late in life",
        "caregiver involvement changes follow-up feasibility",
        "age-specific norms make the result borderline",
    ),
    "exclusion_conditions": (
        "an exclusion condition is suspected but unconfirmed",
        "a competing diagnosis is more likely",
        "the main reason for referral falls outside your scope",
        "the case needs a different specialty first",
        "the issue can usually remain in primary care",
        "the available evidence argues against your specialty",
        "a safety concern requires urgent care instead",
        "the referral goal is administrative rather than clinical",
    ),
    "interests": (
        "the case closely matches a stated clinical interest",
        "the case is adjacent to a research interest",
        "the case could support a teaching discussion",
        "the case is uncommon but within your practice",
        "the case fits a developing area of interest",
        "the case is routine but high value for coordination",
        "the case aligns with a multidisciplinary interest",
        "the case does not match your interests but fits your scope",
    ),
}
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
        {
            "id": "lucy-referral-priority",
            "physician_persona": "lucy",
            "source_type": "profile_confirmation",
            "source_reference": "referral-priority",
            "prompt": "Which factor matters most when you refer?",
            "question_type": "single_choice",
            "answer_options": [
                "Specialist expertise for the patient's needs",
                "Earliest available appointment",
                "Continuity with specialists I already know",
            ],
            "why_this_matters": "Helps your agent weigh options the same way you would.",
            "asked_count": None,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        },
        {
            "id": "lucy-workup-priority",
            "physician_persona": "lucy",
            "source_type": "profile_confirmation",
            "source_reference": "workup-priority",
            "prompt": "Which workup do you usually want completed first?",
            "question_type": "single_choice",
            "answer_options": ["Core labs", "Imaging", "Whatever the specialist's office requests"],
            "why_this_matters": "Shapes what your agent asks for before a referral is sent.",
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
        (
            "identity",
            "Do you provide longitudinal primary care across multiple chronic conditions?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "care_setting",
        ),
        (
            "focus",
            "Should your agent emphasize specialty-care coordination as a core practice focus?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "interests",
        ),
        (
            "case-interest",
            "Do complex cases involving more than one specialty fit your coordination practice?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "diagnosis_phenotype",
        ),
        (
            "good-fit",
            "Does a clearly stated specialist question make a referral a better fit?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "prior_workup",
        ),
        (
            "redirect",
            "Do you usually redirect cases when the basic workup is missing?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "prior_workup",
        ),
        (
            "workup",
            "Which context is most useful before referral?",
            "multi_select",
            [
                "Current labs",
                "Trend over time",
                "Medication history",
                "Prior specialist evaluation",
                "Home measurements",
            ],
            "required_labs",
        ),
        (
            "trajectory",
            "Does a rapidly worsening trajectory increase referral urgency?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "trajectory",
        ),
        (
            "access",
            "Which access constraints should your agent represent?",
            "multi_select",
            [
                "Travel distance",
                "Visit modality",
                "Insurance",
                "Scheduling urgency",
                "Caregiver availability",
            ],
            "geography_access",
        ),
        (
            "communication",
            "Which specialist communication style do you prefer?",
            "single_choice",
            ["Concise recommendation", "Recommendation with rationale", "Shared-care plan"],
            "communication_preference",
        ),
        (
            "follow-up",
            "Should specialists return a specific follow-up plan to primary care?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "follow_up",
        ),
    ),
    "iain": (
        (
            "identity",
            "Do progressive CKD and resistant hypertension represent a core part of your practice?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "interests",
        ),
        (
            "focus",
            "Would you see a CKD referral when the underlying cause remains uncertain?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "diagnosis_phenotype",
        ),
        (
            "case-interest",
            "Do cardiorenal cases generally fit your practice?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "comorbidity",
        ),
        (
            "good-fit",
            "Does a documented decline in eGFR make a CKD referral a better fit?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "trajectory",
        ),
        (
            "redirect",
            "Do you usually redirect hypertension referrals with no renal findings?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "exclusion_conditions",
        ),
        (
            "workup",
            "Which studies are most useful before nephrology review?",
            "multi_select",
            ["BMP", "UPCR", "Urinalysis", "Renal imaging", "Home BP log"],
            "required_labs",
        ),
        (
            "trajectory",
            "Does rapid eGFR decline change referral urgency?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "trajectory",
        ),
        (
            "proteinuria",
            "Can progressive renal dysfunction fit your practice even when proteinuria is absent?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "disease_severity",
        ),
        (
            "access",
            "Which access constraints should your agent represent?",
            "multi_select",
            [
                "Travel distance",
                "Video-first option",
                "Insurance",
                "Scheduling urgency",
                "Local laboratory access",
            ],
            "geography_access",
        ),
        (
            "co-management",
            "When cardiorenal disease is present, do you typically favor cardiology co-management?",
            "yes_no_depends",
            ["Yes", "Depends", "No"],
            "care_setting",
        ),
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
            "question_type": question_type,
            "answer_options": answer_options,
            "dimension_being_narrowed": dimension,
            "why_this_matters": "Fills a high-value agent initialization gap.",
            "asked_count": None,
            "synthetic": True,
            "terminal": True,
            "created_at": BASE_TIMESTAMP,
        }
        for key, prompt, question_type, answer_options, dimension in _prompts
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
    practice = "primary-care coordination" if persona_id == "lucy" else "nephrology"
    for dimension_index, (dimension, conditions) in enumerate(_CALIBRATION_DIMENSIONS.items()):
        for condition_index, condition in enumerate(conditions):
            yield {
                "id": f"{persona_id}-bank-{dimension_index:02d}-{condition_index:02d}",
                "physician_persona": persona_id,
                "source_type": "practice_gap",
                "source_reference": f"calibration:{dimension}:{condition_index}",
                "prompt": (f"Would this case fit your {practice} practice if {condition}?"),
                "question_type": "yes_no_depends",
                "answer_options": ["Yes", "Depends", "No"],
                "why_this_matters": (
                    f"Clarifies the physician's {dimension.replace('_', ' ')} boundary."
                ),
                "dimension_being_narrowed": dimension,
                "question_objective": "Locate a bounded practice-fit decision boundary.",
                "asked_count": None,
                "synthetic": True,
                "terminal": False,
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


_BRANCH_NARROWING = {
    "diagnosis_phenotype": (
        "Would the case fit if the referring question were limited to diagnostic clarification?",
        "Would it still fit if the diagnosis remained unconfirmed after the basic workup?",
    ),
    "disease_severity": (
        "Would objective progression make the case appropriate despite limited symptoms?",
        "Would it still fit if the latest single measurement were reassuring?",
    ),
    "trajectory": (
        "Would documented progression over multiple measurements make the case appropriate?",
        "Would it still fit if the latest measurement were stable?",
    ),
    "comorbidity": (
        "Would the case fit if the comorbidity directly constrained usual management?",
        "Would it still fit if another specialist were already co-managing the patient?",
    ),
    "prior_workup": (
        "Would the case fit if all basic testing were complete except one preferred study?",
        "Would it still fit if that study could not be obtained locally?",
    ),
    "required_labs": (
        "Would a documented trend be enough if the newest laboratory result were pending?",
        "Would it still be enough if the last result were more than three months old?",
    ),
    "treatment_history": (
        "Would intolerance of first-line treatment make the case appropriate?",
        "Would it still fit before another standard option had been tried?",
    ),
    "geography_access": (
        "Would a video-first visit make the case practical for your practice?",
        "Would it still fit if all follow-up also had to be remote?",
    ),
    "procedure_need": (
        "Would the case fit if the immediate question were whether a procedure is indicated?",
        "Would it still fit if the procedure had to occur at another site?",
    ),
    "care_setting": (
        "Would an initial e-consult be sufficient to determine next steps?",
        "Would it still fit if an in-person examination were likely afterward?",
    ),
    "age_context": (
        "Would age alter your threshold for accepting the case?",
        "Would it still fit if functional status were preserved?",
    ),
    "exclusion_conditions": (
        "Would you accept the case after the competing diagnosis was excluded?",
        "Would it still fit if another specialty needed to evaluate first?",
    ),
    "interests": (
        "Would the case fit even if it were outside your stated interests but within scope?",
        "Would it still fit if it required multidisciplinary co-management?",
    ),
    "communication_preference": (
        "Would a concise recommendation plus rationale meet your communication needs?",
        "Would you also require a shared follow-up plan?",
    ),
    "follow_up": (
        "Would a specific follow-up interval be sufficient for return to primary care?",
        "Would you also require explicit re-referral triggers?",
    ),
}


def deterministic_branch_question(
    persona_id: str, parent: dict, assigned_ids: set[str]
) -> dict | None:
    """Create one grounded child for a ternary Depends when no static child exists."""
    depth = int(parent.get("branch_depth", 0)) + 1
    if parent.get("question_type") != "yes_no_depends" or depth > MAX_BRANCH_DEPTH:
        return None
    dimension = parent.get("dimension_being_narrowed") or "diagnosis_phenotype"
    prompts = _BRANCH_NARROWING.get(dimension, _BRANCH_NARROWING["diagnosis_phenotype"])
    prompt = (
        prompts[depth - 1]
        if depth <= len(prompts)
        else (
            f"If {dimension.replace('_', ' ')} were the only remaining uncertainty, "
            "would you accept the case?"
        )
    )
    digest = hashlib.sha256(f"{persona_id}:{parent['id']}:{depth}:{prompt}".encode()).hexdigest()[
        :12
    ]
    question_id = f"{persona_id}-branch-generated-{digest}"
    if question_id in assigned_ids:
        return None
    root_id = parent.get("root_question_id", parent["id"])
    branch_path = [*parent.get("branch_path", []), f"{parent['id']}:Depends"]
    return normalize_question(
        {
            "id": question_id,
            "physician_persona": persona_id,
            "root_question_id": root_id,
            "parent_question_id": parent["id"],
            "branch_depth": depth,
            "branch_path": branch_path,
            "branch_condition": "Depends",
            "source_type": "deterministic_branch",
            "source_reference": parent.get("source_reference"),
            "prompt": prompt,
            "question_type": "yes_no" if depth == MAX_BRANCH_DEPTH else "yes_no_depends",
            "answer_options": ["Yes", "No"]
            if depth == MAX_BRANCH_DEPTH
            else ["Yes", "Depends", "No"],
            "why_this_matters": f"Narrows the {dimension.replace('_', ' ')} boundary.",
            "dimension_being_narrowed": dimension,
            "terminal_candidate": depth == MAX_BRANCH_DEPTH,
            "proposed_boundary_rationale": (
                f"This answer clarifies the physician's {dimension.replace('_', ' ')} boundary."
            ),
            "source_references": [parent.get("source_reference")]
            if parent.get("source_reference")
            else [],
            "terminal": depth == MAX_BRANCH_DEPTH,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        }
    )


def training_queue_summary(questions: list[dict], responses: list[dict]) -> dict:
    unanswered = [item for item in questions if item["status"] == "unanswered"]
    persona_id = questions[0]["physician_persona"] if questions else None
    catalog_total = QUESTION_BANK_AVAILABLE
    if persona_id:
        catalog_total += len(TRAINING_QUESTIONS[persona_id]) + len(
            INITIALIZATION_QUESTIONS[persona_id]
        )
    answered_catalog_ids = {
        item["question_id"] for item in responses if "-branch-" not in item["question_id"]
    }
    today = datetime.now(UTC).date().isoformat()
    answered_today = sum(
        1 for item in responses if str(item.get("answered_at", "")).startswith(today)
    )
    return {
        "recommended_today": min(TRAINING_DAILY_LIMIT, len(unanswered)),
        "unanswered_total": len(unanswered),
        "available_total": max(0, catalog_total - len(answered_catalog_ids)),
        "answered_today": answered_today,
        "daily_limit": TRAINING_DAILY_LIMIT,
        "extended_limit": TRAINING_EXTENDED_LIMIT,
        "availability_model": "lazy_grounded_sources",
    }


def project_initialization(
    profile: dict,
    interests: list[dict],
    questions: list[dict],
    persisted_state: dict | None = None,
    first_training_completed: bool = False,
) -> dict:
    required_steps = [
        {"id": "professional_identity", "label": "Professional identity"},
        {"id": "practice_context", "label": "Basic specialty and practice context"},
        {"id": "interests", "label": "At least one confirmed interest"},
        {"id": "first_training", "label": "First 10-question setup session"},
    ]
    completed_step_ids = {"professional_identity", "practice_context"}
    if any(item.get("confirmed", True) for item in interests):
        completed_step_ids.add("interests")
    if first_training_completed or persisted_state:
        completed_step_ids.add("first_training")
    initialized = persisted_state is not None
    completed = set(INITIALIZATION_SECTIONS) if initialized else {
        "professional_identity",
        "clinical_focus",
        "access_practice_context",
    }
    if not initialized and any(
        item["interest_type"] == "case_interest" for item in interests
    ):
        completed.add("case_interests")
    if not initialized and any(item["status"] == "answered" for item in questions):
        completed.update({"referral_preferences", "workup_preferences"})
    incomplete = [] if initialized else [
        item for item in INITIALIZATION_SECTIONS if item not in completed
    ]
    return {
        "status": "initialized" if initialized else "in_progress",
        "initialized": initialized,
        "initialized_at": persisted_state["initialized_at"] if persisted_state else None,
        "required_steps": required_steps,
        "completed_steps": [
            item for item in required_steps if item["id"] in completed_step_ids
        ],
        "initialized_sections": [item for item in INITIALIZATION_SECTIONS if item in completed],
        "incomplete_sections": incomplete,
        "high_value_questions_remaining": sum(
            1 for item in questions if item["status"] == "unanswered"
        ),
        "blocking": False,
        "meaning": (
            "Agent initialized; ongoing improvement happens through Profile and Train."
            if initialized
            else "Complete one setup training session to initialize your agent."
        ),
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
        return f"For Dr. Saruhashi, nephrology-first routing for progressive CKD with resistant hypertension: {answer}."
    if question_id == "lucy-ida-routing":
        return f"Dr. Saruhashi uses gastroenterology-first routing for persistent iron deficiency without source evaluation: {answer}."
    if question_id == "lucy-referral-context":
        return f"Dr. Saruhashi wants referral questions to include {', '.join(answer)}."
    if question_id == "lucy-referral-priority":
        return f"When referring, Dr. Saruhashi prioritizes: {answer}."
    if question_id == "lucy-workup-priority":
        return f"Dr. Saruhashi usually wants {str(answer).casefold()} completed first."
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
    return f"The physician answered {answer} for practice-calibration question {question_id}."


def synthesize_branch_learning(root_question_id: str, branch: list[tuple[dict, dict]]) -> str:
    """Synthesize one reviewable boundary from a root and its answered descendants."""
    answered = [(question, response) for question, response in branch if not response["skipped"]]
    if not answered:
        raise ValueError("A branch learning requires at least one answer")
    if root_question_id == "iain-resistant-htn-normal-kidney":
        answers = {question["id"]: response["answer"] for question, response in answered}
        if answers.get("iain-branch-declining-egfr-normal-upcr") == "Yes":
            return (
                "Progressive renal dysfunction can make resistant-hypertension referrals "
                "appropriate even without proteinuria."
            )
    leaf_question, leaf_response = max(
        answered, key=lambda item: int(item[0].get("branch_depth", 0))
    )
    if len(answered) == 1:
        return proposed_learning_statement(leaf_question["id"], leaf_response["answer"])
    answer = leaf_response["answer"]
    dimension = str(leaf_question.get("dimension_being_narrowed") or "practice fit").replace(
        "_", " "
    )
    rationale = leaf_question.get("proposed_boundary_rationale")
    if rationale:
        return f"{rationale.rstrip('.')} Final boundary response: {answer}."
    return (
        f"The physician's {dimension} boundary resolves to {answer} at: {leaf_question['prompt']}"
    )


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


def related_personas(perspective: str, records: list[dict], members: list[dict]) -> set[str]:
    related = {
        persona for member in members if (persona := PERSONA_BY_NPI.get(member["npi"])) is not None
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
