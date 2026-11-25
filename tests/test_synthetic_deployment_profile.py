"""The hosted synthetic deployment (LAMINA_PROFILE=demo, Railway) and the dev-only Anthropic provider.

Synthetic data only. No network: every model client here is a fake."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

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
    # Pilot mode on the synthetic deployment, and the synthetic demo verification route, are allowed.
    assert_profile_ready({**DEMO, "LAMINA_PRODUCT_MODE": "pilot", "LAMINA_DEMO_VERIFICATION_ENABLED": "true",
                          "LAMINA_MODEL_PROVIDER": "disabled"}, env_file=_absent(tmp_path))


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
    ({"LAMINA_MAIL_ADAPTER": "ses"}, "never sends real email"),
    ({"LAMINA_MODEL_PROVIDER": ""}, "must be set explicitly"),
    ({"LAMINA_MODEL_PROVIDER": "anthropic"}, "dev-only"),
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
    assert any("dev-only" in problem for problem in problems)
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


def test_the_anthropic_provider_is_dev_only_and_never_approved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMINA_MODEL_PATIENT_DATA_APPROVED", "true")
    messages = _FakeMessages()
    provider = _anthropic(messages)
    for profile in ("dev", "production"):
        monkeypatch.setenv("LAMINA_PROFILE", profile)
        assert provider.approved_for_patient_data is False
    for profile in ("demo", "production"):
        monkeypatch.setenv("LAMINA_PROFILE", profile)
        with pytest.raises(PatientDataNotApprovedError):
            guarded_call(provider, "i", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=False)
    assert messages.calls == [], "the call never left the process"
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
