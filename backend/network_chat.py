"""General, non-patient-specific "Ask their agent" chat from a Network
physician profile (pre-NLP physician-representation cleanup pass, Part
J-Q). Deliberately a DIFFERENT boundary than
backend/referrals/coordination_chat.py's patient-scoped channel:

- No patient is selected, no patient record is mounted, no referral exists.
- Answers are grounded ONLY in that physician's own CONFIRMED general
  practice representation (professional profile sections, confirmed case/
  clinical interests, confirmed practice representation facts, confirmed
  training learnings) -- never another patient's record, another referral's
  context, or an unconfirmed/proposed learning.
- Deterministic/keyword-grounded, mirroring coordination_chat.py's own
  established pattern -- no live LLM call, no hidden reasoning to expose.
- Nothing here is persisted: this module never writes to WorkflowStore or
  anywhere else. The caller (frontend) keeps any multi-turn history only in
  its own component state for the current session.
"""

from __future__ import annotations


def answer_general_practice_question(
    representation: dict,
    physician_name: str,
    question: str,
) -> tuple[str, list[str], bool]:
    """Returns (answer, based_on, unconfirmed). `unconfirmed` mirrors the
    patient-scoped chat's `requires_physician_input` shape for frontend
    reuse: true whenever the physician has not actually confirmed a
    representation this question could be grounded in, so the UI can show
    the same honest-uncertainty treatment it already uses elsewhere.
    Never fabricates a preference/policy that was never confirmed."""
    lower = question.lower()
    sections = representation.get("sections", representation)
    clinical_focus = sections.get("clinical_focus") or []
    good_fit = sections.get("good_fit") or []
    preferred_workup = sections.get("preferred_workup") or sections.get("referral_requirements") or []
    access_facts = sections.get("access_facts") or []
    interests = [item["statement"] if isinstance(item, dict) and "statement" in item else item for item in (sections.get("interests") or [])]
    confirmed_learnings = [item["statement"] for item in (sections.get("confirmed_learnings") or [])]

    if any(keyword in lower for keyword in ("workup", "require", "need before", "order before", "test before")):
        if preferred_workup:
            return (
                f"Dr. {physician_name} typically wants: {', '.join(preferred_workup)}.",
                ["confirmed practice representation"],
                False,
            )
        return (
            f"Dr. {physician_name} has not confirmed a preference on that yet.",
            [],
            True,
        )

    if any(keyword in lower for keyword in ("e-consult", "econsult", "in-person", "in person", "virtual visit")):
        # NLP referral-preference pass, Part V: grounded ONLY in a CONFIRMED
        # modality preference -- never a draft, and never fabricated when
        # nothing has been confirmed (Part P/Q: decline rather than invent).
        modality_preference = sections.get("modality_preference")
        if modality_preference:
            return (
                f"Dr. {physician_name} has confirmed: {modality_preference}",
                ["confirmed referral preference"],
                False,
            )
        return (
            f"Dr. {physician_name} has not confirmed a preference on e-consult versus in-person visits yet.",
            [],
            True,
        )

    if any(keyword in lower for keyword in ("case", "send you", "useful to send", "interested in", "kinds of")):
        facts = [*clinical_focus, *good_fit, *interests]
        if facts:
            return (
                f"Dr. {physician_name}'s confirmed practice focus includes: {', '.join(dict.fromkeys(facts))}.",
                ["confirmed practice representation", "confirmed case/clinical interests"],
                False,
            )
        return (
            f"Dr. {physician_name} has not confirmed specific case interests yet.",
            [],
            True,
        )

    if any(keyword in lower for keyword in ("information", "referral useful", "makes a referral", "what do you need")):
        if preferred_workup:
            return (
                f"A referral is most useful to Dr. {physician_name} when it includes: {', '.join(preferred_workup)}.",
                ["confirmed practice representation"],
                False,
            )
        return (
            f"Dr. {physician_name} has not confirmed a specific referral-information preference yet.",
            [],
            True,
        )

    if any(keyword in lower for keyword in ("access", "wait", "availability", "how long", "how soon")):
        if access_facts:
            return (
                f"Dr. {physician_name}'s typical in-person access is {access_facts[0]}.",
                ["confirmed practice representation"],
                False,
            )
        return (
            f"Dr. {physician_name} has not confirmed current access information yet.",
            [],
            True,
        )

    if confirmed_learnings:
        return (
            f"Dr. {physician_name} has confirmed: {confirmed_learnings[0]}",
            ["confirmed training learnings"],
            False,
        )

    return (
        f"I don't have enough confirmed information about Dr. {physician_name}'s practice to answer that.",
        [],
        True,
    )
