"""DEV ONLY: run the pilot API with a fictional NPPES directory for usability trials.

Real pilot onboarding resolves physicians against the live public NPPES registry.
For synthetic-data trials and end-to-end browser testing we must not self-attest
as a real physician, so this launcher swaps in a tiny directory of FICTIONAL
physicians (valid-checksum test NPIs, obviously synthetic names). Everything else —
Supabase auth, approval gate, practices, referrals — is the real pilot code.

Refuses to start unless LAMINA_DEV_FAKE_NPPES=true and LAMINA_PRODUCT_MODE=pilot.
Never use this in a deployment.

    LAMINA_DEV_FAKE_NPPES=true LAMINA_PRODUCT_MODE=pilot \\
      LAMINA_WORKFLOW_DATABASE=data/pilot-dev.sqlite python -m scripts.dev_pilot_server
"""

from __future__ import annotations

import os
import sys

FICTIONAL_PHYSICIANS = {
    # NPI (Luhn-valid test numbers) -> (first, last, specialty, taxonomy, city, state)
    "1234567893": ("Avery", "Testwell", "Endocrinology, Diabetes & Metabolism", "207RE0101X", "Palo Alto", "CA"),
    "1234567802": ("Jordan", "Sampleton", "Nephrology", "207RN0300X", "Oakland", "CA"),
}


def _record(npi: str) -> dict | None:
    if npi not in FICTIONAL_PHYSICIANS:
        return None
    first, last, specialty, code, city, state = FICTIONAL_PHYSICIANS[npi]
    return {
        "number": npi, "enumeration_type": "NPI-1",
        "basic": {"first_name": first.upper(), "last_name": last.upper(), "credential": "M.D. (FICTIONAL)",
                  "status": "A", "enumeration_date": "2015-01-01", "last_updated": "2026-01-01"},
        "taxonomies": [{"code": code, "desc": specialty, "primary": True, "state": state}],
        "addresses": [{"address_purpose": "LOCATION", "address_1": "1 Test Way", "city": city.upper(),
                       "state": state, "postal_code": "940000000", "telephone_number": "555-0100"}],
    }


class FictionalNppes:
    def fetch_record(self, npi: str) -> dict | None:
        return _record(npi)

    def search(self, query: str, specialty: str, location: str, limit: int) -> tuple[list[dict], int]:
        del specialty, location
        wanted = query.casefold().split()
        hits = [record for npi in FICTIONAL_PHYSICIANS if (record := _record(npi)) and all(
            word in f"{record['basic']['first_name']} {record['basic']['last_name']}".casefold() for word in wanted)]
        return hits[:limit], len(hits)


def main() -> int:
    if os.environ.get("LAMINA_DEV_FAKE_NPPES", "").casefold() != "true" or \
            os.environ.get("LAMINA_PRODUCT_MODE", "").casefold() != "pilot":
        print("Refusing to start: set LAMINA_DEV_FAKE_NPPES=true and LAMINA_PRODUCT_MODE=pilot (dev only).")
        return 2
    import uvicorn

    from backend.api import physician_onboarding
    from backend.physician_onboarding import PhysicianOnboardingService
    from backend.provider_network.identity import NppesIdentityResolver
    from backend.workflow import WorkflowStore

    fake = FictionalNppes()
    physician_onboarding.onboarding_service = PhysicianOnboardingService(
        WorkflowStore(), NppesIdentityResolver(fake, cache_seconds=0), search_transport=fake,
    )
    from backend.main import create_app

    port = int(os.environ.get("LAMINA_API_PORT", "8000"))
    print(f"DEV pilot API with FICTIONAL NPPES on http://127.0.0.1:{port} — not for deployment.")
    uvicorn.run(create_app("pilot"), host="127.0.0.1", port=port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
