"""The e2e seed command: refuses anything but the dedicated e2e database, and seeds two
isolated fictional practices through the real pilot API. Fictional user ids only."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.pilot.store import PilotStore
from backend.workflow import WorkflowStore
from scripts import e2e_seed


@pytest.fixture
def e2e_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db = tmp_path / "e2e" / "pilot-e2e.sqlite"
    monkeypatch.setattr(e2e_seed, "E2E_DIR", db.parent)
    monkeypatch.setattr(e2e_seed, "DB_PATH", db)
    monkeypatch.setattr(e2e_seed, "ACCOUNTS", tmp_path / "auth" / "accounts.json")
    monkeypatch.setattr(e2e_seed, "STATE", tmp_path / "state" / "seed.json")
    for key, value in {"LAMINA_E2E": "1", "LAMINA_PRODUCT_MODE": "pilot", "LAMINA_DEV_FAKE_NPPES": "true",
                       "LAMINA_WORKFLOW_DATABASE": str(db), "LAMINA_OPENAI_ENABLED": "false",
                       "LAMINA_PILOT_DOCUMENT_DIR": str(tmp_path / "docs"),
                       # The seeder sets this in-process; registering it here restores it afterwards.
                       "LAMINA_PILOT_ADMIN_USER_IDS": ""}.items():
        monkeypatch.setenv(key, value)
    from backend.api import physician_onboarding

    # The seeder swaps in a fictional-NPPES onboarding service; restore the original after.
    monkeypatch.setattr(physician_onboarding, "onboarding_service", physician_onboarding.onboarding_service)
    return tmp_path


def test_refuses_any_database_but_the_e2e_one(e2e_paths: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMINA_WORKFLOW_DATABASE", str(e2e_paths / "walkthrough.sqlite"))
    with pytest.raises(SystemExit, match="Refusing"):
        e2e_seed.reset()
    monkeypatch.setenv("LAMINA_WORKFLOW_DATABASE", str(e2e_seed.DB_PATH))
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
    store = PilotStore(workflow=WorkflowStore(e2e_seed.DB_PATH))
    a, b = state["practice_a"]["id"], state["practice_b"]["id"]
    names_a = {json.loads(row["patient_json"])["name"] for row in store.referral_rows(a)}
    names_b = {json.loads(row["patient_json"])["name"] for row in store.referral_rows(b)}
    assert len(names_a) == 11 and names_b == {"Ito Isolated-E2E", "Ives Isolated-E2E"}
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
