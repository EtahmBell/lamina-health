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
from urllib.parse import quote

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
    """Where referral documents live. Keys are random and practice-prefixed; nothing is public.
    `signed_url` returns a short-lived download URL (S3), or None when the storage can't sign
    (local: the authenticated API streams the bytes instead)."""

    kind: str

    def put(self, practice_id: str, content: bytes, suffix: str) -> str: ...
    def get(self, storage_key: str) -> bytes: ...
    def signed_url(self, storage_key: str, filename: str, content_type: str, expires_seconds: int) -> str | None: ...


_KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.[a-z]{3}")
SIGNED_URL_MAX_SECONDS = 300


def _new_key(practice_id: str, suffix: str) -> str:
    folder = re.sub(r"[^A-Za-z0-9_-]", "_", practice_id)
    return f"{folder}/{secrets.token_urlsafe(24)}{suffix}"


class LocalDocumentStorage:
    """Disk storage for dev and e2e only. Production refuses to start with it (backend/profiles.py):
    production PHI goes to the S3 storage below (private bucket, KMS encryption, under a BAA)."""

    kind = "local"

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
        storage_key = _new_key(practice_id, suffix)
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

    def signed_url(self, storage_key: str, filename: str, content_type: str, expires_seconds: int) -> str | None:
        del storage_key, filename, content_type, expires_seconds
        return None  # the authenticated API streams local files


class StorageMisconfiguredError(RuntimeError):
    pass


class S3DocumentStorage:
    """Amazon S3 (HIPAA-eligible under the AWS BAA). Private bucket only: every object is written
    with server-side encryption (SSE-KMS with the configured key; refuses without one), never with
    a public ACL, and downloads are presigned GET URLs that expire within 5 minutes, issued only
    after the API has checked the reader's practice access. `verify()` reports a bucket that allows
    public access or has no SSE-KMS default encryption (production refuses to start then)."""

    kind = "s3"

    def __init__(self, bucket: str, kms_key_id: str, *, region: str | None = None, client: object | None = None,
                 prefix: str = "referral-documents/") -> None:
        if not bucket or not kms_key_id:
            raise StorageMisconfiguredError("S3 document storage needs a bucket and a KMS key id")
        self.bucket, self.kms_key_id, self.prefix = bucket, kms_key_id, prefix
        if client is None:
            import boto3
            from botocore.config import Config

            # Signature V4 is required to download SSE-KMS objects with a presigned URL.
            client = boto3.client("s3", region_name=region, config=Config(signature_version="s3v4"))
        self.client = client

    def _object_key(self, storage_key: str) -> str:
        if not _KEY_PATTERN.fullmatch(storage_key):
            raise DocumentRejectedError("Invalid storage key")
        return f"{self.prefix}{storage_key}"

    def put(self, practice_id: str, content: bytes, suffix: str) -> str:
        storage_key = _new_key(practice_id, suffix)
        self.client.put_object(  # type: ignore[attr-defined]
            Bucket=self.bucket, Key=self._object_key(storage_key), Body=content,
            ServerSideEncryption="aws:kms", SSEKMSKeyId=self.kms_key_id,
            ContentType="application/octet-stream", CacheControl="no-store, private",
        )
        return storage_key

    def get(self, storage_key: str) -> bytes:
        response = self.client.get_object(Bucket=self.bucket, Key=self._object_key(storage_key))  # type: ignore[attr-defined]
        return response["Body"].read()

    def signed_url(self, storage_key: str, filename: str, content_type: str, expires_seconds: int) -> str | None:
        expires = max(1, min(int(expires_seconds), SIGNED_URL_MAX_SECONDS))
        disposition = "attachment; filename*=UTF-8''" + quote(filename)
        return self.client.generate_presigned_url(  # type: ignore[attr-defined]
            "get_object",
            Params={"Bucket": self.bucket, "Key": self._object_key(storage_key), "ResponseContentType": content_type,
                    "ResponseContentDisposition": disposition, "ResponseCacheControl": "no-store, private"},
            ExpiresIn=expires,
        )

    def verify(self) -> list[str]:
        """Problems that make this bucket unfit for PHI (empty = fine)."""
        problems = []
        try:
            block = self.client.get_public_access_block(Bucket=self.bucket)["PublicAccessBlockConfiguration"]  # type: ignore[attr-defined]
            if not all(block.get(key) for key in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")):
                problems.append("the bucket does not block all public access")
        except Exception:  # noqa: BLE001 -- no configuration at all is the same finding
            problems.append("the bucket has no public access block")
        try:
            rules = self.client.get_bucket_encryption(Bucket=self.bucket)["ServerSideEncryptionConfiguration"]["Rules"]  # type: ignore[attr-defined]
            if not any(rule.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm") == "aws:kms" for rule in rules):
                problems.append("the bucket's default encryption is not SSE-KMS")
        except Exception:  # noqa: BLE001
            problems.append("the bucket has no default encryption")
        return problems


def document_storage_from_environment() -> DocumentStorage:
    """LAMINA_DOCUMENT_STORAGE=local (dev, e2e) | s3 (production: LAMINA_S3_BUCKET,
    LAMINA_S3_KMS_KEY_ID, AWS_REGION; credentials from the instance/task role, never from files)."""
    kind = environment.get("LAMINA_DOCUMENT_STORAGE", "local").strip().casefold() or "local"
    if kind == "s3":
        return S3DocumentStorage(environment.get("LAMINA_S3_BUCKET", "").strip(),
                                 environment.get("LAMINA_S3_KMS_KEY_ID", "").strip(),
                                 region=environment.get("AWS_REGION", "").strip() or None)
    if kind != "local":
        raise StorageMisconfiguredError("LAMINA_DOCUMENT_STORAGE must be 'local' or 's3'")
    return LocalDocumentStorage()


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
