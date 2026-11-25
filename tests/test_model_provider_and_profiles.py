"""Model providers and configuration profiles (run 2). No network: OpenAI uses a fake SDK object,
Bedrock a stub client. Synthetic data only."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import model_provider as mp
from backend.model_provider import (
    BedrockClaudeProvider,
    DisabledProvider,
    OpenAIProvider,
    PatientDataNotApprovedError,
    configured_provider_name,
    guarded_call,
)
from backend.professional_services import ResponsesApiClient
from backend.profiles import assert_profile_ready, current_profile, production_problems

SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"], "additionalProperties": False}


class _FakeResponses:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(output_text=json.dumps({"answer": "ok"}))


class _FakeBedrock:
    def __init__(self, tool_input: dict | None = None) -> None:
        self.calls: list[dict] = []
        self.tool_input = tool_input if tool_input is not None else {"answer": "ok"}

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        name = kwargs["toolConfig"]["tools"][0]["toolSpec"]["name"]
        return {"output": {"message": {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": name, "input": self.tool_input}}]}},
                "stopReason": "tool_use"}


# ------------------------------------------------------------------- providers


def test_openai_calls_are_never_stored_and_never_search_with_patient_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    responses = _FakeResponses()
    provider = OpenAIProvider(SimpleNamespace(responses=responses), model="test-model", approved=False)
    assert guarded_call(provider, "x", {"q": 1}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=True) == {"answer": "ok"}
    assert responses.calls[0]["store"] is False and responses.calls[0]["tools"] == []
    with pytest.raises(PatientDataNotApprovedError):
        guarded_call(provider, "x", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=True, web_search=True)


def test_bedrock_returns_the_forced_tools_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMINA_PROFILE", "dev")
    client = _FakeBedrock()
    provider = BedrockClaudeProvider(client, model_id="anthropic.claude-test-v1:0", approved=True)
    result = guarded_call(provider, "Answer.", {"question": "q"}, SCHEMA, use_case="t", schema_name="agent_answer",
                          contains_patient_data=True)
    assert result == {"answer": "ok"}
    call = client.calls[0]
    assert call["modelId"] == "anthropic.claude-test-v1:0"
    assert call["toolConfig"]["toolChoice"] == {"tool": {"name": "agent_answer"}}
    assert call["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"] == {"json": SCHEMA}
    assert call["system"] == [{"text": "Answer."}] and call["inferenceConfig"]["temperature"] == 0
    with pytest.raises(RuntimeError, match="temporarily unavailable"):
        guarded_call(BedrockClaudeProvider(SimpleNamespace(converse=lambda **_: {"output": {"message": {"content": [{"text": "no tool"}]}}}),
                                           model_id="m", approved=True),
                     "x", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=False)


def test_production_refuses_patient_data_to_an_unapproved_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeBedrock()
    unapproved = BedrockClaudeProvider(client, model_id="m", approved=False)
    monkeypatch.setenv("LAMINA_PROFILE", "production")
    with pytest.raises(PatientDataNotApprovedError):
        guarded_call(unapproved, "x", {"patient": "Alex Example"}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=True)
    assert client.calls == [], "the call never left the process"
    # Without patient data it may run; an approved provider may take patient data.
    assert guarded_call(unapproved, "x", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=False)
    assert guarded_call(BedrockClaudeProvider(client, model_id="m", approved=True), "x", {}, SCHEMA, use_case="t",
                        schema_name="s", contains_patient_data=True)
    monkeypatch.setenv("LAMINA_PROFILE", "dev")  # synthetic data: allowed
    assert guarded_call(unapproved, "x", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=True)


def test_provider_selection_and_the_wrapper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LAMINA_MODEL_PROVIDER", raising=False)
    monkeypatch.setenv("LAMINA_OPENAI_ENABLED", "false")
    assert configured_provider_name() == "disabled"
    assert isinstance(ResponsesApiClient().provider, DisabledProvider) and ResponsesApiClient().available is False
    monkeypatch.setenv("LAMINA_MODEL_PROVIDER", "bedrock")
    monkeypatch.setenv("LAMINA_BEDROCK_MODEL_ID", "anthropic.claude-test-v1:0")
    wrapper = ResponsesApiClient()
    assert isinstance(wrapper.provider, BedrockClaudeProvider) and wrapper.available
    monkeypatch.setenv("LAMINA_MODEL_PROVIDER", "nope")
    with pytest.raises(RuntimeError):
        configured_provider_name()
    # The wrapper passes the patient-data flag through to the gate.
    client = _FakeBedrock()
    monkeypatch.setenv("LAMINA_PROFILE", "production")
    wrapped = ResponsesApiClient(provider=BedrockClaudeProvider(client, model_id="m", approved=False))
    with pytest.raises(PatientDataNotApprovedError):
        wrapped.structured("x", {}, SCHEMA, use_case="t", schema_name="s", contains_patient_data=True)


def test_every_pilot_call_site_declares_patient_data() -> None:
    """Patient-data paths say so explicitly; the audit in docs/PILOT_DEPLOYMENT_READINESS.md lists them."""
    root = Path(mp.__file__).resolve().parents[1] / "backend" / "pilot"
    for name, expected in (("assistant.py", 2), ("public_agent.py", 1), ("triage.py", 1)):
        text = (root / name).read_text(encoding="utf-8")
        assert text.count("contains_patient_data=True") == expected, name
    assert "contains_patient_data=False" in (root / "teaching.py").read_text(encoding="utf-8")


# -------------------------------------------------------------------- profiles


GOOD = {
    "LAMINA_PROFILE": "production", "LAMINA_PRODUCT_MODE": "pilot",
    "LAMINA_DATABASE_URL": "postgresql://lamina@db.internal:5432/lamina?sslmode=require",
    "LAMINA_DOCUMENT_STORAGE": "s3", "LAMINA_S3_BUCKET": "b", "LAMINA_S3_KMS_KEY_ID": "k", "AWS_REGION": "us-east-1",
    "LAMINA_MODEL_PROVIDER": "bedrock", "LAMINA_MODEL_PATIENT_DATA_APPROVED": "true", "LAMINA_BEDROCK_MODEL_ID": "m",
    "LAMINA_SUPABASE_MFA_TOTP_ENABLED": "true", "SUPABASE_JWT_ISSUER": "https://x.supabase.co/auth/v1",
    "SUPABASE_JWKS_URL": "https://x.supabase.co/auth/v1/.well-known/jwks.json", "LAMINA_PILOT_ADMIN_USER_IDS": "op",
    "LAMINA_CORS_ORIGINS": "https://app.example", "LAMINA_PUBLIC_APP_URL": "https://app.example",
}


def test_a_complete_production_configuration_passes(tmp_path: Path) -> None:
    assert production_problems(GOOD, env_file=tmp_path / "absent.env") == []
    assert_profile_ready(GOOD, env_file=tmp_path / "absent.env")


@pytest.mark.parametrize(("change", "expected"), [
    ({"LAMINA_DATABASE_URL": "sqlite:///data/pilot.sqlite"}, "must be a Postgres URL"),
    ({"LAMINA_DATABASE_URL": "postgresql://db/lamina"}, "must require TLS"),
    ({"LAMINA_WORKFLOW_DATABASE": "data/pilot.sqlite"}, "LAMINA_WORKFLOW_DATABASE (SQLite) is set"),
    ({"LAMINA_DOCUMENT_STORAGE": "local"}, "local document storage is dev-only"),
    ({"LAMINA_E2E_TEST_AUTH": "1"}, "LAMINA_E2E_TEST_AUTH must not be set"),
    ({"LAMINA_E2E_MFA_EXEMPT_USER_IDS": "x"}, "LAMINA_E2E_MFA_EXEMPT_USER_IDS must not be set"),
    ({"LAMINA_DEV_FAKE_NPPES": "true"}, "LAMINA_DEV_FAKE_NPPES must not be set"),
    ({"LAMINA_DEBUG": "1"}, "LAMINA_DEBUG must not be set"),
    ({"LAMINA_MAIL_ADAPTER": "dev"}, "dev outbox"),
    ({"LAMINA_MODEL_PATIENT_DATA_APPROVED": "false"}, "not approved for patient data"),
    ({"LAMINA_MODEL_PROVIDER": ""}, "must be set explicitly"),
    ({"LAMINA_SUPABASE_MFA_TOTP_ENABLED": "false"}, "TOTP MFA enabled"),
    ({"SUPABASE_JWKS_URL": ""}, "SUPABASE_JWKS_URL is missing"),
    ({"LAMINA_PRODUCT_MODE": "demo"}, "must be pilot"),
    ({"LAMINA_CORS_ORIGINS": "http://app.example"}, "https origins"),
])
def test_production_refuses_each_unsafe_setting(tmp_path: Path, change: dict, expected: str) -> None:
    env = {**GOOD, **change}
    problems = production_problems(env, env_file=tmp_path / "absent.env")
    assert any(expected in problem for problem in problems), problems
    with pytest.raises(RuntimeError, match="Refusing to start in production"):
        assert_profile_ready(env, env_file=tmp_path / "absent.env")


def test_production_never_reads_secrets_from_a_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("OPENAI_API_KEY=not-a-real-key\n", encoding="utf-8")
    assert any(".env file is present" in problem for problem in production_problems(GOOD, env_file=env_file))
    problems = "\n".join(production_problems({**GOOD, "OPENAI_API_KEY": "sk-secret-value"}, env_file=env_file))
    assert "sk-secret-value" not in problems, "problems name settings, never values"


def test_profiles_default_to_dev_and_e2e_needs_the_harness() -> None:
    assert current_profile({}) == "dev"
    with pytest.raises(RuntimeError):
        current_profile({"LAMINA_PROFILE": "staging"})
    with pytest.raises(RuntimeError, match="e2e harness"):
        assert_profile_ready({"LAMINA_PROFILE": "e2e"})
    assert_profile_ready({"LAMINA_PROFILE": "e2e", "LAMINA_E2E": "1"})
