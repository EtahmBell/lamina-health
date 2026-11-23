"""Who did what: turn stored actor ids into the names people recognise.

History and change notes always name the actor: the physician ("Dr. Avery Testwell"), the
staff member (their practice label), the referring office (from the referral), or Lamina.
Never a generic "your team". Pure lookups; nothing here changes state.
"""

from __future__ import annotations

from typing import Any

from .store import PilotStore


def physician_display_name(identity: dict | None) -> str | None:
    if not identity:
        return None
    first, last = (identity.get("first_name") or "").strip(), (identity.get("last_name") or "").strip()
    if first and last:
        return f"Dr. {first.title()} {last.title()}"
    # NPPES display names carry credentials ("Avery Testwell, M.D."); the name is before the comma.
    name = (identity.get("display_name") or "").split(",")[0].strip()
    if not name:
        return None
    return name if name.lower().startswith("dr") else f"Dr. {name}"


class ActorDirectory:
    """Names for every practice member (current and former) of one practice."""

    def __init__(self, store: PilotStore, practice_id: str) -> None:
        self.store = store
        self.practice_id = practice_id
        self._users: dict[str, dict[str, str]] = {}
        for member in store.fetch_all(
            "SELECT user_id, role, label, status, physician_owner_scope_id FROM practice_members "
            "WHERE practice_id = ? ORDER BY created_at", (practice_id,),
        ):
            self._users[member["user_id"]] = {
                "name": self._member_name(member),
                "role": member["role"],
            }

    def _member_name(self, member: dict) -> str:
        if member["role"] == "physician":
            name = self.physician_name(member["physician_owner_scope_id"])
            if name:
                return name
        if member.get("label"):
            return member["label"]
        return "Physician" if member["role"] == "physician" else "Staff member"

    def physician_name(self, owner_scope_id: str | None) -> str | None:
        if not owner_scope_id:
            return None
        scope = self.store.workflow.physician_owner_scope(owner_scope_id) or {}
        return physician_display_name(scope.get("provider_identity"))

    def describe(self, actor: str, sender: dict[str, Any] | None = None) -> dict[str, str]:
        """{"name", "role"}; role is physician | staff | referring_office | lamina | system."""
        if actor.startswith("user:"):
            found = self._users.get(actor[5:])
            return dict(found) if found else {"name": "Former practice member", "role": "staff"}
        if actor.startswith("sender:") or actor == "public:form":
            office = (sender or {}).get("practice") or (sender or {}).get("name") or "The referring office"
            return {"name": office, "role": "referring_office"}
        if actor.startswith("agent:auto_draft:"):
            # Work a physician's agent prepared under an activated capability: "Dr. X's agent".
            owner = self._users.get(actor[len("agent:auto_draft:"):])
            return {"name": f"{owner['name']}’s agent" if owner else "The physician’s agent", "role": "lamina"}
        if actor.startswith("agent:"):
            return {"name": "Lamina", "role": "lamina"}
        return {"name": "Lamina (system)", "role": "system"}
