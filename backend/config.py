from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ENV_FILE = REPOSITORY_ROOT / ".env"


def load_repository_environment(path: Path = REPOSITORY_ENV_FILE) -> bool:
    """Load local configuration without overriding explicitly exported values."""
    return load_dotenv(dotenv_path=path, override=False)


load_repository_environment()
environment = os.environ
