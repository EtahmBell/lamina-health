"""Teaching-intent expansion pass: "Tell your agent something" honestly
supports the categories it advertises -- case interest / good fit, not a
fit, required and helpful information, modality -- with negation handled,
ambiguous text never forced into a rule, and confirmed interests feeding the
existing (supporting-only) case-interest fit path.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.clinical import build_patient_context
from backend.physicians.case_fit import assess_physician_case_fit
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    clarification_opportunities,
    confirmed_preference_case_interests,
    confirmed_requirement_items,
    effective_confirmed_rules,
    is_empty_preference,
)
from backend.representation import representation_snapshot_id
from backend.synthetic_data import PATIENTS, PHYSICIAN_CHEN, TONJIT_PATIENT_ID, resolve_case_rules
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import document_chen_consultation

CHEN_ID = PHYSICIAN_CHEN.id
PREFERENCES = "/api/workspace/physician/chen/referral-preferences"
TARGET = "I'm also particularly interested in diabetes cases where the diagnosis is uncertain or the presentation is atypical."
MEDICATION_HISTORY = "If a patient has tried other diabetes medications before, I'd like the reason they were stopped included when it's available."
EXPECTED_INTERESTS = {"Uncertain diabetes diagnosis", "Atypical diabetes presentations"}

offline = ReferralPreferenceInterpretationService(ResponsesApiClient(enabled=False))


def interpret(text: str):
    family, structured, _provider = offline.interpret(text, "Endocrinology", None)
    return family, structured


def positive_fit(structured) -> set[str]:
    return set(structured.case_interests) | set(structured.good_fit)


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    for module in (referral_preferences_api, referrals_api, consult_api, engagement_api, workspace_api, specialist_api, demo_workspace_module):
        monkeypatch.setattr(module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(referral_preferences_api, "referral_preference_interpretation_service", offline)
    return value


def _bootstrap(client: TestClient) -> str:
    client.get("/api/patients")
    return client.cookies[DEFAULT_COOKIE_NAME]


def _teach(client: TestClient, text: str, **extra) -> dict:
    draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": text, **extra}).json()
    confirmed = client.post(f"{PREFERENCES}/{draft['id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


# ------------------------------------------------------------------- R: target


def test_the_reported_sentence_is_a_diabetes_case_interest_and_nothing_else() -> None:
    family, structured = interpret(TARGET)
    assert family == "type_2_diabetes"
    assert set(structured.case_interests) == EXPECTED_INTERESTS
    assert structured.required == [] and structured.helpful == []
    assert structured.good_fit == [] and structured.redirect == []
    assert structured.modality == "unspecified" and structured.modality_rules == []
    assert structured.interpretation_note is None and not is_empty_preference(structured)


# --------------------------------------------------------------- S: paraphrases


@pytest.mark.parametrize(("text", "expected"), [
    ("I like seeing atypical diabetes cases.", {"Atypical diabetes presentations"}),
    ("Unusual diabetes presentations are generally a good fit for my practice.", {"Atypical diabetes presentations"}),
    ("Cases where it isn't clear whether this is really type 2 diabetes are interesting to me.", {"Uncertain diabetes diagnosis"}),
    ("I'm especially interested in diabetes cases with an unclear phenotype.", {"Atypical diabetes presentations"}),
    ("I'm especially interested in patients whose diabetes phenotype doesn't fit straightforward type 2 diabetes.", {"Atypical diabetes presentations"}),
])
def test_paraphrases_converge_on_the_same_positive_fit_concepts(text: str, expected: set[str]) -> None:
    family, structured = interpret(text)
    assert family == "type_2_diabetes"
    assert positive_fit(structured) == expected
    assert structured.required == [] and structured.helpful == [] and structured.redirect == []


def test_an_interest_without_a_known_concept_keeps_the_physicians_own_words() -> None:
    _family, structured = interpret("I'm particularly interested in difficult-to-control diabetes after multiple medication changes.")
    assert structured.case_interests == ["Difficult-to-control diabetes after multiple medication changes"]


# ---------------------------------------------------------- T: the other intents


def test_every_advertised_intent_still_classifies() -> None:
    _f, helpful = interpret("If a patient has tried diabetes medications before, I'd like to know why they were stopped when available.")
    assert [item.required for item in helpful.helpful] == [False, False] and helpful.case_interests == []
    _f, required = interpret("I need a recent A1c before I can review a diabetes referral.")
    assert [(item.key, item.label) for item in required.required] == [("recent_hba1c", "Recent A1c")]
    _f, modality = interpret("Focused diabetes medication questions can start as an e-consult.")
    assert [(rule.modality, rule.condition) for rule in modality.modality_rules] == [("econsult", "Focused diabetes medication questions")]
    family, not_fit = interpret("Routine uncomplicated hypothyroidism generally isn't a good fit for my practice.")
    assert family == "thyroid" and not_fit.redirect == ["Routine uncomplicated hypothyroidism"] and not_fit.good_fit == []
    _f, good_fit = interpret("Complex diabetes after multiple treatment changes is a good fit for me.")
    assert good_fit.good_fit == ["Complex diabetes after multiple treatment changes is a good fit for me"]
    _f, redirect = interpret("I prefer to redirect uncomplicated hypertension back to primary care.")
    assert redirect.redirect == ["Uncomplicated hypertension (better sent to primary care)"]


def test_the_canonical_teaching_interprets_exactly_as_before() -> None:
    from tests._chen_demo_fixture import CHEN_DEMO_SOURCE_TEXT

    _f, structured = interpret(CHEN_DEMO_SOURCE_TEXT)
    assert [item.key for item in structured.required] == ["recent_hba1c", "current_medications", "recent_renal_function"]
    assert [item.label for item in structured.helpful] == ["Glucose logs or CGM"]
    assert structured.good_fit == ["I commonly see patients whose diabetes remains poorly controlled despite treatment escalation"]
    assert structured.case_interests == []


# ---------------------------------------------------------------- U: negation


@pytest.mark.parametrize("text", [
    "I'm not interested in atypical diabetes cases.",
    "I'm not particularly interested in atypical diabetes cases.",
])
def test_negated_interest_is_never_a_positive_preference(text: str) -> None:
    _f, structured = interpret(text)
    assert positive_fit(structured) == set()
    assert is_empty_preference(structured) and structured.interpretation_note


def test_negated_requirement_is_never_required() -> None:
    for text in ("I don't require prior medication trials.", "I don't require a recent A1c."):
        _f, structured = interpret(text)
        assert structured.required == []
        assert is_empty_preference(structured) and structured.interpretation_note


def test_dont_want_is_not_a_positive_fit_signal() -> None:
    _f, structured = interpret("I don't want routine diabetes referrals.")
    assert positive_fit(structured) == set()
    assert structured.redirect == ["Routine diabetes referrals"]


# -------------------------------------------------------- N: low confidence


@pytest.mark.parametrize(("text", "mentions"), [
    ("Diabetes can be complicated sometimes.", "about diabetes"),
    ("I enjoy complex cases.", "not sure"),
])
def test_vague_statements_are_never_forced_into_a_rule(text: str, mentions: str) -> None:
    _f, structured = interpret(text)
    assert is_empty_preference(structured)
    assert mentions in structured.interpretation_note


def test_a_fit_statement_without_a_known_condition_asks_rather_than_guessing_a_family() -> None:
    _f, structured = interpret("I tend to take over medication intensification when primary care has already tried several options.")
    assert is_empty_preference(structured)
    assert "Name the condition" in structured.interpretation_note


def test_a_note_only_interpretation_cannot_be_confirmed(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": "Diabetes can be complicated sometimes."}).json()
        assert draft["structured_rules"]["interpretation_note"]
        assert client.post(f"{PREFERENCES}/{draft['id']}/confirm").status_code == 409


# ------------------------------------------------- O + V: confirm, history, dups


def test_confirming_the_interest_is_additive_and_visible(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        document_chen_consultation(store, ws)
        card = clarification_opportunities(store, ws, CHEN_ID)[0]
        econsult = _teach(client, card["yes_statement"], clarifies="modality")
        medication = _teach(client, MEDICATION_HISTORY)
        effective_before = effective_confirmed_rules(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
        requirements_before = confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
        snapshot_before = representation_snapshot_id(store, ws, "chen")

        interest = _teach(client, TARGET)
        history = {item["id"]: item["status"] for item in client.get(PREFERENCES).json()}
        sections = client.get("/api/workspace/physician/agent-representation?perspective=chen").json()["sections"]
        learnings = client.get("/api/workspace/physician/agent-overview?perspective=chen").json()["recent_learnings"]
        revisable = client.post(f"{PREFERENCES}/interpret", json={"source_text": "Anything.", "revises": interest["id"]}).status_code
        duplicate = client.post(f"{PREFERENCES}/interpret", json={"source_text": "I like seeing atypical diabetes cases."}).json()
        duplicate_confirm = client.post(f"{PREFERENCES}/{duplicate['id']}/confirm").status_code

    assert history[econsult["id"]] == history[medication["id"]] == history[interest["id"]] == "confirmed"
    effective = effective_confirmed_rules(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert set(effective.case_interests) == EXPECTED_INTERESTS
    # Nothing else in the representation changed.
    assert effective.modality_rules == effective_before.modality_rules
    assert effective.helpful == effective_before.helpful and effective.required == effective_before.required
    assert confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY) == requirements_before
    assert interest["representation_snapshot_id_at_confirmation"] != snapshot_before
    # Overview: shown with the physician's other confirmed case interests.
    titles = {item["title"] for item in sections["interests"] if item["interest_type"] == "case_interest"}
    assert EXPECTED_INTERESTS <= titles
    assert any(line["summary"].startswith("Confirmed case interest: ") for line in learnings)
    assert revisable == 200
    # Restating an interest already represented is a no-op, never a duplicate learning.
    assert duplicate_confirm == 409


# ------------------------------------------------------------- W: matching path


def test_a_confirmed_interest_feeds_the_existing_case_fit_path_as_support_only(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        _teach(client, TARGET)
    titles = confirmed_preference_case_interests(store, ws, CHEN_ID)
    assert set(titles) == EXPECTED_INTERESTS
    # A future synthetic case (not a fixture): Tonjit's structure with an
    # atypical, uncertain-classification presentation.
    atypical = build_patient_context(PATIENTS[TONJIT_PATIENT_ID]).model_copy(update={
        "patient_id": "synthetic-atypical",
        "summary": "Adult with an atypical diabetes phenotype and uncertain classification.",
        "facts": ["Lean adult with new hyperglycemia", "Classification uncertain"],
    })
    case_rules = resolve_case_rules(PHYSICIAN_CHEN, atypical, None)
    plain = assess_physician_case_fit(atypical, "Endocrinology", PHYSICIAN_CHEN, case_rules)
    with_interest = assess_physician_case_fit(atypical, "Endocrinology", PHYSICIAN_CHEN, case_rules, case_interest_titles=titles)
    assert any(item.category == "case_interest" for item in with_interest.evidence)
    # A supporting signal only: fit tiers are unchanged, specialty still governs.
    assert (with_interest.clinical_fit, with_interest.receiving_fit) == (plain.clinical_fit, plain.receiving_fit)
    wrong_specialty = assess_physician_case_fit(atypical, "Nephrology", PHYSICIAN_CHEN, case_rules, case_interest_titles=titles)
    assert wrong_specialty.clinical_fit == "poor"


def test_a_disease_name_alone_never_counts_as_a_matching_interest() -> None:
    from backend.physicians.case_fit import interest_matches_case_text

    tonjit_text = "52-year-old with type 2 diabetes and steadily worsening glycemic control despite escalating medication."
    assert not interest_matches_case_text("Uncertain diabetes diagnosis", tonjit_text, "type_2_diabetes")
    assert not interest_matches_case_text("Atypical diabetes presentations", tonjit_text, "type_2_diabetes")
    assert interest_matches_case_text("Type 2 diabetes", tonjit_text, "type_2_diabetes")
    assert interest_matches_case_text("Progressive diabetes despite escalation", tonjit_text, "type_2_diabetes")


# ------------------------------------------------------------ Q: model path


class _FakeModelClient:
    available = True
    model = "fake"

    def structured(self, *_args, **_kwargs) -> dict:
        return {
            "case_family": "type_2_diabetes", "good_fit": [], "required": [], "helpful": [], "redirect": [],
            "modality": "unspecified", "case_interests": ["Uncertain diabetes diagnosis", "Atypical diabetes presentations"],
        }


def test_the_model_path_emits_the_same_representation_shape() -> None:
    family, structured, provider = ReferralPreferenceInterpretationService(_FakeModelClient()).interpret(TARGET, "Endocrinology", None)
    assert provider == "responses_api" and family == "type_2_diabetes"
    _f, offline_structured = interpret(TARGET)
    assert set(structured.case_interests) == set(offline_structured.case_interests)


def test_no_exact_sentence_special_case_exists() -> None:
    source = (Path(__file__).resolve().parents[1] / "backend" / "referral_preferences.py").read_text(encoding="utf-8")
    for fragment in ("particularly interested in diabetes", "presentation is atypical", "diagnosis is uncertain or"):
        assert fragment not in source
