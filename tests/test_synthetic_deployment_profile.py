"""The hosted synthetic deployment (LAMINA_PROFILE=demo, Railway), the Anthropic provider (synthetic
profiles only) and the demo's model-spend limits.

Synthetic data only. No network: every model client here is a fake."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.demo_model_budget import DemoCallerMiddleware, ModelLimitReached, bind_caller, budget
from backend.model_provider import (
    AnthropicProvider,
    BedrockClaudeProvider,
    OpenAIProvider,
    PatientDataNotApprovedError,
    anthropic_schema,
    configured_provider_name,
    guarded_call,
    patient_data_approved,
    provider_from_environment,
)
from backend.profiles import assert_profile_ready, demo_problems, production_problems

SCHEMA = {"type": "object", "properties": {"answer": {"type": ["string", "null"]}}, "required": ["answer"],
          "additionalProperties": False}

DEMO = {
    "LAMINA_PROFILE": "demo", "LAMINA_PRODUCT_MODE": "demo", "LAMINA_MODEL_PROVIDER": "openai",
    "LAMINA_CORS_ORIGINS": "https://lamina-demo.example",
}


def _absent(tmp_path: Path) -> Path:
    return tmp_path / "absent.env"


def test_a_safe_synthetic_deployment_starts(tmp_path: Path) -> None:
    assert demo_problems(DEMO, env_file=_absent(tmp_path)) == []
    assert_profile_ready(DEMO, env_file=_absent(tmp_path))
    # Pilot mode on the synthetic deployment is allowed.
    assert_profile_ready({**DEMO, "LAMINA_PRODUCT_MODE": "pilot", "LAMINA_MODEL_PROVIDER": "disabled"},
                         env_file=_absent(tmp_path))


@pytest.mark.parametrize(("change", "expected"), [
    ({"LAMINA_MODEL_PATIENT_DATA_APPROVED": "true"}, "LAMINA_MODEL_PATIENT_DATA_APPROVED must not be set"),
    ({"LAMINA_MODEL_PATIENT_DATA_APPROVED": "yes"}, "LAMINA_MODEL_PATIENT_DATA_APPROVED must not be set"),
    ({"LAMINA_E2E": "1"}, "LAMINA_E2E must not be set"),
    ({"LAMINA_E2E_TEST_AUTH": "1"}, "LAMINA_E2E_TEST_AUTH must not be set"),
    ({"LAMINA_E2E_MFA_EXEMPT_USER_IDS": "u1"}, "LAMINA_E2E_MFA_EXEMPT_USER_IDS must not be set"),
    ({"LAMINA_DEV_FAKE_NPPES": "true"}, "LAMINA_DEV_FAKE_NPPES must not be set"),
    ({"LAMINA_DEBUG": "1"}, "LAMINA_DEBUG must not be set"),
    ({"DEBUG": "true"}, "DEBUG must not be set"),
    ({"PYTHONDEVMODE": "1"}, "PYTHONDEVMODE must not be set"),
    # Run 3: the synthetic demo flow doesn't need demo verification; on a public site it is self-verification.
    ({"LAMINA_DEMO_VERIFICATION_ENABLED": "true"}, "LAMINA_DEMO_VERIFICATION_ENABLED must not be set"),
    ({"LAMINA_MAIL_ADAPTER": "ses"}, "never sends real email"),
    ({"LAMINA_MODEL_PROVIDER": ""}, "must be set explicitly"),
    # Run 4: anthropic is allowed on the synthetic demo -- but needs its key, and limits are numbers.
    ({"LAMINA_MODEL_PROVIDER": "anthropic"}, "ANTHROPIC_API_KEY is missing"),
    ({"LAMINA_DEMO_MODEL_DAILY_CAP": "lots"}, "LAMINA_DEMO_MODEL_DAILY_CAP must be a whole number"),
    ({"LAMINA_DEMO_MODEL_PER_IP_LIMIT": "-1"}, "LAMINA_DEMO_MODEL_PER_IP_LIMIT must be a whole number"),
    ({"LAMINA_CORS_ORIGINS": ""}, "LAMINA_CORS_ORIGINS is missing"),
    ({"LAMINA_CORS_ORIGINS": "http://lamina-demo.example"}, "https origins"),
])
def test_the_synthetic_deployment_refuses_each_unsafe_setting(tmp_path: Path, change: dict, expected: str) -> None:
    env = {**DEMO, **change}
    problems = demo_problems(env, env_file=_absent(tmp_path))
    assert any(expected in problem for problem in problems), problems
    with pytest.raises(RuntimeError, match="Refusing to start the synthetic demo deployment"):
        assert_profile_ready(env, env_file=_absent(tmp_path))


def test_the_synthetic_deployment_never_reads_a_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("OPENAI_API_KEY=not-a-real-key\n", encoding="utf-8")
    assert any(".env file is present" in problem for problem in demo_problems(DEMO, env_file=env_file))
    problems = "\n".join(demo_problems({**DEMO, "LAMINA_MODEL_PATIENT_DATA_APPROVED": "sk-looks-secret"}, env_file=env_file))
    assert "sk-looks-secret" not in problems, "problems name settings, never values"


def test_no_provider_is_ever_approved_for_patient_data_on_the_synthetic_deployment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMINA_PROFILE", "demo")
    monkeypatch.setenv("LAMINA_MODEL_PATIENT_DATA_APPROVED", "true")  # refused at startup; ignored if it slips through
    assert patient_data_approved() is False
    for provider in (OpenAIProvider(model="m", api_key="k"), BedrockClaudeProvider(model_id="m"),
                     OpenAIProvider(model="m", api_key="k", approved=True), BedrockClaudeProvider(model_id="m", approved=True)):
        assert provider.approved_for_patient_data is False, provider.name
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    assert patient_data_approved() is True  # the flag itself still works where it means something


def test_health_marks_only_the_synthetic_deployment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from backend import main

    monkeypatch.setattr("backend.profiles.REPOSITORY_ENV_FILE", _absent(tmp_path))
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    assert TestClient(main.create_app("demo")).get("/health").json() == {"status": "ok", "data_mode": "synthetic"}
    for name, value in DEMO.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("LAMINA_MODEL_PATIENT_DATA_APPROVED", raising=False)
    for name in ("LAMINA_E2E", "LAMINA_E2E_TEST_AUTH", "LAMINA_E2E_MFA_EXEMPT_USER_IDS", "LAMINA_DEV_FAKE_NPPES", "LAMINA_DEBUG"):
        monkeypatch.delenv(name, raising=False)
    health = TestClient(main.create_app("demo")).get("/health").json()
    assert health == {"status": "ok", "data_mode": "synthetic", "deployment": "synthetic"}


def test_production_still_refuses_what_it_refused_and_now_the_dev_provider(tmp_path: Path) -> None:
    from tests.test_model_provider_and_profiles import GOOD

    assert production_problems(GOOD, env_file=_absent(tmp_path)) == []
    problems = production_problems({**GOOD, "LAMINA_MODEL_PROVIDER": "anthropic"}, env_file=_absent(tmp_path))
    assert any("has no BAA" in problem and "never production" in problem for problem in problems)
    with pytest.raises(RuntimeError, match="Refusing to start in production"):
        assert_profile_ready({**GOOD, "LAMINA_MODEL_PROVIDER": "anthropic", "LAMINA_MODEL_PATIENT_DATA_APPROVED": "true"},
                             env_file=_absent(tmp_path))


# ------------------------------------------------------------ dev-only Anthropic provider


class _FakeMessages:
    def __init__(self, text: str = '{"answer": "ok"}', stop_reason: str = "end_turn") -> None:
        self.calls: list[dict] = []
        self.text, self.stop_reason = text, stop_reason

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(stop_reason=self.stop_reason, usage=SimpleNamespace(input_tokens=11, output_tokens=7),
                               content=[SimpleNamespace(type="text", text=self.text)])


def _anthropic(messages: _FakeMessages) -> AnthropicProvider:
    return AnthropicProvider(SimpleNamespace(messages=messages), model="claude-test", effort="low")


def test_the_anthropic_provider_returns_structured_output(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    messages = _FakeMessages()
    provider = _anthropic(messages)
    assert guarded_call(provider, "instr", {"q": 1}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=False) == {"answer": "ok"}
    call = messages.calls[0]
    assert call["model"] == "claude-test" and call["system"] == "instr"
    assert json.loads(call["messages"][0]["content"]) == {"q": 1}
    assert call["output_config"]["effort"] == "low"
    assert call["output_config"]["format"]["schema"]["properties"]["answer"] == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    assert provider.last_usage == {"input_tokens": 11, "output_tokens": 7}
    with pytest.raises(RuntimeError):  # a refusal / truncation is a failure (callers fall back)
        guarded_call(_anthropic(_FakeMessages(stop_reason="refusal")), "i", {}, SCHEMA, use_case="t", schema_name="s",
                     contains_patient_data=False)


def test_the_anthropic_provider_is_for_synthetic_profiles_only_and_never_approved(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LAMINA_MODEL_PATIENT_DATA_APPROVED", "true")
    monkeypatch.setenv("LAMINA_DEMO_MODEL_USAGE_DB", str(tmp_path / "usage.sqlite"))
    budget.reset()
    messages = _FakeMessages()
    provider = _anthropic(messages)
    for profile in ("dev", "demo", "production"):
        monkeypatch.setenv("LAMINA_PROFILE", profile)
        assert provider.approved_for_patient_data is False, profile
    monkeypatch.setenv("LAMINA_PROFILE", "production")
    with pytest.raises(PatientDataNotApprovedError):
        guarded_call(provider, "i", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=False)
    assert messages.calls == [], "production: the call never left the process"
    monkeypatch.setenv("LAMINA_PROFILE", "demo")  # run 4: allowed on the synthetic demo
    assert guarded_call(provider, "i", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=True) == {"answer": "ok"}
    assert len(messages.calls) == 1
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    monkeypatch.setenv("LAMINA_MODEL_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "placeholder-not-a-key")
    assert configured_provider_name() == "anthropic" and isinstance(provider_from_environment(), AnthropicProvider)


def test_anthropic_schema_keeps_the_shape() -> None:
    schema = {"type": "object", "additionalProperties": False, "required": ["a", "b", "c"], "properties": {
        "a": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4},
        "b": {"type": ["string", "null"], "enum": ["x", "y", None]},
        "c": {"type": "array", "items": {"type": "integer"}, "minItems": 3}}}
    out = anthropic_schema(schema)
    assert out["properties"]["a"] == {"type": "array", "items": {"type": "string"}, "minItems": 1}
    assert out["properties"]["b"] == {"anyOf": [{"type": "string", "enum": ["x", "y"]}, {"type": "null"}]}
    assert out["properties"]["c"] == {"type": "array", "items": {"type": "integer"}}
    assert schema["properties"]["a"]["maxItems"] == 4, "the caller's schema is not modified"


def test_railway_config_starts_the_app_with_a_health_check() -> None:
    """Run 3: railway.json pins the start command and the health check (it overrides the dashboard)."""
    config = json.loads((Path(__file__).resolve().parents[1] / "railway.json").read_text(encoding="utf-8"))
    deploy = config["deploy"]
    assert deploy["startCommand"] == "python -m uvicorn backend.main:app --host 0.0.0.0 --port $PORT"  # the dashboard's command
    assert deploy["healthcheckPath"] == "/health" and deploy["numReplicas"] == 1, "one replica: SQLite on a volume"
    assert "build" not in config, "the builder stays the dashboard's choice"



# ------------------------------------------------------------- demo model-spend limits (run 4)


@pytest.fixture
def demo_budget(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("LAMINA_PROFILE", "demo")
    monkeypatch.setenv("LAMINA_DEMO_MODEL_USAGE_DB", str(tmp_path / "usage.sqlite"))
    for name in ("LAMINA_DEMO_MODEL_DAILY_CAP", "LAMINA_DEMO_MODEL_PER_SESSION_LIMIT", "LAMINA_DEMO_MODEL_PER_IP_LIMIT"):
        monkeypatch.delenv(name, raising=False)
    budget.reset()
    yield budget
    budget.reset()


def _call(provider) -> dict:
    return guarded_call(provider, "i", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=False)


def test_per_session_and_per_ip_limits(monkeypatch: pytest.MonkeyPatch, demo_budget) -> None:
    monkeypatch.setenv("LAMINA_DEMO_MODEL_PER_SESSION_LIMIT", "2")
    monkeypatch.setenv("LAMINA_DEMO_MODEL_PER_IP_LIMIT", "3")
    messages = _FakeMessages()
    provider = _anthropic(messages)
    bind_caller("session-a", "203.0.113.5")
    _call(provider), _call(provider)
    with pytest.raises(ModelLimitReached) as caught:
        _call(provider)
    assert caught.value.reason == "session" and len(messages.calls) == 2, "the refused call never reached the model"
    bind_caller("session-b", "203.0.113.5")  # same IP, new session
    _call(provider)
    with pytest.raises(ModelLimitReached) as caught:
        _call(provider)
    assert caught.value.reason == "ip"
    bind_caller("session-c", "198.51.100.7")  # someone else is unaffected
    assert _call(provider) == {"answer": "ok"}


def test_the_daily_cap_is_persisted_and_zero_turns_models_off(monkeypatch: pytest.MonkeyPatch, demo_budget) -> None:
    monkeypatch.setenv("LAMINA_DEMO_MODEL_DAILY_CAP", "2")
    provider = _anthropic(_FakeMessages())
    for index in range(2):
        bind_caller(f"s{index}", f"10.0.0.{index}")
        _call(provider)
    bind_caller("s9", "10.0.0.9")
    with pytest.raises(ModelLimitReached) as caught:
        _call(provider)
    assert caught.value.reason == "daily_cap"
    budget.reset()  # a restart clears the in-process windows -- not the persisted daily count
    assert budget.used_today() == 2
    with pytest.raises(ModelLimitReached):
        _call(provider)
    monkeypatch.setenv("LAMINA_DEMO_MODEL_DAILY_CAP", "0")
    with pytest.raises(ModelLimitReached):
        _call(provider)


def test_limits_only_apply_on_the_synthetic_demo(monkeypatch: pytest.MonkeyPatch, demo_budget) -> None:
    monkeypatch.setenv("LAMINA_DEMO_MODEL_DAILY_CAP", "0")
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    assert _call(_anthropic(_FakeMessages())) == {"answer": "ok"}


def test_a_limited_call_falls_back_to_the_non_ai_behaviour_and_the_response_says_so(monkeypatch: pytest.MonkeyPatch, demo_budget) -> None:
    """The product's callers catch the refusal and use their deterministic path; the API marks
    the response so the page can say the AI is paused."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.pilot.teaching import TeachingService
    from backend.professional_services import ResponsesApiClient

    monkeypatch.setenv("LAMINA_DEMO_MODEL_DAILY_CAP", "0")
    messages = _FakeMessages()
    teaching = TeachingService(rules=None, client=ResponsesApiClient(provider=_anthropic(messages)))
    app = FastAPI()

    @app.get("/interpret")
    def interpret() -> dict:
        return teaching.interpret("For thyroid nodule referrals I need a TSH within 90 days.", ["Thyroid nodule"])

    app.add_middleware(DemoCallerMiddleware, cookie_name="lamina_demo_workspace")
    response = TestClient(app).get("/interpret", cookies={"lamina_demo_workspace": "w1"})
    assert response.status_code == 200
    assert response.json()["interpreter"] == "deterministic", "the non-AI answer"
    assert response.headers["x-lamina-ai-limited"] == "daily_cap"
    assert messages.calls == []
    monkeypatch.setenv("LAMINA_DEMO_MODEL_DAILY_CAP", "5")
    fine = TestClient(app).get("/interpret", cookies={"lamina_demo_workspace": "w2"})
    assert "x-lamina-ai-limited" not in fine.headers


def test_the_synthetic_app_installs_the_caller_middleware_and_exposes_the_header(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from backend import main

    monkeypatch.setattr("backend.profiles.REPOSITORY_ENV_FILE", _absent(tmp_path))
    for name, value in DEMO.items():
        monkeypatch.setenv(name, value)
    for name in ("LAMINA_E2E", "LAMINA_E2E_TEST_AUTH", "LAMINA_E2E_MFA_EXEMPT_USER_IDS", "LAMINA_DEV_FAKE_NPPES", "LAMINA_DEBUG",
                 "LAMINA_MODEL_PATIENT_DATA_APPROVED", "LAMINA_DEMO_VERIFICATION_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    app = main.create_app("demo")
    assert any(item.cls is DemoCallerMiddleware for item in app.user_middleware)
    preflight = TestClient(app).options("/health", headers={"Origin": DEMO["LAMINA_CORS_ORIGINS"], "Access-Control-Request-Method": "GET"})
    assert preflight.status_code == 200
    simple = TestClient(app).get("/health", headers={"Origin": DEMO["LAMINA_CORS_ORIGINS"]})
    assert "x-lamina-ai-limited" in simple.headers.get("access-control-expose-headers", "").lower()
