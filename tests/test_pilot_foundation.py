"""Pilot foundation: mode separation, onboarding → practice → membership, intake
referrals, triage, decisions, the canonical rule store, and append-only events.

Offline and deterministic: NPPES is a fake transport, Supabase a fake verifier,
and documents go to a temporary directory.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.api import physician_onboarding as onboarding_api
from backend.auth import get_token_verifier
from backend.main import create_app
from backend.physician_onboarding import LookupThrottle, PhysicianOnboardingService
from backend.pilot import api as pilot_api
from backend.pilot.documents import LocalDocumentStorage
from backend.pilot.intake import ALLOWED_TRANSITIONS, IntakeService, can_transition
from backend.pilot.mode import product_mode
from backend.pilot.models import IntakeReferral, IntakeStatus, PracticeRuleInput
from backend.pilot.rules import PracticeRules
from backend.pilot.store import PilotStore
from backend.pilot.triage import DocumentText, EvidenceProposal, triage_referral
from backend.provider_network.identity import NppesIdentityResolver
from backend.workflow import WorkflowStore
from tests.test_pilot_onboarding import NPI_A, NPI_B, FakeTransport, FakeVerifier, _h

TODAY = date(2026, 11, 9)
RECENT = (TODAY - timedelta(days=30)).isoformat()
STALE = (TODAY - timedelta(days=400)).isoformat()

DIABETES_RULE = {
    "referral_type": "Diabetes management",
    "good_fit": ["type 2 diabetes not at goal", "insulin titration"],
    "outside_scope": ["type 1 diabetes pump management"],
    "required": [
        {"key": "recent_a1c", "label": "Recent HbA1c", "required": True, "freshness_days": 180},
        {"key": "renal_function", "label": "Renal function", "required": True, "freshness_days": 365},
    ],
    "helpful": [{"key": "glucose_log", "label": "Glucose log", "required": False}],
    "urgent_signals": ["diabetic ketoacidosis"],
    "modality": "in_person",
}


class SearchTransport(FakeTransport):
    def search(self, query, specialty, location, limit):
        del specialty, location, limit
        last = query.split()[-1].casefold()
        hits = [record for record in self.records.values()
                if record["basic"]["last_name"].casefold().startswith(last)]
        return hits, len(hits)


class Pilot:
    def __init__(self, client: TestClient, store: PilotStore, workflow: WorkflowStore) -> None:
        self.client, self.store, self.workflow = client, store, workflow

    def get(self, path: str, user: str, **kwargs):
        return self.client.get(path, headers=_h(user), **kwargs)

    def post(self, path: str, user: str, body: dict | None = None, **kwargs):
        return self.client.post(path, headers=_h(user), json=body, **kwargs)

    def status(self, user: str) -> dict:
        response = self.get("/api/me/practice/status", user)
        assert response.status_code == 200, response.text
        return response.json()

    def confirm_physician(self, user: str, npi: str) -> None:
        assert self.post("/api/me/onboarding/npi/lookup", user, {"npi": npi}).status_code == 200
        assert self.post("/api/me/onboarding/identity/confirm", user, {"npi": npi}).status_code == 200

    def approve(self, user: str) -> None:
        scope = self.workflow.selected_physician_owner_scope(user)
        response = self.post(f"/api/internal/pilot-physicians/{scope['id']}/approve", "admin")
        assert response.status_code == 200, response.text

    def create_practice(self, user: str, name: str = "Smith Endocrinology") -> dict:
        response = self.post("/api/me/practice", user, {"name": name, "specialty": "Endocrinology"})
        assert response.status_code == 201, response.text
        return response.json()

    def ready_physician(self, user: str = "user-a", npi: str = NPI_A) -> dict:
        self.confirm_physician(user, npi)
        practice = self.create_practice(user)
        self.approve(user)
        return practice

    def add_rule(self, user: str = "user-a", rule: dict | None = None) -> dict:
        response = self.post("/api/me/practice/rules", user, rule or DIABETES_RULE)
        assert response.status_code == 201, response.text
        return response.json()

    def add_staff(self, physician: str = "user-a", staff: str = "user-c") -> None:
        invite = self.post("/api/me/practice/invitations", physician, {"label": "Front desk"})
        assert invite.status_code == 201, invite.text
        accepted = self.post("/api/me/practice/invitations/accept", staff, {"token": invite.json()["token"]})
        assert accepted.status_code == 200, accepted.text

    def referral(self, user: str = "user-a", **overrides) -> dict:
        body = {
            "sender": {"name": "Dr. Pat Rivera", "practice": "Rivera Family Medicine",
                       "contact": "fax 555-0100"},
            "patient": {"name": "Alex Example", "date_of_birth": "1970-01-02"},
            "referral_type": "Diabetes management",
            "reason": "Type 2 diabetes not at goal despite metformin and glipizide",
            "submitted_items": [],
            **overrides,
        }
        response = self.post("/api/me/practice/referrals", user, body)
        assert response.status_code == 201, response.text
        return response.json()


@pytest.fixture
def pilot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workflow = WorkflowStore(tmp_path / "workflow.sqlite")
    transport = SearchTransport()
    service = PhysicianOnboardingService(
        workflow, NppesIdentityResolver(transport, cache_seconds=0), LookupThrottle(limit=1000),
        search_transport=transport,
    )
    monkeypatch.setattr(onboarding_api, "onboarding_service", service)
    monkeypatch.setenv("LAMINA_PILOT_ADMIN_USER_IDS", "admin")
    store = PilotStore(workflow=workflow)
    intake = IntakeService(store, storage=LocalDocumentStorage(tmp_path / "docs"), extractor=None, today=TODAY)
    services = pilot_api.PilotServices.build(store, intake)
    app = create_app("pilot")
    app.dependency_overrides[get_token_verifier] = lambda: FakeVerifier()
    app.dependency_overrides[pilot_api.get_pilot_services] = lambda: services
    yield Pilot(TestClient(app), store, workflow)


def _event_types(store: PilotStore, **filters) -> list[str]:
    return [event["event_type"] for event in store.events(**filters)]


# ------------------------------------------------------------------ mode separation


def test_product_mode_defaults_to_demo_and_rejects_unknown_values() -> None:
    assert product_mode("") == "demo"
    assert product_mode("PILOT") == "pilot"
    with pytest.raises(RuntimeError):
        product_mode("production")


def test_pilot_mode_exposes_no_demo_routes(pilot: Pilot) -> None:
    paths = set(create_app("pilot").openapi()["paths"])
    assert all(
        path.startswith(("/api/me/onboarding", "/api/me/practice", "/api/internal/pilot-physicians"))
        or path == "/health"
        for path in paths
    ), paths
    for demo_path in (
        "/api/patients", "/api/patients/patient-ckd-htn-001", "/api/workspace/activity",
        "/api/workspace/specialist", "/api/workspace/physician/chen/referral-preferences",
        "/api/network/feed", "/api/providers/search?q=chen", "/api/me/physician/profile",
        "/api/physicians/physician-chen/referrals",
    ):
        assert pilot.client.get(demo_path, headers=_h("user-a")).status_code == 404, demo_path
    health = pilot.client.get("/health").json()
    assert health["product_mode"] == "pilot" and health["data_mode"] == "pilot"


def test_demo_mode_still_serves_the_synthetic_demo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from backend.api import consult as consult_api
    from backend.fhir import SyntheticClinicalDataSource

    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", WorkflowStore(tmp_path / "demo.sqlite"))
    client = TestClient(create_app("demo"))
    assert client.get("/health").json() == {"status": "ok", "data_mode": "synthetic"}
    patients = client.get("/api/patients")
    assert patients.status_code == 200
    assert {"patient-ckd-htn-001", "patient-ida-002"} <= {patient["id"] for patient in patients.json()}
    assert all(patient["synthetic"] is True for patient in patients.json())
    assert "/api/me/practice/status" not in create_app("demo").openapi()["paths"]


def test_pilot_package_never_imports_demo_fixtures_or_personas() -> None:
    """Static guard: no pilot module imports demo/synthetic modules or names a demo persona."""
    import ast

    forbidden_modules = (
        "backend.synthetic_data", "backend.demo_identity", "backend.demo_workspace",
        "backend.fhir", "backend.clinical", "backend.engagement", "backend.referral_preferences",
        "backend.referrals", "backend.agents", "backend.specialist_projection",
        "backend.physician_sandbox", "backend.eval_harness",
    )
    forbidden_names = {"PERSONAS", "DEMO_PATIENTS", "LUCY_AGENT_ID", "EDITABLE_PERSONAS"}
    forbidden_literals = ("physician-chen", "physician-jung", "patient-ckd", "patient-ida", "lucy", "iain")
    package = Path(__file__).resolve().parents[1] / "backend" / "pilot"
    for path in package.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert not node.module.startswith(forbidden_modules), (path.name, node.module)
                assert not {alias.name for alias in node.names} & forbidden_names, path.name
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    assert not alias.name.startswith(forbidden_modules), (path.name, alias.name)
            elif isinstance(node, ast.Name):
                assert node.id not in forbidden_names, (path.name, node.id)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                lowered = node.value.casefold()
                assert not any(literal in lowered.split() or literal in lowered.split("-")
                               or lowered == literal for literal in forbidden_literals), (path.name, node.value)
                assert "physician-chen" not in lowered and "patient-ckd" not in lowered, path.name


def test_pilot_scope_never_returns_demo_fixture_data(pilot: Pilot) -> None:
    pilot.ready_physician()
    # A brand-new practice has nothing: no seeded referrals, rules, or patients.
    assert pilot.get("/api/me/practice/referrals", "user-a").json() == []
    assert pilot.get("/api/me/practice/rules", "user-a").json() == []
    # A demo persona's CONFIRMED preference in the same canonical table never leaks in.
    now = datetime.now(UTC).isoformat()
    with sqlite3.connect(pilot.store.path) as db:
        db.execute(
            "INSERT INTO physician_referral_preferences (id, workspace_id, physician_id, case_family, "
            "source_text, structured_rules_json, status, source, created_at, updated_at, confirmed_at) "
            "VALUES ('demo-pref', 'demo-workspace-x', 'physician-chen', 'type_2_diabetes', 'Need A1c', ?, "
            "'confirmed', 'migrated_fixture', ?, ?, ?)",
            (json.dumps({"required": [{"key": "recent_hba1c", "label": "Recent HbA1c",
                                       "required": True}]}), now, now, now),
        )
    detail = pilot.referral(referral_type="type_2_diabetes")
    recommendation = detail["recommendation"]
    assert recommendation["fit"] == "unknown"
    assert recommendation["requirements"] == []
    assert json.loads(json.dumps(detail["rules_snapshot"])) == {"rules": []}
    # A demo patient id cannot be resolved through any pilot route.
    assert pilot.get("/api/me/practice/referrals/patient-ckd-htn-001", "user-a").status_code == 404


# --------------------------------------------------------- onboarding / identity


def test_name_search_returns_candidates_without_creating_ownership(pilot: Pilot) -> None:
    response = pilot.post("/api/me/onboarding/npi/search", "user-a", {"name": "Jane Smith"})
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert [result["identity"]["npi"] for result in results] == [NPI_A]
    assert results[0]["claim_available"] is True
    assert pilot.workflow.provider_claims("user-a") == []
    assert pilot.status("user-a")["next_step"] == "physician_onboarding"
    assert pilot.post("/api/me/onboarding/npi/search", "user-a", {"name": "1234567893"}).status_code == 409


def test_real_user_resolves_owner_scope_then_practice_setup(pilot: Pilot) -> None:
    assert pilot.status("user-a")["next_step"] == "physician_onboarding"
    pilot.confirm_physician("user-a", NPI_A)
    status = pilot.status("user-a")
    assert status["next_step"] == "practice_setup"
    assert status["physician_onboarding"]["status"] == "pilot_approval_pending"
    assert status["practice_defaults"]["specialty"] == "Nephrology"
    assert "Palo Alto" in status["practice_defaults"]["address"]
    scope = pilot.workflow.selected_physician_owner_scope("user-a")
    assert scope and scope["npi"] == NPI_A
    assert "physician_claimed_profile" in _event_types(pilot.store, actor="user:user-a")


def test_duplicate_physician_claim_is_refused_with_a_stable_code(pilot: Pilot) -> None:
    pilot.confirm_physician("user-a", NPI_A)
    assert pilot.post("/api/me/onboarding/npi/lookup", "user-b", {"npi": NPI_A}).status_code == 200
    status = pilot.get("/api/me/onboarding/status", "user-b").json()
    assert status["selection"]["claim_available"] is False
    response = pilot.post("/api/me/onboarding/identity/confirm", "user-b", {"npi": NPI_A})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "npi_already_claimed"
    assert pilot.post("/api/me/onboarding/npi/search", "user-b", {"name": "Smith"}).json()[
        "results"][0]["claim_available"] is False
    assert pilot.workflow.provider_claims("user-b") == []


def test_pilot_approval_gates_the_workspace_not_practice_setup(pilot: Pilot) -> None:
    pilot.confirm_physician("user-a", NPI_A)
    pilot.create_practice("user-a")
    assert pilot.status("user-a")["next_step"] == "pilot_pending"
    blocked = pilot.get("/api/me/practice/referrals", "user-a")
    assert blocked.status_code == 403 and blocked.json()["detail"]["code"] == "pilot_access_pending"
    pilot.approve("user-a")
    assert pilot.status("user-a")["next_step"] == "workspace"
    assert pilot.get("/api/me/practice/referrals", "user-a").status_code == 200
    scope = pilot.workflow.selected_physician_owner_scope("user-a")
    assert pilot.post(f"/api/internal/pilot-physicians/{scope['id']}/disable", "admin").status_code == 200
    assert pilot.get("/api/me/practice/referrals", "user-a").status_code == 403
    assert pilot.status("user-a")["next_step"] == "unavailable"


def test_unconfirmed_account_cannot_create_a_practice(pilot: Pilot) -> None:
    response = pilot.post("/api/me/practice", "user-b", {"name": "No Identity Clinic"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "physician_profile_required"
    assert pilot.get("/api/me/practice/referrals", "user-b").json()["detail"]["code"] == "practice_required"


# ------------------------------------------------------------- practice / staff


def test_practice_creation_records_owner_membership_and_event(pilot: Pilot) -> None:
    practice = pilot.ready_physician()
    membership = pilot.store.membership_for_user("user-a")
    assert membership["role"] == "physician" and membership["practice_id"] == practice["id"]
    assert membership["physician_owner_scope_id"] == pilot.workflow.selected_physician_owner_scope("user-a")["id"]
    assert "practice_created" in _event_types(pilot.store, practice_id=practice["id"])
    duplicate = pilot.post("/api/me/practice", "user-a", {"name": "Second"})
    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "already_in_practice"


def test_staff_invitation_is_single_use_and_staff_permissions_are_limited(pilot: Pilot) -> None:
    pilot.ready_physician()
    invite = pilot.post("/api/me/practice/invitations", "user-a", {"label": "Front desk"}).json()
    preview = pilot.post("/api/me/practice/invitations/preview", "user-c", {"token": invite["token"]})
    assert preview.json()["practice_name"] == "Smith Endocrinology"
    joined = pilot.post("/api/me/practice/invitations/accept", "user-c", {"token": invite["token"]})
    assert joined.status_code == 200 and joined.json()["role"] == "staff"
    assert joined.json()["next_step"] == "workspace"
    reuse = pilot.post("/api/me/practice/invitations/accept", "user-b", {"token": invite["token"]})
    assert reuse.status_code == 404 and reuse.json()["detail"]["code"] == "invitation_unavailable"
    # Token is stored only as a hash.
    with sqlite3.connect(pilot.store.path) as db:
        assert invite["token"] not in json.dumps(db.execute("SELECT * FROM practice_invitations").fetchall())

    pilot.add_rule()
    detail = pilot.referral("user-c")  # Staff can do intake.
    referral_id = detail["referral"]["id"]
    assert pilot.post(f"/api/me/practice/referrals/{referral_id}/approve", "user-c").status_code == 200
    for method, path, body in (
        ("POST", "/api/me/practice/rules", DIABETES_RULE),
        ("POST", "/api/me/practice/invitations", {"label": "x"}),
        ("PUT", "/api/me/practice", {"name": "Renamed"}),
        ("POST", f"/api/me/practice/referrals/{referral_id}/disposition", {"decision": "accept"}),
        ("GET", "/api/me/practice/events", None),
    ):
        response = pilot.client.request(method, path, headers=_h("user-c"), json=body)
        assert response.status_code == 403, (path, response.text)
        assert response.json()["detail"]["code"] == "physician_required"
    assert {"staff_invited", "staff_joined"} <= set(_event_types(pilot.store))


def test_staff_inherit_the_practice_approval_gate(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_staff()
    scope = pilot.workflow.selected_physician_owner_scope("user-a")
    pilot.post(f"/api/internal/pilot-physicians/{scope['id']}/disable", "admin")
    response = pilot.get("/api/me/practice/referrals", "user-c")
    assert response.status_code == 403 and response.json()["detail"]["code"] == "practice_not_approved"
    assert pilot.status("user-c")["next_step"] == "practice_pending"


def test_confirmed_physician_cannot_join_as_staff_and_practices_are_isolated(pilot: Pilot) -> None:
    pilot.ready_physician("user-a", NPI_A)
    pilot.add_rule()
    referral_id = pilot.referral()["referral"]["id"]
    pilot.confirm_physician("user-b", NPI_B)
    invite = pilot.post("/api/me/practice/invitations", "user-a", {}).json()
    refused = pilot.post("/api/me/practice/invitations/accept", "user-b", {"token": invite["token"]})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "physician_account"
    pilot.create_practice("user-b", "Doe Cardiology")
    pilot.approve("user-b")
    assert pilot.get("/api/me/practice/referrals", "user-b").json() == []
    assert pilot.get(f"/api/me/practice/referrals/{referral_id}", "user-b").status_code == 404
    assert pilot.post(f"/api/me/practice/referrals/{referral_id}/approve", "user-b").status_code == 404


# ------------------------------------------------------------------- referrals


def test_inbound_referral_exists_without_a_clinical_data_source_patient(pilot: Pilot) -> None:
    pilot.ready_physician()
    detail = pilot.referral(received_at="2026-11-01T09:30:00+00:00")
    referral = detail["referral"]
    assert referral["patient"] == {"name": "Alex Example", "date_of_birth": "1970-01-02", "sex": None,
                                   "phone": None, "insurance": None, "external_id": None}
    assert referral["received_at"] == "2026-11-01T09:30:00+00:00"
    assert referral["entered_at"] >= referral["received_at"]
    assert referral["status"] == "triaged"
    assert referral["receiver_practice_id"] == referral["practice_id"]
    with sqlite3.connect(pilot.store.path) as db:
        token_hash = db.execute("SELECT sender_status_token_hash FROM intake_referrals").fetchone()[0]
    assert len(token_hash) == 64
    future = pilot.post("/api/me/practice/referrals", "user-a", {
        "sender": {"name": "x"}, "patient": {"name": "y"}, "referral_type": "t", "reason": "r",
        "received_at": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
    })
    assert future.status_code == 422


def test_status_machine_allows_only_specialist_transitions() -> None:
    S = IntakeStatus
    assert can_transition(S.RECEIVED, S.TRIAGED)
    assert can_transition(S.TRIAGED, S.NEEDS_INFORMATION)
    assert can_transition(S.NEEDS_INFORMATION, S.READY_FOR_REVIEW)
    assert can_transition(S.READY_FOR_REVIEW, S.ACCEPTED)
    for terminal in (S.ACCEPTED, S.REDIRECTED, S.DECLINED):
        assert ALLOWED_TRANSITIONS[terminal] == frozenset()
    assert not can_transition(S.RECEIVED, S.ACCEPTED)
    assert not can_transition(S.READY_FOR_REVIEW, S.TRIAGED)
    assert not can_transition(S.ACCEPTED, S.DECLINED)


def test_invalid_transitions_fail_through_the_api(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()
    referral_id = pilot.referral()["referral"]["id"]
    base = f"/api/me/practice/referrals/{referral_id}"
    declined = pilot.post(f"{base}/disposition", "user-a", {"decision": "decline", "reason": "Out of area"})
    assert declined.status_code == 200 and declined.json()["referral"]["status"] == "declined"
    for path, body in (
        (f"{base}/disposition", {"decision": "accept"}),
        (f"{base}/request-information", {"items": ["Recent HbA1c"]}),
        (f"{base}/escalate", {}),
        (f"{base}/triage", None),
    ):
        response = pilot.post(path, "user-a", body)
        assert response.status_code == 409, (path, response.text)
    assert pilot.post(f"{base}/disposition", "user-a", {
        "decision": "redirect", "reason": "x", "redirect_to": "Nephrology"}).status_code == 409
    assert "referral_declined" in _event_types(pilot.store, referral_id=referral_id)


# ---------------------------------------------------------------------- triage


def test_recommendation_persists_with_provenance_and_recoverable_rule_version(pilot: Pilot) -> None:
    pilot.ready_physician()
    rule = pilot.add_rule()
    detail = pilot.referral(submitted_items=[
        {"key": "recent_a1c", "value": "8.9%", "observed_date": RECENT},
    ])
    recommendation = detail["recommendation"]
    assert recommendation["fit"] == "strong"
    assert recommendation["readiness"] == "missing_information"
    assert recommendation["missing_items"] == ["Renal function"]
    assert recommendation["next_step"] == "request_information"
    assert recommendation["suggested_modality"] == "in_person"
    assert recommendation["generator"] == "deterministic" and recommendation["model_id"] is None
    fit_reason = next(item for item in recommendation["rationale"] if "fit criterion" in item["statement"])
    assert fit_reason["source"] == {**fit_reason["source"], "kind": "practice_rule",
                                    "rule_id": rule["id"], "rule_version": 1}
    a1c = next(item for item in recommendation["requirements"] if item["key"] == "recent_a1c")
    assert a1c["state"] == "satisfied" and a1c["evidence"]["kind"] == "submitted_item"

    # Revise the rule: the recommendation still cites the exact earlier version.
    revised = pilot.client.put(
        f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"),
        json={**DIABETES_RULE, "required": DIABETES_RULE["required"][:1]},
    ).json()
    assert revised["version"] == 2 and revised["supersedes_id"] == rule["id"]
    persisted = pilot.store.recommendation_row(detail["referral"]["practice_id"], recommendation["id"])
    snapshot = json.loads(persisted["rules_snapshot_json"])
    assert snapshot["rules"][0]["rule_id"] == rule["id"] and snapshot["rules"][0]["version"] == 1
    assert len(snapshot["rules"][0]["content"]["required"]) == 2
    history = pilot.get(f"/api/me/practice/rules/{revised['id']}/history", "user-a").json()
    assert [(item["version"], item["operational_status"]) for item in history] == [
        (1, "superseded"), (2, "confirmed"),
    ]
    with sqlite3.connect(pilot.store.path) as db, pytest.raises(sqlite3.DatabaseError):
        db.execute("UPDATE physician_referral_preferences SET structured_rules_json='{}' WHERE id=?",
                   (rule["id"],))
    with sqlite3.connect(pilot.store.path) as db, pytest.raises(sqlite3.DatabaseError):
        db.execute("UPDATE triage_recommendations SET generator='x'")


def _referral_model(**overrides) -> IntakeReferral:
    base = {
        "id": "ref_test", "practice_id": "prc_test", "source": "manual", "status": "received",
        "sender": {"name": "Dr. R"}, "receiver_practice_id": "prc_test", "patient": {"name": "P"},
        "referral_type": "Diabetes management", "reason": "Type 2 diabetes not at goal",
        "received_at": "2026-11-01T00:00:00+00:00", "entered_at": "2026-11-01T00:00:00+00:00",
        "entered_by": "user:x", "created_at": "2026-11-01T00:00:00+00:00",
        "updated_at": "2026-11-01T00:00:00+00:00",
    }
    return IntakeReferral.model_validate({**base, **overrides})


def _rules(tmp_path: Path) -> list:
    store = PilotStore(tmp_path / "rules.sqlite")
    rules = PracticeRules(store)
    rules.create("prc_test", "phys", PracticeRuleInput.model_validate(DIABETES_RULE), actor="user:x")
    return rules.operational("prc_test", "  diabetes MANAGEMENT ")


def test_unknown_never_auto_satisfies_a_requirement(tmp_path: Path) -> None:
    rules = _rules(tmp_path)
    document = DocumentText("doc_1", "notes.txt", ["Labs: Recent HbA1c 9.1% drawn last month."])

    class LyingExtractor:
        model_id = "fake-model"

        def propose(self, requirements, documents):
            return [
                # Not on the page: must be dropped.
                EvidenceProposal("renal_function", "doc_1", 1, "eGFR 55 mL/min"),
                # Unknown key and bad page: dropped.
                EvidenceProposal("made_up", "doc_1", 1, "Recent HbA1c 9.1%"),
                EvidenceProposal("glucose_log", "doc_1", 9, "Recent HbA1c"),
            ]

    recommendation, _ = triage_referral(
        _referral_model(submitted_items=[
            {"key": "renal_function", "value": "Cr 1.1", "observed_date": STALE},
        ]),
        rules, [document], today=TODAY, extractor=LyingExtractor(),
    )
    states = {item.key: item.state for item in recommendation.requirements}
    assert states["recent_a1c"] == "proposed_from_document"  # Found, but never "satisfied".
    assert states["renal_function"] == "missing"  # Stale value + hallucinated quote.
    assert states["glucose_log"] == "optional_missing"
    assert recommendation.readiness == "missing_information"
    assert recommendation.next_step == "confirm_document_evidence"
    assert recommendation.generator == "deterministic+llm_extraction"
    assert recommendation.model_id == "fake-model"
    a1c = next(item for item in recommendation.requirements if item.key == "recent_a1c")
    assert a1c.evidence.document_id == "doc_1" and a1c.evidence.page == 1
    assert "HbA1c" in a1c.evidence.quote

    no_rules, snapshot = triage_referral(_referral_model(), [], [document], today=TODAY)
    assert no_rules.fit == "unknown" and no_rules.readiness == "unknown"
    assert no_rules.requires_physician is True and snapshot == {"rules": []}

    def failing(*_args, **_kwargs):
        raise RuntimeError("provider down")

    class Broken:
        model_id = "broken"
        propose = staticmethod(failing)

    degraded, _ = triage_referral(_referral_model(), rules, [document], today=TODAY, extractor=Broken())
    assert {item.key: item.state for item in degraded.requirements}["renal_function"] == "missing"


def test_fit_priority_and_outside_scope_are_rule_driven(tmp_path: Path) -> None:
    rules = _rules(tmp_path)
    outside, _ = triage_referral(
        _referral_model(reason="Type 1 diabetes pump management question"), rules, [], today=TODAY
    )
    assert outside.fit == "outside_scope" and outside.next_step == "consider_redirect"
    assert outside.requires_physician is True
    urgent, _ = triage_referral(
        _referral_model(reason="Recent diabetic ketoacidosis admission"), rules, [], today=TODAY
    )
    assert urgent.suggested_priority == "urgent" and urgent.requires_physician
    sender_urgent, _ = triage_referral(_referral_model(sender_priority="urgent"), rules, [], today=TODAY)
    assert sender_urgent.suggested_priority == "urgent"
    unclear, _ = triage_referral(_referral_model(reason="Please see"), rules, [], today=TODAY)
    assert unclear.fit == "possible" and unclear.requires_physician


def test_decisions_accepted_edited_rejected_persist_and_are_immutable(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()

    approved = pilot.referral()
    rid = approved["referral"]["id"]
    after = pilot.post(f"/api/me/practice/referrals/{rid}/approve", "user-a").json()
    assert after["decision"]["decision"] == "accepted"
    assert after["referral"]["status"] == "needs_information"  # next_step was request_information
    again = pilot.post(f"/api/me/practice/referrals/{rid}/approve", "user-a")
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_decided"

    edited_id = pilot.referral()["referral"]["id"]
    no_change = pilot.post(f"/api/me/practice/referrals/{edited_id}/edit", "user-a", {"fit": "strong"})
    assert no_change.status_code == 422
    edited = pilot.post(f"/api/me/practice/referrals/{edited_id}/edit", "user-a", {
        "suggested_priority": "soon", "next_step": "physician_review", "reason": "Seen before; A1c rising",
    }).json()
    assert edited["decision"]["decision"] == "edited"
    assert edited["decision"]["changed_fields"] == {
        "next_step": {"from": "request_information", "to": "physician_review"},
        "suggested_priority": {"from": "routine", "to": "soon"},
    }
    assert edited["effective_triage"]["suggested_priority"] == "soon"
    assert edited["recommendation"]["suggested_priority"] == "routine"  # Original preserved.
    assert edited["referral"]["status"] == "ready_for_review"

    rejected_id = pilot.referral()["referral"]["id"]
    assert pilot.post(f"/api/me/practice/referrals/{rejected_id}/reject", "user-a", {}).status_code == 422
    rejected = pilot.post(f"/api/me/practice/referrals/{rejected_id}/reject", "user-a",
                          {"reason": "This is a thyroid question, not diabetes"}).json()
    assert rejected["decision"]["decision"] == "rejected"
    assert rejected["effective_triage"]["requires_physician"] is True
    assert rejected["referral"]["status"] == "ready_for_review"

    practice_id = approved["referral"]["practice_id"]
    decisions = [row["decision"] for rid_ in (rid, edited_id, rejected_id)
                 for row in pilot.store.decision_rows(practice_id, rid_)]
    assert decisions == ["accepted", "edited", "rejected"]
    with sqlite3.connect(pilot.store.path) as db, pytest.raises(sqlite3.DatabaseError):
        db.execute("DELETE FROM recommendation_decisions")
    types = _event_types(pilot.store, practice_id=practice_id)
    assert {"recommendation_accepted", "recommendation_edited", "recommendation_rejected"} <= set(types)


def test_missing_information_flow_reaches_ready_only_with_human_evidence(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()
    pilot.add_staff()
    rid = pilot.referral("user-c")["referral"]["id"]
    base = f"/api/me/practice/referrals/{rid}"
    requested = pilot.post(f"{base}/request-information", "user-c", {}).json()
    assert requested["referral"]["status"] == "needs_information"
    request = requested["referral"]["information_request"]
    assert request["items"] == ["Recent HbA1c", "Renal function"] and request["sent"] is False

    document = pilot.client.post(
        f"{base}/documents", headers={**_h("user-c"), "Content-Type": "text/plain",
                                      "X-Filename": "outside%20labs.txt"},
        content=b"Outside labs\nRecent HbA1c 8.7% on 2026-10-15\fRenal function: creatinine 1.0",
    )
    assert document.status_code == 201, document.text
    after_upload = document.json()
    doc = after_upload["referral"]["documents"][0]
    assert doc["filename"] == "outside labs.txt" and doc["extraction_status"] == "extracted"
    states = {item["key"]: item["state"] for item in after_upload["recommendation"]["requirements"]}
    assert states == {"recent_a1c": "proposed_from_document", "renal_function": "proposed_from_document",
                      "glucose_log": "optional_missing"}
    assert after_upload["referral"]["status"] == "needs_information"  # Proposals don't move status.

    pilot.post(f"{base}/items", "user-c", {"key": "recent_a1c", "value": "8.7%",
                                           "observed_date": "2026-10-15", "document_id": doc["id"], "page": 1})
    final = pilot.post(f"{base}/items", "user-c", {"key": "renal_function", "value": "Cr 1.0",
                                                   "observed_date": RECENT}).json()
    assert final["recommendation"]["readiness"] == "ready"
    assert final["referral"]["status"] == "ready_for_review"
    events = _event_types(pilot.store, referral_id=rid)
    for expected in ("referral_received", "referral_triaged", "recommendation_generated",
                     "missing_information_detected", "information_requested", "document_uploaded",
                     "referral_item_recorded", "referral_ready"):
        assert expected in events, expected
    ready_event = next(e for e in pilot.store.events(referral_id=rid) if e["event_type"] == "referral_ready")
    assert ready_event["autonomy"] == "automatic"

    accepted = pilot.post(f"{base}/disposition", "user-a", {"decision": "accept"}).json()
    assert accepted["referral"]["status"] == "accepted"
    assert "referral_accepted" in _event_types(pilot.store, referral_id=rid)


def test_documents_are_private_validated_and_practice_scoped(pilot: Pilot, tmp_path: Path) -> None:
    pilot.ready_physician()
    rid = pilot.referral()["referral"]["id"]
    upload = pilot.client.post(
        f"/api/me/practice/referrals/{rid}/documents",
        headers={**_h("user-a"), "Content-Type": "application/pdf", "X-Filename": "../../etc/fax.pdf"},
        content=b"%PDF-1.4 fake pdf body",
    ).json()
    doc = upload["referral"]["documents"][0]
    assert doc["filename"] == "fax.pdf" and doc["extraction_status"] == "unsupported"
    stored = [path for path in (tmp_path / "docs").rglob("*") if path.is_file()]
    assert len(stored) == 1 and "fax" not in stored[0].name
    download = pilot.get(f"/api/me/practice/documents/{doc['id']}", "user-a")
    assert download.status_code == 200 and download.content == b"%PDF-1.4 fake pdf body"
    assert download.headers["cache-control"] == "no-store, private"
    assert download.headers["content-disposition"].startswith("attachment")
    assert pilot.client.get(f"/api/me/practice/documents/{doc['id']}").status_code == 401
    spoofed = pilot.client.post(
        f"/api/me/practice/referrals/{rid}/documents",
        headers={**_h("user-a"), "Content-Type": "application/pdf"}, content=b"MZ\x90\x00 not a pdf",
    )
    assert spoofed.status_code == 422 and spoofed.json()["detail"]["code"] == "document_rejected"
    pilot.confirm_physician("user-b", NPI_B)
    pilot.create_practice("user-b", "Other")
    pilot.approve("user-b")
    assert pilot.get(f"/api/me/practice/documents/{doc['id']}", "user-b").status_code == 404
    assert "document_viewed" in _event_types(pilot.store, referral_id=rid)


# ---------------------------------------------------------------------- events


def test_pilot_events_are_append_only_and_queryable(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.status("user-a")
    pilot.status("user-a")
    assert _event_types(pilot.store, actor="user:user-a").count("physician_signed_in") == 1
    pilot.add_rule()
    events = pilot.get("/api/me/practice/events", "user-a").json()
    assert {"practice_created", "learning_confirmed", "physician_signed_in"} <= {e["event_type"] for e in events}
    only = pilot.get("/api/me/practice/events?event_type=learning_confirmed", "user-a").json()
    assert [event["event_type"] for event in only] == ["learning_confirmed"]
    with sqlite3.connect(pilot.store.path) as db:
        for statement in ("UPDATE pilot_events SET actor='x'", "DELETE FROM pilot_events"):
            with pytest.raises(sqlite3.DatabaseError):
                db.execute(statement)


def test_canonical_rule_store_backfills_and_syncs_legacy_rows(tmp_path: Path) -> None:
    workflow = WorkflowStore(tmp_path / "workflow.sqlite")
    now = datetime.now(UTC).isoformat()
    with sqlite3.connect(workflow.path) as db:
        db.execute(
            "INSERT INTO physician_referral_preferences (id, workspace_id, physician_id, case_family, "
            "source_text, structured_rules_json, status, source, created_at, updated_at) "
            "VALUES ('legacy-1', 'ws', 'physician-x', 'thyroid', 't', '{}', 'draft', 'physician_authored_nlp', ?, ?)",
            (now, now),
        )
        row = db.execute(
            "SELECT operational_status, physician_confirmed, referral_type, scope FROM physician_referral_preferences"
        ).fetchone()
        assert row == ("inferred", 0, "thyroid", "physician")
        db.execute("UPDATE physician_referral_preferences SET status='confirmed', confirmed_at=? "
                   "WHERE id='legacy-1'", (now,))
        assert db.execute("SELECT operational_status, physician_confirmed FROM physician_referral_preferences"
                          ).fetchone() == ("confirmed", 1)
        # Legacy rows stay editable in place, exactly as before.
        db.execute("UPDATE physician_referral_preferences SET structured_rules_json='{\"a\":1}'")
    # Re-opening the store (migration re-run) is idempotent.
    WorkflowStore(tmp_path / "workflow.sqlite")
