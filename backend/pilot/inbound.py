"""Inbound fax and email adapters (run 3). Vendor-agnostic: every vendor implements
`InboundProvider.verify_and_parse(headers, body, now)` and is registered by name; the deployment
picks it by configuration (`LAMINA_FAX_PROVIDER`, `LAMINA_EMAIL_PROVIDER`), with its webhook secret
in `LAMINA_FAX_WEBHOOK_SECRET` / `LAMINA_EMAIL_WEBHOOK_SECRET` (from the environment only).

Only `mock` vendors exist here (synthetic tests, dev and e2e). Production refuses `mock`
(backend/profiles.py). A real HIPAA fax/email vendor is added as one class: its own signature check
and payload mapping onto `InboundMessage` -- the pipeline after that is unchanged.

Every request is authenticated and replay-protected:
* the signature is an HMAC-SHA256 over "<timestamp>.<raw body>" with the vendor's secret, compared
  in constant time; the timestamp must be within `TOLERANCE_SECONDS` of now;
* each vendor event id is recorded once (`inbound_webhook_receipts`, unique per provider): a replay
  of the same event creates nothing new and is answered as a duplicate.
Nothing here logs a body, a header value or a document.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

from backend.config import environment

TOLERANCE_SECONDS = 300
MAX_ATTACHMENTS = 20
SIGNATURE_HEADER = "x-lamina-mock-signature"


class WebhookRejected(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass
class InboundAttachment:
    filename: str
    content_type: str
    content: bytes


@dataclass
class InboundMessage:
    channel: str  # fax | email
    provider: str
    event_id: str
    to_address: str
    from_address: str | None
    subject: str | None = None
    body_text: str | None = None
    attachments: list[InboundAttachment] = field(default_factory=list)


class InboundProvider(Protocol):
    name: str
    channel: str

    def verify_and_parse(self, headers: Mapping[str, str], body: bytes, now: datetime) -> InboundMessage: ...


def sign(secret: str, timestamp: int, body: bytes) -> str:
    """The mock vendors' signature header value: "t=<unix seconds>,v1=<hex hmac>"."""
    digest = hmac.new(secret.encode(), str(timestamp).encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def _verify(secret: str, headers: Mapping[str, str], body: bytes, now: datetime) -> None:
    if len(secret) < 32:
        raise WebhookRejected(503, "webhook_not_configured", "This inbound channel is not configured")
    raw = {key.lower(): value for key, value in headers.items()}.get(SIGNATURE_HEADER, "")
    parts = dict(part.split("=", 1) for part in raw.split(",") if "=" in part)
    try:
        timestamp = int(parts.get("t", ""))
    except ValueError as error:
        raise WebhookRejected(401, "bad_signature", "Missing or malformed signature") from error
    if abs(now.timestamp() - timestamp) > TOLERANCE_SECONDS:
        raise WebhookRejected(401, "stale_signature", "Signature timestamp is outside the allowed window")
    expected = sign(secret, timestamp, body).split("v1=", 1)[1]
    if not hmac.compare_digest(expected, parts.get("v1", "")):
        raise WebhookRejected(401, "bad_signature", "Signature does not match")


def _payload(body: bytes) -> dict:
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as error:
        raise WebhookRejected(400, "bad_payload", "The payload is not JSON") from error
    if not isinstance(payload, dict) or not str(payload.get("event_id") or "").strip() or not str(payload.get("to") or "").strip():
        raise WebhookRejected(400, "bad_payload", "event_id and to are required")
    return payload


def _attachment(item: dict) -> InboundAttachment:
    try:
        content = base64.b64decode(str(item.get("data_base64") or ""), validate=True)
    except (binascii.Error, ValueError) as error:
        raise WebhookRejected(400, "bad_payload", "An attachment is not valid base64") from error
    return InboundAttachment(str(item.get("filename") or "attachment"), str(item.get("content_type") or ""), content)


class MockFaxProvider:
    """Synthetic fax vendor: {event_id, to, from, document: {filename, content_type, data_base64}}."""

    name = "mock"
    channel = "fax"

    def __init__(self, secret: str | None = None) -> None:
        self.secret = secret if secret is not None else environment.get("LAMINA_FAX_WEBHOOK_SECRET", "")

    def verify_and_parse(self, headers: Mapping[str, str], body: bytes, now: datetime) -> InboundMessage:
        _verify(self.secret, headers, body, now)
        payload = _payload(body)
        document = payload.get("document")
        if not isinstance(document, dict):
            raise WebhookRejected(400, "bad_payload", "A fax carries one document")
        return InboundMessage("fax", self.name, str(payload["event_id"]), str(payload["to"]), payload.get("from"),
                              attachments=[_attachment(document)])


class MockEmailProvider:
    """Synthetic email vendor: {event_id, to, from, subject, text, attachments: [...]}. The body
    text is kept as its own source document; attachments become documents."""

    name = "mock"
    channel = "email"

    def __init__(self, secret: str | None = None) -> None:
        self.secret = secret if secret is not None else environment.get("LAMINA_EMAIL_WEBHOOK_SECRET", "")

    def verify_and_parse(self, headers: Mapping[str, str], body: bytes, now: datetime) -> InboundMessage:
        _verify(self.secret, headers, body, now)
        payload = _payload(body)
        attachments = payload.get("attachments") or []
        if not isinstance(attachments, list) or len(attachments) > MAX_ATTACHMENTS:
            raise WebhookRejected(400, "bad_payload", f"At most {MAX_ATTACHMENTS} attachments")
        return InboundMessage("email", self.name, str(payload["event_id"]), str(payload["to"]).strip().casefold(),
                              payload.get("from"), subject=(payload.get("subject") or "")[:300] or None,
                              body_text=payload.get("text") or None,
                              attachments=[_attachment(item) for item in attachments if isinstance(item, dict)])


PROVIDERS: dict[str, dict[str, type]] = {"fax": {"mock": MockFaxProvider}, "email": {"mock": MockEmailProvider}}


def configured_provider(channel: str, name: str) -> InboundProvider | None:
    """The provider for this webhook URL, only if it is the one configured for the channel."""
    configured = environment.get(f"LAMINA_{channel.upper()}_PROVIDER", "").strip().casefold()
    if not configured or configured != name or name not in PROVIDERS.get(channel, {}):
        return None
    return PROVIDERS[channel][name]()


def now_utc() -> datetime:
    return datetime.now(UTC)
