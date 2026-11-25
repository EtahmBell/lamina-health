"""The e2e seed command: refuses anything but the dedicated e2e database, and seeds two
isolated fictional practices through the real pilot API. Fictional user ids only."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import psycopg
import pytest

from backend.pilot.store import PilotStore
from backend.workflow import WorkflowStore
from scripts import e2e_seed
from tests.pg_support import _with_database, admin_url, test_db_mode

pytestmark = pytest.mark.skipif(test_db_mode() == "sqlite", reason="the e2e seed runs on Postgres (run 2)")


@pytest.fixture
def e2e_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Its own throwaway database on the local server: never the real `lamina_e2e`.
    name = f"lamina_e2e_test_{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(e2e_seed, "E2E_DATABASE", name)
    monkeypatch.setattr(e2e_seed, "E2E_DIR", tmp_path / "e2e")
    monkeypatch.setattr(e2e_seed, "ACCOUNTS", tmp_path / "auth" / "accounts.json")
    monkeypatch.setattr(e2e_seed, "STATE", tmp_path / "state" / "seed.json")
    for key, value in {"LAMINA_E2E": "1", "LAMINA_PRODUCT_MODE": "pilot", "LAMINA_DEV_FAKE_NPPES": "true",
                       "LAMINA_DATABASE_URL": _with_database(admin_url(), name), "LAMINA_TEST_DATABASE_URL": admin_url(),
                       "LAMINA_OPENAI_ENABLED": "false",
                       "LAMINA_PILOT_DOCUMENT_DIR": str(tmp_path / "docs"),
                       # The seeder sets this in-process; registering it here restores it afterwards.
                       "LAMINA_PILOT_ADMIN_USER_IDS": ""}.items():
        monkeypatch.setenv(key, value)
    from backend.api import physician_onboarding

    # The seeder swaps in a fictional-NPPES onboarding service; restore the original after.
    monkeypatch.setattr(physician_onboarding, "onboarding_service", physician_onboarding.onboarding_service)
    yield tmp_path
    with psycopg.connect(admin_url(), autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def test_refuses_any_database_but_the_e2e_one(e2e_paths: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    e2e_url = e2e_seed.e2e_url()
    monkeypatch.setenv("LAMINA_DATABASE_URL", _with_database(admin_url(), "lamina_dev"))  # not the e2e database
    with pytest.raises(SystemExit, match="Refusing"):
        e2e_seed.reset()
    monkeypatch.setenv("LAMINA_DATABASE_URL", e2e_url.replace("127.0.0.1", "db.example.com"))  # not loopback
    with pytest.raises(SystemExit, match="loopback"):
        e2e_seed.reset()
    monkeypatch.setenv("LAMINA_DATABASE_URL", e2e_url)
    monkeypatch.delenv("LAMINA_E2E")
    with pytest.raises(SystemExit, match="LAMINA_E2E"):
        e2e_seed.reset()


def test_without_captured_accounts_it_only_resets(e2e_paths: Path) -> None:
    e2e_seed.reset()
    assert json.loads(e2e_seed.STATE.read_text())["seeded"] is False


def test_seeds_two_isolated_fictional_practices(e2e_paths: Path) -> None:
    e2e_seed.ACCOUNTS.parent.mkdir(parents=True)
    e2e_seed.ACCOUNTS.write_text(json.dumps({role: {"user_id": f"e2e-{role}"} for role in e2e_seed.ROLES}))
    e2e_seed.reset()
    state = json.loads(e2e_seed.STATE.read_text())
    assert state["seeded"] and state["practice_a"]["physician_name"] == "Dr. Avery Testwell"
    store = PilotStore(workflow=WorkflowStore(url=e2e_seed.e2e_url()))
    a, b = state["practice_a"]["id"], state["practice_b"]["id"]
    names_a = {json.loads(row["patient_json"])["name"] for row in store.referral_rows(a)}
    names_b = {json.loads(row["patient_json"])["name"] for row in store.referral_rows(b)}
    assert len(names_a) == 11 + 12 and names_b == {"Ito Isolated-E2E", "Ives Isolated-E2E"}  # scenarios + shadow history
    assert all(name.endswith("-E2E") for name in names_a | names_b), "fictional, marked E2E"
    refs = state["referrals"]
    still_open = store.referral_row(a, refs["still_open"])
    assert still_open["status"] == "ready_for_review"
    assert store.referral_row(b, refs["verify"]) is None, "practice B can't read practice A rows"
    # Scenario preconditions the specs rely on.
    from backend.pilot.api import PilotServices
    services = PilotServices.build(store)
    physician = services.practice.context("e2e-physician")
    for key in ("conflict_keep", "conflict_apply"):
        assert len(services.intake.detail(physician, refs[key])["correction_conflicts"]) == 1
    declined = services.intake.detail(physician, refs["declined_notify"])
    assert declined["office_notification"]["state"] == "not_sent", "a decline the office hasn't been told about"
    change = services.intake.detail(physician, refs["change"])
    assert change["changes_since_seen"] == [], "the change happens in the spec, not the seed"
    assert services.practice.context("e2e-second_physician").practice_id == b
    # Steps move the second physician in and out of practice A.
    e2e_seed.step("join-second-physician")
    joined = services.practice.context("e2e-second_physician")
    assert joined.practice_id == a and not joined.is_admin
    e2e_seed.step("return-second-physician")
    assert services.practice.context("e2e-second_physician").is_admin
    # Shadow step: practice B gets a rule and a confirmed representation, so Home has nothing to ask.
    e2e_seed.shadow_second()
    home = e2e_seed.Seeder(e2e_seed._accounts()).call("GET", "/api/me/practice/home", "second_physician")
    assert home["needs_you"] == []
    # The screenshot run alternates initializing → shadow once per viewport; both repeat cleanly.
    for _ in range(2):
        e2e_seed.step("initializing-second-physician")
        lifecycle = services.representation.lifecycle(services.practice.context("e2e-second_physician"))
        assert lifecycle["state"] == "initializing"
        e2e_seed.shadow_second()
    rules_b = e2e_seed.Seeder(e2e_seed._accounts()).call("GET", "/api/me/practice/rules", "second_physician")
    assert [rule["referral_type"] for rule in rules_b] == ["Kidney stones"]
    # Step 18: physician A has enough shadow history to be eligible; physician B does not.
    drafting = services.activation.eligibility(a, services.practice.context("e2e-physician").owner_scope_id, "auto_draft_requests")
    assert drafting["eligible"], drafting["reasons"]
    assert "Adrenal nodule" in drafting["coverage"]["gaps"]
    b_owner = services.practice.context("e2e-second_physician").owner_scope_id
    assert not services.activation.eligibility(b, b_owner, "auto_draft_requests")["eligible"]
    # Steps: turn drafting on, then a referral with a missing item gets an agent-drafted request.
    e2e_seed.set_auto_draft("active")
    e2e_seed.new_missing_referral()
    rid = json.loads(e2e_seed.STATE.read_text())["referrals"]["auto_draft"]
    [request] = services.missing.for_referral(a, rid)
    assert request["status"] == "draft" and request["created_by"].startswith("agent:auto_draft:")
    e2e_seed.set_auto_draft("shadow")
    assert services.activation.state(a, services.practice.context("e2e-physician").owner_scope_id, "auto_draft_requests")["state"] == "shadow"
