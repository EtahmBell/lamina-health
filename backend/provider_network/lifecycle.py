"""The single canonical projection of claim and agent-activation state."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .models import AgentStatus


def project_lifecycle(
    claim: Mapping[str, Any] | None,
    agent_state: Mapping[str, Any] | None,
) -> AgentStatus:
    if agent_state and agent_state.get("status") == "disabled":
        return AgentStatus.DISABLED
    if agent_state and agent_state.get("status") == "active":
        return AgentStatus.ACTIVE
    if claim:
        status = claim.get("status")
        if status == "verified":
            return AgentStatus.VERIFIED
        if status == "verification_pending":
            return AgentStatus.VERIFICATION_PENDING
        if status == "claimed":
            return AgentStatus.CLAIMED
    return AgentStatus.RESERVED
