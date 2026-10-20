"""Re-export of the shared representation-snapshot helper.

Moved to backend/representation.py (NLP referral-preference pass, Part G/O)
so both the evaluation harness and the referral-preference confirmation flow
share one definition of "the representation changed" -- never two competing
snapshot calculations.
"""

from __future__ import annotations

from backend.representation import representation_snapshot_id

__all__ = ["representation_snapshot_id"]
