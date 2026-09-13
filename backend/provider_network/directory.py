from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

from .models import AgentStatus, PhysicianNetworkProfile, ProviderSource, ReservedAgentIdentity


def _default_database_candidates() -> list[Path]:
    repository = Path(__file__).resolve().parents[2]
    configured = os.getenv("LAMINA_NPPES_DATABASE", "").strip()
    candidates = [repository / "data" / "processed" / "lamina.sqlite"]
    if configured:
        candidates.insert(0, Path(configured).expanduser())
    candidates.append(repository.parent / "lamina-og" / "lamina-starter" / "data" / "processed" / "lamina.sqlite")
    return candidates


def discover_nppes_database() -> Path | None:
    return next((path.resolve() for path in _default_database_candidates() if path.is_file()), None)


def _fts_prefix_query(text: str) -> str:
    tokens = re.findall(r"[\w'-]+", text, flags=re.UNICODE)
    return " ".join(f'"{token.replace(chr(34), "")}"*' for token in tokens)


def _status(value: str) -> AgentStatus:
    normalized = value.casefold()
    mapped = {
        "claim_pending": AgentStatus.VERIFICATION_PENDING,
        "configuring": AgentStatus.VERIFIED,
        "paused": AgentStatus.DISABLED,
    }.get(normalized)
    return mapped or AgentStatus(normalized)


class NppesDirectory:
    """Read-only adapter for the audited legacy NPPES/FTS schema."""

    def __init__(self, database: Path | None = None) -> None:
        self.database = database.resolve() if database else discover_nppes_database()
        self._record_count: int | None = None

    @property
    def available(self) -> bool:
        return self.database is not None and self.database.is_file()

    def _connect(self) -> sqlite3.Connection:
        if not self.database:
            raise RuntimeError("NPPES directory is not configured")
        connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    def count(self) -> int:
        if self._record_count is not None:
            return self._record_count
        if not self.available:
            return 0
        with self._connect() as connection:
            self._record_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM physicians WHERE upper(source)='NPPES' AND active=1"
                ).fetchone()[0]
            )
        return self._record_count

    def search(self, terms: str, limit: int) -> list[PhysicianNetworkProfile]:
        query = _fts_prefix_query(terms)
        if not self.available or not query:
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT p.npi, p.display_name, p.primary_specialty,
                       p.primary_taxonomy_code, p.organization_name, p.city,
                       p.state, p.phone, a.status AS agent_status
                FROM physician_fts f
                JOIN physicians p ON p.npi = f.npi
                JOIN agents a ON a.physician_npi = p.npi
                WHERE physician_fts MATCH ? AND upper(p.source) = 'NPPES' AND p.active = 1
                ORDER BY bm25(physician_fts, 8.0, 3.0, 1.0, 0.5), p.last_name, p.first_name
                LIMIT ?
                """,
                (query, limit),
            ).fetchall()
        return [self._profile(row) for row in rows]

    def get(self, npi: str) -> PhysicianNetworkProfile | None:
        if not self.available:
            return None
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT p.npi, p.display_name, p.primary_specialty,
                       p.primary_taxonomy_code, p.organization_name, p.city,
                       p.state, p.phone, a.status AS agent_status
                FROM physicians p JOIN agents a ON a.physician_npi = p.npi
                WHERE p.npi = ? AND upper(p.source) = 'NPPES' AND p.active = 1
                """,
                (npi,),
            ).fetchone()
        return self._profile(row) if row else None

    @staticmethod
    def _profile(row: sqlite3.Row) -> PhysicianNetworkProfile:
        return PhysicianNetworkProfile(
            npi=str(row["npi"]),
            display_name=row["display_name"],
            specialty=row["primary_specialty"] or "Physician",
            taxonomy_code=row["primary_taxonomy_code"] or None,
            organization=row["organization_name"] or None,
            city=(row["city"] or "").title(),
            state=(row["state"] or "").upper(),
            phone=row["phone"] or None,
            source=ProviderSource.NPPES,
            agent=ReservedAgentIdentity(
                id=f"agent-{row['npi']}", status=_status(row["agent_status"])
            ),
            directory_disclaimer=(
                "Public NPPES directory record. This does not indicate that the physician "
                "joined, verified, or authorised Lamina."
            ),
        )
