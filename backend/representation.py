"""Representation snapshot identifier.

The smallest clean abstraction that lets an evaluation result or a confirmed
preference say "this was produced using THIS physician-representation
state" -- a deterministic content hash over everything that could actually
change it: confirmed training learnings, confirmed interests, physician-
entered profile overlays, and confirmed referral preferences. Read-only
(never writes anything). Changes the moment any of those change; stable
otherwise -- so a before/after representation-change comparison is just
"these two snapshot ids differ," with no version-management subsystem.

Originally introduced for the physician-agent evaluation harness (Part G of
that pass); now also the version reference the referral-preference
confirmation flow records at the moment of confirmation (Part O of the NLP
referral-preference pass), so both features share one definition of
"the representation changed" rather than inventing two.
"""

from __future__ import annotations

import hashlib
import json

from backend.engagement import EDITABLE_PERSONAS, PERSONAS
from backend.workflow import WorkflowStore


def representation_snapshot_id(workflow_store: WorkflowStore, workspace_id: str, persona_id: str) -> str:
    editable = persona_id in EDITABLE_PERSONAS
    overlays = workflow_store.profile_items(workspace_id, persona_id) if editable else []
    interest_overlays = workflow_store.physician_interests(workspace_id, persona_id) if editable else []
    learnings = workflow_store.proposed_learnings(workspace_id, persona_id)
    confirmed_learnings = sorted(item["statement"] for item in learnings if item["status"] == "confirmed")
    confirmed_interests = sorted(item["title"] for item in interest_overlays if item["confirmed"])
    physician_id = PERSONAS.get(persona_id, {}).get("physician_id")
    confirmed_preferences = (
        sorted(
            (item["case_family"], item["structured_rules_json"])
            for item in workflow_store.confirmed_referral_preferences_for_physician(
                workspace_id, physician_id
            )
        )
        if physician_id
        else []
    )
    payload = json.dumps(
        {
            "overlays": sorted((item["id"], item.get("detail")) for item in overlays),
            "confirmed_learnings": confirmed_learnings,
            "confirmed_interests": confirmed_interests,
            "confirmed_referral_preferences": confirmed_preferences,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:12]
