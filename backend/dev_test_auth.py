"""DEV/E2E ONLY: a local test identity provider (sign-up, sign-in, TOTP MFA) for the Playwright
harness. Never part of a deployment.

Why: the e2e specs must create brand-new invitee accounts and set up two-step sign-in (invite ->
accept -> MFA -> first sign-in) without a real identity provider, without typing anyone's real
password, and without storing a TOTP secret anywhere. The pre-existing e2e roles keep using real
DEV Supabase sessions; for those three captured accounts only, MFA is treated as satisfied (they
were captured before MFA was required) -- the explicit, gated "MFA bypass".

How it is gated (all must hold, else `install_dev_test_auth` raises and the launcher exits):
* nothing in `backend.main` imports this module; only `scripts/dev_pilot_server.py` installs it;
* LAMINA_E2E=1 and LAMINA_E2E_TEST_AUTH=1, LAMINA_PRODUCT_MODE=pilot, LAMINA_DEV_FAKE_NPPES=true;
* LAMINA_DATABASE_URL is the dedicated e2e database (Postgres `lamina_e2e` on loopback);
* no production marker in the environment (LAMINA_ENVIRONMENT=production, RAILWAY_*, VERCEL, ...);
* the launcher binds to 127.0.0.1 only.

Tokens are HS256 with a random per-process key, issuer `lamina-dev-test-auth`; a production
verifier (Supabase JWKS, RS256/ES256 only) never accepts them. Passwords are scrypt-hashed in
memory; nothing is written to disk or logged.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from threading import RLock
from typing import Annotated, Any

import jwt
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.auth import AuthenticatedUser, AuthenticationError, TokenVerifier

ISSUER = "lamina-dev-test-auth"
KEY_ID = "lamina-dev-test"
AUDIENCE = "authenticated"
TOKEN_SECONDS = 3600
E2E_DATABASE = "lamina_e2e"
PRODUCTION_MARKERS = (
    "RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "VERCEL", "VERCEL_ENV", "RENDER",
    "FLY_APP_NAME", "K_SERVICE", "DYNO", "HEROKU_APP_ID", "AWS_EXECUTION_ENV", "ECS_CONTAINER_METADATA_URI",
)


def refusal_reasons(env: Mapping[str, str] | None = None) -> list[str]:
    """Every reason the dev test identity provider must not run here (empty = allowed)."""
    env = os.environ if env is None else env
    problems = []
    if env.get("LAMINA_E2E") != "1":
        problems.append("LAMINA_E2E=1 is not set")
    if env.get("LAMINA_E2E_TEST_AUTH") != "1":
        problems.append("LAMINA_E2E_TEST_AUTH=1 is not set")
    if env.get("LAMINA_PRODUCT_MODE", "").casefold() != "pilot":
        problems.append("LAMINA_PRODUCT_MODE is not pilot")
    if env.get("LAMINA_DEV_FAKE_NPPES", "").casefold() != "true":
        problems.append("LAMINA_DEV_FAKE_NPPES is not true")
    # The dedicated e2e database: Postgres `lamina_e2e` on loopback (run 2).
    from urllib.parse import urlparse

    url = urlparse(env.get("LAMINA_DATABASE_URL", ""))
    if url.path.strip("/") != E2E_DATABASE or url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        problems.append("the database is not the dedicated e2e database")
    if env.get("LAMINA_PROFILE", "").strip().casefold() == "production":
        problems.append("LAMINA_PROFILE is production")
    for name in ("LAMINA_ENVIRONMENT", "ENVIRONMENT", "APP_ENV", "NODE_ENV"):
        if env.get(name, "").casefold() in {"production", "prod"}:
            problems.append(f"{name} says production")
    found = [name for name in PRODUCTION_MARKERS if env.get(name)]
    if found:
        problems.append("a hosting/production environment is detected")
    return problems


def assert_dev_test_auth_allowed(env: Mapping[str, str] | None = None) -> None:
    problems = refusal_reasons(env)
    if problems:
        raise RuntimeError("Dev test sign-in refused (e2e only): " + "; ".join(problems))


def totp(secret: str, at: float | None = None, step: int = 30, digits: int = 6) -> str:
    """RFC 6238 TOTP (SHA-1), as authenticator apps compute it."""
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    counter = int((time.time() if at is None else at) // step)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


@dataclass
class _Account:
    id: str
    email: str
    password_hash: bytes
    salt: bytes
    factors: dict[str, dict[str, Any]] = field(default_factory=dict)
    revoked_before: int = 0


class DevTestIdentityProvider:
    """In-memory accounts for one launcher process. Restarting the launcher forgets them."""

    def __init__(self) -> None:
        self._key = secrets.token_bytes(32)
        self._accounts: dict[str, _Account] = {}
        self._lock = RLock()

    # --------------------------------------------------------------- tokens

    def _session(self, account: _Account, aal: str) -> dict:
        now = int(time.time())
        token = jwt.encode(
            {"sub": account.id, "email": account.email, "aal": aal, "iat": now, "exp": now + TOKEN_SECONDS,
             "iss": ISSUER, "aud": AUDIENCE, "amr": [{"method": "password", "timestamp": now}]
             + ([{"method": "totp", "timestamp": now}] if aal == "aal2" else [])},
            self._key, algorithm="HS256", headers={"kid": KEY_ID})
        return {"access_token": token, "expires_at": now + TOKEN_SECONDS, "user": {"id": account.id, "email": account.email}}

    def verify(self, token: str) -> AuthenticatedUser:
        try:
            claims = jwt.decode(token, self._key, algorithms=["HS256"], audience=AUDIENCE, issuer=ISSUER,
                                options={"require": ["exp", "iss", "sub", "aud", "iat"]})
        except jwt.PyJWTError as error:
            raise AuthenticationError("Access token is invalid") from error
        account = self._by_id(claims["sub"])
        if not account or claims["iat"] < account.revoked_before:
            raise AuthenticationError("Access token is invalid")
        return AuthenticatedUser(id=account.id, email=account.email, aal=claims.get("aal", "aal1"),
                                 issued_at=int(claims["iat"]))

    def _by_id(self, user_id: str) -> _Account | None:
        return next((account for account in self._accounts.values() if account.id == user_id), None)

    @staticmethod
    def _hash(password: str, salt: bytes) -> bytes:
        return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1)

    # -------------------------------------------------------------- accounts

    def sign_up(self, email: str, password: str) -> dict:
        address = email.strip().casefold()
        if "@" not in address or len(password) < 12:
            raise HTTPException(422, {"code": "invalid_account", "message": "Use an email and a password of 12+ characters"})
        with self._lock:
            if address in self._accounts:
                raise HTTPException(409, {"code": "account_exists", "message": "An account with this email exists. Sign in"})
            salt = secrets.token_bytes(16)
            account = _Account(id=f"devtest-{secrets.token_hex(8)}", email=address, password_hash=self._hash(password, salt), salt=salt)
            self._accounts[address] = account
        return self._session(account, "aal1")

    def sign_in(self, email: str, password: str) -> dict:
        account = self._accounts.get(email.strip().casefold())
        if not account or not hmac.compare_digest(account.password_hash, self._hash(password, account.salt)):
            raise HTTPException(400, {"code": "invalid_credentials", "message": "Invalid login credentials"})
        return self._session(account, "aal1")

    def sign_out_everywhere(self, user: AuthenticatedUser) -> None:
        account = self._by_id(user.id)
        if account:
            account.revoked_before = int(time.time()) + 1

    # ------------------------------------------------------------------- MFA

    def mfa_state(self, user: AuthenticatedUser) -> dict:
        account = self._by_id(user.id)
        factors = [{"id": factor_id, "friendly_name": "Authenticator", "status": factor["status"]}
                   for factor_id, factor in (account.factors if account else {}).items()]
        return {"current": user.aal, "next": "aal2" if any(f["status"] == "verified" for f in factors) else "aal1",
                "factors": factors}

    def enroll(self, user: AuthenticatedUser) -> dict:
        account = self._by_id(user.id)
        if not account:
            raise HTTPException(401, {"code": "invalid_session", "message": "Sign in again"})
        account.factors = {key: value for key, value in account.factors.items() if value["status"] == "verified"}
        secret = base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")
        factor_id = f"factor-{secrets.token_hex(6)}"
        account.factors[factor_id] = {"secret": secret, "status": "unverified"}
        uri = f"otpauth://totp/Lamina%20(dev%20test):{account.email}?secret={secret}&issuer=Lamina%20(dev%20test)"
        return {"factor_id": factor_id, "secret": secret, "uri": uri}

    def verify_factor(self, user: AuthenticatedUser, factor_id: str, code: str) -> dict:
        account = self._by_id(user.id)
        factor = account.factors.get(factor_id) if account else None
        now = time.time()
        if not account or not factor or code.strip() not in {totp(factor["secret"], now + drift) for drift in (-30, 0, 30)}:
            raise HTTPException(422, {"code": "invalid_code", "message": "That code didn’t match. Try the current code"})
        factor["status"] = "verified"
        return self._session(account, "aal2")


class DevTestCompositeVerifier:
    """Dev test tokens (by key id) go to the dev provider; everything else to the real verifier.
    The three captured e2e Supabase accounts count as MFA-verified (the gated bypass)."""

    def __init__(self, provider: DevTestIdentityProvider, primary: TokenVerifier, mfa_exempt_user_ids: frozenset[str]) -> None:
        self.provider, self.primary, self.mfa_exempt = provider, primary, mfa_exempt_user_ids

    def verify(self, token: str) -> AuthenticatedUser:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as error:
            raise AuthenticationError("Access token is invalid") from error
        if header.get("kid") == KEY_ID:
            return self.provider.verify(token)
        user = self.primary.verify(token)
        if user.id in self.mfa_exempt and user.aal != "aal2":
            return replace(user, aal="aal2")
        return user


# Module level: FastAPI resolves these (string) annotations from the module's globals.
Authorization = Annotated[str | None, Header()]


class _Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)


class _Verify(BaseModel):
    model_config = ConfigDict(extra="forbid")
    factor_id: str = Field(min_length=1, max_length=64)
    code: str = Field(min_length=6, max_length=8)


class _Scope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: str = "global"


def dev_test_auth_router(provider: DevTestIdentityProvider) -> APIRouter:
    router = APIRouter(prefix="/api/dev/test-auth", tags=["dev-test-auth"])

    def user_of(authorization: str | None) -> AuthenticatedUser:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, {"code": "invalid_session", "message": "Sign in again"})
        try:
            return provider.verify(authorization[7:])
        except AuthenticationError as error:
            raise HTTPException(401, {"code": "invalid_session", "message": "Sign in again"}) from error

    @router.post("/sign-up")
    def sign_up(body: _Credentials) -> dict:
        return provider.sign_up(body.email, body.password)

    @router.post("/sign-in")
    def sign_in(body: _Credentials) -> dict:
        return provider.sign_in(body.email, body.password)

    @router.post("/sign-out")
    def sign_out(body: _Scope, authorization: Authorization = None) -> dict:
        provider.sign_out_everywhere(user_of(authorization))
        return {"ok": True}

    @router.post("/mfa/state")
    def mfa_state(authorization: Authorization = None) -> dict:
        return provider.mfa_state(user_of(authorization))

    @router.post("/mfa/enroll")
    def enroll(authorization: Authorization = None) -> dict:
        return provider.enroll(user_of(authorization))

    @router.post("/mfa/verify")
    def verify(body: _Verify, authorization: Authorization = None) -> dict:
        return provider.verify_factor(user_of(authorization), body.factor_id, body.code)

    return router


def install_dev_test_auth(app: Any, env: Mapping[str, str] | None = None) -> DevTestIdentityProvider:
    """Called only by the DEV launcher. Refuses (raises) unless every e2e/dev condition holds."""
    env = os.environ if env is None else env
    assert_dev_test_auth_allowed(env)
    from backend.auth import get_token_verifier

    provider = DevTestIdentityProvider()
    exempt = frozenset(value.strip() for value in env.get("LAMINA_E2E_MFA_EXEMPT_USER_IDS", "").split(",") if value.strip())
    primary = get_token_verifier()
    app.include_router(dev_test_auth_router(provider))
    app.dependency_overrides[get_token_verifier] = lambda: DevTestCompositeVerifier(provider, primary, exempt)
    return provider
