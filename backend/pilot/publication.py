"""Publication layer: internal representation → explicit choices → versioned public snapshot.

The public page and public agent read ONLY `public_profile_snapshots` (via
`public_snapshot`). The snapshot builder copies an allow-listed subset of practice
fields and of rules the physician marked publishable; it never includes rule ids,
urgency signals, internal notes, unpublished rules, confidence, or any referral data.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .practice import PilotError, PracticeContext
from .rules import PracticeRules
from .store import PilotStore, new_id, now_iso

SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$")
RESERVED_SLUGS = {"me", "api", "admin", "new", "public", "lamina", "help", "login", "signup"}
SETTING_LIMITS = {"intro": 600, "insurance": 800, "how_to_refer": 800, "hours": 300}


def suggest_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")[:50] or "practice"
    return slug if len(slug) >= 3 else f"{slug}-practice"


class PublicationService:
    def __init__(self, store: PilotStore, rules: PracticeRules) -> None:
        self.store = store
        self.rules = rules

    def _profile(self, practice: dict) -> dict:
        row = self.store.fetch_one("SELECT * FROM public_profiles WHERE practice_id = ?", (practice["id"],))
        if row:
            return row
        base, suffix = suggest_slug(practice["name"]), 1
        slug = base
        while self.store.fetch_one("SELECT 1 FROM public_profiles WHERE slug = ?", (slug,)) or slug in RESERVED_SLUGS:
            suffix += 1
            slug = f"{base}-{suffix}"
        settings = {"show_physicians": True, "locations": [practice["address"]] if practice.get("address") else [],
                    "intro": "", "insurance": "", "how_to_refer": "", "hours": "", "accepts_public_referrals": True}
        self.store.execute([(
            ("INSERT OR IGNORE INTO public_profiles (practice_id, slug, status, settings_json, updated_at) "
            "VALUES (?, ?, 'draft', ?, ?)"), (practice["id"], slug, json.dumps(settings), now_iso()),
        )])
        return self.store.fetch_one("SELECT * FROM public_profiles WHERE practice_id = ?", (practice["id"],))

    def build_snapshot(self, context: PracticeContext) -> dict[str, Any]:
        profile = self._profile(context.practice)
        settings = json.loads(profile["settings_json"])
        practice = context.practice
        physicians = []
        if settings.get("show_physicians", True):
            for scope_id in self.store.physician_scope_ids(context.practice_id):
                scope = self.store.workflow.physician_owner_scope(scope_id) or {}
                identity = scope.get("provider_identity") or {}
                if identity.get("display_name"):
                    physicians.append({"name": identity["display_name"], "specialty": identity.get("specialty")})
        referral_types = []
        modalities: set[str] = set()
        for rule in self.rules.list(context.practice_id):
            if not rule.publishable:
                continue
            if rule.content.modality != "unspecified":
                modalities.add(rule.content.modality)
            referral_types.append({
                "name": rule.referral_type,
                "good_fit": list(rule.content.good_fit),
                "not_seen": list(rule.content.redirect),
                "required": [{"label": item.label, "within_days": item.freshness_days} for item in rule.content.required],
                "helpful": [item.label for item in rule.content.helpful],
                "modality": rule.content.modality,
            })
        return {
            "practice": {key: practice.get(key) for key in ("name", "specialty", "phone", "website", "contact_email")},
            "physicians": physicians,
            "locations": [location for location in settings.get("locations", []) if location][:5],
            "intro": settings.get("intro") or "",
            "insurance": settings.get("insurance") or "",
            "how_to_refer": settings.get("how_to_refer") or "",
            "hours": settings.get("hours") or "",
            "referral_types": referral_types,
            "modalities": sorted(modalities),
            "accepts_public_referrals": bool(settings.get("accepts_public_referrals", True)),
        }

    def preview(self, context: PracticeContext) -> dict:
        profile = self._profile(context.practice)
        current = None
        if profile["current_snapshot_id"]:
            row = self.store.fetch_one("SELECT version, published_at FROM public_profile_snapshots WHERE id = ?",
                                       (profile["current_snapshot_id"],))
            current = row
        draft = self.build_snapshot(context)
        published = None
        if profile["current_snapshot_id"]:
            snap = self.store.fetch_one("SELECT snapshot_json FROM public_profile_snapshots WHERE id = ?",
                                        (profile["current_snapshot_id"],))
            published = json.loads(snap["snapshot_json"]) if snap else None
        return {
            "slug": profile["slug"], "status": profile["status"], "settings": json.loads(profile["settings_json"]),
            "draft_snapshot": draft, "published_version": current, "unpublished_changes": draft != published,
            "rules": [{"id": rule.id, "referral_type": rule.referral_type, "version": rule.version,
                       "publishable": rule.publishable} for rule in self.rules.list(context.practice_id)],
        }

    def update_settings(self, context: PracticeContext, slug: str | None, settings: dict) -> dict:
        context.require_physician("edit the public profile")
        profile = self._profile(context.practice)
        clean = json.loads(profile["settings_json"])
        for key, limit in SETTING_LIMITS.items():
            if key in settings:
                clean[key] = str(settings[key] or "").strip()[:limit]
        if "locations" in settings:
            clean["locations"] = [str(item).strip()[:200] for item in settings["locations"] or [] if str(item).strip()][:5]
        for key in ("show_physicians", "accepts_public_referrals"):
            if key in settings:
                clean[key] = bool(settings[key])
        new_slug = profile["slug"]
        if slug is not None and slug != profile["slug"]:
            candidate = slug.strip().casefold()
            if not SLUG_PATTERN.match(candidate) or candidate in RESERVED_SLUGS:
                raise PilotError("invalid_slug", "Use 3–60 lowercase letters, numbers, or hyphens", 422)
            if self.store.fetch_one("SELECT 1 FROM public_profiles WHERE slug = ? AND practice_id != ?",
                                    (candidate, context.practice_id)):
                raise PilotError("slug_taken", "That address is already in use")
            new_slug = candidate
        self.store.execute(
            [("UPDATE public_profiles SET slug = ?, settings_json = ?, updated_at = ? WHERE practice_id = ?",
              (new_slug, json.dumps(clean), now_iso(), context.practice_id))],
            [{"event_type": "public_profile_settings_updated", "actor": context.actor,
              "practice_id": context.practice_id, "metadata": {"slug_changed": new_slug != profile["slug"]}}],
        )
        return self.preview(context)

    def publish(self, context: PracticeContext) -> dict:
        context.require_physician("publish the public profile")
        profile = self._profile(context.practice)
        snapshot = self.build_snapshot(context)
        version = (self.store.fetch_one(
            "SELECT MAX(version) AS v FROM public_profile_snapshots WHERE practice_id = ?",
            (context.practice_id,))["v"] or 0) + 1
        snapshot_id = new_id("pub")
        self.store.execute(
            [
                (("INSERT INTO public_profile_snapshots (id, practice_id, version, snapshot_json, published_by, published_at) "
                 "VALUES (?, ?, ?, ?, ?, ?)"),
                 (snapshot_id, context.practice_id, version, json.dumps(snapshot), context.actor, now_iso())),
                ("UPDATE public_profiles SET status = 'published', current_snapshot_id = ?, updated_at = ? WHERE practice_id = ?",
                 (snapshot_id, now_iso(), context.practice_id)),
            ],
            [{"event_type": "public_profile_published", "actor": context.actor, "practice_id": context.practice_id,
              "metadata": {"version": version, "slug": profile["slug"],
                           "referral_types": len(snapshot["referral_types"])}}],
        )
        return self.preview(context)

    def unpublish(self, context: PracticeContext) -> dict:
        context.require_physician("unpublish the public profile")
        self._profile(context.practice)
        self.store.execute(
            [("UPDATE public_profiles SET status = 'unpublished', updated_at = ? WHERE practice_id = ?",
              (now_iso(), context.practice_id))],
            [{"event_type": "public_profile_unpublished", "actor": context.actor, "practice_id": context.practice_id}],
        )
        return self.preview(context)


def public_snapshot(store: PilotStore, slug: str) -> tuple[dict, dict] | None:
    """The ONLY read used by unauthenticated public routes: published snapshot + its owner.
    Returns (snapshot, {practice_id, version, slug}) or None."""
    if not slug or not SLUG_PATTERN.match(slug.casefold()):
        return None
    profile = store.fetch_one(
        "SELECT p.practice_id, p.slug, p.status, s.snapshot_json, s.version FROM public_profiles p "
        "JOIN public_profile_snapshots s ON s.id = p.current_snapshot_id "
        "JOIN practices pr ON pr.id = p.practice_id "
        "WHERE p.slug = ? AND p.status = 'published' AND pr.status = 'active'",
        (slug.casefold(),),
    )
    if not profile:
        return None
    return json.loads(profile["snapshot_json"]), {
        "practice_id": profile["practice_id"], "version": profile["version"], "slug": profile["slug"]}
