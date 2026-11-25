"""Document storage (run 2): the local implementation (dev/e2e) and S3 (production), tested with
moto -- a local mock of AWS. No real AWS is ever contacted. Synthetic content only."""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from botocore.config import Config
from moto import mock_aws

from backend.pilot.documents import (
    DocumentRejectedError,
    LocalDocumentStorage,
    S3DocumentStorage,
    StorageMisconfiguredError,
    document_storage_from_environment,
)
from tests.test_pilot_foundation import NPI_B, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h

BUCKET, KEY_ID, REGION = "lamina-pilot-documents-test", "arn:aws:kms:us-east-1:000000000000:key/test-key", "us-east-1"


@pytest.fixture
def s3(monkeypatch: pytest.MonkeyPatch):
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(name, "testing")  # moto only; never real credentials
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION, config=Config(signature_version="s3v4"))
        client.create_bucket(Bucket=BUCKET)
        yield client


def _harden(client) -> None:
    client.put_public_access_block(Bucket=BUCKET, PublicAccessBlockConfiguration={
        "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
    client.put_bucket_encryption(Bucket=BUCKET, ServerSideEncryptionConfiguration={"Rules": [
        {"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "aws:kms", "KMSMasterKeyID": KEY_ID}}]})


def test_s3_round_trip_with_kms_encryption_and_no_public_access(s3) -> None:
    storage = S3DocumentStorage(BUCKET, KEY_ID, client=s3)
    key = storage.put("prc_abc", b"%PDF-1.4 synthetic referral", ".pdf")
    assert key.startswith("prc_abc/") and key.endswith(".pdf")
    assert storage.get(key) == b"%PDF-1.4 synthetic referral"
    head = s3.head_object(Bucket=BUCKET, Key=f"referral-documents/{key}")
    assert head["ServerSideEncryption"] == "aws:kms" and head["SSEKMSKeyId"].endswith("test-key")
    grants = s3.get_object_acl(Bucket=BUCKET, Key=f"referral-documents/{key}")["Grants"]
    assert not [grant for grant in grants if "AllUsers" in str(grant) or "AuthenticatedUsers" in str(grant)], "never public"
    with pytest.raises(DocumentRejectedError):
        storage.get("../../etc/passwd")


def test_signed_downloads_are_short_lived_attachments(s3) -> None:
    storage = S3DocumentStorage(BUCKET, KEY_ID, client=s3)
    key = storage.put("prc_abc", b"synthetic text", ".txt")
    url = storage.signed_url(key, "labs (E2E).txt", "text/plain", 3600)
    query = parse_qs(urlparse(url).query)
    assert int(query["X-Amz-Expires"][0]) == 300, "capped at 5 minutes whatever is asked"
    assert query["response-content-disposition"][0].startswith("attachment; filename*=UTF-8''labs%20%28E2E%29.txt")
    assert int(parse_qs(urlparse(storage.signed_url(key, "a.txt", "text/plain", 60)).query)["X-Amz-Expires"][0]) == 60


def test_bucket_verification_refuses_public_or_unencrypted_buckets(s3) -> None:
    storage = S3DocumentStorage(BUCKET, KEY_ID, client=s3)
    problems = storage.verify()
    assert "the bucket has no public access block" in problems
    _harden(s3)
    assert storage.verify() == []
    s3.put_public_access_block(Bucket=BUCKET, PublicAccessBlockConfiguration={
        "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": False, "RestrictPublicBuckets": True})
    assert storage.verify() == ["the bucket does not block all public access"]


def test_storage_configuration(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    with pytest.raises(StorageMisconfiguredError):
        S3DocumentStorage(BUCKET, "", client=object())  # no KMS key: refused
    monkeypatch.setenv("LAMINA_DOCUMENT_STORAGE", "ftp")
    with pytest.raises(StorageMisconfiguredError):
        document_storage_from_environment()
    monkeypatch.setenv("LAMINA_DOCUMENT_STORAGE", "local")
    monkeypatch.setenv("LAMINA_PILOT_DOCUMENT_DIR", str(tmp_path))
    local = document_storage_from_environment()
    assert isinstance(local, LocalDocumentStorage) and local.signed_url("a/b.txt", "b.txt", "text/plain", 60) is None


def test_the_api_issues_a_signed_link_only_inside_the_practice(s3, pilot: Pilot) -> None:
    """Through the pilot API with S3 storage (moto): a member gets a 60-second link and a
    `document_link_issued` event; another practice gets 404; local storage answers 409."""
    from backend.pilot import api as pilot_api

    pilot.ready_physician()
    pilot.add_rule()
    rid = pilot.referral()["referral"]["id"]
    services = pilot.client.app.dependency_overrides[pilot_api.get_pilot_services]()
    local = services.intake._storage
    upload = lambda: pilot.client.post(
        f"/api/me/practice/referrals/{rid}/documents", content=b"Recent HbA1c 8.1% (synthetic)",
        headers={**_h("user-a"), "Content-Type": "text/plain", "X-Filename": "labs.txt"})
    local_doc = upload().json()["referral"]["documents"][-1]["id"]
    assert pilot.get(f"/api/me/practice/documents/{local_doc}/link", "user-a").json()["detail"]["code"] == "signed_links_unavailable"
    services.intake._storage = S3DocumentStorage(BUCKET, KEY_ID, client=s3)
    try:
        doc = upload().json()["referral"]["documents"][-1]["id"]
        link = pilot.get(f"/api/me/practice/documents/{doc}/link", "user-a")
        assert link.status_code == 200 and link.json()["expires_in"] == 60
        assert "X-Amz-Expires=60" in link.json()["url"] and BUCKET in link.json()["url"]
        assert "document_link_issued" in [e["event_type"] for e in pilot.store.events(referral_id=rid)]
        assert pilot.get(f"/api/me/practice/documents/{doc}", "user-a").content == b"Recent HbA1c 8.1% (synthetic)"
        pilot.confirm_physician("user-b", NPI_B)
        pilot.approve("user-b")
        pilot.create_practice("user-b", "Doe Cardiology")
        assert pilot.get(f"/api/me/practice/documents/{doc}/link", "user-b").status_code == 404, "never another practice"
    finally:
        services.intake._storage = local
