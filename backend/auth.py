"""Supabase access-token verification for protected Lamina API operations."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from threading import RLock
from time import monotonic
from typing import Annotated, Any, Protocol

import httpx
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.config import environment


class AuthenticationError(ValueError):
    pass


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str


class TokenVerifier(Protocol):
    def verify(self, token: str) -> AuthenticatedUser: ...


class UnconfiguredTokenVerifier:
    def verify(self, token: str) -> AuthenticatedUser:
        del token
        raise AuthenticationError("Supabase JWT verification is not configured")


class SupabaseTokenVerifier:
    """Verify Supabase JWTs locally using a bounded, cached JWKS document."""

    def __init__(
        self,
        *,
        issuer: str,
        jwks_url: str,
        audience: str,
        cache_seconds: int = 300,
        jwks_loader: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        self.issuer = issuer.rstrip("/")
        self.jwks_url = jwks_url
        self.audience = audience
        self.cache_seconds = cache_seconds
        self._jwks_loader = jwks_loader or self._fetch_jwks
        self._cached_jwks: dict[str, Any] | None = None
        self._cached_at = 0.0
        self._lock = RLock()

    @classmethod
    def from_environment(cls) -> SupabaseTokenVerifier:
        issuer = environment.get("SUPABASE_JWT_ISSUER", "").strip()
        jwks_url = environment.get("SUPABASE_JWKS_URL", "").strip()
        audience = environment.get("SUPABASE_JWT_AUDIENCE", "authenticated").strip()
        if not issuer or not jwks_url or not audience:
            raise AuthenticationError("Supabase JWT verification is not configured")
        try:
            cache_seconds = int(environment.get("SUPABASE_JWKS_CACHE_SECONDS", "300"))
        except ValueError as error:
            raise AuthenticationError("SUPABASE_JWKS_CACHE_SECONDS must be an integer") from error
        return cls(
            issuer=issuer,
            jwks_url=jwks_url,
            audience=audience,
            cache_seconds=max(30, cache_seconds),
        )

    def _fetch_jwks(self) -> dict[str, Any]:
        response = httpx.get(self.jwks_url, timeout=5.0)
        response.raise_for_status()
        document = response.json()
        if not isinstance(document, dict) or not isinstance(document.get("keys"), list):
            raise AuthenticationError("Supabase JWKS response is invalid")
        return document

    def _jwks(self, *, refresh: bool = False) -> dict[str, Any]:
        with self._lock:
            expired = monotonic() - self._cached_at >= self.cache_seconds
            if refresh or self._cached_jwks is None or expired:
                try:
                    self._cached_jwks = self._jwks_loader()
                except (httpx.HTTPError, ValueError, TypeError) as error:
                    raise AuthenticationError("Unable to load Supabase signing keys") from error
                self._cached_at = monotonic()
            return self._cached_jwks

    @staticmethod
    def _matching_key(document: dict[str, Any], kid: str) -> Any | None:
        for key_data in document.get("keys", []):
            if key_data.get("kid") == kid:
                return jwt.PyJWK.from_dict(key_data).key
        return None

    def verify(self, token: str) -> AuthenticatedUser:
        try:
            header = jwt.get_unverified_header(token)
            algorithm = header.get("alg")
            kid = header.get("kid")
            if algorithm not in {"RS256", "ES256"} or not isinstance(kid, str) or not kid:
                raise AuthenticationError("Access token uses an unsupported signing key")
            key = self._matching_key(self._jwks(), kid)
            if key is None:
                key = self._matching_key(self._jwks(refresh=True), kid)
            if key is None:
                raise AuthenticationError("Access token signing key is unknown")
            claims = jwt.decode(
                token,
                key,
                algorithms=[algorithm],
                audience=self.audience,
                issuer=self.issuer,
                options={"require": ["exp", "iss", "sub", "aud"]},
            )
        except AuthenticationError:
            raise
        except jwt.PyJWTError as error:
            raise AuthenticationError("Access token is invalid") from error
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject.strip():
            raise AuthenticationError("Access token subject is invalid")
        return AuthenticatedUser(id=subject)


@lru_cache(maxsize=1)
def get_token_verifier() -> TokenVerifier:
    try:
        return SupabaseTokenVerifier.from_environment()
    except AuthenticationError:
        return UnconfiguredTokenVerifier()


bearer = HTTPBearer(auto_error=False)


def _authenticate(
    credentials: HTTPAuthorizationCredentials | None,
    verifier: TokenVerifier,
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.casefold() != "bearer":
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        return verifier.verify(credentials.credentials)
    except AuthenticationError as error:
        raise HTTPException(status_code=401, detail="Invalid access token") from error


def require_authenticated_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> AuthenticatedUser:
    return _authenticate(credentials, verifier)


def optional_authenticated_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> AuthenticatedUser | None:
    if credentials is None:
        return None
    return _authenticate(credentials, verifier)
