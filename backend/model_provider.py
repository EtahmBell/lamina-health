"""One model-provider interface behind the existing `ResponsesApiClient` wrapper (run 2).

Providers:
* `openai`   -- the existing OpenAI Responses API path. Every call sends `store=False` (no stored
                responses); a call carrying patient data never uses tools such as web search.
* `bedrock`  -- Anthropic Claude via Amazon Bedrock (Converse API; structured output through a
                single forced tool whose input schema is the requested JSON schema). Bedrock is
                HIPAA-eligible under the AWS BAA. Tested with mocks only.
* `anthropic`-- DEV ONLY: Claude through the direct Anthropic API (ANTHROPIC_API_KEY,
                LAMINA_ANTHROPIC_MODEL, LAMINA_ANTHROPIC_EFFORT). No BAA: it is never approved for
                patient data, whatever any flag says; the demo and production profiles refuse it
                (backend/profiles.py) and `guarded_call` refuses it outside dev/e2e as well.
* `disabled` -- no model; every caller falls back to its deterministic path.

Patient data. `LAMINA_MODEL_PATIENT_DATA_APPROVED=true` declares that the configured provider is
covered by a signed BAA for patient data (ePHI). Every call says whether it carries patient data;
in the production profile such a call refuses to run unless that flag is set (and production
refuses to start with an unapproved provider at all -- backend/profiles.py). In the demo profile (the
hosted synthetic deployment) the flag is refused at startup and ignored here: nothing is approved.

Settings: LAMINA_MODEL_PROVIDER = openai | bedrock | disabled. When unset, the previous behaviour
stands: `openai` if LAMINA_OPENAI_ENABLED is true, else `disabled`. OpenAI: OPENAI_API_KEY,
LAMINA_OPENAI_MODEL. Bedrock: LAMINA_BEDROCK_MODEL_ID, AWS_REGION (credentials from the instance
or task role -- never from files). Nothing here logs prompts, payloads or outputs.
"""

from __future__ import annotations

import json
import logging
from time import perf_counter
from typing import Any, Protocol

from backend.config import environment

logger = logging.getLogger(__name__)
PROVIDERS = ("openai", "bedrock", "anthropic", "disabled")
DEV_ONLY_PROVIDERS = frozenset({"anthropic"})


class PatientDataNotApprovedError(RuntimeError):
    """A call carrying patient data, in production, to a provider not approved (BAA) for it."""


class ModelProvider(Protocol):
    name: str

    @property
    def available(self) -> bool: ...

    @property
    def approved_for_patient_data(self) -> bool: ...

    def structured(self, instructions: str, payload: dict[str, Any], schema: dict[str, Any], *, use_case: str,
                   schema_name: str, contains_patient_data: bool, web_search: bool = False) -> dict: ...


def _flag(name: str, default: str = "false") -> bool:
    return environment.get(name, default).strip().casefold() in {"1", "true", "yes", "on"}


def _profile() -> str:
    from backend.profiles import current_profile

    return current_profile()


def patient_data_approved() -> bool:
    """The operator's BAA declaration -- never honoured on the hosted synthetic deployment."""
    return _flag("LAMINA_MODEL_PATIENT_DATA_APPROVED") and _profile() != "demo"


def _approval(explicit: bool | None) -> bool:
    if _profile() == "demo":
        return False
    return patient_data_approved() if explicit is None else explicit


def configured_provider_name() -> str:
    raw = environment.get("LAMINA_MODEL_PROVIDER", "").strip().casefold()
    if not raw:
        enabled = environment.get("LAMINA_OPENAI_ENABLED", environment.get("LAMINA_RESPONSES_ENABLED", "false"))
        return "openai" if enabled.strip().casefold() in {"1", "true", "yes", "on"} else "disabled"
    if raw not in PROVIDERS:
        raise RuntimeError("LAMINA_MODEL_PROVIDER must be openai, bedrock, anthropic (dev only) or disabled")
    return raw


class DisabledProvider:
    name = "disabled"
    available = False
    approved_for_patient_data = False

    def structured(self, *args: Any, **kwargs: Any) -> dict:
        raise RuntimeError("AI service is not configured")


class OpenAIProvider:
    name = "openai"

    def __init__(self, sdk_client: Any | None = None, *, model: str | None = None, api_key: str | None = None,
                 enabled: bool = True, approved: bool | None = None) -> None:
        self.model = (model if model is not None else environment.get("LAMINA_OPENAI_MODEL", "")).strip()
        self.api_key = api_key if api_key is not None else environment.get("OPENAI_API_KEY", "")
        self.enabled = enabled
        self._approved = approved
        self._sdk_client = sdk_client

    @property
    def available(self) -> bool:
        return bool(self.enabled and self.model and (self.api_key or self._sdk_client))

    @property
    def approved_for_patient_data(self) -> bool:
        return _approval(self._approved)

    def _client(self) -> Any:
        if self._sdk_client is None:
            from openai import OpenAI

            self._sdk_client = OpenAI(api_key=self.api_key, timeout=20.0, max_retries=1)
        return self._sdk_client

    def structured(self, instructions: str, payload: dict[str, Any], schema: dict[str, Any], *, use_case: str,
                   schema_name: str, contains_patient_data: bool, web_search: bool = False) -> dict:
        if web_search and contains_patient_data:
            raise PatientDataNotApprovedError("Web search is never used with patient data")
        response = self._client().responses.create(
            model=self.model,
            instructions=instructions,
            input=json.dumps(payload),
            tools=[{"type": "web_search"}] if web_search else [],
            # Never stored on the provider side (no stored responses, no conversation state).
            store=False,
            text={"format": {"type": "json_schema", "name": schema_name, "strict": True, "schema": schema}},
        )
        usage = getattr(response, "usage", None)
        self.last_usage = {"input_tokens": getattr(usage, "input_tokens", None),
                           "output_tokens": getattr(usage, "output_tokens", None)} if usage is not None else None
        output_text = getattr(response, "output_text", None)
        if output_text is None and isinstance(response, dict):
            output_text = response.get("output_text")
        if not isinstance(output_text, str):
            raise TypeError("No structured response output")
        return json.loads(output_text)


class BedrockClaudeProvider:
    """Anthropic Claude on Amazon Bedrock via the Converse API. The JSON schema becomes the input
    schema of one tool the model is required to call; its input is the structured result."""

    name = "bedrock"

    def __init__(self, client: Any | None = None, *, model_id: str | None = None, region: str | None = None,
                 approved: bool | None = None, max_tokens: int = 2000) -> None:
        self.model_id = (model_id if model_id is not None else environment.get("LAMINA_BEDROCK_MODEL_ID", "")).strip()
        self.region = (region if region is not None else environment.get("AWS_REGION", "")).strip() or None
        self._approved = approved
        self._client_instance = client
        self.max_tokens = max_tokens

    @property
    def available(self) -> bool:
        return bool(self.model_id)

    @property
    def approved_for_patient_data(self) -> bool:
        return _approval(self._approved)

    def _client(self) -> Any:
        if self._client_instance is None:
            import boto3
            from botocore.config import Config

            self._client_instance = boto3.client("bedrock-runtime", region_name=self.region,
                                                 config=Config(read_timeout=30, retries={"max_attempts": 2}))
        return self._client_instance

    def structured(self, instructions: str, payload: dict[str, Any], schema: dict[str, Any], *, use_case: str,
                   schema_name: str, contains_patient_data: bool, web_search: bool = False) -> dict:
        if web_search:
            raise RuntimeError("Web search isn't available on Bedrock")
        tool = schema_name[:64]
        response = self._client().converse(
            modelId=self.model_id,
            system=[{"text": instructions}],
            messages=[{"role": "user", "content": [{"text": json.dumps(payload)}]}],
            inferenceConfig={"maxTokens": self.max_tokens, "temperature": 0},
            toolConfig={"tools": [{"toolSpec": {"name": tool, "description": f"Return the {schema_name} result.",
                                                "inputSchema": {"json": schema}}}],
                        "toolChoice": {"tool": {"name": tool}}},
        )
        usage = response.get("usage") or {}
        self.last_usage = {"input_tokens": usage.get("inputTokens"), "output_tokens": usage.get("outputTokens")}
        for block in response.get("output", {}).get("message", {}).get("content", []):
            use = block.get("toolUse")
            if use and use.get("name") == tool and isinstance(use.get("input"), dict):
                return use["input"]
        raise TypeError("No structured response output")


class AnthropicProvider:
    """DEV ONLY. Claude through the direct Anthropic API, structured output via
    `output_config.format` (JSON schema). Never approved for patient data: there is no BAA."""

    name = "anthropic"
    approved_for_patient_data = False  # never, in any profile

    def __init__(self, client: Any | None = None, *, model: str | None = None, effort: str | None = None,
                 api_key: str | None = None, max_tokens: int = 16000) -> None:
        self.model = (model if model is not None else environment.get("LAMINA_ANTHROPIC_MODEL", "claude-opus-5-5")).strip()
        self.effort = (effort if effort is not None else environment.get("LAMINA_ANTHROPIC_EFFORT", "low")).strip() or None
        self._api_key = api_key if api_key is not None else environment.get("ANTHROPIC_API_KEY", "")
        self._client_instance = client
        self.max_tokens = max_tokens
        self.last_usage: dict | None = None

    @property
    def available(self) -> bool:
        return bool(self.model and (self._api_key or self._client_instance is not None))

    def _client(self) -> Any:
        if self._client_instance is None:
            import anthropic  # dev extra only; the deployment build never installs it

            self._client_instance = anthropic.Anthropic(api_key=self._api_key, timeout=60.0, max_retries=1)
        return self._client_instance

    def structured(self, instructions: str, payload: dict[str, Any], schema: dict[str, Any], *, use_case: str,
                   schema_name: str, contains_patient_data: bool, web_search: bool = False) -> dict:
        if web_search:
            raise RuntimeError("Web search isn't used with the dev Anthropic provider")
        output_config: dict[str, Any] = {"format": {"type": "json_schema", "schema": anthropic_schema(schema)}}
        if self.effort:
            output_config["effort"] = self.effort
        response = self._client().messages.create(
            model=self.model, max_tokens=self.max_tokens, system=instructions,
            messages=[{"role": "user", "content": json.dumps(payload)}], output_config=output_config,
        )
        usage = getattr(response, "usage", None)
        self.last_usage = {"input_tokens": getattr(usage, "input_tokens", None),
                           "output_tokens": getattr(usage, "output_tokens", None)} if usage is not None else None
        if getattr(response, "stop_reason", None) in {"refusal", "max_tokens"}:
            raise TypeError(f"No structured response output ({response.stop_reason})")
        text = next((block.text for block in response.content if getattr(block, "type", "") == "text"), None)
        if not isinstance(text, str):
            raise TypeError("No structured response output")
        return json.loads(text)


def anthropic_schema(schema: Any) -> Any:
    """The same JSON schema in the subset Anthropic structured outputs accept: a nullable
    `type: [T, "null"]` becomes `anyOf`, and array-size limits other than minItems 0/1 are dropped
    (the callers' validators still enforce them)."""
    if isinstance(schema, list):
        return [anthropic_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out = {key: anthropic_schema(value) for key, value in schema.items() if key != "maxItems"}
    if isinstance(out.get("minItems"), int) and out["minItems"] > 1:
        out.pop("minItems")
    kind = out.get("type")
    if isinstance(kind, list) and "null" in kind and len(kind) == 2:
        base = next(item for item in kind if item != "null")
        branch: dict[str, Any] = {"type": base, **{k: v for k, v in out.items() if k not in {"type", "enum"}}}
        if "enum" in out:
            branch["enum"] = [value for value in out["enum"] if value is not None]
        return {"anyOf": [branch, {"type": "null"}]}
    return out


def provider_from_environment() -> ModelProvider:
    name = configured_provider_name()
    if name == "openai":
        return OpenAIProvider()
    if name == "bedrock":
        return BedrockClaudeProvider()
    if name == "anthropic":
        return AnthropicProvider()
    return DisabledProvider()


def guarded_call(provider: ModelProvider, instructions: str, payload: dict[str, Any], schema: dict[str, Any], *,
                 use_case: str, schema_name: str, contains_patient_data: bool, web_search: bool = False) -> dict:
    """The one place every model call goes through: the patient-data gate, then the provider,
    with a metadata-only log line (no prompt, payload or output)."""
    from backend.profiles import current_profile

    if not provider.available:
        raise RuntimeError("AI service is not configured")
    if provider.name in DEV_ONLY_PROVIDERS and current_profile() not in {"dev", "e2e"}:
        raise PatientDataNotApprovedError("This model provider is for local development only")
    if contains_patient_data and current_profile() == "production" and not provider.approved_for_patient_data:
        logger.warning("lamina_ai_call", extra={"use_case": use_case, "success": False, "provider": provider.name,
                                                "refused": "patient_data_not_approved"})
        raise PatientDataNotApprovedError("This model provider isn't approved for patient data")
    started = perf_counter()
    try:
        result = provider.structured(instructions, payload, schema, use_case=use_case, schema_name=schema_name,
                                     contains_patient_data=contains_patient_data, web_search=web_search)
    except PatientDataNotApprovedError:
        raise
    except Exception as error:
        logger.warning("lamina_ai_call", extra={"use_case": use_case, "success": False, "provider": provider.name,
                                                "latency_ms": round((perf_counter() - started) * 1000),
                                                "fallback_used": True, "error_type": type(error).__name__})
        raise RuntimeError("AI service is temporarily unavailable") from error
    logger.info("lamina_ai_call", extra={"use_case": use_case, "success": True, "provider": provider.name,
                                         "latency_ms": round((perf_counter() - started) * 1000), "fallback_used": False})
    return result
