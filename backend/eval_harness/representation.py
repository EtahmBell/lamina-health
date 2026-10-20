"""Representation snapshot identifier (Part G).

The smallest clean abstraction that lets an evaluation result say "this
was produced using THIS physician-representation state" -- a deterministic
content hash over everything that could actually change it: confirmed
training learnings, confirmed interests, and physician-entered profile
overlays. Read-only (Part N: never writes anything). Changes the moment
any of those change; stable otherwise -- so a before/after representation-
change comparison (Part Q, for the future NLP preference feature) is just
"these two snapshot ids differ," with no version-management subsystem.
"""

from __future__ import annotations

import hashlib
import json

from backend.engagement import EDITABLE_PERSONAS
from backend.workflow import WorkflowStore


def representation_snapshot_id(workflow_store: WorkflowStore, workspace_id: str, persona_id: str) -> str:
    editable = persona_id in EDITABLE_PERSONAS
    overlays = workflow_store.profile_items(workspace_id, persona_id) if editable else []
    interest_overlays = workflow_store.physician_interests(workspace_id, persona_id) if editable else []
    learnings = workflow_store.proposed_learnings(workspace_id, persona_id)
    confirmed_learnings = sorted(item["statement"] for item in learnings if item["status"] == "confirmed")
    confirmed_interests = sorted(item["title"] for item in interest_overlays if item["confirmed"])
    payload = json.dumps(
        {
            "overlays": sorted((item["id"], item.get("detail")) for item in overlays),
            "confirmed_learnings": confirmed_learnings,
            "confirmed_interests": confirmed_interests,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:12]
