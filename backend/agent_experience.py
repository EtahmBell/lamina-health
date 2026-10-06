"""Canonical My Agent projections and controlled synthetic chat fixtures."""

from __future__ import annotations

import hashlib
from typing import Any

from backend.engagement import BASE_TIMESTAMP, PERSONAS, normalize_question

_TEST_CASES: dict[str, list[dict[str, Any]]] = {
    "lucy": [
        {
            "id": "lucy-test-progressive-ckd",
            "title": "Progressive CKD with resistant hypertension",
            "summary": "A short Jordan-like referral-routing scenario.",
            "facts": [
                "Progressive stage 3b CKD",
                "Resistant hypertension",
                "Declining eGFR",
            ],
            "intended_domain": "specialty_routing",
            "source": "controlled_synthetic_jordan_like",
            "correction_prompt": "Would you usually refer this type of case to nephrology first?",
        },
        {
            "id": "lucy-test-persistent-iron-deficiency",
            "title": "Persistent iron deficiency without source evaluation",
            "summary": "A short Maria-like referral-sequencing scenario.",
            "facts": [
                "Persistent iron deficiency",
                "No gastrointestinal source evaluation yet",
                "No acute instability",
            ],
            "intended_domain": "specialty_routing",
            "source": "controlled_synthetic_maria_like",
            "correction_prompt": "Would you usually refer this type of case to gastroenterology first?",
        },
        {
            "id": "lucy-test-preserved-renal-function",
            "title": "Borderline resistant hypertension",
            "summary": "Resistant hypertension with preserved renal function.",
            "facts": [
                "Resistant hypertension",
                "Preserved renal function",
                "No documented proteinuria",
            ],
            "intended_domain": "learned_referral_boundary",
            "source": "controlled_synthetic_boundary",
            "correction_prompt": "Would you usually choose nephrology first when renal function is preserved?",
        },
        {
            "id": "lucy-test-incomplete-workup",
            "title": "Referral with incomplete workup",
            "summary": "A stable specialty question with one preferred study missing.",
            "facts": [
                "Stable chronic presentation",
                "Clear specialty question",
                "One preferred study is unavailable",
            ],
            "intended_domain": "workup_preference",
            "source": "controlled_synthetic_preference",
            "correction_prompt": "Would you proceed with specialty outreach when one preferred study is missing?",
        },
    ],
    "iain": [
        {
            "id": "iain-test-progressive-ckd",
            "title": "Progressive stage 3b CKD with resistant hypertension",
            "summary": "A bounded Jordan-like nephrology fit scenario.",
            "facts": [
                "Progressive stage 3b CKD",
                "Resistant hypertension",
                "Declining eGFR",
            ],
            "intended_domain": "practice_fit",
            "source": "controlled_synthetic_jordan_like",
            "correction_prompt": "Would you see this type of progressive CKD case?",
        },
        {
            "id": "iain-test-normal-renal-function",
            "title": "Resistant hypertension with normal renal function",
            "summary": "A boundary test without established renal dysfunction.",
            "facts": [
                "Resistant hypertension",
                "Normal renal function",
                "No documented proteinuria",
            ],
            "intended_domain": "practice_fit_boundary",
            "source": "controlled_synthetic_boundary",
            "correction_prompt": "Would you see resistant hypertension when renal function is normal?",
        },
        {
            "id": "iain-test-proteinuric-ckd",
            "title": "Proteinuric CKD",
            "summary": "A bounded renal referral with proteinuria and CKD.",
            "facts": ["Chronic kidney disease", "Documented proteinuria", "Current BMP available"],
            "intended_domain": "practice_fit",
            "source": "controlled_synthetic_renal",
            "correction_prompt": "Would you generally see proteinuric CKD?",
        },
        {
            "id": "iain-test-borderline-cardiorenal",
            "title": "Borderline cardiorenal case",
            "summary": "Stable renal findings with a competing cardiovascular question.",
            "facts": [
                "Stable mild renal impairment",
                "Prominent cardiovascular question",
                "No rapid renal decline",
            ],
            "intended_domain": "co_management_boundary",
            "source": "controlled_synthetic_cardiorenal",
            "correction_prompt": "Would this borderline cardiorenal case fit your practice?",
        },
    ],
}


def agent_test_cases(persona_id: str) -> list[dict]:
    return [
        {key: value for key, value in item.items() if key != "correction_prompt"}
        for item in _TEST_CASES[persona_id]
    ]


def test_case_by_id(persona_id: str, case_id: str) -> dict | None:
    return next((item for item in _TEST_CASES[persona_id] if item["id"] == case_id), None)


def deterministic_portrait(
    persona_id: str, confirmed_learnings: list[dict]
) -> tuple[str, list[str]]:
    if persona_id == "lucy":
        portrait = (
            "Primary care physician in Oakland focused on coordinating specialty care. "
            "Your agent understands that progressive renal dysfunction often shifts "
            "resistant-hypertension referrals toward nephrology and that persistent iron "
            "deficiency without source evaluation generally starts with gastroenterology."
        )
    else:
        portrait = (
            "Nephrologist in Oakland with interests in proteinuric CKD, cardiorenal disease, "
            "and difficult-to-control blood pressure in CKD. Your agent understands your "
            "preferred CKD workup and the situations that make resistant hypertension a good "
            "fit for your practice."
        )
    facts = [item["statement"] for item in confirmed_learnings]
    if facts:
        portrait = f"{portrait} It also includes {len(facts)} physician-confirmed training learning{'s' if len(facts) != 1 else ''}."
    return portrait, facts


def deterministic_agent_chat(
    persona_id: str,
    mode: str,
    message: str,
    representation: dict,
    test_case: dict | None,
) -> dict:
    sections = representation["sections"]
    confirmed = sections.get("confirmed_learnings", [])
    lower = message.casefold()
    if mode == "practice_question":
        if "interest" in lower or "cases" in lower:
            interests = [item["title"] for item in sections.get("interests", [])]
            answer = (
                f"Your confirmed interests include {', '.join(interests)}."
                if interests
                else "You have not confirmed any case interests yet."
            )
            return {
                "answer": answer,
                "evidence_summary": interests,
                "based_on": [f"interest:{item['id']}" for item in sections.get("interests", [])],
                "coverage": "confirmed_representation" if interests else "uncertain",
                "uncertainty": None if interests else "No confirmed interests are available.",
                "can_train_from_this": not interests,
            }
        if "workup" in lower or "before a referral" in lower:
            workup = sections.get("preferred_workup", [])
            return {
                "answer": (
                    f"Your current representation lists {', '.join(workup)}."
                    if workup
                    else "You have not taught me a preferred pre-referral workup yet."
                ),
                "evidence_summary": workup,
                "based_on": ["practice:preferred_workup"] if workup else [],
                "coverage": "confirmed_representation" if workup else "uncertain",
                "uncertainty": None if workup else "Preferred workup is not represented.",
                "can_train_from_this": not workup,
            }
        if "learned" in lower or "practice" in lower:
            rules = [*sections.get("explicit_rules", []), *[item["statement"] for item in confirmed]]
            return {
                "answer": (
                    f"I currently represent {len(rules)} explicit or physician-confirmed practice rules."
                    if rules
                    else "You have not confirmed practice rules yet."
                ),
                "evidence_summary": rules,
                "based_on": ["practice:explicit_rules", *[f"learning:{item['id']}" for item in confirmed]],
                "coverage": "confirmed_representation" if rules else "uncertain",
                "uncertainty": None if rules else "No confirmed practice rules are available.",
                "can_train_from_this": not rules,
            }
        return {
            "answer": "You have not taught me enough to answer that practice boundary yet.",
            "evidence_summary": [],
            "based_on": [],
            "coverage": "uncertain",
            "uncertainty": "No matching confirmed rule or interest was found.",
            "can_train_from_this": True,
        }

    assert test_case is not None
    case_id = test_case["id"]
    known: dict[str, tuple[str, list[str]]] = {
        "lucy-test-progressive-ckd": (
            "Your current representation would usually route this synthetic scenario to nephrology first.",
            ["practice:explicit_rules:renal-routing"],
        ),
        "lucy-test-persistent-iron-deficiency": (
            "Your current representation would usually start with gastroenterology for source evaluation.",
            ["practice:explicit_rules:anaemia-routing"],
        ),
        "iain-test-progressive-ckd": (
            "This synthetic scenario matches your represented focus in progressive CKD and resistant hypertension.",
            ["practice:clinical_focus", "practice:preferred_workup"],
        ),
        "iain-test-proteinuric-ckd": (
            "This synthetic scenario matches your represented interest in proteinuric CKD.",
            ["practice:clinical_focus", "practice:preferred_workup"],
        ),
    }
    if case_id in known:
        answer, based_on = known[case_id]
        return {
            "answer": answer,
            "evidence_summary": test_case["facts"],
            "based_on": based_on,
            "coverage": "represented",
            "uncertainty": None,
            "can_train_from_this": True,
        }
    relevant = [
        item for item in confirmed if any(word in item["statement"].casefold() for word in ("renal", "hypertension", "cardiorenal", "workup"))
    ]
    if relevant:
        return {
            "answer": f"Based on your confirmed training: {relevant[0]['statement']}",
            "evidence_summary": test_case["facts"],
            "based_on": [f"learning:{relevant[0]['id']}"],
            "coverage": "confirmed_training",
            "uncertainty": None,
            "can_train_from_this": True,
        }
    return {
        "answer": "You have not taught me enough to resolve this synthetic practice boundary.",
        "evidence_summary": test_case["facts"],
        "based_on": [f"test_case:{case_id}"],
        "coverage": "uncertain",
        "uncertainty": "No matching confirmed practice rule is available.",
        "can_train_from_this": True,
    }


def focused_training_question(persona_id: str, chat_response: dict) -> dict:
    case = test_case_by_id(persona_id, chat_response.get("test_case_id") or "")
    prompt = (
        case["correction_prompt"]
        if case
        else "Does your current agent response reflect how you would usually handle this?"
    )
    seed_key = f"{persona_id}:{chat_response['response_id']}:{prompt}"
    question_id = f"{persona_id}-focused-{hashlib.sha256(seed_key.encode()).hexdigest()[:12]}"
    return normalize_question(
        {
            "id": question_id,
            "physician_persona": persona_id,
            "source_type": "agent_chat_correction",
            "source_reference": f"agent-chat:{chat_response['response_id']}",
            "prompt": prompt,
            "question_type": "yes_no_depends",
            "answer_options": ["Yes", "Depends", "No"],
            "why_this_matters": "Corrects one focused gap in the agent's practice representation.",
            "dimension_being_narrowed": case["intended_domain"] if case else "practice_fit",
            "question_objective": "Resolve the practice boundary exposed by agent testing.",
            "terminal": False,
            "synthetic": True,
            "created_at": BASE_TIMESTAMP,
        }
    )


def persona_identity_summary(persona_id: str) -> dict:
    persona = PERSONAS[persona_id]
    return {
        "persona_id": persona_id,
        "name": persona["name"],
        "specialty": persona["specialty"],
        "location": persona["location"],
        "synthetic": True,
    }
