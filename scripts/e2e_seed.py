"""DEV/E2E ONLY: reset and seed the dedicated Playwright database with fictional data.

    python -m scripts.e2e_seed reset                 # wipe data/e2e/pilot-e2e.sqlite and seed it
    python -m scripts.e2e_seed step <name>           # scenario switch while the e2e API runs
    python -m scripts.e2e_seed inspect <what> <id>   # read-only JSON for assertions (no secrets)

Refuses to run unless LAMINA_E2E=1, LAMINA_PRODUCT_MODE=pilot, LAMINA_DEV_FAKE_NPPES=true and
LAMINA_WORKFLOW_DATABASE points at data/e2e/pilot-e2e.sqlite. Never touches the walkthrough or any
other database. Every practice, physician, patient and referral is fictional and marked "E2E".

Seeding goes through the real pilot API in-process (FastAPI TestClient), so the data is what the
product itself writes. Supabase user ids come from frontend/e2e/.auth/accounts.json, which the
one-time manual session capture writes; with no accounts captured yet the database is reset and
left empty (enough for the capture step). Output ids, slugs and the sender link go to
frontend/e2e/.state/seed.json (gitignored).

Practices:
  A  Northfield Endocrinology (E2E): physician (admin, Dr. Avery Testwell) + staff "Front desk (E2E)",
     agent in shadow, rules, a pending practice-level learning, published public page, and one
     referral per e2e scenario.
  B  Riverside Nephrology (E2E): the second physician (Dr. Jordan Sampleton), agent still
     initializing (for the setup specs), two closed referrals (for isolation and an empty Home).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
E2E_DIR = ROOT / "data" / "e2e"
DB_PATH = E2E_DIR / "pilot-e2e.sqlite"
ACCOUNTS = ROOT / "frontend" / "e2e" / ".auth" / "accounts.json"
STATE = ROOT / "frontend" / "e2e" / ".state" / "seed.json"
OPERATOR = "e2e-seed-operator"
ROLES = ("physician", "second_physician", "staff")
NPI_A, NPI_B = "1234567893", "1234567802"  # fictional directory in scripts/dev_pilot_server.py

SENDER = {"name": "Dr. Casey Placeholder (E2E)", "practice": "Placeholder Family Medicine (E2E)", "contact": "fax 555-0199"}
RECENT = (datetime.now(UTC).date() - timedelta(days=30)).isoformat()
PRIVATE_NOTE = "E2E-PRIVATE-JUDGMENT: I decide nodules in pregnancy myself"

THYROID = {
    "referral_type": "Thyroid nodule", "good_fit": ["nodule larger than 1 cm"], "outside_scope": [],
    "required": [{"key": "thyroid_ultrasound", "label": "Thyroid ultrasound", "required": True},
                 {"key": "tsh", "label": "Recent TSH", "required": True, "freshness_days": 90}],
    "urgent_signals": ["stridor"], "modality": "econsult", "judgment": [PRIVATE_NOTE],
}
DIABETES = {
    "referral_type": "Diabetes management", "good_fit": ["type 2 diabetes not at goal"],
    "required": [{"key": "recent_a1c", "label": "Recent HbA1c", "required": True, "freshness_days": 180},
                 {"key": "renal_function", "label": "Renal function", "required": True, "freshness_days": 365}],
    "modality": "in_person",
}
ADRENAL = {"referral_type": "Adrenal nodule", "good_fit": ["incidental adrenal nodule"], "modality": "econsult"}
OSTEOPOROSIS = {"referral_type": "Osteoporosis", "good_fit": ["low bone density"], "modality": "econsult"}
HYPERPARA = {"referral_type": "Hyperparathyroidism", "good_fit": ["raised calcium"], "modality": "unspecified"}
KIDNEY_STONES = {"referral_type": "Kidney stones", "good_fit": ["recurrent kidney stones"], "modality": "either"}
DIABETES_ITEMS = [{"key": "recent_a1c", "value": "HbA1c 8.4% (E2E)", "observed_date": RECENT},
                  {"key": "renal_function", "value": "eGFR 82 (E2E)", "observed_date": RECENT}]


def guard() -> None:
    problems = []
    if os.environ.get("LAMINA_E2E") != "1":
        problems.append("LAMINA_E2E=1 is not set")
    if os.environ.get("LAMINA_PRODUCT_MODE", "").casefold() != "pilot":
        problems.append("LAMINA_PRODUCT_MODE is not pilot")
    if os.environ.get("LAMINA_DEV_FAKE_NPPES", "").casefold() != "true":
        problems.append("LAMINA_DEV_FAKE_NPPES is not true")
    configured = Path(os.environ.get("LAMINA_WORKFLOW_DATABASE", "")).resolve()
    if configured != DB_PATH.resolve():
        problems.append("LAMINA_WORKFLOW_DATABASE is not the dedicated e2e database")
    if problems:
        sys.exit("Refusing to touch any database: " + "; ".join(problems) + ". (e2e only)")


def _accounts() -> dict[str, str]:
    if not ACCOUNTS.is_file():
        return {}
    data = json.loads(ACCOUNTS.read_text(encoding="utf-8"))
    return {role: data[role]["user_id"] for role in ROLES if data.get(role, {}).get("user_id")}


class Seeder:
    """The real pilot API, in-process, with seed-only bearer tokens mapped to captured user ids."""

    def __init__(self, users: dict[str, str]) -> None:
        os.environ["LAMINA_PILOT_ADMIN_USER_IDS"] = OPERATOR
        from fastapi.testclient import TestClient

        from backend.api import physician_onboarding
        from backend.auth import AuthenticatedUser, AuthenticationError, get_token_verifier
        from backend.main import create_app
        from backend.physician_onboarding import PhysicianOnboardingService
        from backend.provider_network.identity import NppesIdentityResolver
        from backend.workflow import WorkflowStore
        from scripts.dev_pilot_server import FictionalNppes

        tokens = {f"seed-{role}": user for role, user in users.items()} | {"seed-operator": OPERATOR}

        class SeedVerifier:
            def verify(self, token: str) -> AuthenticatedUser:
                if token in tokens:
                    return AuthenticatedUser(id=tokens[token])
                raise AuthenticationError("invalid")

        fake = FictionalNppes()
        self.workflow = WorkflowStore(DB_PATH)
        physician_onboarding.onboarding_service = PhysicianOnboardingService(
            self.workflow, NppesIdentityResolver(fake, cache_seconds=0), search_transport=fake)
        app = create_app("pilot")
        app.dependency_overrides[get_token_verifier] = lambda: SeedVerifier()
        self.client = TestClient(app)
        self.users = users

    def call(self, method: str, path: str, role: str | None, body: dict | None = None, ok: tuple = (200, 201, 204)) -> dict:
        headers = {"Authorization": f"Bearer seed-{role}"} if role else {}
        response = self.client.request(method, path, headers=headers, json=body)
        if response.status_code not in ok:
            sys.exit(f"Seed step failed: {method} {path} -> {response.status_code} {response.text[:300]}")
        return response.json() if response.content else {}

    def physician(self, role: str, npi: str, practice: str, specialty: str) -> dict:
        self.call("POST", "/api/me/onboarding/npi/lookup", role, {"npi": npi})
        self.call("POST", "/api/me/onboarding/identity/confirm", role, {"npi": npi})
        created = self.call("POST", "/api/me/practice", role, {"name": practice, "specialty": specialty})
        scope = self.workflow.selected_physician_owner_scope(self.users[role])
        self.call("POST", f"/api/internal/pilot-physicians/{scope['id']}/approve", "operator")
        return created

    def referral(self, role: str, patient: str, referral_type: str, reason: str, items: list | None = None) -> str:
        detail = self.call("POST", "/api/me/practice/referrals", role, {
            "sender": SENDER, "patient": {"name": patient, "date_of_birth": "1970-01-02"},
            "referral_type": referral_type, "reason": reason, "submitted_items": items or []})
        return detail["referral"]["id"]

    def send_request(self, role: str, rid: str) -> str:
        detail = self.call("POST", f"/api/me/practice/referrals/{rid}/request-information", role, {})
        request = detail["information_requests"][-1]
        sent = self.call("POST", f"/api/me/practice/information-requests/{request['id']}/send", role, {"mode": "mark_sent"})
        return sent["status_link"].rsplit("/r/", 1)[1]

    def revise(self, rid: str, base: dict, **changes) -> dict:
        return self.call("PUT", f"/api/me/practice/rules/{rid}", "physician", {**base, **changes})


def reset() -> None:
    guard()
    E2E_DIR.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = Path(str(DB_PATH) + suffix)
        if path.exists():
            path.unlink()
    users = _accounts()
    STATE.parent.mkdir(parents=True, exist_ok=True)
    if set(users) != set(ROLES):
        STATE.write_text(json.dumps({"seeded": False}, indent=1), encoding="utf-8")
        print("e2e database reset; no seed data (sessions not captured yet).")
        return
    s = Seeder(users)
    # ---- practice A: admin physician, staff, rules, published page
    practice_a = s.physician("physician", NPI_A, "Northfield Endocrinology (E2E)", "Endocrinology")
    rules = {spec["referral_type"]: s.call("POST", "/api/me/practice/rules", "physician", spec)
             for spec in (THYROID, DIABETES, ADRENAL, OSTEOPOROSIS, HYPERPARA)}
    invite = s.call("POST", "/api/me/practice/invitations", "physician", {"label": "Front desk (E2E)"})
    s.call("POST", "/api/me/practice/invitations/accept", "staff", {"token": invite["token"]})
    s.call("POST", "/api/me/practice/representation/confirm", "physician")  # agent enters shadow
    slug = "northfield-endocrinology-e2e"
    s.call("PUT", "/api/me/practice/public-profile", "physician", {
        "slug": slug, "intro": "Fictional endocrinology practice used for automated tests (E2E).",
        "how_to_refer": "Fax a referral letter (E2E).", "accepts_public_referrals": True})
    s.call("POST", "/api/me/practice/public-profile/publish", "physician")
    # A practice-level learning waiting for an ADMIN physician.
    proposal = s.call("POST", "/api/me/practice/teach", "physician",
                      {"text": "For Hyperparathyroidism referrals I need a calcium level."})
    # ---- practice A referrals, one per scenario
    r = {
        "verify": s.referral("staff", "Vega Verify-E2E", "Thyroid nodule", "1.4 cm thyroid nodule; please evaluate."),
        "ready": s.referral("staff", "Rhee Ready-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS),
        "flag": s.referral("staff", "Fox Flag-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS),
        "signoff": s.referral("staff", "Sato Signoff-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS),
        "redirect": s.referral("staff", "Ruiz Redirect-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS),
        "decline": s.referral("staff", "Diaz Decline-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS),
        "change": s.referral("staff", "Chen Change-E2E", "Adrenal nodule", "Incidental adrenal nodule on CT."),
        "conflict_keep": s.referral("staff", "Cole Conflict-E2E", "Osteoporosis", "Low bone density on DXA."),
        "conflict_apply": s.referral("staff", "Cruz Conflict-E2E", "Osteoporosis", "Low bone density on DXA."),
        "still_open": s.referral("staff", "Stone StillOpen-E2E", "Thyroid nodule", "1.1 cm thyroid nodule; please evaluate."),
        "declined_notify": s.referral("staff", "Dahl Declined-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS),
    }
    # Declined by the physician; nobody has told the referring office yet (staff's follow-up).
    s.call("POST", f"/api/me/practice/referrals/{r['declined_notify']}/disposition", "physician",
           {"decision": "decline", "reason": "Better served by the diabetes education program (E2E)."})
    # "Changed since you last looked": the physician looks, then updates the Adrenal rule.
    # The spec has staff re-run triage, so cause (rule update) and trigger (staff) differ.
    s.call("GET", f"/api/me/practice/referrals/{r['change']}", "physician")
    s.call("POST", f"/api/me/practice/referrals/{r['change']}/seen", "physician")
    s.revise(rules["Adrenal nodule"]["id"], ADRENAL, modality="in_person")
    # Correction vs newer rule: the physician corrected visit type, then changed the rule.
    for key in ("conflict_keep", "conflict_apply"):
        s.call("POST", f"/api/me/practice/referrals/{r[key]}/correct", "physician", {"suggested_modality": "in_person"})
    s.revise(rules["Osteoporosis"]["id"], OSTEOPOROSIS, modality="either")
    for key in ("conflict_keep", "conflict_apply"):
        s.call("POST", f"/api/me/practice/referrals/{r[key]}/triage", "physician")
    # Ready with an outstanding request: TSH received and verified, ultrasound still requested.
    token = s.send_request("staff", r["still_open"])
    s.call("POST", f"/api/public/r/{token}/response", None,
           {"items": [{"key": "tsh", "value": "TSH 1.9 mIU/L (E2E)", "observed_date": RECENT}]})
    s.call("POST", f"/api/me/practice/referrals/{r['still_open']}/items/tsh/verify", "staff", {})
    s.call("POST", f"/api/me/practice/referrals/{r['still_open']}/mark-ready", "staff", {"note": "TSH verified (E2E)."})
    # ---- practice B: second physician, agent initializing, closed referrals only
    practice_b = s.physician("second_physician", NPI_B, "Riverside Nephrology (E2E)", "Nephrology")
    b = {
        "accepted": s.referral("second_physician", "Ito Isolated-E2E", "Kidney stones", "Recurrent kidney stones."),
        "declined": s.referral("second_physician", "Ives Isolated-E2E", "Kidney stones", "Recurrent kidney stones."),
    }
    s.call("POST", f"/api/me/practice/referrals/{b['accepted']}/disposition", "second_physician", {"decision": "accept"})
    s.call("POST", f"/api/me/practice/referrals/{b['declined']}/disposition", "second_physician",
           {"decision": "decline", "reason": "Outside our service (E2E)."})
    # Practice B already told its referring office (outside Lamina), so its Home is truly empty.
    s.call("POST", f"/api/me/practice/referrals/{b['declined']}/office-notified", "second_physician")
    status = s.call("GET", "/api/me/practice/status", "physician")
    state = {
        "seeded": True, "sender_token": token, "public_slug": slug,
        "practice_a": {"id": practice_a["id"], "name": "Northfield Endocrinology (E2E)",
                       "physician_name": status.get("physician_name"), "staff_label": "Front desk (E2E)"},
        "practice_b": {"id": practice_b["id"], "name": "Riverside Nephrology (E2E)"},
        "referrals": r, "practice_b_referrals": b, "practice_proposal_id": proposal["id"],
        "private_markers": [PRIVATE_NOTE, "calcium level", "Vega Verify-E2E", "Rhee Ready-E2E", "Ito Isolated-E2E",
                            "Front desk (E2E)", "Thyroid ultrasound"],
    }
    STATE.write_text(json.dumps(state, indent=1), encoding="utf-8")
    print(f"e2e database seeded: 2 practices, {len(r) + len(b)} referrals.")


def step(name: str) -> None:
    """Scenario switches the specs make while the e2e API is running (same database)."""
    guard()
    from backend.pilot.store import PilotStore
    from backend.workflow import WorkflowStore

    store = PilotStore(workflow=WorkflowStore(DB_PATH))
    state = json.loads(STATE.read_text(encoding="utf-8"))
    users = _accounts()
    second = users["second_physician"]
    with store._connect() as db:
        if name == "join-second-physician":
            # Joining a practice as a second physician isn't a product flow yet: arrange it directly.
            db.execute("UPDATE practice_members SET practice_id = ?, is_admin = 0 WHERE user_id = ?",
                       (state["practice_a"]["id"], second))
        elif name == "return-second-physician":
            db.execute("UPDATE practice_members SET practice_id = ?, is_admin = 1 WHERE user_id = ?",
                       (state["practice_b"]["id"], second))
        elif name == "initializing-second-physician":
            # Put the second physician's agent back to "initializing" with no stages done (used by
            # the screenshot run, which captures both states, once per viewport).
            db.execute("UPDATE agent_lifecycle SET state = 'initializing', setup_json = ?, shadow_at = NULL "
                       "WHERE practice_id = ?", (json.dumps({"stages": {}}), state["practice_b"]["id"]))
        else:
            sys.exit(f"Unknown step: {name}")
    print(f"step {name}: done")


def shadow_second() -> None:
    guard()
    s = Seeder(_accounts())
    # A practice in shadow has at least one rule; without one Home (rightly) asks for criteria.
    if not any(rule["referral_type"] == KIDNEY_STONES["referral_type"]
               for rule in s.call("GET", "/api/me/practice/rules", "second_physician")):
        s.call("POST", "/api/me/practice/rules", "second_physician", KIDNEY_STONES)
    s.call("POST", "/api/me/practice/representation/confirm", "second_physician")
    print("step shadow-second-physician: done")


def inspect(what: str, referral_id: str) -> None:
    guard()
    from backend.pilot.store import PilotStore
    from backend.workflow import WorkflowStore

    store = PilotStore(workflow=WorkflowStore(DB_PATH))
    state = json.loads(STATE.read_text(encoding="utf-8"))
    practice = state["practice_a"]["id"]
    if what == "signoff":
        row = store.signoff(practice, referral_id) or {}
        out = {key: row.get(key) for key in ("decision", "actor_role", "reason", "redirect_to", "representation_version_id")}
        out["actor_is_physician"] = row.get("actor") == f"user:{_accounts()['physician']}"
        out["corrections"] = [{k: c[k] for k in ("field", "from_value", "to_value", "agent_value", "actor_role")}
                              for c in row.get("corrections", [])]
        out["staff_rows"] = store.fetch_one(
            "SELECT COUNT(*) AS n FROM referral_signoffs WHERE referral_id = ? AND actor_role != 'physician'", (referral_id,))["n"]
    elif what == "resolutions":
        out = store.fetch_all(
            "SELECT field, choice, rule_version, actor_role FROM correction_conflict_resolutions WHERE referral_id = ? "
            "ORDER BY created_at, rowid", (referral_id,))
    else:
        sys.exit(f"Unknown inspect target: {what}")
    print(json.dumps(out))


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in {"reset", "step", "inspect"}:
        print(__doc__)
        return 2
    if argv[0] == "reset":
        reset()
    elif argv[0] == "step" and len(argv) == 2:
        shadow_second() if argv[1] == "shadow-second-physician" else step(argv[1])
    elif argv[0] == "inspect" and len(argv) == 3:
        inspect(argv[1], argv[2])
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
