"""Configuration profiles (run 2): dev, e2e, production. `LAMINA_PROFILE` (default dev).

* dev        -- local development; synthetic data; SQLite or local Postgres; local documents.
* e2e        -- the Playwright harness (it sets LAMINA_E2E=1); dev-only test sign-in allowed there.
* production -- real deployment. `production_problems()` lists everything that makes the
                configuration unsafe; `create_app` refuses to start if there is any. Secrets come
                only from the environment (injected from a secrets manager): in production the
                repository `.env` file is never loaded, and its presence is itself refused.

Nothing here prints secret values: problems name the setting, never its value.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

PROFILES = ("dev", "e2e", "production")
REPOSITORY_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"

# Never allowed in production (test/dev-only switches and debug flags).
FORBIDDEN_IN_PRODUCTION = (
    "LAMINA_E2E", "LAMINA_E2E_TEST_AUTH", "LAMINA_E2E_MFA_EXEMPT_USER_IDS", "LAMINA_DEV_FAKE_NPPES",
    "LAMINA_DEBUG", "DEBUG", "PYTHONDEVMODE", "LAMINA_DEMO_VERIFICATION_ENABLED",
)
REQUIRED_SECRETS = (
    "SUPABASE_JWT_ISSUER", "SUPABASE_JWKS_URL", "LAMINA_DATABASE_URL", "LAMINA_PILOT_ADMIN_USER_IDS",
    "LAMINA_CORS_ORIGINS", "LAMINA_PUBLIC_APP_URL",
)


def current_profile(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    raw = env.get("LAMINA_PROFILE", "dev").strip().casefold() or "dev"
    if raw not in PROFILES:
        raise RuntimeError("LAMINA_PROFILE must be dev, e2e or production")
    return raw


def _on(value: str | None) -> bool:
    return (value or "").strip().casefold() in {"1", "true", "yes", "on"}


def production_problems(env: Mapping[str, str] | None = None, *, env_file: Path = REPOSITORY_ENV_FILE) -> list[str]:
    """Everything that makes this environment unfit for production (empty = fit)."""
    env = os.environ if env is None else env
    problems: list[str] = []
    if env.get("LAMINA_PRODUCT_MODE", "").strip().casefold() != "pilot":
        problems.append("LAMINA_PRODUCT_MODE must be pilot (the synthetic demo never runs in production)")
    # Database: Postgres only.
    database = env.get("LAMINA_DATABASE_URL", "").strip()
    if not database.startswith(("postgresql://", "postgresql+psycopg://", "postgres://")):
        problems.append("LAMINA_DATABASE_URL must be a Postgres URL (SQLite is dev-only)")
    elif "sslmode=require" not in database and "sslmode=verify-full" not in database:
        problems.append("LAMINA_DATABASE_URL must require TLS (sslmode=require or verify-full)")
    if env.get("LAMINA_WORKFLOW_DATABASE"):
        problems.append("LAMINA_WORKFLOW_DATABASE (SQLite) is set")
    # Documents: private, encrypted S3 only.
    if env.get("LAMINA_DOCUMENT_STORAGE", "local").strip().casefold() != "s3":
        problems.append("LAMINA_DOCUMENT_STORAGE must be s3 (local document storage is dev-only)")
    else:
        for name in ("LAMINA_S3_BUCKET", "LAMINA_S3_KMS_KEY_ID", "AWS_REGION"):
            if not env.get(name, "").strip():
                problems.append(f"{name} is missing")
    if env.get("LAMINA_PILOT_DOCUMENT_DIR"):
        problems.append("LAMINA_PILOT_DOCUMENT_DIR (local document storage) is set")
    # Test auth, dev switches, debug flags.
    for name in FORBIDDEN_IN_PRODUCTION:
        if env.get(name, "").strip() and env.get(name, "").strip().casefold() not in {"0", "false", "no", "off"}:
            problems.append(f"{name} must not be set in production")
    if env.get("LAMINA_MAIL_ADAPTER", "").strip().casefold() == "dev":
        problems.append("LAMINA_MAIL_ADAPTER=dev (the dev outbox) is not for production")
    # Model provider: none, or one approved for patient data (BAA).
    provider = env.get("LAMINA_MODEL_PROVIDER", "").strip().casefold()
    if not provider:
        problems.append("LAMINA_MODEL_PROVIDER must be set explicitly (openai, bedrock or disabled)")
    elif provider not in {"openai", "bedrock", "disabled"}:
        problems.append("LAMINA_MODEL_PROVIDER must be openai, bedrock or disabled")
    elif provider != "disabled":
        if not _on(env.get("LAMINA_MODEL_PATIENT_DATA_APPROVED")):
            problems.append(f"the {provider} model provider is not approved for patient data "
                            "(LAMINA_MODEL_PATIENT_DATA_APPROVED requires a signed BAA)")
        needed = ("OPENAI_API_KEY", "LAMINA_OPENAI_MODEL") if provider == "openai" else ("LAMINA_BEDROCK_MODEL_ID", "AWS_REGION")
        problems.extend(f"{name} is missing" for name in needed if not env.get(name, "").strip())
    if _on(env.get("LAMINA_PILOT_LLM_EXTRACTION_ENABLED")) and provider in {"", "disabled"}:
        problems.append("LAMINA_PILOT_LLM_EXTRACTION_ENABLED is on without an approved model provider")
    # Identity: Supabase with TOTP MFA (the API enforces it; the project must allow enrolment).
    if not _on(env.get("LAMINA_SUPABASE_MFA_TOTP_ENABLED")):
        problems.append("LAMINA_SUPABASE_MFA_TOTP_ENABLED must confirm the Supabase project has TOTP MFA enabled")
    issuer = env.get("SUPABASE_JWT_ISSUER", "")
    if issuer and not issuer.startswith("https://"):
        problems.append("SUPABASE_JWT_ISSUER must be an https URL")
    # Secrets: present, and only from the environment.
    problems.extend(f"{name} is missing" for name in REQUIRED_SECRETS if not env.get(name, "").strip())
    origins = env.get("LAMINA_CORS_ORIGINS", "")
    if origins and any(origin.strip().startswith("http://") for origin in origins.split(",")):
        problems.append("LAMINA_CORS_ORIGINS must be https origins")
    if env_file.exists():
        problems.append("a repository .env file is present; production secrets come only from the environment")
    return problems


def assert_profile_ready(env: Mapping[str, str] | None = None, *, env_file: Path = REPOSITORY_ENV_FILE) -> None:
    """Called by create_app: the production profile refuses to start with any problem."""
    env = os.environ if env is None else env
    profile = current_profile(env)
    if profile == "production":
        problems = production_problems(env, env_file=env_file)
        if problems:
            raise RuntimeError("Refusing to start in production:\n  - " + "\n  - ".join(problems))
    elif profile == "e2e" and env.get("LAMINA_E2E") != "1":
        raise RuntimeError("The e2e profile runs only inside the e2e harness (LAMINA_E2E=1)")
