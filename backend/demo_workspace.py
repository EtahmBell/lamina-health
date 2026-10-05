"""Anonymous, server-managed workspace boundary for mutable public-demo state."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, Response

from backend.config import environment
from backend.workflow import workflow_store

DEFAULT_COOKIE_NAME = "lamina_demo_workspace"
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_-]{40,64}$")
_BOOTSTRAP_TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
BOOTSTRAP_HEADER = "x-lamina-workspace-bootstrap"


def configured_cors_origins() -> list[str]:
    origins = [
        item.strip().rstrip("/")
        for item in environment.get(
            "LAMINA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ).split(",")
        if item.strip()
    ]
    if "*" in origins:
        raise RuntimeError("LAMINA_CORS_ORIGINS must list explicit origins when cookies are enabled")
    return origins


@dataclass(frozen=True)
class DemoWorkspaceSettings:
    cookie_name: str
    secure: bool
    same_site: Literal["lax", "strict", "none"]
    domain: str | None
    ttl_seconds: int
    bootstrap_ttl_seconds: int

    @classmethod
    def from_environment(cls) -> DemoWorkspaceSettings:
        same_site = environment.get("LAMINA_DEMO_COOKIE_SAMESITE", "lax").lower()
        if same_site not in {"lax", "strict", "none"}:
            raise RuntimeError("LAMINA_DEMO_COOKIE_SAMESITE must be lax, strict, or none")
        secure = environment.get("LAMINA_DEMO_COOKIE_SECURE", "false").lower() == "true"
        if same_site == "none" and not secure:
            raise RuntimeError("SameSite=None demo cookies must also be Secure")
        ttl_hours = int(environment.get("LAMINA_DEMO_WORKSPACE_TTL_HOURS", "168"))
        if ttl_hours < 1:
            raise RuntimeError("LAMINA_DEMO_WORKSPACE_TTL_HOURS must be at least 1")
        bootstrap_ttl_seconds = int(
            environment.get("LAMINA_DEMO_BOOTSTRAP_TTL_SECONDS", "120")
        )
        if not 30 <= bootstrap_ttl_seconds <= 600:
            raise RuntimeError(
                "LAMINA_DEMO_BOOTSTRAP_TTL_SECONDS must be between 30 and 600"
            )
        return cls(
            cookie_name=environment.get("LAMINA_DEMO_COOKIE_NAME", DEFAULT_COOKIE_NAME),
            secure=secure,
            same_site=same_site,
            domain=environment.get("LAMINA_DEMO_COOKIE_DOMAIN") or None,
            ttl_seconds=ttl_hours * 60 * 60,
            bootstrap_ttl_seconds=bootstrap_ttl_seconds,
        )


def _set_cookie(response: Response, workspace_id: str, settings: DemoWorkspaceSettings) -> None:
    response.set_cookie(
        key=settings.cookie_name,
        value=workspace_id,
        max_age=settings.ttl_seconds,
        httponly=True,
        secure=settings.secure,
        samesite=settings.same_site,
        domain=settings.domain,
        path="/",
    )


def demo_workspace(
    request: Request,
    response: Response,
) -> str:
    settings = DemoWorkspaceSettings.from_environment()
    raw_candidate = request.cookies.get(settings.cookie_name)
    candidate = raw_candidate
    if candidate and not _OPAQUE_ID.fullmatch(candidate):
        candidate = None
    bootstrap_token = (
        request.headers.get(BOOTSTRAP_HEADER) if raw_candidate is None else None
    )
    bootstrap_hash = (
        hashlib.sha256(bootstrap_token.encode("ascii")).hexdigest()
        if bootstrap_token and _BOOTSTRAP_TOKEN.fullmatch(bootstrap_token)
        else None
    )
    workspace_id, created = workflow_store.resolve_demo_workspace(
        candidate,
        settings.ttl_seconds,
        bootstrap_hash,
        settings.bootstrap_ttl_seconds,
    )
    if created or candidate != workspace_id:
        _set_cookie(response, workspace_id, settings)
    return workspace_id


def demo_workspace_mutation(
    request: Request,
    workspace_id: Annotated[str, Depends(demo_workspace)],
) -> str:
    """Reject cross-origin cookie mutations even before application logic runs."""
    origin = request.headers.get("origin")
    cross_site = request.headers.get("sec-fetch-site") == "cross-site"
    if (
        origin and origin.rstrip("/") not in configured_cors_origins()
    ) or (not origin and cross_site):
        raise HTTPException(status_code=403, detail="Origin is not allowed")
    return workspace_id


DemoWorkspace = Annotated[str, Depends(demo_workspace)]
MutableDemoWorkspace = Annotated[str, Depends(demo_workspace_mutation)]
