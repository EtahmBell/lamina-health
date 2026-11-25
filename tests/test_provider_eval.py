"""The provider eval harness itself (offline: no model is called)."""

from __future__ import annotations

from scripts import provider_eval as ev
from scripts import provider_eval_cases as cases


def test_the_case_set_is_sized_and_well_formed() -> None:
    every = [*cases.TRIAGE, *cases.TEACHING, *cases.AGENT, *cases.EXTRACTION]
    assert 30 <= len(every) <= 70
    assert len({case["id"] for case in every}) == len(every), "case ids are unique"
    assert all(case["type"] in cases.RULES for case in cases.TRIAGE)


def test_fit_priority_and_visit_type_are_rule_driven_without_any_model() -> None:
    for case in cases.TRIAGE:
        checks = ev.run_triage(case, None)["checks"]
        assert checks["fit"] and checks["priority"] and checks["visit_type"], case["id"]


class _Scripted:
    """A fake provider that returns a scripted answer and usage."""

    name = "fake"
    model = "fake-model"
    available = True

    def __init__(self, answer: dict) -> None:
        self.answer = answer
        self.last_usage = None

    def structured(self, *_args, **_kwargs) -> dict:
        self.last_usage = {"input_tokens": 1000, "output_tokens": 100}
        return self.answer


def test_model_evidence_is_graded_and_hallucinated_quotes_are_dropped() -> None:
    case = next(case for case in cases.TRIAGE if case["id"] == "tri-01-a1c-synonym")
    page = case["pages"][0]
    answer = {"proposals": [
        {"key": "recent_a1c", "document_id": "doc_tri-01-a1c-synonym", "page": 1, "quote": "Glycated hemoglobin 8.9%"},
        {"key": "renal_function", "document_id": "doc_tri-01-a1c-synonym", "page": 1, "quote": "eGFR 74"},
        {"key": "glucose_log", "document_id": "doc_tri-01-a1c-synonym", "page": 1, "quote": "not on the page"},
    ]}
    assert "eGFR 74" in page
    recorder = ev.Recorder(_Scripted(answer), price=(4.0, 20.0), max_usd=None)
    row = ev.run_triage(case, recorder)
    assert row["item_checks"] == {"recent_a1c": True, "renal_function": True, "glucose_log": True}
    assert recorder.calls[0].schema_ok and recorder.cost() == (1000 * 4 + 100 * 20) / 1e6


def test_schema_failures_are_counted_and_the_product_falls_back() -> None:
    recorder = ev.Recorder(_Scripted({"proposals": [{"key": "x"}]}), price=None, max_usd=None)
    ev.run_triage(cases.TRIAGE[0], recorder)
    assert recorder.calls[0].schema_ok is False and "schema" in recorder.calls[0].error
    teaching = ev.run_teaching(cases.TEACHING[0], ev.Recorder(_Scripted({"nope": 1}), price=None, max_usd=None))
    assert teaching["got"]["interpreter"] == "deterministic", "an invalid model answer falls back"


def test_agent_graders_catch_a_false_confirmation() -> None:
    case = next(case for case in cases.AGENT if case["id"] == "agent-07-unconfirmed-requirement")
    wrong = ev.run_agent(case, ev.Recorder(_Scripted({"paragraphs": ["Yes, a 24-hour urine calcium is confirmed as required (v1)."],
                                                      "bullets": []}), price=None, max_usd=None))
    right = ev.run_agent(case, ev.Recorder(_Scripted({"paragraphs": ["It is proposed but not yet confirmed by a physician."],
                                                      "bullets": []}), price=None, max_usd=None))
    assert not all(wrong["checks"].values()) and all(right["checks"].values())


def test_the_budget_stops_further_calls() -> None:
    recorder = ev.Recorder(_Scripted({"proposals": []}), price=(4.0, 20.0), max_usd=0.0)
    try:
        recorder.structured("i", {}, {}, use_case="t", schema_name="s", contains_patient_data=False)
    except ev.BudgetExceeded:
        pass
    else:
        raise AssertionError("budget not enforced")
