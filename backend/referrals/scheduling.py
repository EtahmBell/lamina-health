"""Synthetic provider-availability source (Part E).

Deliberately NOT a calendar product: a minimal, structured stand-in for
"query the provider's real scheduling system," so a future real integration
has an obvious seam to replace this module without touching the coordination
logic in service.py. Slots are generated relative to "now" (never hardcoded
calendar dates) so the demo always reads as forward-looking, no matter when
it's actually run.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from backend.models import AppointmentSlot

NEW_PATIENT_ENDOCRINOLOGY = "New Endocrinology consultation"
_NEW_PATIENT_DURATION_MINUTES = 45
_CHEN_LOCATION = "Oakland, CA"

# (days from now, hour, minute) -- three plausible near-future weekday-ish
# slots, spaced out the way a real new-patient specialist schedule would be.
# Hour/minute are Dr. Chen's own clinic wall-clock time (Oakland, CA), never
# UTC (bug-fix pass, Part B) -- `starts_at` below is deliberately emitted
# without a UTC offset so the frontend's `new Date(...)` parses it as local
# time directly, displaying exactly this hour/minute everywhere (Lucy, Chen,
# scheduling details, history) instead of silently shifting by the viewing
# browser's own timezone (the actual cause of the old "3:30 AM" appointment
# -- 10:30 tagged as UTC rendered several hours earlier in US local time).
# No real timezone handling is introduced; this simply stops mislabeling a
# clinic-local time as UTC.
_CHEN_OFFSETS = ((15, 15, 30), (17, 14, 0), (20, 9, 0))


def synthetic_chen_availability(now: datetime | None = None) -> list[AppointmentSlot]:
    """Dr. Chen's known synthetic new-patient Endocrinology availability.
    Stable `slot_id`s and a fixed offset table mean repeated calls around the
    same time return the same three options -- this is "check known
    availability," never a live scheduling API call."""
    reference = now or datetime.now(UTC)
    slots = []
    for index, (days, hour, minute) in enumerate(_CHEN_OFFSETS, start=1):
        starts_at = (reference + timedelta(days=days)).replace(
            hour=hour, minute=minute, second=0, microsecond=0, tzinfo=None
        )
        slots.append(
            AppointmentSlot(
                slot_id=f"chen-slot-{index}",
                starts_at=starts_at.isoformat(timespec="minutes"),
                appointment_type=NEW_PATIENT_ENDOCRINOLOGY,
                duration_minutes=_NEW_PATIENT_DURATION_MINUTES,
                location=_CHEN_LOCATION,
            )
        )
    return slots


def open_slots(slots: list[AppointmentSlot], booked_slot_ids: frozenset[str]) -> list[AppointmentSlot]:
    """Only slots nobody holds (routing consolidation pass, Part L). Incoming
    demand -- however high its clinician-confirmed priority -- never
    cancels, bumps, or reassigns an already-booked patient's appointment.
    When nothing is open, the caller escalates (alternative route, e-consult
    if clinically appropriate, or clinic scheduling); it never displaces."""
    return [slot for slot in slots if slot.slot_id not in booked_slot_ids]
