"""Two physicians in one practice (run 2): Home, For you, Your Agent and the readiness review show
each physician their own corrections, conflicts, learnings and capability items -- and name the
other physician when an item is someone else's and practice-wide. Synthetic data only."""

from __future__ import annotations

import pytest

from tests.test_pilot_activation import COMPLETE
from tests.test_pilot_foundation import DIABETES_RULE, NPI_B, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h

DOC_B = "Dr. John Q Doe"  # NPPES name (with middle initial) in the test directory


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LAMINA_OPENAI_ENABLED", "false")


def _two_physicians(pilot: Pilot) -> dict:
    """user-a: admin (practice creator); user-b: joined by invitation (non-admin); user-c: staff."""
    pilot.ready_physician()
    rule = pilot.add_rule()
    pilot.add_staff()
    invite = pilot.post("/api/me/practice/invitations", "user-a", {"email": "user-b@example.test", "role": "physician"}).json()
    assert pilot.post("/api/me/practice/invitations/accept", "user-b", {"token": invite["token"]}).status_code == 200
    pilot.confirm_physician("user-b", NPI_B)
    pilot.approve("user-b")
    assert pilot.status("user-b")["next_step"] == "workspace"
    return rule


def _needs(pilot: Pilot, user: str) -> list[dict]:
    return pilot.get("/api/me/practice/home", user).json()["needs_you"]


def _conflict_referral(pilot: Pilot, rule: dict, corrected_by: str) -> tuple[str, dict]:
    """A correction by `corrected_by`, then the admin changes the practice rule it disagrees with."""
    rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
    assert pilot.post(f"/api/me/practice/referrals/{rid}/correct", corrected_by, {"suggested_modality": "econsult"}).status_code == 200
    v2 = pilot.client.put(f"/api/me/practice/rules/{rule['id']}", headers=_h("user-a"), json={**DIABETES_RULE, "modality": "either"})
    assert v2.status_code == 200, v2.text
    pilot.post(f"/api/me/practice/referrals/{rid}/triage", "user-a")
    return rid, v2.json()


def test_conflicts_are_worded_for_each_physician(pilot: Pilot) -> None:
    rule = _two_physicians(pilot)
    rid, _ = _conflict_referral(pilot, rule, corrected_by="user-b")
    mine = [item for item in _needs(pilot, "user-b") if item["kind"] == "correction_conflict"]
    assert [item["referral_id"] for item in mine] == [rid]
    assert mine[0]["title"] == "Alex Example: your correction differs from the newer practice Diabetes management rule"
    theirs = [item for item in _needs(pilot, "user-a") if item["kind"] == "correction_conflict"]
    assert theirs[0]["title"] == f"Alex Example: {DOC_B}’s correction differs from your newer Diabetes management rule"
    assert not [item for item in _needs(pilot, "user-c") if item["kind"] == "correction_conflict"], "staff never get it"


def test_a_physicians_own_correction_pattern_is_their_learning_only(pilot: Pilot) -> None:
    _two_physicians(pilot)
    for _ in range(2):
        rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/correct", "user-b", {"suggested_modality": "econsult"})
        assert pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-b", {"decision": "accept"}).status_code == 200
    # Dr. B's own question and learning ...
    question = next(item for item in _needs(pilot, "user-b") if item["kind"] == "learning_question")
    assert "changed Diabetes management referrals to eConsult 2 times" in question["title"]
    teach_b = pilot.get("/api/me/practice/teach", "user-b").json()
    own = [proposal for proposal in teach_b["proposals"] if proposal["mine"]]
    assert len(own) == 1 and own[0]["layer"] == "physician" and own[0]["can_confirm"] is True
    assert teach_b["question"]["id"] == question["question_id"]
    # ... never the admin's, the staff's, or anyone else's to answer.
    assert not [item for item in _needs(pilot, "user-a") if item["kind"] in {"learning_question", "proposed_learning"}]
    teach_a = pilot.get("/api/me/practice/teach", "user-a").json()
    assert own[0]["id"] not in {proposal["id"] for proposal in teach_a["proposals"]} and teach_a["question"] is None
    assert pilot.post(f"/api/me/practice/learning/questions/{question['question_id']}/answer", "user-a",
                      {"answer": "yes"}).status_code == 404
    # Dr. B confirms it: it becomes THEIR statement (physician layer), not the practice's.
    answered = pilot.post(f"/api/me/practice/learning/questions/{question['question_id']}/answer", "user-b", {"answer": "yes"})
    assert answered.status_code == 200, answered.text
    rules_b = pilot.get("/api/me/practice/rules", "user-b").json()
    assert any(rule["layer"] == "physician" and rule["content"]["modality"] == "econsult" for rule in rules_b)
    assert not any(rule["layer"] == "physician" for rule in pilot.get("/api/me/practice/rules", "user-a").json())


def test_practice_wide_learnings_go_to_admins_not_to_other_physicians(pilot: Pilot) -> None:
    _two_physicians(pilot)
    # Staff keep asking for the same extra item: a practice-wide pattern.
    for _ in range(2):
        rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/request-information", "user-c", {"items": ["Lipid panel"]})
        pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    assert any(item["kind"] == "learning_question" and "Lipid panel" in item["title"] for item in _needs(pilot, "user-a"))
    assert not any(item["kind"] in {"learning_question", "proposed_learning"} for item in _needs(pilot, "user-b"))
    # On Train the non-admin sees the practice-wide proposal read-only (an admin confirms it).
    proposals = pilot.get("/api/me/practice/teach", "user-b").json()["proposals"]
    practice_wide = [proposal for proposal in proposals if proposal["layer"] == "practice"]
    assert practice_wide and all(proposal["can_confirm"] is False for proposal in practice_wide)


def test_capability_items_and_readiness_are_each_physicians_own(pilot: Pilot) -> None:
    _two_physicians(pilot)
    for _ in range(2):
        rid = pilot.referral("user-c", submitted_items=COMPLETE)["referral"]["id"]
        pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    review_a = pilot.get("/api/me/practice/activation", "user-a").json()
    review_b = pilot.get("/api/me/practice/activation", "user-b").json()
    assert review_a["metrics"]["all_time"]["decided"] == 2
    assert review_b["metrics"]["all_time"]["decided"] == 0, "Dr. A's sign-offs never count toward Dr. B's review"
    assert review_b["summary"]["recommended"]["text"].startswith("Keep deciding referrals as usual")
    # Your Agent: each physician's own lifecycle (Dr. B is still in setup; Dr. A's rules are theirs).
    assert pilot.get("/api/me/practice/representation", "user-b").json()["lifecycle"]["state"] == "initializing"
    assert any(item["kind"] == "setup" for item in _needs(pilot, "user-b"))
    assert not any(item["kind"] == "setup" for item in _needs(pilot, "user-a"))


def test_someone_elses_items_name_their_author_never_your(pilot: Pilot) -> None:
    """Found in the run-2 screens: the referral page and Train said "your correction" / "your
    instruction" to a physician about another physician's. The API now says whose it is."""
    rule = _two_physicians(pilot)
    rid, _ = _conflict_referral(pilot, rule, corrected_by="user-a")
    conflict_for_b = pilot.get(f"/api/me/practice/referrals/{rid}", "user-b").json()["correction_conflicts"][0]
    assert conflict_for_b["corrected_by_you"] is False and conflict_for_b["rule_by_you"] is False
    assert conflict_for_b["corrected_by_name"] == conflict_for_b["rule_by_name"] != DOC_B
    conflict_for_a = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["correction_conflicts"][0]
    assert conflict_for_a["corrected_by_you"] is True and conflict_for_a["rule_by_you"] is True
    # The admin teaches a practice-wide statement: Dr. B sees it read-only, attributed to the admin.
    taught = pilot.post("/api/me/practice/teach", "user-a", {"text": "For Thyroid nodule referrals I need a TSH."})
    assert taught.status_code == 201, taught.text
    as_b = next(p for p in pilot.get("/api/me/practice/teach", "user-b").json()["proposals"] if p["id"] == taught.json()["id"])
    assert as_b["by_you"] is False and as_b["author_name"] == conflict_for_b["corrected_by_name"] and as_b["can_confirm"] is False
    as_a = next(p for p in pilot.get("/api/me/practice/teach", "user-a").json()["proposals"] if p["id"] == taught.json()["id"])
    assert as_a["by_you"] is True and as_a["author_name"] is None
