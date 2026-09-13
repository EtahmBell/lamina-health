from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from backend.models import PatientRecord

from .mapping import map_fhir_resources_to_patient

SYNTHETIC_TAG_SYSTEM = "https://lamina.health/fhir/tags"
SYNTHETIC_TAG_CODE = "synthetic-demo"
SYNTHETIC_TAG = {
    "system": SYNTHETIC_TAG_SYSTEM,
    "code": SYNTHETIC_TAG_CODE,
    "display": "Lamina synthetic demo data",
}
DEMO_PATIENT_IDENTIFIER_SYSTEM = "https://lamina.health/fhir/demo-patient"
MAX_FHIR_RESPONSE_BYTES = 2_000_000


class MedplumError(RuntimeError):
    def __init__(self, category: str) -> None:
        super().__init__(category)
        self.category = category


@dataclass(frozen=True)
class MedplumSettings:
    base_url: str
    token_url: str
    fhir_base_url: str
    client_id: str
    client_secret: str
    project_id: str
    timeout_seconds: float = 20

    @classmethod
    def from_environment(cls) -> MedplumSettings:
        base_url = os.getenv("MEDPLUM_BASE_URL", "").strip().rstrip("/")
        client_id = os.getenv("MEDPLUM_CLIENT_ID", "").strip()
        client_secret = os.getenv("MEDPLUM_CLIENT_SECRET", "").strip()
        project_id = os.getenv("MEDPLUM_PROJECT_ID", "").strip()
        if not all((base_url, client_id, client_secret, project_id)):
            raise MedplumError("medplum_not_configured")
        token_url = os.getenv("MEDPLUM_TOKEN_URL", "").strip() or f"{base_url}/oauth2/token"
        fhir_base = (
            os.getenv("MEDPLUM_FHIR_BASE_URL", "").strip().rstrip("/")
            or f"{base_url}/fhir/R4"
        )
        try:
            timeout = float(os.getenv("MEDPLUM_REQUEST_TIMEOUT_SECONDS", "20"))
        except ValueError as error:
            raise MedplumError("medplum_configuration_invalid") from error
        if timeout <= 0:
            raise MedplumError("medplum_configuration_invalid")
        return cls(base_url, token_url, fhir_base, client_id, client_secret, project_id, timeout)


def has_synthetic_tag(resource: dict[str, Any]) -> bool:
    return any(
        item.get("system") == SYNTHETIC_TAG_SYSTEM and item.get("code") == SYNTHETIC_TAG_CODE
        for item in (resource.get("meta") or {}).get("tag", [])
    )


class MedplumClient:
    def __init__(
        self,
        settings: MedplumSettings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.client = httpx.Client(timeout=settings.timeout_seconds, transport=transport)
        self._token: str | None = None
        self._token_expires_at = 0.0

    def close(self) -> None:
        self.client.close()

    def _access_token(self, force_refresh: bool = False) -> str:
        if not force_refresh and self._token and time.monotonic() < self._token_expires_at:
            return self._token
        try:
            response = self.client.post(
                self.settings.token_url,
                auth=(self.settings.client_id, self.settings.client_secret),
                data={"grant_type": "client_credentials", "scope": "openid"},
                headers={"Accept": "application/json"},
            )
        except httpx.TimeoutException as error:
            raise MedplumError("medplum_token_timeout") from error
        except httpx.HTTPError as error:
            raise MedplumError("medplum_token_unreachable") from error
        if response.status_code in {400, 401, 403}:
            raise MedplumError("medplum_authentication_failed")
        if response.status_code >= 400:
            raise MedplumError("medplum_token_upstream_error")
        try:
            payload = response.json()
            self._token = str(payload["access_token"])
            expires_in = max(int(payload.get("expires_in", 300)), 30)
        except (KeyError, TypeError, ValueError) as error:
            raise MedplumError("medplum_invalid_token_response") from error
        self._token_expires_at = time.monotonic() + max(expires_in - 30, 1)
        return self._token

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = self._access_token()
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/fhir+json"}
        if json_body is not None:
            headers["Content-Type"] = "application/fhir+json"
        url = f"{self.settings.fhir_base_url}/{path.lstrip('/')}"
        try:
            response = self.client.request(
                method, url, params=params, json=json_body, headers=headers
            )
            if response.status_code == 401 and method.upper() == "GET":
                headers["Authorization"] = f"Bearer {self._access_token(True)}"
                response = self.client.request(method, url, params=params, headers=headers)
        except httpx.TimeoutException as error:
            raise MedplumError("medplum_fhir_timeout") from error
        except httpx.HTTPError as error:
            raise MedplumError("medplum_fhir_unreachable") from error
        if response.status_code == 404:
            raise MedplumError("medplum_resource_not_found")
        if response.status_code in {401, 403}:
            raise MedplumError("medplum_access_denied")
        if response.status_code >= 400:
            raise MedplumError("medplum_fhir_operation_failed")
        if len(response.content) > MAX_FHIR_RESPONSE_BYTES:
            raise MedplumError("medplum_fhir_response_too_large")
        try:
            payload = response.json()
        except ValueError as error:
            raise MedplumError("medplum_invalid_fhir_json") from error
        if payload.get("resourceType") == "OperationOutcome":
            raise MedplumError("medplum_operation_outcome")
        return payload

    def search(self, resource_type: str, params: dict[str, str]) -> list[dict[str, Any]]:
        bundle = self.request("GET", resource_type, params={**params, "_count": "100"})
        return [
            entry["resource"]
            for entry in (bundle.get("entry") or [])[:100]
            if isinstance(entry.get("resource"), dict)
        ]

    def upsert_by_identifier(
        self,
        resource_type: str,
        system: str,
        value: str,
        resource: dict[str, Any],
    ) -> dict[str, Any]:
        matches = self.search(resource_type, {"identifier": f"{system}|{value}"})
        exact = next(
            (
                item
                for item in matches
                if any(
                    identifier.get("system") == system and identifier.get("value") == value
                    for identifier in item.get("identifier") or []
                )
            ),
            None,
        )
        if exact:
            resource = {**resource, "id": exact["id"]}
            return self.request(
                "PUT", f"{resource_type}/{quote(str(exact['id']), safe='')}", json_body=resource
            )
        return self.request("POST", resource_type, json_body=resource)


class MedplumClinicalDataSource:
    source_name = "medplum_fhir"

    def __init__(
        self,
        settings: MedplumSettings,
        *,
        client: MedplumClient | None = None,
    ) -> None:
        self.client = client or MedplumClient(settings)

    def get_patient(self, patient_id: str) -> PatientRecord | None:
        patients = self.client.search(
            "Patient", {"identifier": f"{DEMO_PATIENT_IDENTIFIER_SYSTEM}|{patient_id}"}
        )
        patient = next(
            (
                item
                for item in patients
                if has_synthetic_tag(item)
                and any(
                    identifier.get("system") == DEMO_PATIENT_IDENTIFIER_SYSTEM
                    and identifier.get("value") == patient_id
                    for identifier in item.get("identifier") or []
                )
            ),
            None,
        )
        if not patient:
            return None
        subject = f"Patient/{patient['id']}"

        def synthetic_subject(
            resource_type: str, parameter: str = "subject"
        ) -> list[dict[str, Any]]:
            return [
                item
                for item in self.client.search(resource_type, {parameter: subject})
                if (item.get(parameter) or {}).get("reference") == subject
                and has_synthetic_tag(item)
            ]

        return map_fhir_resources_to_patient(
            patient_id,
            patient,
            synthetic_subject("Condition"),
            synthetic_subject("MedicationRequest"),
            synthetic_subject("Observation"),
            synthetic_subject("Coverage", "beneficiary"),
        )

