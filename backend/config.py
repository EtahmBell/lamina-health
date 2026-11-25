from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ENV_FILE = REPOSITORY_ROOT / ".env"


def load_repository_environment(path: Path = REPOSITORY_ENV_FILE) -> bool:
    """Load local configuration without overriding explicitly exported values."""
    return load_dotenv(dotenv_path=path, override=False)


# Production and the hosted synthetic deployment (demo) never read a file: settings and secrets come
# only from the environment (a secrets manager / the host's variables).
if os.environ.get("LAMINA_PROFILE", "").strip().casefold() not in {"production", "demo"}:
    load_repository_environment()
environment = os.environ
