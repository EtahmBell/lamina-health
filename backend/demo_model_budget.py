"""Model-spend protection for the hosted synthetic deployment (LAMINA_PROFILE=demo).

The demo is public, so every model call there goes through `DemoModelBudget.admit()` first
(called by `backend.model_provider.guarded_call`):

* per session and per client IP: at most N calls in a sliding window
  (LAMINA_DEMO_MODEL_PER_SESSION_LIMIT, default 20; LAMINA_DEMO_MODEL_PER_IP_LIMIT, default 40;
  LAMINA_DEMO_MODEL_WINDOW_SECONDS, default 600);
* per UTC day, for the whole deployment: LAMINA_DEMO_MODEL_DAILY_CAP calls (default 300; 0 turns
  model calls off). The count is persisted in a small SQLite file (LAMINA_DEMO_MODEL_USAGE_DB,
  default next to LAMINA_WORKFLOW_DATABASE, i.e. on the Railway volume) so a restart doesn't reset it.

A refused call raises `ModelLimitReached` (a RuntimeError): every caller already falls back to its
deterministic, non-AI behaviour when a model call fails. The request is marked so the API answers
with the `X-Lamina-AI-Limited` header and the frontend shows a clear "AI paused" note.

Who is calling comes from `bind_caller` (an ASGI middleware sets it per request: a hash of the
demo session cookie or bearer token, and a hash of the client IP -- never the raw values).
In-process windows assume one replica (railway.json pins numReplicas = 1).
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
from collections import defaultdict, deque
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic

from backend.config import environment


class ModelLimitReached(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(f"Demo AI limit reached ({reason})")
        self.reason = reason  # session | ip | daily_cap


@dataclass
class Caller:
    session: str = "anonymous"
    ip: str = "unknown"
    limited: list[str] = field(default_factory=list)  # reasons hit during this request


_caller: ContextVar[Caller | None] = ContextVar("lamina_model_caller", default=None)
LIMITED_HEADER = "X-Lamina-AI-Limited"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def bind_caller(session: str | None, ip: str | None) -> Caller:
    caller = Caller(_hash(session) if session else "anonymous", _hash(ip) if ip else "unknown")
    _caller.set(caller)
    return caller


def current_caller() -> Caller:
    return _caller.get() or Caller()


def _int(name: str, default: int) -> int:
    try:
        return max(0, int(environment.get(name, str(default)).strip()))
    except ValueError:
        return default


def usage_db_path() -> Path:
    configured = environment.get("LAMINA_DEMO_MODEL_USAGE_DB", "").strip()
    if configured:
        return Path(configured)
    workflow = environment.get("LAMINA_WORKFLOW_DATABASE", "").strip()
    base = Path(workflow).parent if workflow else Path(__file__).resolve().parents[1] / "data"
    return base / "demo_model_usage.sqlite"


class DemoModelBudget:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _db(self) -> sqlite3.Connection:
        path = self.path or usage_db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path, timeout=5, isolation_level=None)
        db.execute("CREATE TABLE IF NOT EXISTS demo_model_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)")
        return db

    def used_today(self) -> int:
        db = self._db()
        try:
            row = db.execute("SELECT calls FROM demo_model_usage WHERE day = ?", (datetime.now(UTC).date().isoformat(),)).fetchone()
            return int(row[0]) if row else 0
        finally:
            db.close()

    def _window(self, key: str, limit: int, window: float, now: float) -> bool:
        hits = self._hits[key]
        while hits and now - hits[0] >= window:
            hits.popleft()
        return len(hits) < limit

    def admit(self, caller: Caller | None = None) -> None:
        """Count one model call, or raise ModelLimitReached (and mark the request)."""
        caller = caller or current_caller()
        window = float(_int("LAMINA_DEMO_MODEL_WINDOW_SECONDS", 600) or 600)
        per_session = _int("LAMINA_DEMO_MODEL_PER_SESSION_LIMIT", 20)
        per_ip = _int("LAMINA_DEMO_MODEL_PER_IP_LIMIT", 40)
        cap = _int("LAMINA_DEMO_MODEL_DAILY_CAP", 300)
        now = monotonic()
        with self._lock:
            reason = None
            if not self._window(f"s:{caller.session}", per_session, window, now):
                reason = "session"
            elif not self._window(f"i:{caller.ip}", per_ip, window, now):
                reason = "ip"
            else:
                reason = self._take_daily(cap)
            if reason:
                caller.limited.append(reason)
                raise ModelLimitReached(reason)
            self._hits[f"s:{caller.session}"].append(now)
            self._hits[f"i:{caller.ip}"].append(now)

    def _take_daily(self, cap: int) -> str | None:
        """Atomically count today's call against the cap (persisted)."""
        if cap <= 0:
            return "daily_cap"
        day = datetime.now(UTC).date().isoformat()
        db = self._db()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT calls FROM demo_model_usage WHERE day = ?", (day,)).fetchone()
            used = int(row[0]) if row else 0
            if used >= cap:
                db.execute("ROLLBACK")
                return "daily_cap"
            db.execute("INSERT INTO demo_model_usage (day, calls) VALUES (?, 1) "
                       "ON CONFLICT(day) DO UPDATE SET calls = calls + 1", (day,))
            db.execute("COMMIT")
            return None
        finally:
            db.close()

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


budget = DemoModelBudget()


def client_ip(scope_client: tuple | None, headers: dict[str, str]) -> str | None:
    """The client IP; behind Railway's proxy, LAMINA_TRUST_PROXY=true reads X-Forwarded-For."""
    host = scope_client[0] if scope_client else None
    if environment.get("LAMINA_TRUST_PROXY", "false").strip().casefold() == "true":
        forwarded = headers.get("x-forwarded-for", "").split(",")[0].strip()
        host = forwarded or host
    return host


class DemoCallerMiddleware:
    """Binds the caller for each request and, if a demo limit was hit while answering it, adds
    `X-Lamina-AI-Limited: <reasons>` so the frontend can say the AI is paused."""

    def __init__(self, app, cookie_name: str) -> None:
        self.app = app
        self.cookie_name = cookie_name

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        cookies = dict(part.strip().split("=", 1) for part in headers.get("cookie", "").split(";") if "=" in part)
        session = cookies.get(self.cookie_name) or headers.get("authorization")
        caller = bind_caller(session, client_ip(scope.get("client"), headers))

        async def tagged_send(message):
            if message["type"] == "http.response.start" and caller.limited:
                message = {**message, "headers": [*message.get("headers", []),
                                                   (LIMITED_HEADER.lower().encode(), ",".join(sorted(set(caller.limited))).encode())]}
            await send(message)

        await self.app(scope, receive, tagged_send)
