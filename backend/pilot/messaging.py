"""Outbound message adapters for approved missing-information requests.

Only a human-approved request ever reaches `send`. The model never calls this.

* `dev`      (default) -- records the message in `outbound_messages` (a local outbox)
               and sends nothing externally. Used for local work and usability trials.
* `disabled` -- refuses to send; staff use the manual channel (copy + fax/phone).
* a real provider -- implement `MailSender` (e.g. a BAA-covered provider) and wire it
               in `mail_sender_from_environment`. Not implemented in this pass: a
               provider decision (and BAA) is required first; see PILOT_PHI_READINESS.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from backend.config import environment

from .store import PilotStore, new_id, now_iso, redact_sender_links

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class MailNotConfiguredError(RuntimeError):
    pass


@dataclass(frozen=True)
class MailReceipt:
    adapter: str
    message_id: str


class MailSender(Protocol):
    name: str

    def send(
        self, *, practice_id: str, referral_id: str | None, recipient: str, subject: str,
        body: str, approved_by: str,
    ) -> MailReceipt: ...


class DevOutboxMailer:
    """Writes to the local outbox table only. Nothing leaves the machine."""

    name = "dev_outbox"

    def __init__(self, store: PilotStore) -> None:
        self.store = store

    def send(
        self, *, practice_id: str, referral_id: str | None, recipient: str, subject: str,
        body: str, approved_by: str,
    ) -> MailReceipt:
        message_id = new_id("msg")
        self.store.execute([(
            ("INSERT INTO outbound_messages (id, practice_id, referral_id, adapter, recipient, "
            "subject, body, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
            # A real provider transmits `body` (with the secure link) and keeps nothing.
            # This local outbox is storage, so it keeps the message with the link removed.
            (message_id, practice_id, referral_id, self.name, recipient, subject,
             redact_sender_links(body), approved_by, now_iso()),
        )])
        return MailReceipt(self.name, message_id)


class DisabledMailer:
    name = "disabled"

    def send(self, **_: object) -> MailReceipt:
        raise MailNotConfiguredError(
            "Email sending is not configured. Send the request yourself and mark it as sent"
        )


def mail_sender_from_environment(store: PilotStore) -> MailSender:
    adapter = environment.get("LAMINA_MAIL_ADAPTER", "dev").strip().casefold()
    if adapter == "dev":
        return DevOutboxMailer(store)
    if adapter == "disabled":
        return DisabledMailer()
    raise RuntimeError(
        "LAMINA_MAIL_ADAPTER must be 'dev' or 'disabled' until a BAA-covered provider is wired"
    )


def public_app_url() -> str:
    return environment.get("LAMINA_PUBLIC_APP_URL", "http://127.0.0.1:5173").rstrip("/")
