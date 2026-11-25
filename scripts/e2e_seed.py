"""DEV/E2E ONLY: reset and seed the dedicated Playwright database with fictional data.

    python -m scripts.e2e_seed reset                 # drop, re-migrate and seed the lamina_e2e database
    python -m scripts.e2e_seed step <name>           # scenario switch while the e2e API runs
    python -m scripts.e2e_seed inspect <what> <id>   # read-only JSON for assertions (no secrets)

Refuses to run unless LAMINA_E2E=1, LAMINA_PRODUCT_MODE=pilot, LAMINA_DEV_FAKE_NPPES=true and
LAMINA_DATABASE_URL is the `lamina_e2e` Postgres database on loopback (run 2; derived from
LAMINA_TEST_DATABASE_URL). Never touches the walkthrough or any other database. Every practice, physician, patient and referral is fictional and marked "E2E".

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
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
E2E_DIR = ROOT / "data" / "e2e"
# Run 2: the e2e database is Postgres -- a dedicated `lamina_e2e` database on the local dev
# container (loopback only), dropped and re-migrated (Alembic) at every reset.
E2E_DATABASE = "lamina_e2e"


def e2e_url() -> str:
    return os.environ.get("LAMINA_DATABASE_URL", "").strip()
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
THYROID_ITEMS = [{"key": "thyroid_ultrasound", "value": "1.3 cm nodule on ultrasound (E2E)", "observed_date": RECENT},
                 {"key": "tsh", "value": "TSH 2.0 mIU/L (E2E)", "observed_date": RECENT}]
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
    from urllib.parse import urlparse

    url = urlparse(e2e_url())
    if url.scheme not in {"postgresql", "postgres"} or url.path.strip("/") != E2E_DATABASE:
        problems.append(f"LAMINA_DATABASE_URL is not the dedicated Postgres e2e database ({E2E_DATABASE})")
    elif url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        problems.append("the e2e database is not on loopback")
    if not os.environ.get("LAMINA_TEST_DATABASE_URL"):
        problems.append("LAMINA_TEST_DATABASE_URL (the local admin connection) is not set")
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
            """Seed-only sessions: MFA-verified (aal2), each with a fictional seed email so the
            staff invitation (bound to an email) can be accepted in-process."""

            def verify(self, token: str) -> AuthenticatedUser:
                if token in tokens:
                    return AuthenticatedUser(id=tokens[token], email=f"{token}@example.test", aal="aal2",
                                             issued_at=int(time.time()))
                raise AuthenticationError("invalid")

        fake = FictionalNppes()
        self.workflow = WorkflowStore(url=e2e_url())
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
        # Invite-only: the request (a confirmed identity) is approved before the practice exists.
        self.call("POST", "/api/me/onboarding/npi/lookup", role, {"npi": npi})
        self.call("POST", "/api/me/onboarding/identity/confirm", role, {"npi": npi})
        scope = self.workflow.selected_physician_owner_scope(self.users[role])
        self.call("POST", f"/api/internal/pilot-physicians/{scope['id']}/approve", "operator")
        return self.call("POST", "/api/me/practice", role, {"name": practice, "specialty": specialty})

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

    def workflow_store_execute(self, sql: str, values: tuple) -> None:
        from backend.pilot.store import PilotStore

        PilotStore(workflow=self.workflow).execute([(sql, values)])

    def revise(self, rid: str, base: dict, **changes) -> dict:
        return self.call("PUT", f"/api/me/practice/rules/{rid}", "physician", {**base, **changes})


def _recreate_e2e_database() -> None:
    """Drop and recreate `lamina_e2e`, then migrate it to the Alembic head (the real migrations)."""
    import subprocess

    import psycopg

    with psycopg.connect(os.environ["LAMINA_TEST_DATABASE_URL"], autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{E2E_DATABASE}" WITH (FORCE)')
        admin.execute(f'CREATE DATABASE "{E2E_DATABASE}"')
    migrated = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ROOT / "backend" / "migrations" / "alembic.ini"), "upgrade", "head"],
        cwd=ROOT, env=os.environ.copy(), capture_output=True, text=True, check=False)
    if migrated.returncode != 0:
        sys.exit("Migrating the e2e database failed:\n" + migrated.stderr[-1500:])


def reset() -> None:
    guard()
    E2E_DIR.mkdir(parents=True, exist_ok=True)
    _recreate_e2e_database()
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
    invite = s.call("POST", "/api/me/practice/invitations", "physician",
                    {"label": "Front desk (E2E)", "email": "seed-staff@example.test"})
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
    s.call("POST", f"/api/me/practice/referrals/{r['still_open']}/mark-ready", "staff", {"note": "TSH verified (E2E).", "confirm_missing": ["Thyroid ultrasound"]})
    # ---- Step 18: shadow history for the readiness review. Physician A has decided enough
    # referrals over enough days to be eligible; physician B (below) has not. Includes real
    # disagreements: a strong-fit decline, priority corrections and a visit-type correction.
    history = []
    for index in range(8):
        rid = s.referral("staff", f"Hale History{index + 1}-E2E", "Diabetes management", "Type 2 diabetes not at goal.", DIABETES_ITEMS)
        if index in (2, 5):
            s.call("POST", f"/api/me/practice/referrals/{rid}/correct", "physician", {"suggested_priority": "soon"})
        if index == 6:
            s.call("POST", f"/api/me/practice/referrals/{rid}/correct", "physician", {"suggested_modality": "econsult"})
        s.call("POST", f"/api/me/practice/referrals/{rid}/disposition", "physician", {"decision": "accept"})
        history.append(rid)
    for index, decision in enumerate(("accept", "accept", "decline")):
        rid = s.referral("staff", f"Hart History{index + 1}-E2E", "Thyroid nodule", "1.3 cm thyroid nodule; please evaluate.", THYROID_ITEMS)
        body = {"decision": decision} if decision == "accept" else {"decision": decision, "reason": "Better seen locally (E2E)."}
        s.call("POST", f"/api/me/practice/referrals/{rid}/disposition", "physician", body)
        if decision == "decline":
            s.call("POST", f"/api/me/practice/referrals/{rid}/office-notified", "staff")
        history.append(rid)
    rid = s.referral("staff", "Hood History-E2E", "Adrenal nodule", "Incidental adrenal nodule on CT.")
    s.call("POST", f"/api/me/practice/referrals/{rid}/disposition", "physician", {"decision": "accept"})
    history.append(rid)
    # Shadow began eight days ago (dev-only: the e2e database has no real elapsed time).
    s.workflow_store_execute("UPDATE agent_lifecycle SET shadow_at = ? WHERE practice_id = ?",
                             ((datetime.now(UTC) - timedelta(days=8)).isoformat(timespec="seconds"), practice_a["id"]))
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
        "referrals": r, "practice_b_referrals": b, "practice_proposal_id": proposal["id"], "history": history,
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

    store = PilotStore(workflow=WorkflowStore(url=e2e_url()))
    state = json.loads(STATE.read_text(encoding="utf-8"))
    users = _accounts()
    second = users["second_physician"]
    with store._connect() as db:
        if name == "join-second-physician":
            # Moves the SEEDED second physician between the two practices for the specs that need
            # them in practice A (spec 15 covers the real invite -> join flow with a new account).
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


def new_missing_referral() -> None:
    """Staff enter a referral with a required item missing; triage runs and, when auto-drafting
    is on, the agent drafts the request in the staff queue. The id is added to seed.json."""
    guard()
    s = Seeder(_accounts())
    state = json.loads(STATE.read_text(encoding="utf-8"))
    count = sum(1 for key in state["referrals"] if key.startswith("auto_draft"))
    rid = s.referral("staff", f"Ada AutoDraft{count + 1}-E2E", "Thyroid nodule", "1.6 cm thyroid nodule; please evaluate.",
                     [THYROID_ITEMS[1]])  # the ultrasound is missing
    state["referrals"]["auto_draft" if not count else f"auto_draft_{count + 1}"] = rid
    STATE.write_text(json.dumps(state, indent=1), encoding="utf-8")
    print("step new-missing-referral: done")


def new_unverified_referral() -> None:
    """Screens only: a referral where the office sent one required item (received, not yet
    verified) and another is still missing -- the staff "Ready" check lists them separately."""
    guard()
    s = Seeder(_accounts())
    state = json.loads(STATE.read_text(encoding="utf-8"))
    rid = s.referral("staff", "Uma Unverified-E2E", "Diabetes management", "Type 2 diabetes not at goal.")
    token = s.send_request("staff", rid)
    s.call("POST", f"/api/public/r/{token}/response", None,
           {"items": [{"key": "renal_function", "value": "eGFR 79 (E2E)", "observed_date": RECENT}]})
    state["referrals"]["unverified"] = rid
    STATE.write_text(json.dumps(state, indent=1), encoding="utf-8")
    print("step new-unverified-referral: done")


def flag_auto_draft_three_times() -> None:
    """Screens only: three non-serious "this was wrong" flags (by staff) on the agent's drafted
    request return drafting to shadow; each must then be resolved with a note."""
    guard()
    s = Seeder(_accounts())
    state = json.loads(STATE.read_text(encoding="utf-8"))
    detail = s.call("GET", f"/api/me/practice/referrals/{state['referrals']['auto_draft']}", "staff")
    item = next(iter(detail["agent_items"].values()))["item_id"]
    for n in range(3):
        s.call("POST", f"/api/me/practice/activation/items/{item}/flag", "staff", {"note": f"Asked for the wrong item ({n + 1}, E2E)"})
    print("step flag-auto-draft-three-times: done")


def resolve_auto_draft_flags() -> None:
    """Screens only: the physician resolves (with a note) every open flag on drafting, so a later
    viewport's screenshots start from the same state (one database serves all three viewports)."""
    guard()
    s = Seeder(_accounts())
    review = s.call("GET", "/api/me/practice/activation", "physician")
    for cap in review.get("capabilities", []):
        for flag in cap.get("flags", []):
            if not flag.get("resolved_at") and (flag.get("serious") or flag.get("blocking")):
                s.call("POST", f"/api/me/practice/activation/flags/{flag['id']}/resolve", "physician",
                       {"note": "Reviewed for the screenshot run (E2E)."})
    print("step resolve-auto-draft-flags: done")


def approve_invited_physician() -> None:
    """The Lamina operator approves the pilot request of the physician who joined by invitation in
    spec 15 (a dev-test account), through the real internal approval API."""
    guard()
    s = Seeder(_accounts())
    pending = s.call("GET", "/api/internal/pilot-physicians?status=pending", "operator")
    invited = [row for row in pending if str(row["auth_user_id"]).startswith("devtest-")]
    if not invited:
        sys.exit("No invited physician is waiting for approval")
    for row in invited:
        s.call("POST", f"/api/internal/pilot-physicians/{row['owner_scope_id']}/approve", "operator")
    print(f"step approve-invited-physician: approved {len(invited)}")


def set_auto_draft(state_name: str) -> None:
    guard()
    s = Seeder(_accounts())
    s.call("PUT", "/api/me/practice/activation/capabilities/auto_draft_requests", "physician",
           {"state": state_name, "confirm": state_name == "active"})
    print(f"step auto-draft-{state_name}: done")


SEEDER_STEPS = {
    "shadow-second-physician": lambda: shadow_second(),
    "new-missing-referral": lambda: new_missing_referral(),
    "activate-auto-draft": lambda: set_auto_draft("active"),
    "shadow-auto-draft": lambda: set_auto_draft("shadow"),
    "approve-invited-physician": lambda: approve_invited_physician(),
    "new-unverified-referral": lambda: new_unverified_referral(),
    "flag-auto-draft-three-times": lambda: flag_auto_draft_three_times(),
    "resolve-auto-draft-flags": lambda: resolve_auto_draft_flags(),
}


def inspect(what: str, referral_id: str) -> None:
    guard()
    from backend.pilot.store import PilotStore
    from backend.workflow import WorkflowStore

    store = PilotStore(workflow=WorkflowStore(url=e2e_url()))
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
    elif what == "account-events":
        # Audit trail for the access specs: event types and actors' kinds only (no ids, no secrets).
        rows = store.fetch_all("SELECT event_type, actor, metadata_json FROM pilot_events WHERE practice_id = ? "
                               "OR (practice_id IS NULL AND actor LIKE 'user:devtest-%') ORDER BY id", (practice,))
        out = [{"type": row["event_type"], "by_invitee": row["actor"].startswith("user:devtest-"),
                "role": json.loads(row["metadata_json"] or "{}").get("role")} for row in rows]
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
        SEEDER_STEPS[argv[1]]() if argv[1] in SEEDER_STEPS else step(argv[1])
    elif argv[0] == "inspect" and len(argv) == 3:
        inspect(argv[1], argv[2])
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
