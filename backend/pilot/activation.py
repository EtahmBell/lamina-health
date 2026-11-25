"""Readiness review and physician-approved activation (Step 18). See docs/PILOT_ACTIVATION.md.

* Agreement metrics are computed ONLY from the physician's own sign-offs, corrections and
  conflict choices (never staff reviews or the retired approval step), per dimension, with raw
  counts, segmented by referral type and representation version.
* Readiness is per capability; eligibility only ALLOWS the physician to turn something on.
* Gating is enforced here, in the backend: an off capability never runs; shadow records only.
* Every change is an append-only `capability_events` row (actor, role, time, representation
  version). Shadow records are never shown to referring offices and never sent.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from .attribution import ActorDirectory
from .models import RequestInformationInput
from .practice import PilotError, PracticeContext
from .rules import normalize_referral_type
from .store import PilotStore, new_id, now_iso


def _setting(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


def settings() -> dict[str, int]:
    """Configurable minimums (environment), read on each use so tests and pilots can tune them."""
    return {
        "min_shadow_days": _setting("LAMINA_READINESS_MIN_SHADOW_DAYS", 3),
        "min_decided": _setting("LAMINA_READINESS_MIN_DECIDED", 10),
        "min_per_type": _setting("LAMINA_READINESS_MIN_PER_TYPE", 3),
        "min_for_percent": _setting("LAMINA_REVIEW_MIN_FOR_PERCENT", 10),
    }


STATE_ORDER = {"off": 0, "shadow": 1, "active": 2}

# Only capabilities that exist in code. Pre-filling visit type / priority is NOT here: the
# agent's suggestion already is the working triage, so there is nothing separable to gate.
CAPABILITIES: dict[str, dict[str, Any]] = {
    "auto_draft_requests": {
        "name": "Draft missing-information requests",
        "description": "When a triaged referral is missing required items and nobody has asked for them yet, "
                       "the agent creates the draft request in the staff queue.",
        "short": "drafting requests",
        "risk": "low",
        "states": ["off", "shadow", "active"],
        "default": "shadow",
        "depends_on": ["readiness", "requirements"],
        "needs_readiness": True,
        "per_type": True,
        "will": ["Create a draft information request in the staff queue, listing the missing required items",
                 "Mark the draft “Drafted by your agent”"],
        "never": ["Send anything — staff review, edit and send every request",
                  "Contact the patient or the referring office",
                  "Accept, redirect or decline a referral"],
        "confirm": "Lamina will create draft requests in {staff}’s queue when required items are missing. "
                   "Nothing is sent without staff.",
    },
    "learning_questions": {
        "name": "Ask learning questions",
        "description": "When your corrections repeat, the agent asks one question about it — at most one a day "
                       "(or a week). Nothing changes unless you answer yes.",
        "description_staff": "When {doctor}’s corrections repeat, the agent asks {doctor} one question about it — at most "
                             "one a day (or a week). Nothing changes unless {doctor} answers yes.",
        "risk": "low",
        "states": ["off", "active"],
        "default": "active",
        "depends_on": [],
        "needs_readiness": False,
        "per_type": False,
        "will": ["Ask at most one question per day (or per week) about a repeated correction"],
        "never": ["Change a rule without your answer"],
        "confirm": "Your agent will ask at most one question {frequency} about repeated corrections.",
    },
}
ALWAYS_YOURS = [
    "Accepting, redirecting or declining a referral",
    "Sending any message outside Lamina",
    "Scheduling",
    "Confirming rules or how your agent represents you",
]
COMING_LATER = ["Daily briefings", "Email and fax", "Waitlist and scheduling"]

AGENT_ACTOR_PREFIX = "agent:auto_draft:"
# Repeated non-serious "this was wrong" flags on one capability return it to shadow.
REPEATED_FLAGS = 3
REPEATED_FLAG_DAYS = 7
STATE_WORDS = {"off": "Off", "shadow": "Shadow", "active": "On"}


# ------------------------------------------------------------------------- metrics


def _fit_verdict(agent_fit: str, judgment: bool, decision: str) -> str:
    """The explicit fit mapping (docs/PILOT_ACTIVATION.md)."""
    if judgment or agent_fit == "unknown":
        return "deferred"
    if agent_fit == "possible" and decision != "accept":
        # Not agreement, and not a hard disagreement: "possible" left room for a decline.
        return "possible_not_accepted"
    if agent_fit in {"strong", "possible"}:
        return "agree" if decision == "accept" else "disagree"
    if agent_fit == "outside_scope":
        return "disagree" if decision == "accept" else "agree"
    return "deferred"


def _tally(rows: list[dict], min_for_percent: int) -> dict:
    agreed = sum(1 for row in rows if row == "agree")
    disagreed = sum(1 for row in rows if row == "disagree")
    deferred = sum(1 for row in rows if row == "deferred")
    possible = sum(1 for row in rows if row == "possible_not_accepted")
    total = agreed + disagreed
    return {"agreed": agreed, "disagreed": disagreed, "deferred": deferred, "possible_not_accepted": possible, "of": total,
            "text": f"agreed on {agreed} of {total}" if total else "nothing to compare yet",
            # A percentage only once the denominator is big enough to mean something.
            "percent": round(100 * agreed / total) if total >= min_for_percent and total else None}


DIMENSIONS = ("fit", "priority", "visit_type", "readiness")
DIMENSION_LABELS = {"fit": "Fit", "priority": "Priority", "visit_type": "Visit type", "readiness": "Readiness"}


def compute_metrics(store: PilotStore, practice_id: str, owner_scope_id: str, physician_user_id: str,
                    current_version_id: str | None) -> dict:
    """Agreement between the agent's recommendations and THIS physician's decisions, from stored
    data only. Reproducible (scripts/activation_metrics.py calls this read-only)."""
    min_pct = settings()["min_for_percent"]
    actor = f"user:{physician_user_id}"
    signoffs = store.fetch_all(
        "SELECT * FROM referral_signoffs WHERE practice_id = ? AND actor = ? AND actor_role = 'physician' "
        "ORDER BY created_at", (practice_id, actor))
    referrals = {row["id"]: row for row in store.fetch_all(
        "SELECT id, referral_type, patient_json FROM intake_referrals WHERE practice_id = ?", (practice_id,))}
    asked_more: dict[str, list[str]] = defaultdict(list)
    for event in store.events(practice_id=practice_id, event_type="information_requested"):
        asked_more[event["referral_id"] or ""] += event["metadata"].get("extra_items") or []
    learnings = _learning_links(store, practice_id)
    cases, disagreements, possible_not_accepted = [], [], []
    for signoff in signoffs:
        rid = signoff["referral_id"]
        referral = referrals.get(rid) or {}
        rec = json.loads(signoff["recommendation_json"] or "null") or {}
        effective = json.loads(signoff["effective_triage_json"] or "null") or {}
        if not rec:
            continue  # decided without any recommendation: nothing to compare
        first = store.fetch_one("SELECT recommendation_json, rules_snapshot_json FROM triage_recommendations "
                                "WHERE practice_id = ? AND referral_id = ? ORDER BY created_at, rowid LIMIT 1",
                                (practice_id, rid))
        first_rec = json.loads(first["recommendation_json"]) if first else rec
        rec_row = store.fetch_one("SELECT rules_snapshot_json FROM triage_recommendations WHERE id = ?",
                                  (signoff["recommendation_id"] or "",))
        snapshot_rules = (json.loads((rec_row or first or {}).get("rules_snapshot_json") or "{}") or {}).get("rules", [])
        rtype = referral.get("referral_type") or "Unknown type"
        rule = next((r for r in snapshot_rules if normalize_referral_type(r["referral_type"]) == normalize_referral_type(rtype)),
                    snapshot_rules[0] if snapshot_rules else None)
        judgment = rec.get("fit") == "unknown" or any(
            item.get("item") == "case_by_case" for item in rec.get("statements_used") or [])
        decision = signoff["decision"]
        verdicts = {
            "fit": _fit_verdict(rec.get("fit", "unknown"), judgment, decision),
            "priority": "agree" if rec.get("suggested_priority") == effective.get("suggested_priority", rec.get("suggested_priority")) else "disagree",
            "visit_type": ("deferred" if rec.get("suggested_modality") == "unspecified" else
                           "agree" if rec.get("suggested_modality") == effective.get("suggested_modality", rec.get("suggested_modality")) else "disagree"),
        }
        extra = [item for item in asked_more.get(rid, []) if item]
        accepted_without = decision == "accept" and bool(rec.get("missing_items"))
        verdicts["readiness"] = "disagree" if (extra or accepted_without) else "agree"
        physician_did = {"fit": decision, "priority": effective.get("suggested_priority", rec.get("suggested_priority")),
                         "visit_type": effective.get("suggested_modality", rec.get("suggested_modality")),
                         "readiness": ("asked for more: " + ", ".join(extra)) if extra else
                                      ("accepted without: " + ", ".join(rec.get("missing_items") or [])) if accepted_without else "as flagged"}
        agent_said = {"fit": rec.get("fit"), "priority": rec.get("suggested_priority"), "visit_type": rec.get("suggested_modality"),
                      "readiness": ("missing: " + ", ".join(first_rec.get("missing_items") or [])) if first_rec.get("missing_items") else "nothing missing"}
        case = {"referral_id": rid, "referral_type": rtype, "version_id": signoff["representation_version_id"],
                "current": bool(current_version_id) and signoff["representation_version_id"] == current_version_id,
                "decided_at": signoff["created_at"], "verdicts": verdicts}
        cases.append(case)
        for dimension, verdict in verdicts.items():
            if verdict not in {"disagree", "possible_not_accepted"}:
                continue
            patient = json.loads(referral.get("patient_json") or "{}").get("name") if referral else None
            (disagreements if verdict == "disagree" else possible_not_accepted).append({
                "referral_id": rid, "patient_name": patient, "referral_type": rtype, "dimension": dimension,
                "agent_said": agent_said[dimension], "physician_did": physician_did[dimension],
                "rule": {"rule_id": rule["rule_id"], "referral_type": rule["referral_type"], "version": rule["version"]} if rule else None,
                "learning": learnings.get(rid), "decided_at": signoff["created_at"], "current": case["current"],
            })
    conflicts = store.fetch_all(
        "SELECT choice, field, rule_version, referral_id, created_at FROM correction_conflict_resolutions "
        "WHERE practice_id = ? AND actor = ? AND actor_role = 'physician'", (practice_id, actor))

    def window(rows: list[dict]) -> dict:
        by_type: dict[str, dict] = {}
        for rtype in sorted({row["referral_type"] for row in rows}):
            typed = [row for row in rows if row["referral_type"] == rtype]
            by_type[rtype] = {"decided": len(typed),
                              **{d: _tally([row["verdicts"][d] for row in typed], min_pct) for d in DIMENSIONS}}
        return {"decided": len(rows), "dimensions": {d: _tally([row["verdicts"][d] for row in rows], min_pct) for d in DIMENSIONS},
                "by_type": by_type}

    by_version: dict[str, int] = defaultdict(int)
    for row in cases:
        by_version[row["version_id"] or "none"] += 1
    return {
        "physician_actor": actor, "min_for_percent": min_pct,
        "all_time": window(cases), "current_rules": window([row for row in cases if row["current"]]),
        "by_version": dict(by_version),
        "conflict_choices": {"keep_correction": sum(1 for row in conflicts if row["choice"] == "keep_correction"),
                             "apply_rule": sum(1 for row in conflicts if row["choice"] == "apply_rule")},
        "disagreements": sorted(disagreements, key=lambda item: item["decided_at"], reverse=True),
        # "possible fit" -> declined / redirected: shown on its own, never mixed with disagreements.
        "possible_not_accepted": sorted(possible_not_accepted, key=lambda item: item["decided_at"], reverse=True),
    }


def _learning_links(store: PilotStore, practice_id: str) -> dict[str, dict]:
    """referral id → the newest correction-pattern learning whose evidence includes it."""
    links: dict[str, dict] = {}
    for row in store.fetch_all(
            "SELECT id, referral_type, operational_status, provenance_json, created_at FROM physician_referral_preferences "
            "WHERE practice_id = ? AND source = 'correction_pattern' ORDER BY created_at", (practice_id,)):
        provenance = json.loads(row["provenance_json"] or "{}")
        status = {"inferred": "proposed", "confirmed": "confirmed", "inferred_active": "confirmed",
                  "rejected": "rejected", "superseded": "confirmed"}.get(row["operational_status"], row["operational_status"])
        for item in provenance.get("evidence", []):
            if item.get("referral_id"):
                links[item["referral_id"]] = {"proposal_id": row["id"], "status": status, "referral_type": row["referral_type"]}
    return links


# ------------------------------------------------------------------------- service


class ActivationService:
    def __init__(self, store: PilotStore, intake: Any, representation: Any, learning: Any) -> None:
        self.store, self.intake, self.representation, self.learning = store, intake, representation, learning

    # ---------------------------------------------------------------- owners

    def _physician_user(self, practice_id: str, owner_scope_id: str) -> str | None:
        member = next((m for m in self.store.members(practice_id)
                       if m["role"] == "physician" and m["physician_owner_scope_id"] == owner_scope_id), None)
        return member["user_id"] if member else None

    def _owner(self, context: PracticeContext) -> str | None:
        """Physicians act on their OWN agent; staff read the practice physician's."""
        if context.role == "physician":
            return context.owner_scope_id
        return self.representation.referral_physician(context.practice_id)

    def _version_id(self, practice_id: str, owner_scope_id: str) -> str | None:
        latest = self.representation.latest_version(practice_id, owner_scope_id)
        return latest["id"] if latest else None

    # ---------------------------------------------------------------- states

    def _limit(self, practice_id: str, capability: str) -> str:
        row = self.store.fetch_one("SELECT max_state FROM practice_capability_limits WHERE practice_id = ? AND capability = ?",
                                   (practice_id, capability))
        return row["max_state"] if row else "active"

    def state(self, practice_id: str, owner_scope_id: str, capability: str) -> dict:
        spec = CAPABILITIES[capability]
        row = self.store.fetch_one(
            "SELECT * FROM capability_states WHERE practice_id = ? AND owner_scope_id = ? AND capability = ?",
            (practice_id, owner_scope_id, capability))
        state = row["state"] if row else spec["default"]
        limit = self._limit(practice_id, capability)
        if STATE_ORDER[state] > STATE_ORDER[limit]:
            # A practice maximum always wins; fall to the highest state the capability allows.
            state = max((s for s in spec["states"] if STATE_ORDER[s] <= STATE_ORDER[limit]), key=STATE_ORDER.get)
        return {"state": state, "config": json.loads(row["config_json"]) if row else {}, "limit": limit,
                "updated_at": row["updated_at"] if row else None, "updated_by": row["updated_by"] if row else None}

    def _write_state(self, context: PracticeContext, owner_scope_id: str, capability: str, state: str, config: dict,
                     event_type: str, reason: str | None = None, metadata: dict | None = None,
                     before: str | None = None) -> None:
        before = before or self.state(context.practice_id, owner_scope_id, capability)["state"]
        version = self._version_id(context.practice_id, owner_scope_id)
        now = now_iso()
        self.store.execute([
            (("INSERT INTO capability_states (practice_id, owner_scope_id, capability, state, config_json, "
              "representation_version_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
              "ON CONFLICT(practice_id, owner_scope_id, capability) DO UPDATE SET state = excluded.state, "
              "config_json = excluded.config_json, representation_version_id = excluded.representation_version_id, "
              "updated_by = excluded.updated_by, updated_at = excluded.updated_at"),
             (context.practice_id, owner_scope_id, capability, state, json.dumps(config, sort_keys=True), version,
              context.actor, now)),
            self._event_statement(context, owner_scope_id, capability, event_type, before, state, reason, metadata, version, now),
        ], [{"event_type": f"capability_{event_type}", "actor": context.actor, "practice_id": context.practice_id,
             "owner_scope_id": owner_scope_id,
             "metadata": {"capability": capability, "from": before, "to": state, "role": context.role, "reason": reason}}])

    @staticmethod
    def _event_statement(context: PracticeContext, owner_scope_id: str | None, capability: str | None, event_type: str,
                         before: str | None, after: str | None, reason: str | None, metadata: dict | None,
                         version: str | None, now: str) -> tuple:
        return (("INSERT INTO capability_events (id, practice_id, owner_scope_id, capability, event_type, from_state, "
                 "to_state, reason, metadata_json, representation_version_id, actor, actor_role, created_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
                (new_id("cev"), context.practice_id, owner_scope_id, capability, event_type, before, after, reason,
                 json.dumps(metadata or {}, sort_keys=True), version, context.actor, context.role, now))

    def set_state(self, context: PracticeContext, capability: str, state: str, *, confirm: bool = False,
                  excluded_types: list[str] | None = None, frequency: str | None = None) -> dict:
        """A physician changes THEIR OWN agent's capability. Turning on requires an explicit
        confirmation and eligibility; nothing ever turns on by itself."""
        context.require_physician("change what your agent does")
        if capability not in CAPABILITIES:
            raise PilotError("unknown_capability", "That capability doesn't exist", 404)
        spec = CAPABILITIES[capability]
        if state not in spec["states"]:
            raise PilotError("invalid_state", f"{spec['name']} can be: {', '.join(spec['states'])}", 422)
        owner = context.owner_scope_id
        if not owner:
            raise PilotError("no_agent", "You don't have an agent in this practice yet", 409)
        limit = self._limit(context.practice_id, capability)
        if STATE_ORDER[state] > STATE_ORDER[limit]:
            raise PilotError("practice_limit", f"Your practice allows {spec['name'].lower()} up to “{limit}”", 403)
        current = self.state(context.practice_id, owner, capability)
        config = dict(current["config"])
        if frequency is not None:
            if frequency not in {"daily", "weekly"}:
                raise PilotError("invalid_frequency", "Choose daily or weekly", 422)
            config["frequency"] = frequency
        if state == "active":
            if not confirm:
                raise PilotError("confirmation_required", "Confirm what this changes before turning it on", 409)
            if spec["needs_readiness"]:
                eligibility = self.eligibility(context.practice_id, owner, capability)
                if not eligibility["eligible"]:
                    raise PilotError("not_eligible", "Not eligible yet: " + "; ".join(eligibility["reasons"]), 409)
                # Types without enough cases are excluded (the physician can see which).
                config["excluded_types"] = sorted(set(excluded_types or []) | set(eligibility["coverage"]["gaps"]))
        event = {"active": "activated", "shadow": "returned_to_shadow", "off": "turned_off"}[state]
        if state == current["state"] and frequency is None:
            return self.review(context)
        self._write_state(context, owner, capability, state, config, event if frequency is None or state != current["state"] else "settings_changed",
                          metadata={"excluded_types": config.get("excluded_types", []), "frequency": config.get("frequency")})
        return self.review(context)

    def pause_all(self, context: PracticeContext) -> dict:
        """One action: every active capability of this physician's agent back to shadow (or off
        where shadow doesn't exist)."""
        context.require_physician("pause your agent")
        owner = context.owner_scope_id
        paused = []
        for key, spec in CAPABILITIES.items():
            if not spec["needs_readiness"]:
                continue  # learning questions are a setting, not delegated work
            if self.state(context.practice_id, owner, key)["state"] == "active":
                self._write_state(context, owner, key, "shadow" if "shadow" in spec["states"] else "off",
                                  self.state(context.practice_id, owner, key)["config"], "paused", reason="Paused everything")
                paused.append(key)
        self.store.execute([self._event_statement(context, owner, None, "pause_all", None, None, "Paused everything",
                                                  {"capabilities": paused}, self._version_id(context.practice_id, owner), now_iso())])
        return self.review(context)

    def set_limit(self, context: PracticeContext, capability: str, max_state: str) -> dict:
        """Practice admin: a practice-wide maximum no physician can exceed. Lowering it lowers
        anyone above it, recorded per physician."""
        context.require_admin("set practice-wide limits for agents")
        if capability not in CAPABILITIES or max_state not in STATE_ORDER:
            raise PilotError("invalid_limit", "Unknown capability or state", 422)
        now = now_iso()
        physicians = self.representation.practice_physicians(context.practice_id)
        before = {owner: self.state(context.practice_id, owner, capability) for owner in physicians}
        self.store.execute([
            (("INSERT INTO practice_capability_limits (practice_id, capability, max_state, updated_by, updated_at) "
              "VALUES (?, ?, ?, ?, ?) ON CONFLICT(practice_id, capability) DO UPDATE SET max_state = excluded.max_state, "
              "updated_by = excluded.updated_by, updated_at = excluded.updated_at"),
             (context.practice_id, capability, max_state, context.actor, now)),
            self._event_statement(context, None, capability, "practice_limit_set", None, max_state, None, {}, None, now),
        ])
        # Every physician whose agent was above the new maximum is lowered, recorded, and told on Home.
        for owner, previous in before.items():
            if STATE_ORDER[previous["state"]] > STATE_ORDER[max_state]:
                lowered = max((s for s in CAPABILITIES[capability]["states"] if STATE_ORDER[s] <= STATE_ORDER[max_state]),
                              key=STATE_ORDER.get)
                self._write_state(context, owner, capability, lowered, previous["config"], "lowered_by_practice_limit",
                                  reason=f"Practice maximum set to {max_state}", before=previous["state"],
                                  metadata={"max_state": max_state})
        return self.limits(context)

    def limits(self, context: PracticeContext) -> dict:
        return {"limits": {key: self._limit(context.practice_id, key) for key in CAPABILITIES}, "can_edit": context.is_admin}

    # ------------------------------------------------------------ eligibility

    def _shadow_days(self, practice_id: str, owner_scope_id: str) -> tuple[float | None, str | None]:
        row = self.store.fetch_one("SELECT state, shadow_at FROM agent_lifecycle WHERE practice_id = ? AND owner_scope_id = ?",
                                   (practice_id, owner_scope_id))
        if not row or row["state"] != "shadow" or not row["shadow_at"]:
            return None, None
        since = datetime.fromisoformat(row["shadow_at"])
        return (datetime.now(UTC) - since).total_seconds() / 86400, row["shadow_at"]

    def _metrics(self, practice_id: str, owner_scope_id: str) -> dict:
        user = self._physician_user(practice_id, owner_scope_id)
        if not user:
            return compute_metrics(self.store, practice_id, owner_scope_id, "-", None)
        return compute_metrics(self.store, practice_id, owner_scope_id, user, self._version_id(practice_id, owner_scope_id))

    def _serious_open(self, practice_id: str, owner_scope_id: str, capability: str) -> list[dict]:
        return self.store.fetch_all(
            "SELECT * FROM agent_item_flags WHERE practice_id = ? AND owner_scope_id = ? AND capability = ? "
            "AND serious = 1 AND resolved_at IS NULL", (practice_id, owner_scope_id, capability))

    def _repeated_open(self, practice_id: str, owner_scope_id: str, capability: str) -> list[dict]:
        """Unresolved non-serious flags behind an automatic return to shadow (since it was last
        turned on). Like a serious flag, each must be resolved with a note before turning it back on."""
        activated = self.store.fetch_one(
            "SELECT MAX(created_at) AS at FROM capability_events WHERE practice_id = ? AND owner_scope_id = ? "
            "AND capability = ? AND event_type = 'activated'", (practice_id, owner_scope_id, capability))
        returns = self.store.fetch_all(
            "SELECT metadata_json FROM capability_events WHERE practice_id = ? AND owner_scope_id = ? AND capability = ? "
            "AND event_type = 'auto_returned_repeated_flags' AND created_at >= ?",
            (practice_id, owner_scope_id, capability, (activated or {}).get("at") or ""))
        ids = sorted({flag_id for row in returns for flag_id in json.loads(row["metadata_json"] or "{}").get("flag_ids", [])})
        if not ids:
            return []
        return self.store.fetch_all(
            f"SELECT * FROM agent_item_flags WHERE id IN ({', '.join('?' for _ in ids)}) AND serious = 0 "
            "AND resolved_at IS NULL ORDER BY created_at", ids)

    def _blocking_flags(self, practice_id: str, owner_scope_id: str, capability: str) -> list[dict]:
        return [*self._serious_open(practice_id, owner_scope_id, capability),
                *self._repeated_open(practice_id, owner_scope_id, capability)]

    def eligibility(self, practice_id: str, owner_scope_id: str, capability: str, metrics: dict | None = None) -> dict:
        spec = CAPABILITIES[capability]
        config = settings()
        metrics = metrics or self._metrics(practice_id, owner_scope_id)
        by_type = metrics["all_time"]["by_type"]
        covered = sorted(t for t, row in by_type.items() if row["decided"] >= config["min_per_type"])
        gaps = sorted(t for t, row in by_type.items() if row["decided"] < config["min_per_type"])
        coverage = {"covered": covered, "gaps": gaps, "min_per_type": config["min_per_type"]}
        if not spec["needs_readiness"]:
            return {"eligible": True, "reasons": [], "coverage": coverage, "always_available": True}
        reasons = []
        days, since = self._shadow_days(practice_id, owner_scope_id)
        if days is None:
            reasons.append("Your agent isn’t in shadow mode yet — finish setup first")
        elif days < config["min_shadow_days"]:
            left = max(1, int(config["min_shadow_days"] - days + 0.999))
            reasons.append(f"{left} day{'s' if left != 1 else ''} of shadowing left")
        decided = metrics["all_time"]["decided"]
        if decided < config["min_decided"]:
            more = config["min_decided"] - decided
            reasons.append(f"Needs {more} more decided referral{'s' if more != 1 else ''}")
        if spec["per_type"] and not covered and decided >= config["min_decided"]:
            reasons.append(f"No referral type has {config['min_per_type']} decided referrals yet")
        if self._serious_open(practice_id, owner_scope_id, capability):
            reasons.append("A serious “this was wrong” flag is unresolved")
        repeated = self._repeated_open(practice_id, owner_scope_id, capability)
        if repeated:
            reasons.append(f"{len(repeated)} “this was wrong” flag{'s' if len(repeated) != 1 else ''} that returned it to "
                           f"shadow {'are' if len(repeated) != 1 else 'is'} unresolved — resolve each with a note")
        if "requirements" in spec["depends_on"] and self._representation_conflicts(practice_id, owner_scope_id):
            reasons.append("Your representation has an open conflict to resolve first")
        return {"eligible": not reasons, "reasons": reasons, "coverage": coverage, "shadow_since": since,
                "shadow_days": None if days is None else round(days, 1), "always_available": False}

    def _representation_conflicts(self, practice_id: str, owner_scope_id: str) -> list:
        user = self._physician_user(practice_id, owner_scope_id)
        member = next((m for m in self.store.members(practice_id) if m["user_id"] == user), None)
        if member is None:
            return []
        practice = self.store.fetch_one("SELECT * FROM practices WHERE id = ?", (practice_id,))
        context = PracticeContext(user_id=user, practice=dict(practice), member=member, role="physician", owner_scope_id=owner_scope_id)
        return self.representation.view(context).get("conflicts") or []

    # ---------------------------------------------------------------- review

    def capability_view(self, practice_id: str, owner_scope_id: str, key: str, metrics: dict, staff_label: str) -> dict:
        spec = CAPABILITIES[key]
        state = self.state(practice_id, owner_scope_id, key)
        eligibility = self.eligibility(practice_id, owner_scope_id, key, metrics)
        examples = [{**json.loads(row["payload_json"]), "created_at": row["created_at"], "item_id": row["id"]}
                    for row in self.store.fetch_all(
                        "SELECT * FROM agent_prepared_items WHERE practice_id = ? AND owner_scope_id = ? AND capability = ? "
                        "AND mode = 'shadow' ORDER BY created_at DESC LIMIT 5", (practice_id, owner_scope_id, key))]
        flags = self.store.fetch_all(
            "SELECT id, serious, note, actor, actor_role, created_at, resolved_at, resolution_note, item_id FROM agent_item_flags "
            "WHERE practice_id = ? AND owner_scope_id = ? AND capability = ? ORDER BY created_at DESC", (practice_id, owner_scope_id, key))
        blocking = {flag["id"] for flag in self._blocking_flags(practice_id, owner_scope_id, key)}
        frequency = state["config"].get("frequency", "daily")
        return {
            "key": key, "name": spec["name"], "description": spec["description"], "risk": spec["risk"],
            "states": spec["states"], "state": state["state"], "practice_limit": state["limit"],
            "config": state["config"], "depends_on": spec["depends_on"], "will": spec["will"], "never": spec["never"],
            "confirm_text": spec["confirm"].format(staff=staff_label, frequency="a week" if frequency == "weekly" else "a day"),
            "eligibility": eligibility, "shadow_examples": examples,
            # `blocking`: must be resolved (with a note) before this can be turned on again.
            "flags": [{**flag, "serious": bool(flag["serious"]), "blocking": flag["id"] in blocking} for flag in flags],
            "updated_at": state["updated_at"],
            "updated_by_name": ActorDirectory(self.store, practice_id).describe(state["updated_by"])["name"] if state["updated_by"] else None,
        }

    def review(self, context: PracticeContext) -> dict:
        """The physician's readiness review (staff: read-only capability view)."""
        owner = self._owner(context)
        if not owner:
            return {"available": False, "capabilities": [], "always_yours": ALWAYS_YOURS, "coming_later": COMING_LATER}
        staff_names = [m["label"] or "staff" for m in self.store.members(context.practice_id) if m["role"] == "staff"]
        staff_label = staff_names[0] if len(staff_names) == 1 else "the staff"
        metrics = self._metrics(context.practice_id, owner)
        doctor = self.intake.physician_name(context.practice_id) or "the physician"
        capabilities = [self.capability_view(context.practice_id, owner, key, metrics, staff_label) for key in CAPABILITIES]
        _days, since = self._shadow_days(context.practice_id, owner)
        active = [CAPABILITIES[cap["key"]]["short"] for cap in capabilities if cap["state"] == "active" and CAPABILITIES[cap["key"]]["needs_readiness"]]
        base = {
            "available": True, "physician_view": context.role == "physician",
            "capabilities": capabilities if context.role == "physician" else [
                {**{key: cap[key] for key in ("key", "name", "state", "will", "never", "updated_at", "updated_by_name")},
                 "description": CAPABILITIES[cap["key"]].get("description_staff", cap["description"]).format(doctor=doctor)}
                for cap in capabilities],
            "always_yours": ALWAYS_YOURS if context.role == "physician" else [
                "Accepting, redirecting or declining a referral", "Sending any message outside Lamina", "Scheduling",
                f"Confirming rules or how the agent represents {doctor}"],
            "coming_later": COMING_LATER,
            "status": {"shadow_since": since, "decided": metrics["all_time"]["decided"], "active": active,
                       "line": ("Shadow mode" if not active else f"Partly active · {' and '.join(active)} on")},
            "limits": self.limits(context)["limits"], "can_set_limits": context.is_admin,
        }
        if context.role != "physician":
            return base
        summary = self.representation.learning_summary(context)
        notices = self.notices(context.practice_id, owner)
        return {**base, "metrics": metrics, "settings": settings(), "notices": notices,
                "summary": self._summary(capabilities, notices, base["status"]["line"]),
                "open": {"questions": summary["counts"]["open_questions"] + summary["counts"]["queued_questions"],
                         "pending_learnings": summary["counts"]["pending_learnings"]}}

    @staticmethod
    def _summary(capabilities: list[dict], notices: list[dict], line: str) -> dict:
        """The top of the readiness page: status, what's eligible, and ONE recommended action."""
        delegated = [cap for cap in capabilities if CAPABILITIES[cap["key"]]["needs_readiness"]]
        eligible = [cap["name"] for cap in delegated if cap["state"] != "active" and cap["eligibility"]["eligible"]
                    and cap["practice_limit"] == "active"]
        not_eligible = [{"name": cap["name"], "reasons": cap["eligibility"]["reasons"]}
                        for cap in delegated if cap["state"] != "active" and cap["eligibility"]["reasons"]]
        active = [cap["name"] for cap in delegated if cap["state"] == "active"]
        serious = next((cap for cap in delegated if any(f["serious"] and not f["resolved_at"] for f in cap["flags"])), None)
        repeated = next((cap for cap in delegated if any(f["blocking"] and not f["serious"] for f in cap["flags"])), None)
        if serious:
            action = {"text": f"Review the serious flag on {serious['name'].lower()} — it stays in shadow until you resolve it.",
                      "label": "Review the flag", "target": f"cap-{serious['key']}"}
        elif notices:
            action = {"text": notices[0]["title"] + ". " + notices[0]["detail"], "label": "See what changed",
                      "target": "readiness-notices"}
        elif repeated:
            count = sum(1 for f in repeated["flags"] if f["blocking"])
            action = {"text": f"Resolve the {count} flag{'s' if count != 1 else ''} that returned {repeated['name'].lower()} to "
                              "shadow, each with a short note, before turning it back on.",
                      "label": "Review the flags", "target": f"cap-{repeated['key']}"}
        elif eligible:
            action = {"text": f"Look over where you disagreed, then decide whether to turn on {eligible[0].lower()}. "
                              "Eligible only allows it; nothing changes until you choose.",
                      "label": "Review where you disagreed", "target": "readiness-disagreed"}
        elif active:
            action = {"text": "Nothing needs you here. Flag any draft that’s wrong; you can pause at any time.",
                      "label": None, "target": None}
        else:
            reasons = "; ".join(r[0].lower() + r[1:] for r in (not_eligible[0]["reasons"] if not_eligible else []))
            action = {"text": "Keep deciding referrals as usual" + (f" — {reasons}." if reasons else "."), "label": None, "target": None}
        return {"status": line, "eligible": eligible, "not_eligible": not_eligible, "active": active, "recommended": action}

    def lifecycle_line(self, practice_id: str, owner_scope_id: str | None) -> str | None:
        if not owner_scope_id:
            return None
        active = [spec["short"] for key, spec in CAPABILITIES.items()
                  if spec["needs_readiness"] and self.state(practice_id, owner_scope_id, key)["state"] == "active"]
        # Names what is on (a count would disagree with settings like learning questions, which
        # show "On" but aren't delegated work).
        return f"Partly active · {' and '.join(active)} on" if active else None

    # ---------------------------------------------------------------- gating

    def learning_enabled(self, practice_id: str, owner_scope_id: str | None = None) -> tuple[bool, timedelta]:
        """Backend gate for learning questions: off → none are asked. Each physician's own setting
        decides for their questions; practice-wide ones follow the practice's physician (if one)."""
        owner = owner_scope_id or self.representation.referral_physician(practice_id)
        if not owner:
            return True, timedelta(hours=24)
        state = self.state(practice_id, owner, "learning_questions")
        interval = timedelta(days=7) if state["config"].get("frequency") == "weekly" else timedelta(hours=24)
        return state["state"] == "active", interval

    def on_triaged(self, context: PracticeContext, referral_id: str, recommendation: Any) -> None:
        """Auto-draft missing-information requests -- gated HERE: off does nothing; shadow records
        what it would have drafted (never shown to offices, never sent); active creates the draft
        in the staff queue for a person to review and send."""
        key = "auto_draft_requests"
        missing = list(getattr(recommendation, "missing_items", None) or [])
        if not missing:
            return
        owner = self.representation.referral_physician(context.practice_id)
        if not owner:
            return
        state = self.state(context.practice_id, owner, key)
        if state["state"] == "off":
            return
        row = self.store.referral_row(context.practice_id, referral_id)
        if not row or row["status"] not in {"received", "triaged", "needs_information"}:
            return
        if normalize_referral_type(row["referral_type"]) in {normalize_referral_type(t) for t in state["config"].get("excluded_types", [])}:
            return
        if self.store.fetch_one("SELECT 1 FROM missing_information_requests WHERE practice_id = ? AND referral_id = ? "
                                "AND status IN ('draft', 'approved', 'sent', 'partially_resolved')", (context.practice_id, referral_id)):
            return  # someone (or the agent) already asked
        if self.store.fetch_one("SELECT 1 FROM agent_prepared_items WHERE practice_id = ? AND referral_id = ? AND capability = ? "
                                "AND json_extract(payload_json, '$.recommendation_id') = ?",
                                (context.practice_id, referral_id, key, recommendation.id)):
            return  # one prepared item per recommendation
        version = self._version_id(context.practice_id, owner)
        payload = {"recommendation_id": recommendation.id, "items": missing, "referral_type": row["referral_type"],
                   "patient_name": json.loads(row["patient_json"] or "{}").get("name")}
        if state["state"] == "shadow":
            self._record(context.practice_id, owner, key, referral_id, "shadow", payload, None, version)
            return
        user = self._physician_user(context.practice_id, owner)
        agent = PracticeContext(user_id=user or "agent", practice=context.practice, member={}, role="agent",
                                owner_scope_id=None, actor_label=f"{AGENT_ACTOR_PREFIX}{user}")
        try:
            detail = self.intake.request_information(agent, referral_id, RequestInformationInput(items=missing, note=None))
        except PilotError:
            return  # the referral moved on meanwhile; nothing prepared
        request = (detail.get("information_requests") or [])[-1]
        self._record(context.practice_id, owner, key, referral_id, "active", {**payload, "request_id": request["id"]},
                     request["id"], version)

    def _record(self, practice_id: str, owner_scope_id: str, capability: str, referral_id: str, mode: str,
                payload: dict, object_id: str | None, version: str | None) -> None:
        self.store.execute([(
            ("INSERT INTO agent_prepared_items (id, practice_id, owner_scope_id, capability, referral_id, mode, payload_json, "
             "object_id, never_sent, representation_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
            (new_id("api"), practice_id, owner_scope_id, capability, referral_id, mode, json.dumps(payload, sort_keys=True),
             object_id, 1 if mode == "shadow" else 0, version, now_iso()),
        )], [{"event_type": "agent_prepared_" + mode, "actor": f"agent:{capability}", "autonomy": "automatic",
              "practice_id": practice_id, "referral_id": referral_id, "metadata": {"capability": capability, "object_id": object_id}}])

    # ----------------------------------------------------------------- flags

    def item_for_object(self, practice_id: str, object_id: str) -> dict | None:
        return self.store.fetch_one("SELECT * FROM agent_prepared_items WHERE practice_id = ? AND object_id = ?", (practice_id, object_id))

    def flag(self, context: PracticeContext, item_id: str, serious: bool, note: str | None) -> dict:
        """"This was wrong" on something the agent prepared. Anyone in the practice can flag;
        only a physician can mark it serious, which returns the capability to shadow at once."""
        item = self.store.fetch_one("SELECT * FROM agent_prepared_items WHERE id = ? AND practice_id = ?", (item_id, context.practice_id))
        if not item:
            raise PilotError("item_not_found", "That agent-prepared item doesn't exist", 404)
        if serious and context.role != "physician":
            raise PilotError("physician_required", "Only a physician can mark a flag as serious", 403)
        now = now_iso()
        flag_id = new_id("flg")
        owner, capability = item["owner_scope_id"], item["capability"]
        version = self._version_id(context.practice_id, owner)
        self.store.execute([
            (("INSERT INTO agent_item_flags (id, practice_id, owner_scope_id, capability, item_id, serious, note, actor, "
              "actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
             (flag_id, context.practice_id, owner, capability, item_id, 1 if serious else 0, (note or "").strip()[:1000] or None,
              context.actor, context.role, now)),
            self._event_statement(context, owner, capability, "flagged", None, None, (note or "").strip()[:500] or None,
                                  {"item_id": item_id, "serious": serious}, version, now),
        ])
        current = self.state(context.practice_id, owner, capability)
        if serious and current["state"] == "active":
            self._write_state(context, owner, capability, "shadow", current["config"],
                              "auto_returned", reason="A serious “this was wrong” flag", metadata={"flag_id": flag_id})
        elif not serious and current["state"] == "active":
            recent = self._recent_flags(context.practice_id, owner, capability)
            if len(recent) >= REPEATED_FLAGS:
                self._write_state(context, owner, capability, "shadow", current["config"], "auto_returned_repeated_flags",
                                  reason=f"{len(recent)} “this was wrong” flags in {REPEATED_FLAG_DAYS} days",
                                  metadata={"flag_ids": [row["id"] for row in recent]})
        return {"flag_id": flag_id, "state": self.state(context.practice_id, owner, capability)["state"]}

    def _recent_flags(self, practice_id: str, owner_scope_id: str, capability: str) -> list[dict]:
        """Non-serious flags in the last 7 days, counted since the capability was last turned on
        (flags from before are already behind a return to shadow)."""
        since = (datetime.now(UTC) - timedelta(days=REPEATED_FLAG_DAYS)).isoformat()
        activated = self.store.fetch_one(
            "SELECT MAX(created_at) AS at FROM capability_events WHERE practice_id = ? AND owner_scope_id = ? "
            "AND capability = ? AND event_type = 'activated'", (practice_id, owner_scope_id, capability))
        since = max(since, (activated or {}).get("at") or "")
        return self.store.fetch_all(
            "SELECT id FROM agent_item_flags WHERE practice_id = ? AND owner_scope_id = ? AND capability = ? "
            "AND serious = 0 AND created_at >= ? ORDER BY created_at", (practice_id, owner_scope_id, capability, since))

    # --------------------------------------------------------------- notices

    def notices(self, practice_id: str, owner_scope_id: str) -> list[dict]:
        """Changes the physician didn't make themselves (a return to shadow after repeated flags,
        a lowered practice limit), shown until they acknowledge them."""
        acknowledged = {json.loads(row["metadata_json"] or "{}").get("event_id") for row in self.store.fetch_all(
            "SELECT metadata_json FROM capability_events WHERE practice_id = ? AND owner_scope_id = ? "
            "AND event_type = 'notice_acknowledged'", (practice_id, owner_scope_id))}
        directory = ActorDirectory(self.store, practice_id)
        own_actor = f"user:{self._physician_user(practice_id, owner_scope_id)}"
        result = []
        for row in self.store.fetch_all(
                "SELECT * FROM capability_events WHERE practice_id = ? AND owner_scope_id = ? AND event_type IN "
                "('auto_returned_repeated_flags', 'lowered_by_practice_limit') ORDER BY created_at", (practice_id, owner_scope_id)):
            if row["id"] in acknowledged or row["capability"] not in CAPABILITIES:
                continue
            if row["event_type"] == "lowered_by_practice_limit" and row["actor"] == own_actor:
                continue  # an admin physician lowering their own agent already knows
            name = CAPABILITIES[row["capability"]]["name"]
            to = STATE_WORDS.get(row["to_state"], row["to_state"])
            if row["event_type"] == "auto_returned_repeated_flags":
                title = f"{name} went back to shadow"
                detail = (f"{row['reason']} returned it to shadow automatically. Resolve each flag with a short note "
                          "before deciding whether to turn it back on.")
            else:
                by = directory.describe(row["actor"])["name"]
                title = f"{name} was lowered to {to.lower()}"
                detail = (f"{by} set the practice maximum to {to.lower()}, so your agent’s setting changed from "
                          f"{STATE_WORDS.get(row['from_state'], row['from_state']).lower()} to {to.lower()}.")
            result.append({"id": row["id"], "kind": row["event_type"], "capability": row["capability"], "title": title,
                           "detail": detail, "created_at": row["created_at"]})
        return result

    def acknowledge_notice(self, context: PracticeContext, event_id: str) -> dict:
        context.require_physician("acknowledge a change to your agent")
        owner = context.owner_scope_id or ""
        if not any(notice["id"] == event_id for notice in self.notices(context.practice_id, owner)):
            raise PilotError("notice_not_found", "Nothing to acknowledge", 404)
        self.store.execute([self._event_statement(context, owner, None, "notice_acknowledged", None, None, None,
                                                  {"event_id": event_id}, self._version_id(context.practice_id, owner), now_iso())])
        return self.review(context)

    def resolve_flag(self, context: PracticeContext, flag_id: str, note: str | None = None) -> dict:
        """The physician resolves one flag, always with a short note on what they found."""
        context.require_physician("resolve a flag on your agent's work")
        flag = self.store.fetch_one("SELECT * FROM agent_item_flags WHERE id = ? AND practice_id = ? AND owner_scope_id = ?",
                                    (flag_id, context.practice_id, context.owner_scope_id or ""))
        if not flag:
            raise PilotError("flag_not_found", "Flag not found", 404)
        if flag["resolved_at"]:
            raise PilotError("flag_resolved", "This flag is already resolved", 409)
        text = (note or "").strip()[:1000]
        if not text:
            raise PilotError("note_required", "Add a short note on what you found before resolving the flag", 422)
        now = now_iso()
        self.store.execute([
            ("UPDATE agent_item_flags SET resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND resolved_at IS NULL",
             (context.actor, now, text, flag_id)),
            self._event_statement(context, flag["owner_scope_id"], flag["capability"], "flag_resolved", None, None, text[:500],
                                  {"flag_id": flag_id, "serious": bool(flag["serious"])},
                                  self._version_id(context.practice_id, flag["owner_scope_id"]), now),
        ])
        return self.review(context)

    def agent_items_for_referral(self, context: PracticeContext, referral_id: str) -> dict:
        """Detail extension: which information requests the agent drafted (for attribution and
        the "This was wrong" control). Shadow records are never part of a referral's view."""
        rows = self.store.fetch_all("SELECT id, capability, object_id FROM agent_prepared_items WHERE practice_id = ? "
                                    "AND referral_id = ? AND mode = 'active'", (context.practice_id, referral_id))
        result = {}
        for row in rows:
            flags = self.store.fetch_all("SELECT id, serious, actor_role, created_at, resolved_at FROM agent_item_flags "
                                         "WHERE item_id = ? ORDER BY created_at", (row["id"],))
            result[row["object_id"]] = {"item_id": row["id"], "capability": row["capability"],
                                        "flags": [{**flag, "serious": bool(flag["serious"])} for flag in flags]}
        return {"agent_items": result}

    # ---------------------------------------------------------------- home

    def home_items(self, context: PracticeContext) -> list[dict]:
        if context.role != "physician" or not context.owner_scope_id:
            return []
        owner = context.owner_scope_id
        items = []
        for key, spec in CAPABILITIES.items():
            for flag in self._serious_open(context.practice_id, owner, key):
                items.append({"kind": "capability_returned", "rank": 0, "path": "/me/agent?tab=readiness",
                              "title": f"{spec['name']} went back to shadow",
                              "detail": "A serious “this was wrong” flag returned it to shadow. Review the flag, then decide.",
                              "action": "Review", "flag_id": flag["id"]})
        for notice in self.notices(context.practice_id, owner):
            items.append({"kind": "capability_notice", "rank": 0, "path": "/me/agent?tab=readiness",
                          "title": notice["title"], "detail": notice["detail"], "action": "Review", "notice_id": notice["id"]})
        if not items:
            metrics = self._metrics(context.practice_id, owner)
            eligible = [key for key, spec in CAPABILITIES.items() if spec["needs_readiness"]
                        and self.state(context.practice_id, owner, key)["state"] != "active"
                        and self.eligibility(context.practice_id, owner, key, metrics)["eligible"]]
            if eligible:
                items.append({"kind": "readiness_review", "rank": 6, "path": "/me/agent?tab=readiness",
                              "title": "Your agent’s readiness review is available",
                              "detail": "See how its recommendations compared with your decisions, and choose what it may do.",
                              "action": "Open"})
        return items
