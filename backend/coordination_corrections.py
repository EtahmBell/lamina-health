"""Physician corrections of their own agent's coordination representations
(agent coordination oversight pass).

A correction never edits the coordination record. It is a separate,
attributable AgentCorrection attached to one structured item. Its scope
decides what else happens:

- `episode`: an annotation on this coordination only;
- `future`: a durable learning, through the SAME learning/versioning
  infrastructure as "Tell your agent something" -- a referral preference
  for a receiving physician (interpreted by the existing interpreter,
  layered and confirmed by the existing store), or a confirmed agent
  learning for the referring physician;
- `both`.

`propose` is pure (cancelling changes nothing); `confirm` is the only
write. Ownership is checked here, independently of what the UI shows.
"""

from __future__ import annotations

from datetime import UTC, datetime

from backend.demo_identity import LUCY_AGENT_ID
from backend.engagement import PERSONAS
from backend.models import (
    AgentCorrection,
    CoordinationCorrectionProposal,
    CoordinationItem,
    Referral,
    StructuredReferralPreference,
)
from backend.referral_preferences import (
    _learning_lines,
    confirmed_requirement_items,
    effective_confirmed_rules,
    is_empty_preference,
    layer_preferences,
    referral_preference_interpretation_service,
)
from backend.referrals.coordination_episode import can_correct_item
from backend.referrals.coordination_chat import represented_agent_id
from backend.referrals.requirements import requirements_for
from backend.representation import representation_snapshot_id
from backend.workflow import WorkflowStore

EPISODE_EFFECT = (
    "Adds your correction to this coordination record. The original entry stays visible, "
    "and nothing about how your agent handles other cases changes."
)


class CorrectionNotAllowed(Exception):
    """The viewer may not correct this item (not their agent, or a recorded fact)."""


class CorrectionConflict(Exception):
    """The requested scope can't be applied (e.g. nothing durable to learn)."""


def persona_for_physician(physician_id: str) -> str | None:
    if physician_id == LUCY_AGENT_ID:
        return "lucy"
    return next((key for key, persona in PERSONAS.items() if persona.get("physician_id") == physician_id), None)


def authorize_correction(referral: Referral, item: CoordinationItem, physician_id: str) -> None:
    if physician_id not in (referral.referring_physician_id, referral.receiving_physician_id):
        raise CorrectionNotAllowed("Only the two physicians on this referral may correct its coordination.")
    if item.content_kind not in ("agent_representation", "practice_representation") or item.actor_kind != "agent":
        raise CorrectionNotAllowed("This entry is a recorded fact; it can't be corrected.")
    if not can_correct_item(physician_id, item):
        raise CorrectionNotAllowed("A physician may only correct their own agent.")


def _future_for_receiving(
    workflow_store: WorkflowStore, workspace_id: str, referral: Referral, physician_id: str,
    persona_id: str, case_family: str, text: str,
) -> tuple[list[str], str | None, StructuredReferralPreference | None]:
    """(effect lines, unavailable reason, interpreted preference) -- the
    existing referral-preference interpreter, never a second one."""
    _family, structured, _provider = referral_preference_interpretation_service.interpret(
        text, PERSONAS[persona_id]["specialty"], case_family
    )
    if is_empty_preference(structured):
        return [], structured.interpretation_note or "This doesn't describe how your practice handles referrals, so it can only apply to this coordination.", None
    current = effective_confirmed_rules(workflow_store, workspace_id, physician_id, case_family)
    if current is not None and layer_preferences(current, structured) == current:
        return [], "Your agent already represents this guidance; there's nothing new to learn from it.", None
    lines = [_proposal_line(line) for line in _learning_lines(current, layer_preferences(current, structured))]
    # Make a demotion explicit: an item that blocks review today and becomes
    # helpful information.
    operational = confirmed_requirement_items(workflow_store, workspace_id, physician_id, case_family)
    if operational is None:
        operational = requirements_for(physician_id, case_family)
    blocking = {item.key: item.label for item in operational if item.required}
    lines += [
        f"{blocking[item.key]} will no longer block review."
        for item in structured.helpful if item.key in blocking
    ]
    return lines, None, structured


# _learning_lines describes a CONFIRMED change; a proposal isn't one yet.
_PROPOSAL_WORDING = (
    ("Confirmed as required before review: ", "Required before review: "),
    ("Confirmed as helpful before review: ", "Helpful before review, never blocking it: "),
    ("Confirmed a good fit: ", "A good fit: "),
    ("Confirmed case interest: ", "Case interest: "),
    ("Confirmed generally routed elsewhere: ", "Generally routed elsewhere: "),
    ("Clarified that e-consult can be appropriate when ", "E-consult can be appropriate when "),
    ("Confirmed that in-person evaluation is preferred when ", "In-person evaluation is preferred when "),
)


def _proposal_line(line: str) -> str:
    for confirmed, proposed in _PROPOSAL_WORDING:
        if line.startswith(confirmed):
            return proposed + line[len(confirmed):]
    return line


def propose(
    workflow_store: WorkflowStore, workspace_id: str, referral: Referral, item: CoordinationItem,
    physician_id: str, text: str, case_family: str, suggested_scope: str | None,
) -> CoordinationCorrectionProposal:
    authorize_correction(referral, item, physician_id)
    persona_id = persona_for_physician(physician_id)
    lines: list[str] = []
    reason: str | None = None
    structured: StructuredReferralPreference | None = None
    if persona_id is None:
        reason = "This physician has no agent representation to update, so the correction can only apply to this coordination."
    elif physician_id == referral.receiving_physician_id:
        lines, reason, structured = _future_for_receiving(
            workflow_store, workspace_id, referral, physician_id, persona_id, case_family, text
        )
    else:
        lines = [f"Becomes confirmed guidance for how your agent represents similar cases: “{text.strip()}”"]
    if reason and suggested_scope in ("future", "both"):
        suggested_scope = "episode"
    return CoordinationCorrectionProposal(
        item_id=item.id,
        original_representation=item.statement,
        correction_text=text.strip(),
        suggested_scope=suggested_scope,
        episode_effect=EPISODE_EFFECT,
        future_available=reason is None,
        future_effect=lines,
        future_unavailable_reason=reason,
        future_case_family=case_family if structured is not None else None,
        future_preference=structured,
    )


def confirm(
    workflow_store: WorkflowStore, workspace_id: str, referral: Referral, item: CoordinationItem,
    physician_id: str, text: str, case_family: str, scope: str,
) -> AgentCorrection:
    """The only write. A durable scope re-derives its learning server-side
    (never trusting a client-supplied rule set) and confirms it through the
    existing store, which layers it and records supersession."""
    proposal = propose(workflow_store, workspace_id, referral, item, physician_id, text, case_family, scope)
    learning_id: str | None = None
    version: str | None = None
    if scope in ("future", "both"):
        if not proposal.future_available:
            raise CorrectionConflict(proposal.future_unavailable_reason or "Nothing durable to learn from this correction.")
        persona_id = persona_for_physician(physician_id)
        assert persona_id is not None
        if proposal.future_preference is not None:
            created = workflow_store.create_referral_preference(
                workspace_id, physician_id, case_family,
                source_text=proposal.correction_text,
                structured_rules_json=proposal.future_preference.model_dump_json(),
                source="coordination_correction",
            )
            workflow_store.confirm_referral_preference(workspace_id, created["id"], None)
            version = representation_snapshot_id(workflow_store, workspace_id, persona_id)
            workflow_store.set_referral_preference_snapshot(workspace_id, created["id"], version)
            learning_id = created["id"]
        else:
            learning = workflow_store.create_proposed_learning(
                workspace_id, persona_id, "coordination_correction",
                f"referral-{referral.id}:{item.id}:{datetime.now(UTC).isoformat()}",
                proposal.correction_text,
            )
            workflow_store.update_proposed_learning(
                workspace_id, persona_id, learning["id"], proposal.correction_text, "confirmed", "coordination_correction"
            )
            version = representation_snapshot_id(workflow_store, workspace_id, persona_id)
            learning_id = f"learning-{learning['id']}"
    correction = AgentCorrection(
        physician_id=physician_id,
        agent_id=represented_agent_id(physician_id),
        patient_id=referral.patient_id,
        referral_id=referral.id,
        source_item_id=item.id,
        original_representation=item.statement,
        correction_text=proposal.correction_text,
        scope=scope,
        status="confirmed" if learning_id else "episode_annotation",
        resulting_learning_id=learning_id,
        resulting_representation_version=version,
        created_at=datetime.now(UTC).isoformat(),
    )
    return workflow_store.create_correction(workspace_id, referral.patient_id, correction)
