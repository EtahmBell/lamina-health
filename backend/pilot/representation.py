"""The physician agent's representation of how a physician and their practice work (Step 17).

Built ON the canonical rule store (`physician_referral_preferences`) -- not beside it:

* Every statement is a rule row (proposed = `inferred`, confirmed = `confirmed`,
  rejected = `rejected`), versioned by the rule store, in one of two layers: `practice`
  (whole practice; edited by the practice admin) or `physician` (one physician's own).
* Statement kinds are fields of the rule content: hard requirements (`required`), scope
  policy (`scope_policy` + fit / outside-scope criteria), soft preferences (`modality`,
  `preferences`), exceptions (`exceptions`), physician judgment (`judgment`,
  `case_by_case`). "Unknown" is derived: a topic with no confirmed answer.
* Guided setup answers create PROPOSALS through the existing teaching service. Nothing is
  confirmed without the physician (or practice admin) confirming it.
* A representation VERSION is an append-only snapshot of exactly what is confirmed, recorded
  whenever that changes (and when the physician confirms the representation). Every triage
  recommendation stores the version it used, so Step 18 can measure agreement against it.

Lifecycle per physician: `initializing` → `shadow`. Shadow: the agent recommends; people
decide. Nothing here enables any autonomy.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from .models import REPRESENTATION_TOPICS, PracticeRule
from .practice import PilotError, PracticeContext
from .rules import PracticeRules, RuleNotFoundError, normalize_referral_type
from .store import PilotStore, new_id, now_iso
from .teaching import TeachingService, _content_dict, is_practice_admin, require_can_edit
from .triage import _tokens
from .vocabulary import referral_type_key

STAGES = ("identity", "scope", "requirements", "delegation", "review")
STAGE_LABELS = {
    "identity": "Identity and practice", "scope": "Case scope", "requirements": "Requirements, urgency and visit type",
    "delegation": "Delegation", "review": "How your agent represents you",
}
# Honest per-stage estimates for a first useful version (minutes).
STAGE_MINUTES = {"identity": 1, "scope": 2, "requirements": 3, "delegation": 1, "review": 2}
SCOPE_POLICIES = ("accept", "out_of_scope", "case_by_case")

# Stage D: the kinds of work, who usually does it, and how much the physician eventually wants
# the agent to do. Stored only; nothing is enabled. There is deliberately no option for
# autonomous clinical decisions or autonomous external sending.
DELEGATION_TASKS = {
    "check_completeness": "Check whether a referral is complete",
    "draft_information_requests": "Draft missing-information requests",
    "summarize_referrals": "Summarise referrals",
    "flag_out_of_scope": "Flag out-of-scope referrals",
}
HANDLED_BY = ("physician", "staff", "agent_prepares")
AUTONOMY_LEVELS = ("off", "observe", "prepare_drafts", "ask_before_acting")
WEEK = timedelta(days=7)

# Specialty starter suggestions: short, generic referral TYPE names only -- never thresholds or
# clinical criteria. Each is labelled "Suggested — not confirmed" and needs its own answer.
STARTER_TYPES = {
    "endocrin": ["Thyroid nodule", "Diabetes management", "Thyroid function abnormality", "Adrenal nodule"],
    "nephrolog": ["Chronic kidney disease", "Proteinuria", "Electrolyte abnormality"],
    "cardiolog": ["Chest pain evaluation", "Heart failure", "Arrhythmia"],
    "gastroenterolog": ["Abnormal liver tests", "Iron deficiency anaemia", "Dyspepsia"],
    "rheumatolog": ["Inflammatory arthritis", "Positive ANA"],
    "hematolog": ["Anaemia", "Thrombocytopenia"],
    "pulmon": ["Abnormal lung imaging", "Chronic cough"],
}


def confirmed_since(rules: PracticeRules, practice_id: str, owner_scope_id: str | None, since: str) -> list[PracticeRule]:
    """THE definition of "newly confirmed this week": current (active) statements whose
    confirmation happened since `since`. Used by the learned-this-week panel AND the weekly
    summary sentence, so the two can never disagree."""
    return sorted(
        [rule for rule in rules.list(practice_id, owner_scope_id=owner_scope_id)
         if rule.confirmed_at and rule.confirmed_at >= since],
        key=lambda rule: rule.confirmed_at or "", reverse=True,
    )


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:20]


class RepresentationService:
    def __init__(self, store: PilotStore, rules: PracticeRules, teaching: TeachingService,
                 learning: Any = None) -> None:
        self.store = store
        self.rules = rules
        self.teaching = teaching
        # LearningService: decides which ONE question is answerable today (pacing lives there).
        self.learning = learning

    # ------------------------------------------------------------- physicians

    def practice_physicians(self, practice_id: str) -> list[str]:
        return list(self.store.physician_scope_ids(practice_id))

    def referral_physician(self, practice_id: str) -> str | None:
        """Whose referrals these are. Pilot practices have one physician; with several (not
        possible today) only the practice layer applies until referrals are assigned."""
        physicians = self.practice_physicians(practice_id)
        return physicians[0] if len(physicians) == 1 else None

    def _owner(self, context: PracticeContext) -> str | None:
        return context.owner_scope_id if context.role == "physician" else self.referral_physician(context.practice_id)

    # -------------------------------------------------------------- lifecycle

    def _lifecycle_row(self, practice_id: str, owner_scope_id: str) -> dict:
        row = self.store.fetch_one(
            "SELECT * FROM agent_lifecycle WHERE practice_id = ? AND owner_scope_id = ?", (practice_id, owner_scope_id))
        if row:
            return row
        # First read: a physician who already confirmed rules before Step 17 is in shadow.
        existing = bool(self.rules.list(practice_id, owner_scope_id=owner_scope_id))
        now = now_iso()
        state = "shadow" if existing else "initializing"
        self.store.execute(
            [(("INSERT OR IGNORE INTO agent_lifecycle (practice_id, owner_scope_id, state, setup_json, created_at, "
               "updated_at, shadow_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
              (practice_id, owner_scope_id, state, json.dumps({"stages": {}, "migrated": existing}), now, now,
               now if existing else None))],
            [{"event_type": "agent_lifecycle_created", "actor": "system:lifecycle", "autonomy": "automatic",
              "practice_id": practice_id, "metadata": {"state": state, "had_confirmed_rules": existing}}],
        )
        return self.store.fetch_one(
            "SELECT * FROM agent_lifecycle WHERE practice_id = ? AND owner_scope_id = ?", (practice_id, owner_scope_id))

    def _setup(self, row: dict) -> dict:
        return json.loads(row["setup_json"] or "{}")

    def _save_setup(self, context: PracticeContext, setup: dict, event: str, metadata: dict) -> None:
        self.store.execute(
            [("UPDATE agent_lifecycle SET setup_json = ?, updated_at = ? WHERE practice_id = ? AND owner_scope_id = ?",
              (json.dumps(setup, sort_keys=True), now_iso(), context.practice_id, context.owner_scope_id))],
            [{"event_type": event, "actor": context.actor, "practice_id": context.practice_id, "metadata": metadata}],
        )

    def lifecycle(self, context: PracticeContext) -> dict:
        owner = self._owner(context)
        if not owner:
            return {"state": None, "label": None}
        row = self._lifecycle_row(context.practice_id, owner)
        setup = self._setup(row)
        stages = setup.get("stages", {})
        statuses = {stage: stages.get(stage, {}).get("status", "not_started") for stage in STAGES}
        next_stage = next((stage for stage in STAGES if statuses[stage] in {"not_started", "in_progress"}), None)
        remaining = sum(STAGE_MINUTES[stage] for stage in STAGES if statuses[stage] in {"not_started", "in_progress"})
        return {
            "state": row["state"],
            "label": ("Shadow mode — your agent recommends; you and your staff decide."
                      if row["state"] == "shadow" else "Setting up — your agent is not representing you yet."),
            "shadow_at": row["shadow_at"],
            "stages": [{"id": stage, "label": STAGE_LABELS[stage], "status": statuses[stage],
                        "minutes": STAGE_MINUTES[stage]} for stage in STAGES],
            "next_stage": next_stage,
            "minutes_remaining": remaining,
            "setup_complete": statuses["review"] == "done",
            "migrated": bool(setup.get("migrated")),
        }

    # ------------------------------------------------------------- setup stages

    def _require_own_setup(self, context: PracticeContext) -> dict:
        if context.role != "physician" or not context.owner_scope_id:
            raise PilotError("physician_required", "Only the physician sets up their agent", 403)
        return self._lifecycle_row(context.practice_id, context.owner_scope_id)

    def _mark(self, setup: dict, stage: str, status: str, **extra: Any) -> dict:
        stages = setup.setdefault("stages", {})
        stages[stage] = {**stages.get(stage, {}), "status": status, "updated_at": now_iso(), **extra}
        return setup

    def setup_view(self, context: PracticeContext) -> dict:
        row = self._require_own_setup(context)
        setup = self._setup(row)
        scope = self.store.workflow.physician_owner_scope(context.owner_scope_id or "") or {}
        identity = scope.get("provider_identity") or {}
        practice = context.practice
        prefill = {
            "specialty": {"value": identity.get("specialty") or practice.get("specialty"),
                          "source": "the NPPES public registry" if identity.get("specialty") else "your practice record"},
            "locations": {"value": [practice["address"]] if practice.get("address") else [],
                          "source": "your practice record (from NPPES)"},
            "display_name": identity.get("display_name"),
        }
        starters = self._starters(setup, prefill["specialty"]["value"])
        known = self.rules.referral_types(context.practice_id, context.owner_scope_id)
        known_keys = {referral_type_key(name) for name in known}
        return {
            "lifecycle": self.lifecycle(context),
            "profile": setup.get("profile"),
            "prefill": prefill,
            "delegation": setup.get("delegation") or {},
            "delegation_tasks": [{"id": key, "label": label} for key, label in DELEGATION_TASKS.items()],
            "handled_by_options": list(HANDLED_BY),
            "autonomy_options": list(AUTONOMY_LEVELS),
            "referral_types": known,
            "starter_suggestions": [name for name in starters if referral_type_key(name) not in known_keys],
            "is_practice_admin": is_practice_admin(context),
            "pending": [self.teaching.view(rule) for rule in self.rules.proposals(context.practice_id, context.owner_scope_id)
                        if (rule.provenance or {}).get("setup_stage")],
        }

    def save_identity(self, context: PracticeContext, payload: dict) -> dict:
        row = self._require_own_setup(context)
        setup = self._setup(row)

        def clean(value: Any) -> str | None:
            return " ".join(str(value or "").split())[:200] or None

        def listed(values: Any) -> list[str]:
            return [text for text in (clean(v) for v in (values or [])) if text][:10]

        setup["profile"] = {
            "specialty": clean(payload.get("specialty")), "subspecialty": clean(payload.get("subspecialty")),
            "locations": listed(payload.get("locations")), "clinical_interests": listed(payload.get("clinical_interests")),
            "reviewed_by": context.actor, "reviewed_at": now_iso(),
            # Which values the physician kept from a prefill vs typed: labelled, never silent.
            "sources": {key: str(value)[:80] for key, value in (payload.get("sources") or {}).items()},
        }
        self._mark(setup, "identity", "done")
        self._save_setup(context, setup, "setup_stage_completed", {"stage": "identity"})
        return self.setup_view(context)

    def skip_stage(self, context: PracticeContext, stage: str) -> dict:
        if stage not in STAGES or stage == "review":
            raise PilotError("invalid_stage", "That stage can’t be skipped", 422)
        row = self._require_own_setup(context)
        setup = self._mark(self._setup(row), stage, "skipped")
        self._save_setup(context, setup, "setup_stage_skipped", {"stage": stage})
        return self.setup_view(context)

    def _replace_pending(self, context: PracticeContext, stage: str, referral_type: str) -> None:
        """A new answer for the same type and stage replaces the unreviewed earlier one."""
        for rule in self.rules.proposals(context.practice_id, context.owner_scope_id):
            provenance = rule.provenance or {}
            if provenance.get("setup_stage") == stage and normalize_referral_type(rule.referral_type) == normalize_referral_type(referral_type):
                self.rules.set_status(context.practice_id, rule.id, "rejected", actor=context.actor,
                                      event_type="setup_answer_replaced", metadata={"stage": stage})

    def _registry_specialty(self, context: PracticeContext) -> str | None:
        """The specialty prefill uses: NPPES first, then the practice record."""
        scope = self.store.workflow.physician_owner_scope(context.owner_scope_id or "") or {}
        return (scope.get("provider_identity") or {}).get("specialty") or context.practice.get("specialty")

    @staticmethod
    def _starters(setup: dict, fallback_specialty: str | None) -> list[str]:
        """Approved starter suggestions: referral-type NAMES only (no clinical content), always
        labelled "Suggested", each confirmed individually."""
        specialty = (setup.get("profile") or {}).get("specialty") or fallback_specialty or ""
        return next((types for stem, types in STARTER_TYPES.items() if stem in specialty.casefold()), [])

    def _propose(self, context: PracticeContext, stage: str, referral_type: str, text: str, content: dict,
                 interpreter: str = "setup", review_notes: list[str] | None = None,
                 suggested: bool = False) -> dict:
        self._replace_pending(context, stage, referral_type)
        base = {"good_fit": [], "outside_scope": [], "required": [], "helpful": [], "urgent_signals": [],
                "modality": "unspecified", "note": None}
        return self.teaching.propose(
            context, text, source="onboarding",
            interpretation={"referral_type": referral_type, "content": {**base, **content}, "structured": True,
                            "confidence": 1.0, "clarification": None, "interpreter": interpreter,
                            "review_notes": review_notes or []},
            extra_provenance={"setup_stage": stage, **({"suggested": True} if suggested else {})},
        )

    def save_scope(self, context: PracticeContext, types: list[dict]) -> dict:
        """Stage B. Each answered type becomes a PROPOSED scope statement ("unknown" answers
        create nothing -- they stay unknown)."""
        row = self._require_own_setup(context)
        starter_keys = {referral_type_key(name) for name in self._starters(
            self._setup(row), self._registry_specialty(context))}
        proposals = []
        for entry in types:
            name = " ".join(str(entry.get("referral_type") or "").split())[:120]
            policy = entry.get("policy")
            if not name or policy == "unknown":
                continue
            if policy not in SCOPE_POLICIES:
                raise PilotError("invalid_policy", "Choose: I see these, out of scope, or case by case", 422)
            aliases = [" ".join(str(alias).split())[:120] for alias in entry.get("aliases") or [] if str(alias).strip()][:10]
            text = {"accept": f"I see {name} referrals", "out_of_scope": f"{name} referrals are out of scope",
                    "case_by_case": f"I decide {name} referrals case by case"}[policy]
            content = {"scope_policy": policy, "aliases": aliases, "answered_topics": ["scope"]}
            if policy == "case_by_case":
                content["judgment"] = [f"Decides {name} referrals case by case"]
            # The label survives into review: a starter suggestion stays "Suggested" even after
            # the physician picks a policy for it (only names on the approved list qualify).
            suggested = bool(entry.get("suggested")) and referral_type_key(name) in starter_keys
            proposals.append(self._propose(context, "scope", name, text, content, suggested=suggested))
        setup = self._mark(self._setup(row), "scope", "done", answered=len(proposals))
        self._save_setup(context, setup, "setup_stage_completed", {"stage": "scope", "proposals": len(proposals)})
        return {"proposals": proposals, "setup": self.setup_view(context)}

    def save_requirements(self, context: PracticeContext, referral_type: str, payload: dict) -> dict:
        """Stage C for one type: natural language and/or structured items → ONE proposal,
        shown item by item for confirmation. The Step 16 parser does the language."""
        row = self._require_own_setup(context)
        name = " ".join(referral_type.split())[:120]
        if not name:
            raise PilotError("referral_type_required", "Choose a referral type", 422)
        content: dict[str, Any] = {"required": [], "helpful": [], "urgent_signals": [], "preferences": [],
                                   "exceptions": [], "judgment": [], "answered_topics": []}
        review_notes: list[str] = []
        clarification = None
        text = " ".join(str(payload.get("text") or "").split())
        if text:
            interpreted = self.teaching.interpret(text, [name])
            parsed = interpreted["content"]
            for key in ("required", "helpful", "urgent_signals", "preferences", "exceptions", "judgment"):
                content[key] += parsed.get(key, [])
            if parsed.get("modality", "unspecified") != "unspecified":
                content["modality"] = parsed["modality"]
            if parsed.get("note"):
                content["note"] = parsed["note"]
            review_notes += interpreted.get("review_notes", [])
            if not interpreted["structured"]:
                review_notes.append("I couldn’t turn your answer into items. Add them below, or leave this for later.")
        for item in payload.get("required") or []:
            if str(item.get("label") or "").strip():
                content["required"].append(_item(item, required=True))
        for item in payload.get("helpful") or []:
            if str(item.get("label") or "").strip():
                content["helpful"].append(_item(item, required=False))
        content["urgent_signals"] += [str(v).strip() for v in payload.get("urgent_signals") or [] if str(v).strip()]
        if payload.get("modality") in {"in_person", "econsult", "either"}:
            content["modality"] = payload["modality"]
        if payload.get("nothing_required") or content["required"] or content["helpful"]:
            content["answered_topics"].append("requirements")
        if content["urgent_signals"] or payload.get("no_urgency_signals"):
            content["answered_topics"].append("urgency")
        if content.get("modality", "unspecified") != "unspecified":
            content["answered_topics"].append("modality")
        # One focused question, only when it matters: a "recent" item with no time window.
        vague = [item["label"] for item in content["required"] if item.get("freshness_days") is None
                 and "recent" in item["label"].casefold()]
        if vague:
            clarification = {"question": f"How recent should “{vague[0]}” be? (e.g. within 90 days)", "item": vague[0]}
        proposal = None
        if content["answered_topics"] or any(content[key] for key in ("preferences", "exceptions", "judgment")):
            proposal = self._propose(context, "requirements", name, text or f"Requirements for {name}", content,
                                     interpreter="setup+parser" if text else "setup", review_notes=review_notes)
        setup = self._setup(row)
        done_types = sorted(set(setup.get("stages", {}).get("requirements", {}).get("types", [])) | {name})
        self._mark(setup, "requirements", "in_progress", types=done_types)
        self._save_setup(context, setup, "setup_stage_progress", {"stage": "requirements", "referral_type": name})
        return {"proposal": proposal, "review_notes": review_notes, "clarification": clarification,
                "setup": self.setup_view(context)}

    def finish_stage(self, context: PracticeContext, stage: str) -> dict:
        if stage not in {"requirements"}:
            raise PilotError("invalid_stage", "Unknown stage", 422)
        row = self._require_own_setup(context)
        setup = self._mark(self._setup(row), stage, "done")
        self._save_setup(context, setup, "setup_stage_completed", {"stage": stage})
        return self.setup_view(context)

    def save_delegation(self, context: PracticeContext, answers: dict) -> dict:
        row = self._require_own_setup(context)
        delegation = {}
        for task, answer in (answers or {}).items():
            if task not in DELEGATION_TASKS:
                raise PilotError("invalid_task", "Unknown kind of work", 422)
            handled_by, autonomy = answer.get("handled_by"), answer.get("autonomy")
            if handled_by not in HANDLED_BY or autonomy not in AUTONOMY_LEVELS:
                raise PilotError("invalid_delegation", "Choose who handles it and how much the agent should do", 422)
            delegation[task] = {"handled_by": handled_by, "autonomy": autonomy}
        setup = self._setup(row)
        setup["delegation"] = delegation
        self._mark(setup, "delegation", "done")
        # Preferences for Step 18 only. Nothing is enabled: every capability stays in shadow.
        self._save_setup(context, setup, "delegation_preferences_saved", {"tasks": sorted(delegation), "enabled": []})
        return self.setup_view(context)

    def confirm_representation(self, context: PracticeContext) -> dict:
        """Stage E's explicit "Confirm representation": snapshot what IS confirmed (pending and
        unknown items stay as they are -- this confirms nothing implicitly) and enter shadow."""
        row = self._require_own_setup(context)
        version = self.record_version(context.practice_id, context.owner_scope_id, actor=context.actor,
                                      reason="confirmed_by_physician", force=True)
        setup = self._mark(self._setup(row), "review", "done")
        for stage in STAGES[:-1]:
            status = setup["stages"].get(stage, {}).get("status")
            if status in {None, "not_started"}:
                self._mark(setup, stage, "skipped")  # finished later under Your Agent → Train
            elif status == "in_progress":
                self._mark(setup, stage, "done")
        now = now_iso()
        entering = row["state"] != "shadow"
        self.store.execute(
            [(("UPDATE agent_lifecycle SET state = 'shadow', setup_json = ?, updated_at = ?, "
               "shadow_at = COALESCE(shadow_at, ?) WHERE practice_id = ? AND owner_scope_id = ?"),
              (json.dumps(setup, sort_keys=True), now, now, context.practice_id, context.owner_scope_id))],
            [{"event_type": "representation_confirmed", "actor": context.actor, "practice_id": context.practice_id,
              "metadata": {"representation_version_id": version["id"], "version": version["version"]}}]
            + ([{"event_type": "agent_entered_shadow", "actor": context.actor, "practice_id": context.practice_id,
                 "metadata": {"representation_version_id": version["id"]}}] if entering else []),
        )
        return {"version": version, "lifecycle": self.lifecycle(context), "representation": self.view(context)}

    # ------------------------------------------------------------ the statements

    def _rules_for(self, context: PracticeContext, owner: str | None, include_proposals: bool) -> list[PracticeRule]:
        staff = context.role != "physician"
        confirmed = self.rules.list(context.practice_id, owner_scope_id=None if staff else owner)
        proposals = [] if (staff or not include_proposals) else self.rules.proposals(context.practice_id, owner)
        return [*confirmed, *proposals]

    @staticmethod
    def _items(rule: PracticeRule, status: str) -> list[dict]:
        base = {"rule_id": rule.id, "version": rule.version, "layer": rule.layer, "status": status,
                "source": rule.source, "confirmed_at": rule.confirmed_at,
                "confirmed_by": (rule.provenance or {}).get("actor") if status == "confirmed" else None}
        content = rule.content
        items = []
        if content.scope_policy:
            items.append({**base, "kind": "scope_policy" if content.scope_policy != "case_by_case" else "physician_judgment",
                          "text": {"accept": "You see these referrals", "out_of_scope": "Out of scope",
                                   "case_by_case": "You decide these case by case"}[content.scope_policy],
                          "value": content.scope_policy})
        elif status == "confirmed":
            items.append({**base, "kind": "scope_policy", "text": "You see these referrals (from your rule)", "value": "accept"})
        items += [{**base, "kind": "scope_policy", "text": f"Good fit: {phrase}"} for phrase in content.good_fit]
        items += [{**base, "kind": "scope_policy", "text": f"Not seen: {phrase}"} for phrase in content.redirect]
        items += [{**base, "kind": "hard_requirement", "text": item.label + (f" (within {item.freshness_days} days)" if item.freshness_days else ""),
                   "key": item.key} for item in content.required]
        items += [{**base, "kind": "soft_preference", "text": f"Helpful: {item.label}", "key": item.key} for item in content.helpful]
        # Urgency signals drive priority deterministically; shown as their own "Urgency" label.
        items += [{**base, "kind": "hard_requirement", "subkind": "urgency", "text": f"Urgent if: {phrase}"}
                  for phrase in content.urgent_signals]
        if content.modality != "unspecified":
            items.append({**base, "kind": "soft_preference",
                          "text": {"in_person": "Prefers an in-person visit", "econsult": "Prefers eConsult",
                                   "either": "Either in-person or eConsult"}[content.modality]})
        items += [{**base, "kind": "soft_preference", "text": text} for text in content.preferences]
        items += [{**base, "kind": "exception", "text": text} for text in content.exceptions]
        items += [{**base, "kind": "physician_judgment", "text": text} for text in content.judgment
                  if not text.startswith("Decides ")]
        items += [{**base, "kind": "soft_preference", "text": f"Make optional: {key.replace('_', ' ')}"} for key in content.make_optional]
        return items

    def view(self, context: PracticeContext) -> dict:
        """How the agent represents this physician (staff: the practice-level statements only)."""
        owner = self._owner(context)
        rules = self._rules_for(context, owner, include_proposals=True)
        groups: dict[str, dict] = {}
        for rule in rules:
            key = referral_type_key(rule.referral_type) or rule.referral_type.casefold()
            group = groups.setdefault(key, {"referral_type": rule.referral_type, "aliases": [], "items": [],
                                            "answered": set(), "confirmed_policy": None, "layers": set()})
            status = "confirmed" if rule.operational_status in {"confirmed", "inferred_active"} else "proposed"
            group["items"] += self._items(rule, status)
            group["layers"].add(rule.layer)
            if status == "confirmed":
                group["aliases"] = sorted(set(group["aliases"]) | set(rule.content.aliases))
                # A confirmed rule answers "scope" (a legacy rule without a policy = an accepted type).
                group["answered"] |= set(rule.content.answered_topics) | {"scope"}
                if rule.content.required or rule.content.helpful:
                    group["answered"].add("requirements")
                if rule.content.urgent_signals:
                    group["answered"].add("urgency")
                if rule.content.modality != "unspecified":
                    group["answered"].add("modality")
                group["confirmed_policy"] = group["confirmed_policy"] or rule.content.scope_policy or "accept"
        result = []
        for group in groups.values():
            policy = group["confirmed_policy"]
            topics = ["scope"] if policy is None else (
                [topic for topic in REPRESENTATION_TOPICS if topic not in group["answered"]] if policy == "accept" else [])
            result.append({
                "referral_type": group["referral_type"], "aliases": group["aliases"], "scope_policy": policy,
                "layers": sorted(group["layers"]), "items": group["items"],
                # Honest unknowns: what the agent has no confirmed answer for.
                "unknown_topics": topics,
            })
        result.sort(key=lambda group: group["referral_type"].casefold())
        row = self._lifecycle_row(context.practice_id, owner) if owner else None
        setup = self._setup(row) if row else {}
        physician = context.role == "physician"
        return {
            "types": result,
            "conflicts": self.conflicts(context) if physician else [],
            "delegation": (setup.get("delegation") or {}) if physician else {},
            "delegation_tasks": DELEGATION_TASKS,
            "profile": setup.get("profile") if physician else None,
            "unknowns": self._global_unknowns(result, setup) if physician else [],
            "version": self.latest_version(context.practice_id, owner) if owner else None,
            "lifecycle": self.lifecycle(context),
            "view": "physician" if physician else "staff_practice_level",
            "is_practice_admin": is_practice_admin(context),
        }

    @staticmethod
    def _global_unknowns(types: list[dict], setup: dict) -> list[str]:
        unknowns = []
        if not types:
            unknowns.append("Which referral types you see")
        stages = setup.get("stages", {})
        if stages.get("delegation", {}).get("status") != "done":
            unknowns.append("Who handles each kind of referral work")
        for group in types:
            for topic in group["unknown_topics"]:
                unknowns.append(f"{group['referral_type']}: {_TOPIC_TEXT[topic]}")
        return unknowns

    def conflicts(self, context: PracticeContext) -> list[dict]:
        """Practice-vs-physician disagreements, surfaced for review (never auto-resolved)."""
        owner = self._owner(context)
        if not owner:
            return []
        allow = bool(context.practice.get("allow_physician_loosening"))
        confirmed = self.rules.list(context.practice_id, owner_scope_id=owner)
        by_type: dict[str, dict[str, list[PracticeRule]]] = {}
        for rule in confirmed:
            by_type.setdefault(referral_type_key(rule.referral_type), {}).setdefault(rule.layer, []).append(rule)
        found = []
        for layers in by_type.values():
            practice, physician = layers.get("practice", []), layers.get("physician", [])
            if not practice or not physician:
                continue
            p_policy = next((r.content.scope_policy for r in practice if r.content.scope_policy), None)
            m_policy = next((r.content.scope_policy for r in physician if r.content.scope_policy), None)
            if p_policy and m_policy and p_policy != m_policy:
                found.append({"kind": "scope_policy", "referral_type": practice[0].referral_type,
                              "practice": p_policy, "physician": m_policy})
            required = {item.key for r in practice for item in r.content.required}
            for rule in physician:
                for key in rule.content.make_optional:
                    if key in required and not allow:
                        found.append({"kind": "requirement_loosening", "referral_type": rule.referral_type,
                                      "item_key": key, "detail": "The practice requires it and doesn’t allow loosening"})
        return found

    # --------------------------------------------------------------- versions

    def _snapshot(self, practice_id: str, owner_scope_id: str) -> dict:
        rules = self.rules.list(practice_id, owner_scope_id=owner_scope_id)
        row = self._lifecycle_row(practice_id, owner_scope_id)
        setup = self._setup(row)
        return {
            "statements": sorted(
                [{"rule_id": rule.id, "version": rule.version, "layer": rule.layer, "referral_type": rule.referral_type,
                  "content": rule.content.model_dump(mode="json")} for rule in rules],
                key=lambda entry: (entry["referral_type"].casefold(), entry["layer"], entry["rule_id"])),
            "delegation": setup.get("delegation") or {},
            "profile": {key: value for key, value in (setup.get("profile") or {}).items() if key not in {"reviewed_at", "reviewed_by"}},
        }

    def latest_version(self, practice_id: str, owner_scope_id: str) -> dict | None:
        row = self.store.fetch_one(
            "SELECT id, version, reason, created_by, created_at FROM representation_versions "
            "WHERE practice_id = ? AND owner_scope_id = ? ORDER BY version DESC LIMIT 1", (practice_id, owner_scope_id))
        return dict(row) if row else None

    def record_version(self, practice_id: str, owner_scope_id: str | None, *, actor: str, reason: str,
                       force: bool = False) -> dict | None:
        """Append a version when the confirmed representation differs from the latest one
        (or when the physician explicitly confirms it). Returns {id, version}."""
        if not owner_scope_id:
            return None
        snapshot = self._snapshot(practice_id, owner_scope_id)
        digest = _hash(snapshot)
        latest = self.store.fetch_one(
            "SELECT * FROM representation_versions WHERE practice_id = ? AND owner_scope_id = ? "
            "ORDER BY version DESC LIMIT 1", (practice_id, owner_scope_id))
        if latest and latest["content_hash"] == digest and not (force and latest["reason"] != "confirmed_by_physician"):
            return {"id": latest["id"], "version": latest["version"]}
        version_id = new_id("repv")
        number = (latest["version"] + 1) if latest else 1
        self.store.execute(
            [(("INSERT INTO representation_versions (id, practice_id, owner_scope_id, version, content_hash, "
               "snapshot_json, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
              (version_id, practice_id, owner_scope_id, number, digest, json.dumps(snapshot, sort_keys=True),
               reason, actor, now_iso()))],
            [{"event_type": "representation_version_recorded", "actor": actor, "autonomy": "automatic"
              if reason == "triage" else "human", "practice_id": practice_id,
              "metadata": {"representation_version_id": version_id, "version": number, "reason": reason}}],
        )
        return {"id": version_id, "version": number}

    def versions(self, context: PracticeContext) -> list[dict]:
        owner = self._owner(context)
        if context.role != "physician" or not owner:
            return []
        return self.store.fetch_all(
            "SELECT id, version, reason, created_by, created_at FROM representation_versions "
            "WHERE practice_id = ? AND owner_scope_id = ? ORDER BY version DESC", (context.practice_id, owner))

    # ------------------------------------------------------- learned this week

    def learning_summary(self, context: PracticeContext) -> dict:
        """THE source for every learning count shown anywhere (Home, Your Agent, Train badge):
        newly confirmed statements this week, pending learnings, open questions."""
        owner = self._owner(context)
        since = (datetime.now(UTC) - WEEK).isoformat(timespec="seconds")
        physician_view = context.role == "physician"
        confirmed = [
            {"rule_id": rule.id, "referral_type": rule.referral_type, "version": rule.version, "layer": rule.layer,
             "confirmed_at": rule.confirmed_at, "source": rule.source}
            for rule in confirmed_since(self.rules, context.practice_id, owner if physician_view else None, since)
        ]
        proposals = [self.teaching.view(rule) for rule in self.rules.proposals(
            context.practice_id, owner if physician_view else None)]
        # Learnings come from teaching and corrections; unreviewed setup answers are counted
        # separately (they are reviewed in setup's Stage E, not as learnings).
        setup_pending = [item for item in proposals if item.get("setup_stage")]
        questions = [dict(row) for row in self.store.fetch_all(
            "SELECT id, question, proposal_rule_id, created_at FROM learning_questions WHERE practice_id = ? "
            "AND status = 'pending' ORDER BY created_at", (context.practice_id,))]
        # Each thing to review is counted ONCE: a learning the agent is asking about (today or
        # queued) is a question, never also a pending learning, and never "learned".
        asked = {question["proposal_rule_id"] for question in questions}
        pending = [item for item in proposals if not item.get("setup_stage") and item["id"] not in asked]
        # One question a day: only today's question is actionable; the rest are queued. The
        # choice is the same one Home shows (LearningService.question_for_today).
        today = (self.learning.question_for_today(context.practice_id, mark_shown=False)
                 if self.learning is not None else (questions[0] if questions else None))
        today_id = (today or {}).get("id")
        open_now = [question for question in questions if question["id"] == today_id]
        queued = [question for question in questions if question["id"] != today_id]
        return {
            "since": since,
            "confirmed_this_week": confirmed,
            "pending_learnings": pending,
            "open_questions": open_now,
            "queued_questions": queued,
            "setup_pending": setup_pending,
            "lifecycle": self.lifecycle(context),
            "counts": {"confirmed_this_week": len(confirmed), "pending_learnings": len(pending),
                       "open_questions": len(open_now), "queued_questions": len(queued),
                       "setup_pending": len(setup_pending)},
        }

    # -------------------------------------------------------------- linkage

    def linkage(self, context: PracticeContext) -> list[dict]:
        """For Step 18: every recommendation with the representation version and statements it
        used and the referral's final decision. For decided referrals, the physician sign-off: the
        recommendation the agent had at that moment, its representation version, the physician's
        corrections and the decision. Reviews from the retired approval step are reported as
        `legacy_review` with the reviewer's role, and never count as physician agreement."""
        context.require_physician("view agreement data")
        rows = self.store.fetch_all(
            "SELECT r.id, r.referral_id, r.representation_version_id, r.recommendation_json, r.created_at, "
            "i.referral_type, i.disposition_json FROM triage_recommendations r JOIN intake_referrals i "
            "ON i.id = r.referral_id WHERE r.practice_id = ? ORDER BY r.created_at, r.rowid", (context.practice_id,))
        signoffs = {item["referral_id"]: self.store.signoff(context.practice_id, item["referral_id"])
                    for item in self.store.fetch_all(
                        "SELECT referral_id FROM referral_signoffs WHERE practice_id = ?", (context.practice_id,))}
        result = []
        for row in rows:
            recommendation = json.loads(row["recommendation_json"])
            decision = self.store.effective_decision(row["id"])
            disposition = json.loads(row["disposition_json"]) if row["disposition_json"] else None
            signoff = signoffs.get(row["referral_id"])
            result.append({
                "recommendation_id": row["id"], "referral_id": row["referral_id"],
                "referral_type": row["referral_type"], "representation_version_id": row["representation_version_id"],
                "statement_kinds": sorted({item["kind"] for item in recommendation.get("statements_used", []) if item.get("drives", True)}),
                "fit": recommendation.get("fit"), "readiness": recommendation.get("readiness"),
                "legacy_review": decision and {
                    "decision": decision["decision"], "actor_role": decision["actor_role"],
                    "carried_forward": bool(decision.get("carried_forward")), "counts_as_physician_agreement": False},
                "final_decision": (disposition or {}).get("decision"),
                # Set only on the recommendation the physician decided on.
                "signoff": signoff and signoff["recommendation_id"] == row["id"] and {
                    "id": signoff["id"], "decision": signoff["decision"],
                    "representation_version_id": signoff["representation_version_id"],
                    "corrections": [{"field": c["field"], "from": c["from_value"], "to": c["to_value"],
                                     "agent_value": c["agent_value"]} for c in signoff["corrections"]],
                    "effective_triage": signoff["effective_triage"], "actor_role": signoff["actor_role"],
                    "created_at": signoff["created_at"]} or None,
                "created_at": row["created_at"],
            })
        return result

    # ---------------------------------------------------------------- items

    def leave_unknown(self, context: PracticeContext, proposal_id: str) -> dict:
        """Stage E "leave unknown": the proposal is set aside; its topic stays unknown."""
        try:
            rule = self.rules.get(context.practice_id, proposal_id)
        except RuleNotFoundError as error:
            raise PilotError("rule_not_found", "Rule not found", 404) from error
        require_can_edit(context, rule)
        self.teaching.reject(context, proposal_id, "left_unknown", event="learning_left_unknown")
        return self.view(context)

    def proposal_content(self, context: PracticeContext, proposal_id: str) -> dict:
        rule = self.rules.get(context.practice_id, proposal_id)
        require_can_edit(context, rule)
        return _content_dict(rule.content)


_TOPIC_TEXT = {"scope": "whether you see these", "requirements": "what you need before review",
               "urgency": "what makes one urgent", "modality": "preferred visit type"}


def _item(item: dict, *, required: bool) -> dict:
    label = " ".join(str(item.get("label")).split())[:120]
    days = item.get("freshness_days")
    days = int(days) if isinstance(days, (int, float, str)) and str(days).strip().isdigit() and int(days) > 0 else None
    key = "_".join(sorted(_tokens(label)))[:80] or "item"  # same keys as the teaching parser
    return {"key": key, "label": label[:1].upper() + label[1:], "required": required, "freshness_days": days}
