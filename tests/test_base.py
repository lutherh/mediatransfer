"""Tests for the base provider utilities."""

from datetime import datetime, timezone

import pytest

from mediatransfer.providers.base import MediaAsset, compute_md5


def _asset(**kwargs):
    defaults = dict(
        id="abc123",
        filename="photo.jpg",
        mime_type="image/jpeg",
        size=1024,
    )
    defaults.update(kwargs)
    return MediaAsset(**defaults)


class TestMediaAsset:
    def test_extension_jpeg(self):
        assert _asset(filename="photo.jpg").extension == "jpg"

    def test_extension_no_dot(self):
        assert _asset(filename="photo").extension == ""

    def test_date_path_with_date(self):
        dt = datetime(2023, 7, 4, 12, 0, 0, tzinfo=timezone.utc)
        assert _asset(created_at=dt).date_path == "2023/07/04"

    def test_date_path_without_date(self):
        assert _asset().date_path == "unknown"


class TestComputeMd5:
    def test_known_value(self):
        # MD5 of empty string
        assert compute_md5(b"") == "d41d8cd98f00b204e9800998ecf8427e"

    def test_deterministic(self):
        data = b"hello world"
        assert compute_md5(data) == compute_md5(data)
