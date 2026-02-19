"""Tests for the S3 provider using moto (mocked AWS)."""

from __future__ import annotations

from datetime import datetime, timezone

import boto3
import pytest

try:
    from moto import mock_aws
    _MOTO_AVAILABLE = True
except ImportError:
    _MOTO_AVAILABLE = False

from mediatransfer.providers.base import MediaAsset
from mediatransfer.providers.s3 import S3Provider

pytestmark = pytest.mark.skipif(not _MOTO_AVAILABLE, reason="moto not installed")

_BUCKET = "test-bucket"
_REGION = "us-east-1"


@pytest.fixture()
def s3_provider():
    with mock_aws():
        boto3.client("s3", region_name=_REGION).create_bucket(Bucket=_BUCKET)
        provider = S3Provider(
            bucket=_BUCKET,
            region_name=_REGION,
        )
        yield provider


def _make_asset(filename="photo.jpg", created_at=None):
    return MediaAsset(
        id=filename,
        filename=filename,
        mime_type="image/jpeg",
        size=len(b"data"),
        created_at=created_at or datetime(2023, 7, 4, tzinfo=timezone.utc),
    )


class TestS3ProviderUploadExists:
    def test_upload_and_exists(self, s3_provider):
        asset = _make_asset()
        s3_provider.upload(asset, b"image data", "2023/07/04/photo.jpg")
        assert s3_provider.exists("2023/07/04/photo.jpg") is True

    def test_exists_false(self, s3_provider):
        assert s3_provider.exists("nonexistent.jpg") is False

    def test_upload_preserves_metadata_header(self, s3_provider):
        asset = _make_asset(created_at=datetime(2023, 7, 4, tzinfo=timezone.utc))
        s3_provider.upload(asset, b"pixels", "2023/07/04/photo.jpg")
        # Check metadata was stored
        head = boto3.client("s3", region_name=_REGION).head_object(
            Bucket=_BUCKET, Key="2023/07/04/photo.jpg"
        )
        assert "original-created-at" in head["Metadata"]


class TestS3ProviderList:
    def test_list_returns_media_files(self, s3_provider):
        asset = _make_asset()
        s3_provider.upload(asset, b"data", "2023/07/04/photo.jpg")
        assets = list(s3_provider.list_assets())
        assert any(a.filename == "photo.jpg" for a in assets)

    def test_list_skips_non_media(self, s3_provider):
        boto3.client("s3", region_name=_REGION).put_object(
            Bucket=_BUCKET, Key="notes.txt", Body=b"text"
        )
        assets = list(s3_provider.list_assets())
        assert not any(a.filename == "notes.txt" for a in assets)


class TestS3ProviderDownload:
    def test_download_round_trip(self, s3_provider):
        asset = _make_asset()
        s3_provider.upload(asset, b"raw pixels", "photo.jpg")
        dl_asset = MediaAsset(
            id="photo.jpg", filename="photo.jpg",
            mime_type="image/jpeg", size=10,
        )
        assert s3_provider.download(dl_asset) == b"raw pixels"
