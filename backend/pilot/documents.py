"""Private referral document storage.

Files are written under a server-side directory that is never mounted as static
content; the only way to read one is the authenticated, practice-checked download
route. Storage keys are random and unrelated to filenames.

Text extraction in this pass covers plain-text uploads only. PDF/image text
extraction (and OCR for faxes) is a documented follow-up: such files are stored
with `extraction_status='unsupported'` and contribute no automatic evidence, so
an unread document can never satisfy a requirement.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
from pathlib import Path
from typing import Protocol

from backend.config import environment

ALLOWED_CONTENT_TYPES = {
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/tiff": ".tif",
}
MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
_PDF_MAGIC = b"%PDF-"
_SIGNATURES = {
    "application/pdf": (_PDF_MAGIC,),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/tiff": (b"II*\x00", b"MM\x00*"),
}
_FORM_FEED = "\f"


class DocumentRejectedError(ValueError):
    pass


class DocumentStorage(Protocol):
    def put(self, practice_id: str, content: bytes, suffix: str) -> str: ...
    def get(self, storage_key: str) -> bytes: ...


class LocalDocumentStorage:
    """Disk storage for local/pilot use. Production PHI requires an encrypted,
    access-logged volume or bucket under a BAA (see docs/PILOT_PHI_READINESS.md)."""

    def __init__(self, root: Path | None = None) -> None:
        default = Path(__file__).resolve().parents[2] / "data" / "pilot_documents"
        self.root = (root or Path(environment.get("LAMINA_PILOT_DOCUMENT_DIR", str(default)))).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, storage_key: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.[a-z]{3}", storage_key):
            raise DocumentRejectedError("Invalid storage key")
        path = (self.root / storage_key).resolve()
        if self.root not in path.parents:
            raise DocumentRejectedError("Invalid storage key")
        return path

    def put(self, practice_id: str, content: bytes, suffix: str) -> str:
        folder = re.sub(r"[^A-Za-z0-9_-]", "_", practice_id)
        storage_key = f"{folder}/{secrets.token_urlsafe(24)}{suffix}"
        path = self._path(storage_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "xb") as handle:
            handle.write(content)
        try:
            os.chmod(path, 0o600)
        except OSError:  # Best effort on platforms without POSIX modes.
            pass
        return storage_key

    def get(self, storage_key: str) -> bytes:
        return self._path(storage_key).read_bytes()


def safe_filename(name: str | None) -> str:
    base = Path(name or "document").name
    cleaned = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip()[:120]
    return cleaned or "document"


def validate_document(content: bytes, content_type: str) -> str:
    """Returns the canonical suffix, or raises. Sniffs magic bytes so a renamed
    executable cannot be stored under a document content type."""
    media_type = content_type.split(";")[0].strip().casefold()
    if media_type not in ALLOWED_CONTENT_TYPES:
        raise DocumentRejectedError("Upload a PDF, plain-text, PNG, JPEG, or TIFF file")
    if not content:
        raise DocumentRejectedError("The uploaded file is empty")
    if len(content) > MAX_DOCUMENT_BYTES:
        raise DocumentRejectedError("Files must be 15 MB or smaller")
    signatures = _SIGNATURES.get(media_type)
    if signatures and not any(content.startswith(signature) for signature in signatures):
        raise DocumentRejectedError("The file contents do not match its type")
    if media_type == "text/plain":
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise DocumentRejectedError("Plain-text files must be UTF-8") from error
    return ALLOWED_CONTENT_TYPES[media_type]


def extract_pages(content: bytes, content_type: str) -> tuple[str, list[str]]:
    """(extraction_status, pages). Plain text splits pages on form feeds."""
    media_type = content_type.split(";")[0].strip().casefold()
    if media_type != "text/plain":
        return "unsupported", []
    text = content.decode("utf-8")
    pages = [page.strip() for page in text.split(_FORM_FEED)]
    if not any(pages):
        return "empty", []
    return "extracted", pages


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
