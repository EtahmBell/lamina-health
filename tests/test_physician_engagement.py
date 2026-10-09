from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.synthetic_data import MARIA_PATIENT_ID, PRIMARY_PATIENT_ID
from backend.workflow import WorkflowStore

IAIN_NPI = "9900000001"
CHEN_NPI = "9900000005"


@pytest.fixture
def engagement_store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(specialist_api, "workflow_store", store)
    monkeypatch.setattr(engagement_api, "workflow_store", store)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", store)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return store


def _url(path: str, perspective: str = "iain") -> str:
    return f"{path}?perspective={perspective}"


def _consult(client: TestClient, patient_id: str = PRIMARY_PATIENT_ID) -> dict:
    response = client.post(f"/api/patients/{patient_id}/consultations", json={})
    assert response.status_code == 200
    return response.json()


def _answer_and_finish(client: TestClient, question_id: str, answer) -> dict:
    session = client.post(_url("/api/workspace/physician/training/sessions")).json()
    response = client.put(
        _url(
            f"/api/workspace/physician/training/sessions/{session['id']}"
            f"/responses/{question_id}"
        ),
        json={"answer": answer},
    )
    assert response.status_code == 200
    finished = client.post(
        _url(f"/api/workspace/physician/training/sessions/{session['id']}/finish")
    )
    assert finished.status_code == 200
    return finished.json()


def test_lucy_and_iain_profiles_are_separate_and_provenance_bearing(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        lucy = client.get(_url("/api/workspace/physician/profile", "lucy")).json()
        iain = client.get(_url("/api/workspace/physician/profile", "iain")).json()
        representation = client.get(
            _url("/api/workspace/physician/agent-representation", "iain")
        ).json()
        lucy_training = client.get(
            _url("/api/workspace/physician/training", "lucy")
        ).json()

    assert lucy["physician"]["name"] == "Dr. Lucy Saruhashi"
    assert lucy["physician"]["specialty"] == "Primary Care"
    assert iain["physician"]["name"] == "Dr. Iain Jung"
    assert iain["physician"]["specialty"] == "Nephrology"
    assert {item["provenance"] for item in lucy["items"]} == {"synthetic_demo"}
    assert {item["provenance"] for item in iain["items"]} == {"synthetic_demo"}
    assert "CKD stage 3–4" in representation["sections"]["clinical_focus"]
    assert "Current basic metabolic panel (BMP)" in representation["sections"][
        "preferred_workup"
    ]
    assert representation["ranking_effect"] == "none"
    assert "ranking" in representation["completeness"]["meaning"]
    assert [question["id"] for question in lucy_training["questions"]] == [
        "lucy-progressive-ckd-routing",
        "lucy-ida-routing",
        "lucy-referral-context",
        "lucy-referral-priority",
        "lucy-workup-priority",
    ]


def test_profile_overlay_and_agent_draft_are_workspace_local(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        changed = visitor_a.put(
            _url("/api/workspace/physician/profile/items/iain-about"),
            json={
                "category": "about",
                "title": "Nephrologist focused on practical CKD referral guidance.",
                "detail": "Synthetic interview edit",
                "shareable": True,
            },
        )
        assert changed.status_code == 200
        assert changed.json()["profile_item"]["provenance"] == "physician_entered"
        assert changed.json()["draft_update"]["status"] == "draft"
        assert changed.json()["draft_update"]["agent_drafted"] is True

        profile_a = visitor_a.get(_url("/api/workspace/physician/profile")).json()
        profile_b = visitor_b.get(_url("/api/workspace/physician/profile")).json()
        updates_b = visitor_b.get(_url("/api/workspace/physician/updates")).json()

    assert next(item for item in profile_a["items"] if item["id"] == "iain-about")[
        "title"
    ].endswith("guidance.")
    assert next(item for item in profile_b["items"] if item["id"] == "iain-about")[
        "title"
    ] == "Nephrologist focused on hypertension and cardiorenal medicine."
    assert updates_b == []


def test_training_is_deterministic_skippable_and_requires_learning_review(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        training = client.get(_url("/api/workspace/physician/training")).json()
        assert [question["prompt"] for question in training["questions"]] == [
            "Do you see resistant hypertension when kidney function is still normal?",
            "For progressive CKD referrals, is a current UPCR required?",
            "Would you see this type of case: progressive stage 3b CKD with resistant hypertension?",
            "Which information is most useful before referral?",
        ]
        assert training["questions"][0]["source_type"] == "network_question"
        assert training["questions"][0]["asked_count"] == 3

        session = client.post(
            _url("/api/workspace/physician/training/sessions")
        ).json()
        answered = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                "/responses/iain-upcr-requirement"
            ),
            json={"answer": "Preferred"},
        )
        skipped = client.put(
            _url(
                f"/api/workspace/physician/training/sessions/{session['id']}"
                "/responses/iain-jordan-fit"
            ),
            json={"skipped": True},
        )
        assert answered.status_code == 200
        assert skipped.json()["skipped"] is True

        finished = client.post(
            _url(f"/api/workspace/physician/training/sessions/{session['id']}/finish")
        ).json()
        assert len(finished["proposed_learnings"]) == 1
        learning = finished["proposed_learnings"][0]
        assert learning["status"] == "suggested"

        before = client.get(
            _url("/api/workspace/physician/agent-representation")
        ).json()
        assert learning["statement"] not in [
            item.get("statement") for item in before["sections"]["confirmed_learnings"]
        ]
        assert any(
            item["id"] == learning["id"] for item in before["gaps"]["unconfirmed_rules"]
        )

        confirmed = client.put(
            _url(f"/api/workspace/physician/training/learnings/{learning['id']}"),
            json={"action": "confirm"},
        ).json()
        after = client.get(
            _url("/api/workspace/physician/agent-representation")
        ).json()

        second = _answer_and_finish(
            client, "iain-resistant-htn-normal-kidney", "Depends"
        )["proposed_learnings"][0]
        edited_learning = client.put(
            _url(f"/api/workspace/physician/training/learnings/{second['id']}"),
            json={"action": "edit", "statement": "Case-by-case after record review."},
        ).json()["learning"]
        rejected_learning = client.put(
            _url(f"/api/workspace/physician/training/learnings/{second['id']}"),
            json={"action": "reject"},
        ).json()["learning"]

    assert confirmed["learning"]["status"] == "confirmed"
    assert confirmed["draft_update"]["status"] == "draft"
    assert any(
        item["id"] == learning["id"] for item in after["sections"]["confirmed_learnings"]
    )
    assert edited_learning["status"] == "suggested"
    assert edited_learning["statement"] == "Case-by-case after record review."
    assert rejected_learning["status"] == "rejected"


def test_update_lifecycle_controls_publication_and_feed_visibility(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _consult(client)
        draft = client.post(
            _url("/api/workspace/physician/updates"),
            json={
                "type": "referral_guidance",
                "title": "Draft CKD guidance",
                "body": "A controlled synthetic update.",
            },
        ).json()
        assert draft["status"] == "draft"
        feed_before = client.get(_url("/api/workspace/network/feed", "lucy")).json()
        assert "Draft CKD guidance" not in {item["title"] for item in feed_before["items"]}

        edited = client.put(
            _url(f"/api/workspace/physician/updates/{draft['id']}"),
            json={
                "type": "referral_guidance",
                "title": "Published CKD guidance",
                "body": "Edited before explicit publication.",
            },
        ).json()
        assert edited["title"] == "Published CKD guidance"
        published = client.put(
            _url(f"/api/workspace/physician/updates/{draft['id']}/publish")
        ).json()
        assert published["status"] == "published"

        feed_published = client.get(_url("/api/workspace/network/feed", "lucy")).json()
        public_profile = client.get(
            "/api/workspace/network/physicians/iain/profile"
        ).json()
        assert "Published CKD guidance" in {
            item["title"] for item in feed_published["items"]
        }
        assert "Published CKD guidance" in {
            item["title"] for item in public_profile["published_updates"]
        }

        dismissed = client.put(
            _url(f"/api/workspace/physician/updates/{draft['id']}/dismiss")
        ).json()
        feed_after = client.get(_url("/api/workspace/network/feed", "lucy")).json()

    assert dismissed["status"] == "archived"
    assert dismissed["published_at"] == published["published_at"]
    assert "Published CKD guidance" not in {item["title"] for item in feed_after["items"]}


def test_feed_requires_membership_or_canonical_interaction(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        assert client.get(_url("/api/workspace/network/feed", "lucy")).json()["items"] == []

        client.post("/api/workspace/network/members", json={"npi": IAIN_NPI})
        member_feed = client.get(_url("/api/workspace/network/feed", "lucy")).json()
        assert {item["physician_persona"] for item in member_feed["items"]} == {"iain"}
        assert member_feed["items"][0]["relationship_basis"] == [
            "explicit_network_member"
        ]

        client.post("/api/workspace/network/members", json={"npi": CHEN_NPI})
        assert {item["physician_persona"] for item in client.get(
            _url("/api/workspace/network/feed", "lucy")
        ).json()["items"]} == {"iain"}

        _consult(client)
        jordan_feed = client.get(_url("/api/workspace/network/feed", "lucy")).json()
        assert {item["physician_persona"] for item in jordan_feed["items"]} == {
            "iain",
            "onadeko",
        }

        _consult(client, MARIA_PATIENT_ID)
        full_feed = client.get(_url("/api/workspace/network/feed", "lucy")).json()

    assert {item["physician_persona"] for item in full_feed["items"]} == {
        "iain",
        "onadeko",
        "sofia",
    }
    assert all(item["physician"]["synthetic"] for item in full_feed["items"])
    assert full_feed["ranking"] == "chronological_only"


def test_full_iain_engagement_loop_is_isolated_between_workspaces(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        _consult(visitor_a)
        visitor_a.put(
            _url("/api/workspace/physician/profile/items/iain-about"),
            json={"category": "about", "title": "Workspace A Iain profile"},
        )
        finished = _answer_and_finish(
            visitor_a, "iain-resistant-htn-normal-kidney", "Depends"
        )
        learning = finished["proposed_learnings"][0]
        confirmed = visitor_a.put(
            _url(f"/api/workspace/physician/training/learnings/{learning['id']}"),
            json={"action": "confirm"},
        ).json()
        update_id = confirmed["draft_update"]["id"]
        visitor_a.put(
            _url(f"/api/workspace/physician/updates/{update_id}/publish")
        )

        profile_b = visitor_b.get(_url("/api/workspace/physician/profile")).json()
        training_b = visitor_b.get(_url("/api/workspace/physician/training")).json()
        updates_b = visitor_b.get(_url("/api/workspace/physician/updates")).json()
        feed_b = visitor_b.get(_url("/api/workspace/network/feed", "lucy")).json()

    assert next(item for item in profile_b["items"] if item["id"] == "iain-about")[
        "title"
    ] == "Nephrologist focused on hypertension and cardiorenal medicine."
    assert all(question["status"] == "unanswered" for question in training_b["questions"])
    assert training_b["proposed_learnings"] == []
    assert updates_b == []
    assert feed_b["items"] == []


def test_engagement_does_not_change_clinical_recommendation(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        baseline = _consult(client)
        client.put(
            _url("/api/workspace/physician/profile/items/iain-publication"),
            json={
                "category": "publications",
                "title": "Synthetic CKD methods paper",
                "detail": "Professional context only",
            },
        )
        finished = _answer_and_finish(client, "iain-upcr-requirement", "Not required")
        client.put(
            _url(
                f"/api/workspace/physician/training/learnings/"
                f"{finished['proposed_learnings'][0]['id']}"
            ),
            json={"action": "confirm"},
        )
        for index in range(3):
            update = client.post(
                _url("/api/workspace/physician/updates"),
                json={
                    "type": "professional_update",
                    "title": f"Activity {index}",
                    "body": "Does not affect ranking.",
                },
            ).json()
            client.put(
                _url(f"/api/workspace/physician/updates/{update['id']}/publish")
            )
        after = _consult(client)

    for key in ("recommended_physician", "before_referral", "availability", "why"):
        assert after[key] == baseline[key]
    assert after["consultation"] == baseline["consultation"]


def test_perspective_and_public_profile_security_boundaries(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        assert client.get(
            "/api/workspace/physician/profile?npi=9900000001"
        ).status_code == 400
        assert client.get(
            "/api/workspace/physician/profile?perspective=onadeko"
        ).status_code == 404
        assert client.get(
            "/api/workspace/network/physicians/9900000001/profile"
        ).status_code == 404

        private = client.put(
            _url("/api/workspace/physician/profile/items/iain-private-note"),
            json={
                "category": "about",
                "title": "Private synthetic note",
                "shareable": False,
            },
        )
        assert private.status_code == 200
        public = client.get("/api/workspace/network/physicians/iain/profile").json()

    assert "Private synthetic note" not in {
        item["title"] for item in public["professional_profile"]["items"]
    }
    assert "training" not in public
    assert "gaps" not in public["practice_representation"]


def test_engagement_tables_are_additive(engagement_store: WorkflowStore) -> None:
    with sqlite3.connect(engagement_store.path) as database:
        tables = {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    assert {
        "physician_profile_items",
        "training_sessions",
        "training_responses",
        "proposed_agent_learnings",
        "practice_updates",
    } <= tables
    assert {"consultations", "provider_claims", "provider_agent_state"} <= tables

