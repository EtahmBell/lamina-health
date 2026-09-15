from __future__ import annotations

import json
import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
if str(REPOSITORY) not in sys.path:
    sys.path.insert(0, str(REPOSITORY))


def main() -> None:
    from backend.fhir.demo import seed_demo_patients
    from backend.fhir.medplum import MedplumClient, MedplumError, MedplumSettings

    try:
        client = MedplumClient(MedplumSettings.from_environment())
        try:
            result = seed_demo_patients(client)
        finally:
            client.close()
    except MedplumError as error:
        raise SystemExit(f"Medplum seed failed safely: {error.category}") from None
    print("Seeded synthetic Lamina demo FHIR resources (no PHI).")
    print(json.dumps({"synthetic": True, "resources": result}, indent=2))


if __name__ == "__main__":
    main()
