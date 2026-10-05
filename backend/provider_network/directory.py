from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx

from .models import (
    AgentStatus,
    DirectorySearchStatus,
    PhysicianNetworkProfile,
    ProviderSource,
    ReservedAgentIdentity,
)

NPPES_API_URL = "https://npiregistry.cms.hhs.gov/api/"
_AUTO = object()


class DirectoryUnavailableError(RuntimeError):
    pass


class NppesTransport(Protocol):
    def search(
        self, query: str, specialty: str, location: str, limit: int
    ) -> tuple[list[dict], int]: ...
    def get(self, npi: str) -> dict | None: ...


class LiveNppesTransport:
    """Small read-only adapter for the public CMS NPI Registry API."""

    def __init__(
        self, client: httpx.Client | None = None, timeout_seconds: float | None = None
    ) -> None:
        self.client = client or httpx.Client()
        self.timeout_seconds = timeout_seconds or float(
            os.getenv("LAMINA_NPPES_TIMEOUT_SECONDS", "10")
        )

    def _request(self, parameters: dict[str, str | int]) -> dict:
        try:
            response = self.client.get(
                NPPES_API_URL,
                params={"version": "2.1", **parameters},
                timeout=self.timeout_seconds,
                headers={"Accept": "application/json", "User-Agent": "Lamina/0.1"},
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise DirectoryUnavailableError(
                "The live NPPES directory is temporarily unavailable"
            ) from error
        if not isinstance(payload, dict) or not isinstance(payload.get("results", []), list):
            raise DirectoryUnavailableError("The live NPPES directory returned an invalid response")
        return payload

    @staticmethod
    def _parameters(query: str, specialty: str, location: str, limit: int) -> dict:
        parameters: dict[str, str | int] = {"enumeration_type": "NPI-1", "limit": min(limit, 40)}
        clean_query = " ".join(query.split())
        if clean_query.isdigit() and len(clean_query) == 10:
            parameters["number"] = clean_query
        elif clean_query:
            parts = clean_query.split()
            if len(parts) == 1:
                parameters["last_name"] = f"{parts[0]}*"
            else:
                parameters["first_name"] = f"{parts[0]}*"
                parameters["last_name"] = f"{parts[-1]}*"
        if specialty.strip():
            parameters["taxonomy_description"] = specialty.strip()
        if location.strip():
            parts = [part.strip() for part in location.split(",") if part.strip()]
            if parts and len(parts[-1]) == 2:
                parameters["state"] = parts[-1].upper()
                if len(parts) > 1:
                    parameters["city"] = parts[-2]
            else:
                parameters["city"] = location.strip()
        return parameters

    def search(
        self, query: str, specialty: str, location: str, limit: int
    ) -> tuple[list[dict], int]:
        payload = self._request(self._parameters(query, specialty, location, limit))
        return payload.get("results", []), int(payload.get("result_count", 0))

    def get(self, npi: str) -> dict | None:
        payload = self._request({"number": npi, "limit": 1})
        results = payload.get("results", [])
        return results[0] if results else None


@dataclass(frozen=True)
class DirectorySearchResult:
    profiles: list[PhysicianNetworkProfile]
    status: DirectorySearchStatus
    backend: str
    total: int
    message: str | None = None


def _default_database_candidates() -> list[Path]:
    repository = Path(__file__).resolve().parents[2]
    configured = os.getenv("LAMINA_NPPES_DATABASE", "").strip()
    candidates = [repository / "data" / "processed" / "lamina.sqlite"]
    if configured:
        candidates.insert(0, Path(configured).expanduser())
    return candidates


def discover_nppes_database() -> Path | None:
    return next((path.resolve() for path in _default_database_candidates() if path.is_file()), None)


def _fts_prefix_query(text: str) -> str:
    tokens = re.findall(r"[\w'-]+", text, flags=re.UNICODE)
    return " ".join(f'"{token.replace(chr(34), "")}"*' for token in tokens)


def _live_enabled() -> bool:
    return os.getenv("LAMINA_NPPES_LIVE_ENABLED", "true").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


class NppesDirectory:
    """Read-only NPPES directory using a local snapshot or the live CMS API."""

    def __init__(
        self, database: Path | None | object = _AUTO, transport: NppesTransport | None = None
    ) -> None:
        automatic = database is _AUTO
        discovered = discover_nppes_database() if automatic else database
        self.database = discovered.resolve() if isinstance(discovered, Path) else None
        self.transport = transport or (
            LiveNppesTransport()
            if automatic and self.database is None and _live_enabled()
            else None
        )
        self._record_count: int | None = None

    @property
    def backend(self) -> str:
        if self.database is not None and self.database.is_file():
            return "local_snapshot"
        if self.transport is not None:
            return "live_api"
        return "unavailable"

    @property
    def available(self) -> bool:
        return self.backend != "unavailable"

    def _connect(self) -> sqlite3.Connection:
        if not self.database or not self.database.is_file():
            raise DirectoryUnavailableError("NPPES directory is not configured")
        connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    def count(self) -> int:
        if self._record_count is not None:
            return self._record_count
        if self.backend != "local_snapshot":
            return 0
        with self._connect() as connection:
            self._record_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM physicians WHERE upper(source)='NPPES' AND active=1"
                ).fetchone()[0]
            )
        return self._record_count

    def search_diagnostic(
        self, query: str, specialty: str, location: str, limit: int
    ) -> DirectorySearchResult:
        terms = " ".join(value.strip() for value in (query, specialty, location) if value.strip())
        if not terms:
            return DirectorySearchResult(
                [],
                DirectorySearchStatus.INVALID_QUERY,
                self.backend,
                self.count(),
                "Enter a physician name, specialty, location, or NPI",
            )
        if self.backend == "unavailable":
            return DirectorySearchResult(
                [],
                DirectorySearchStatus.UNAVAILABLE,
                "unavailable",
                0,
                "The NPPES directory is temporarily unavailable",
            )
        try:
            if self.backend == "local_snapshot":
                profiles, total = self._search_local(terms, limit), self.count()
            else:
                raw, total = self.transport.search(query, specialty, location, limit)
                profiles = [self._live_profile(item) for item in raw]
        except (DirectoryUnavailableError, sqlite3.Error):
            return DirectorySearchResult(
                [],
                DirectorySearchStatus.UNAVAILABLE,
                self.backend,
                0,
                "The NPPES directory is temporarily unavailable",
            )
        return DirectorySearchResult(
            profiles,
            DirectorySearchStatus.AVAILABLE if profiles else DirectorySearchStatus.NO_RESULTS,
            self.backend,
            total,
            None if profiles else "No NPPES physicians matched this search",
        )

    def search(self, terms: str, limit: int) -> list[PhysicianNetworkProfile]:
        return self.search_diagnostic(terms, "", "", limit).profiles

    def _search_local(self, terms: str, limit: int) -> list[PhysicianNetworkProfile]:
        query = _fts_prefix_query(terms)
        if not query:
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT p.npi, p.display_name, p.primary_specialty,
                          p.primary_taxonomy_code, p.organization_name, p.city,
                          p.state, p.phone, a.status AS agent_status
                   FROM physician_fts f JOIN physicians p ON p.npi = f.npi
                   JOIN agents a ON a.physician_npi = p.npi
                   WHERE physician_fts MATCH ? AND upper(p.source)='NPPES' AND p.active=1
                   ORDER BY bm25(physician_fts, 8.0, 3.0, 1.0, 0.5), p.last_name, p.first_name
                   LIMIT ?""",
                (query, limit),
            ).fetchall()
        return [self._profile(row) for row in rows]

    def get(self, npi: str) -> PhysicianNetworkProfile | None:
        if self.backend == "unavailable":
            return None
        if self.backend == "live_api":
            raw = self.transport.get(npi)
            return self._live_profile(raw) if raw else None
        with self._connect() as connection:
            row = connection.execute(
                """SELECT p.npi, p.display_name, p.primary_specialty,
                          p.primary_taxonomy_code, p.organization_name, p.city,
                          p.state, p.phone, a.status AS agent_status
                   FROM physicians p JOIN agents a ON a.physician_npi=p.npi
                   WHERE p.npi=? AND upper(p.source)='NPPES' AND p.active=1""",
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
            agent=ReservedAgentIdentity(id=f"agent-{row['npi']}", status=AgentStatus.RESERVED),
            directory_disclaimer="Public NPPES directory record. This does not indicate that the physician joined, verified, or authorised Lamina.",
        )

    @staticmethod
    def _live_profile(item: dict) -> PhysicianNetworkProfile:
        basic, taxonomies, addresses = (
            item.get("basic") or {},
            item.get("taxonomies") or [],
            item.get("addresses") or [],
        )
        taxonomy = next((value for value in taxonomies if value.get("primary")), None) or (
            taxonomies[0] if taxonomies else {}
        )
        address = next(
            (value for value in addresses if value.get("address_purpose") == "LOCATION"),
            addresses[0] if addresses else {},
        )
        name = " ".join(
            part
            for part in (basic.get("first_name"), basic.get("middle_name"), basic.get("last_name"))
            if part
        ).title()
        credential = basic.get("credential")
        display_name = (
            basic.get("organization_name")
            if item.get("enumeration_type") == "NPI-2"
            else (f"{name}, {credential}" if credential else name)
        )
        npi = str(item.get("number", ""))
        return PhysicianNetworkProfile(
            npi=npi,
            display_name=display_name or f"NPI {npi}",
            specialty=taxonomy.get("desc") or "Physician",
            taxonomy_code=taxonomy.get("code") or None,
            organization=basic.get("organization_name") or None,
            city=(address.get("city") or "").title(),
            state=(address.get("state") or "").upper(),
            phone=address.get("telephone_number") or None,
            source=ProviderSource.NPPES,
            agent=ReservedAgentIdentity(id=f"agent-{npi}", status=AgentStatus.RESERVED),
            directory_disclaimer="Public NPPES directory record. This does not indicate that the physician joined, verified, or authorised Lamina.",
        )
