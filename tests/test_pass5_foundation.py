from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.professional_services import ProfileEnrichmentService
from backend.synthetic_data import MARIA_PATIENT_ID, PRIMARY_PATIENT_ID
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    for module in (
        consult_api,
        workspace_api,
        specialist_api,
        engagement_api,
        demo_workspace_module,
    ):
        monkeypatch.setattr(module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return value


def url(path: str, perspective: str = "iain") -> str:
    return f"{path}?perspective={perspective}"


def test_interests_are_structured_public_and_workspace_local(store: WorkflowStore) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        created = visitor_a.post(
            url("/api/workspace/physician/interests"),
            json={
                "interest_type": "case_interest",
                "title": "Rapid eGFR decline after hypertensive emergency",
                "confirmed": True,
                "shareable": True,
            },
        )
        assert created.status_code == 201
        representation = visitor_a.get(url("/api/workspace/physician/agent-representation")).json()
        public = visitor_a.get("/api/workspace/network/physicians/iain/profile").json()
        pristine = visitor_b.get(url("/api/workspace/physician/interests")).json()

    assert created.json() in representation["sections"]["interests"]
    assert created.json() in public["professional_profile"]["interests"]
    assert created.json() not in pristine
    assert "not acceptance rules" in representation["sections"]["interest_safety"]


def test_initialization_and_lazy_large_queue(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        projection = client.get(url("/api/workspace/physician/initialization")).json()
        queue = client.get(url("/api/workspace/physician/training")).json()
        session = client.post(
            url("/api/workspace/physician/training/sessions"),
            json={"mode": "initialization", "limit": 10},
        ).json()
        extended = client.post(
            url("/api/workspace/physician/training/sessions"),
            json={"mode": "extended", "limit": 25},
        ).json()

    assert projection["blocking"] is False
    assert "case_interests" in projection["initialized_sections"]
    assert queue["queue_summary"]["available_total"] > 100
    assert queue["queue_summary"]["availability_model"] == "lazy_grounded_sources"
    assert len(session["questions"]) == 10
    assert all(item["source_type"] == "initialization" for item in session["questions"])
    assert extended["id"] == session["id"]
    assert len(extended["questions"]) == 10


def test_depends_branch_persists_path_resumes_and_stops_at_boundary(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        session = client.post(url("/api/workspace/physician/training/sessions")).json()
        session_id = session["id"]

        first = client.put(
            url(
                f"/api/workspace/physician/training/sessions/{session_id}/responses/"
                "iain-resistant-htn-normal-kidney"
            ),
            json={"answer": "Depends"},
        ).json()
        assert first["next_question"]["id"] == "iain-branch-progressive-renal"

        second = client.put(
            url(
                f"/api/workspace/physician/training/sessions/{session_id}/responses/"
                "iain-branch-progressive-renal"
            ),
            json={"answer": "Yes"},
        ).json()
        assert second["next_question"]["branch_depth"] == 2

        third = client.put(
            url(
                f"/api/workspace/physician/training/sessions/{session_id}/responses/"
                "iain-branch-proteinuria-absence"
            ),
            json={"answer": "Depends"},
        ).json()
        leaf = third["next_question"]
        assert leaf["branch_depth"] == 3
        assert leaf["branch_path"][-1].endswith(":Depends")

        terminal = client.put(
            url(
                f"/api/workspace/physician/training/sessions/{session_id}/responses/"
                "iain-branch-declining-egfr-normal-upcr"
            ),
            json={"answer": "Yes"},
        ).json()
        assert terminal["next_question"] is None
        resumed = client.get(url(f"/api/workspace/physician/training/sessions/{session_id}")).json()
        finished = client.post(
            url(f"/api/workspace/physician/training/sessions/{session_id}/finish")
        ).json()

    assert len(resumed["responses"]) == 4
    assert max(item["branch_depth"] for item in resumed["questions"]) == 3
    assert any(
        "even without proteinuria" in item["statement"] and item["status"] == "suggested"
        for item in finished["proposed_learnings"]
    )


def test_enrichment_requires_review_and_stays_workspace_local(store: WorkflowStore) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        enriched = visitor_a.post(url("/api/workspace/physician/profile/enrich")).json()
        candidate = enriched["candidates"][0]
        before = visitor_a.get(url("/api/workspace/physician/profile")).json()
        assert not any(
            item["id"] == f"enrichment-{candidate['candidate_id']}" for item in before["items"]
        )

        reviewed = visitor_a.put(
            url(f"/api/workspace/physician/profile/enrichment/{candidate['candidate_id']}"),
            json={"action": "edit_confirm", "title": "Physician-corrected training fact"},
        ).json()
        confirmed = visitor_a.put(
            url(
                "/api/workspace/physician/profile/enrichment/"
                f"{enriched['candidates'][1]['candidate_id']}"
            ),
            json={"action": "confirm"},
        ).json()
        rejected = visitor_a.put(
            url(
                "/api/workspace/physician/profile/enrichment/"
                f"{enriched['candidates'][2]['candidate_id']}"
            ),
            json={"action": "reject"},
        ).json()
        pristine = visitor_b.get(url("/api/workspace/physician/profile/enrichment")).json()

    assert candidate["source_title"] == "Synthetic demo source"
    assert candidate["review_status"] == "suggested"
    assert reviewed["candidate"]["review_status"] == "edited"
    assert reviewed["profile_item"]["title"] == "Physician-corrected training fact"
    assert confirmed["candidate"]["review_status"] == "confirmed"
    assert confirmed["profile_item"] is not None
    assert rejected["candidate"]["review_status"] == "rejected"
    assert rejected["profile_item"] is None
    assert pristine["status"] == "idle"


def test_public_enrichment_rejects_ambiguous_identity() -> None:
    with pytest.raises(ValueError, match="Strong physician identity"):
        ProfileEnrichmentService().public_candidates(
            {"full_name": "Alex Smith", "specialty": "Medicine", "geography": "CA"}
        )


def test_posts_require_publish_and_case_posts_are_synthetic_only(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        # Touch a workspace first, then add Iain to Lucy's soft network.
        client.get(url("/api/workspace/physician/profile", "lucy"))
        workspace_id = client.cookies.get("lamina_demo_workspace")
        assert workspace_id
        store.add_network_member(workspace_id, "9900000001")

        drafted = client.post(
            url("/api/workspace/physician/posts/draft"),
            json={
                "type": "interesting_case",
                "case_origin": "synthetic_demo",
                "source_material": {
                    "title": "A cardiorenal decision boundary",
                    "summary": "A synthetic case about declining eGFR.",
                },
            },
        ).json()["post"]
        feed_before = client.get(url("/api/workspace/network/feed", "lucy")).json()
        rejected = client.post(
            url("/api/workspace/physician/posts/draft"),
            json={
                "type": "interesting_case",
                "case_origin": "real_patient",
                "source_material": {"text": "Do not use this record"},
            },
        )
        published = client.put(
            url(f"/api/workspace/physician/posts/{drafted['id']}/publish")
        ).json()
        feed_after = client.get(url("/api/workspace/network/feed", "lucy")).json()

    assert drafted["drafted_by"] == "lamina_agent"
    assert drafted["physician_approved"] is False
    assert drafted["synthetic_case"] is True
    assert rejected.status_code == 422
    assert all(item.get("id") != f"workspace-{drafted['id']}" for item in feed_before["items"])
    assert published["physician_approved"] is True
    assert any(item.get("id") == f"workspace-{drafted['id']}" for item in feed_after["items"])


def test_engagement_additions_do_not_change_jordan_or_maria(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        before_jordan = client.post(
            f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={}
        ).json()
        before_maria = client.post(
            f"/api/patients/{MARIA_PATIENT_ID}/consultations", json={}
        ).json()
        for index in range(6):
            client.post(
                url("/api/workspace/physician/interests"),
                json={
                    "interest_type": "case_interest",
                    "title": f"Additional bounded interest {index}",
                },
            )
        client.post(
            url("/api/workspace/physician/posts"),
            json={"type": "research_update", "title": "Update", "body": "Synthetic."},
        )
        after_jordan = client.post(
            f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={}
        ).json()
        after_maria = client.post(f"/api/patients/{MARIA_PATIENT_ID}/consultations", json={}).json()

    for key in ("recommended_physician", "before_referral", "availability", "why"):
        assert after_jordan[key] == before_jordan[key]
        assert after_maria[key] == before_maria[key]
    assert after_jordan["recommended_physician"]["physician_name"] == ("Dr. Iain Jung (synthetic)")
    assert after_maria["recommended_physician"]["physician_name"] == (
        "Dr. Tiffany Sanchez (synthetic)"
    )
