"""NPPES physician identity discovery for authenticated onboarding.

This module answers one question: "which public NPPES individual-provider record
does this NPI identify?" It is identity *discovery*, not proof that the caller
is that physician, and it is not credentialing or licensure verification.

Raw NPPES JSON never leaves this module: callers receive a normalized
`NppesIdentity`, or one of the explicit errors below. Every failure is closed —
nothing here creates or implies ownership.
"""

from __future__ import annotations

import os
import re
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime
from threading import Lock
from time import monotonic
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from backend.synthetic_data import SYNTHETIC_PHYSICIAN_NPIS

from .directory import (
    DirectoryMalformedResponseError,
    DirectoryQueryRejectedError,
    DirectoryRateLimitedError,
    DirectoryTimeoutError,
    DirectoryUnavailableError,
    LiveNppesTransport,
)

_NPI_PATTERN = re.compile(r"^\d{10}$")
_SYNTHETIC_NPIS = frozenset(SYNTHETIC_PHYSICIAN_NPIS.values())
_MAX_TAXONOMIES = 8
_MAX_LOCATIONS = 5


class IdentityLookupError(Exception):
    """Base class. `code` is a stable, user-safe identifier for the API layer."""

    code = "identity_lookup_failed"


class InvalidNpiError(IdentityLookupError):
    code = "invalid_npi"


class SyntheticIdentityError(IdentityLookupError):
    code = "synthetic_identity"


class IdentityNotFoundError(IdentityLookupError):
    code = "npi_not_found"


class IdentityNotEligibleError(IdentityLookupError):
    code = "npi_not_eligible"


class IdentityLookupUnavailableError(IdentityLookupError):
    code = "nppes_unavailable"


class IdentityLookupRateLimitedError(IdentityLookupUnavailableError):
    code = "nppes_rate_limited"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class NppesTaxonomy(_Strict):
    code: str | None = None
    description: str
    primary: bool = False
    state: str | None = None


class NppesPracticeLocation(_Strict):
    address_line: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    phone: str | None = None


class NppesIdentity(_Strict):
    npi: str = Field(pattern=r"^\d{10}$")
    first_name: str
    middle_name: str | None = None
    last_name: str
    credential: str | None = None
    display_name: str
    taxonomies: list[NppesTaxonomy] = Field(default_factory=list)
    primary_specialty: str | None = None
    practice_locations: list[NppesPracticeLocation] = Field(default_factory=list)
    enumeration_status: Literal["active"] = "active"
    enumeration_date: str | None = None
    last_updated: str | None = None
    source: Literal["NPPES"] = "NPPES"
    fetched_at: str

    def provider_identity(self) -> dict[str, Any]:
        """Flat display payload kept compatible with existing owner-scope consumers."""
        primary = next((item for item in self.taxonomies if item.primary), None) or (
            self.taxonomies[0] if self.taxonomies else None
        )
        location = self.practice_locations[0] if self.practice_locations else None
        return {
            "npi": self.npi,
            "display_name": self.display_name,
            "specialty": self.primary_specialty or "Physician",
            "taxonomy_code": primary.code if primary else None,
            "organization": None,
            "city": (location.city if location else None) or "",
            "state": (location.state if location else None) or "",
            "phone": location.phone if location else None,
            "source": "NPPES",
            "directory_disclaimer": (
                "Public NPPES directory record. Lamina used it to identify this physician; "
                "it is not credentialing or licensure verification."
            ),
        }


def npi_checksum_valid(npi: str) -> bool:
    """Luhn check over the NPI with the 80840 card-issuer prefix (CMS standard)."""
    if not _NPI_PATTERN.fullmatch(npi):
        return False
    total = 24  # Contribution of the constant "80840" prefix.
    for index, char in enumerate(reversed(npi[:9])):
        digit = int(char)
        if index % 2 == 0:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return (10 - total % 10) % 10 == int(npi[9])


def normalize_npi(value: str) -> str:
    """Strict input validation. Whitespace is tolerated; anything else is rejected."""
    if not isinstance(value, str):
        raise InvalidNpiError("Enter a 10-digit NPI")
    npi = "".join(value.split())
    if not _NPI_PATTERN.fullmatch(npi):
        raise InvalidNpiError("Enter a 10-digit NPI")
    if npi in _SYNTHETIC_NPIS:
        raise SyntheticIdentityError(
            "This NPI belongs to a synthetic Lamina demo physician and cannot be used for a "
            "pilot account"
        )
    if not npi_checksum_valid(npi):
        raise InvalidNpiError("This is not a valid NPI number. Check the digits and try again")
    return npi


def _text(value: Any, *, limit: int = 120) -> str | None:
    if value is None:
        return None
    if not isinstance(value, (str, int)):
        raise DirectoryMalformedResponseError("NPPES record field has an unexpected type")
    clean = " ".join(str(value).split())
    return clean[:limit] or None


def _title(value: str | None) -> str | None:
    return value.title() if value else None


def normalize_nppes_record(raw: Any, npi: str, fetched_at: str) -> NppesIdentity:
    """Convert one raw NPPES API record to an `NppesIdentity`, or fail closed."""
    if not isinstance(raw, dict):
        raise DirectoryMalformedResponseError("NPPES record is not an object")
    if _text(raw.get("number")) != npi:
        raise DirectoryMalformedResponseError("NPPES returned a record for a different NPI")
    if raw.get("enumeration_type") != "NPI-1":
        raise IdentityNotEligibleError(
            "This NPI belongs to an organization. Enter your individual physician NPI"
        )
    basic = raw.get("basic")
    if not isinstance(basic, dict):
        raise DirectoryMalformedResponseError("NPPES record has no basic section")
    status = _text(basic.get("status"))
    if (status and status.upper() != "A") or basic.get("deactivation_date"):
        raise IdentityNotEligibleError("This NPI is not active in NPPES")
    first, last = _text(basic.get("first_name")), _text(basic.get("last_name"))
    if not first or not last:
        raise DirectoryMalformedResponseError("NPPES record is missing a physician name")
    middle = _text(basic.get("middle_name"))
    credential = _text(basic.get("credential"), limit=40)

    raw_taxonomies = raw.get("taxonomies") or []
    if not isinstance(raw_taxonomies, list):
        raise DirectoryMalformedResponseError("NPPES taxonomies are malformed")
    taxonomies: list[NppesTaxonomy] = []
    seen: set[tuple[str | None, str]] = set()
    for item in raw_taxonomies:
        if not isinstance(item, dict):
            raise DirectoryMalformedResponseError("NPPES taxonomy is malformed")
        description = _text(item.get("desc"))
        if not description:
            continue
        code = _text(item.get("code"), limit=20)
        if (code, description) in seen:
            continue
        seen.add((code, description))
        taxonomies.append(
            NppesTaxonomy(
                code=code,
                description=description,
                primary=item.get("primary") is True,
                state=_text(item.get("state"), limit=2),
            )
        )
    taxonomies.sort(key=lambda item: not item.primary)
    taxonomies = taxonomies[:_MAX_TAXONOMIES]

    raw_addresses = [
        *(raw.get("addresses") or []),
        *(raw.get("practiceLocations") or []),
    ]
    locations: list[NppesPracticeLocation] = []
    for item in raw_addresses:
        if not isinstance(item, dict):
            raise DirectoryMalformedResponseError("NPPES address is malformed")
        if item.get("address_purpose") not in {"LOCATION", None}:
            continue  # Mailing addresses are not practice locations.
        postal = _text(item.get("postal_code"), limit=10)
        location = NppesPracticeLocation(
            address_line=_title(_text(item.get("address_1"))),
            city=_title(_text(item.get("city"))),
            state=(_text(item.get("state"), limit=2) or "").upper() or None,
            postal_code=postal[:5] if postal else None,
            phone=_text(item.get("telephone_number"), limit=20),
        )
        if location not in locations:
            locations.append(location)
    locations = locations[:_MAX_LOCATIONS]

    name = " ".join(part for part in (first, middle, last) if part).title()
    return NppesIdentity(
        npi=npi,
        first_name=first.title(),
        middle_name=_title(middle),
        last_name=last.title(),
        credential=credential,
        display_name=f"{name}, {credential}" if credential else name,
        taxonomies=taxonomies,
        primary_specialty=taxonomies[0].description if taxonomies else None,
        practice_locations=locations,
        enumeration_date=_text(basic.get("enumeration_date"), limit=10),
        last_updated=_text(basic.get("last_updated"), limit=10),
        fetched_at=fetched_at,
    )


class NppesRecordTransport(Protocol):
    def fetch_record(self, npi: str) -> dict | None: ...


def _live_lookup_enabled() -> bool:
    return os.getenv("LAMINA_NPPES_LIVE_ENABLED", "true").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


class NppesIdentityResolver:
    """Resolve one NPI to a normalized identity, with a small positive-result cache."""

    def __init__(
        self,
        transport: NppesRecordTransport | None = None,
        *,
        cache_seconds: float = 600,
        cache_size: int = 256,
        clock: Callable[[], float] = monotonic,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.transport = transport
        if transport is None and _live_lookup_enabled():
            self.transport = LiveNppesTransport()
        self.cache_seconds = cache_seconds
        self.cache_size = cache_size
        self._clock = clock
        self._now = now
        self._cache: OrderedDict[str, tuple[float, NppesIdentity]] = OrderedDict()
        self._lock = Lock()

    def lookup(self, value: str) -> NppesIdentity:
        npi = normalize_npi(value)
        with self._lock:
            cached = self._cache.get(npi)
            if cached and self._clock() - cached[0] < self.cache_seconds:
                self._cache.move_to_end(npi)
                return cached[1]
        if self.transport is None:
            raise IdentityLookupUnavailableError("NPPES lookup is not available right now")
        fetched_at = self._now().isoformat(timespec="seconds")
        try:
            raw = self.transport.fetch_record(npi)
            if raw is None:
                raise IdentityNotFoundError("No NPPES record was found for this NPI")
            identity = normalize_nppes_record(raw, npi, fetched_at)
        except DirectoryRateLimitedError as error:
            raise IdentityLookupRateLimitedError(
                "NPPES is busy right now. Try again in a minute"
            ) from error
        except DirectoryQueryRejectedError as error:
            raise InvalidNpiError("NPPES did not accept this NPI") from error
        except (DirectoryTimeoutError, DirectoryMalformedResponseError) as error:
            raise IdentityLookupUnavailableError(
                "NPPES lookup is not available right now. Try again shortly"
            ) from error
        except DirectoryUnavailableError as error:
            raise IdentityLookupUnavailableError(
                "NPPES lookup is not available right now. Try again shortly"
            ) from error
        except IdentityLookupError:
            raise
        except Exception as error:  # Unknown transport/normalization failure: fail closed.
            raise IdentityLookupUnavailableError(
                "NPPES lookup is not available right now. Try again shortly"
            ) from error
        with self._lock:
            self._cache[npi] = (self._clock(), identity)
            self._cache.move_to_end(npi)
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return identity
