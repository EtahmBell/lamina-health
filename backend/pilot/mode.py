"""Product mode: ``demo`` (synthetic, anonymous) or ``pilot`` (real, authenticated).

The mode is read once per app construction. An unknown value fails loudly rather
than silently falling back to the demo, so a misconfigured pilot deployment can
never start serving synthetic data.
"""

from __future__ import annotations

from typing import Literal

from backend.config import environment

ProductMode = Literal["demo", "pilot"]
PRODUCT_MODES: tuple[ProductMode, ...] = ("demo", "pilot")


def product_mode(value: str | None = None) -> ProductMode:
    raw = (value if value is not None else environment.get("LAMINA_PRODUCT_MODE", "demo"))
    normalized = raw.strip().casefold() or "demo"
    if normalized not in PRODUCT_MODES:
        raise RuntimeError("LAMINA_PRODUCT_MODE must be 'demo' or 'pilot'")
    return normalized  # type: ignore[return-value]
