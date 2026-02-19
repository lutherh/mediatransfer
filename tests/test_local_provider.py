"""Tests for the local filesystem provider."""

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from mediatransfer.providers.local import LocalProvider


@pytest.fixture()
def media_dir(tmp_path):
    """Create a temporary directory with a few fake media files."""
    (tmp_path / "2023" / "07").mkdir(parents=True)
    (tmp_path / "photo1.jpg").write_bytes(b"\xff\xd8\xff" + b"\x00" * 100)
    (tmp_path / "photo2.jpeg").write_bytes(b"\xff\xd8\xff" + b"\x00" * 200)
    (tmp_path / "video.mp4").write_bytes(b"\x00" * 512)
    (tmp_path / "readme.txt").write_bytes(b"ignore me")
    return tmp_path


class TestLocalProviderList:
    def test_lists_only_media_files(self, media_dir):
        provider = LocalProvider(root=str(media_dir))
        assets = list(provider.list_assets())
        filenames = {a.filename for a in assets}
        assert "photo1.jpg" in filenames
        assert "photo2.jpeg" in filenames
        assert "video.mp4" in filenames
        assert "readme.txt" not in filenames

    def test_asset_fields(self, media_dir):
        provider = LocalProvider(root=str(media_dir))
        assets = list(provider.list_assets())
        jpg = next(a for a in assets if a.filename == "photo1.jpg")
        assert jpg.size > 0
        assert jpg.mime_type == "image/jpeg"
        assert jpg.created_at is not None


class TestLocalProviderDownload:
    def test_round_trip(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        (src / "img.jpg").write_bytes(b"image data")

        provider = LocalProvider(root=str(src))
        assets = list(provider.list_assets())
        assert len(assets) == 1
        data = provider.download(assets[0])
        assert data == b"image data"


class TestLocalProviderUpload:
    def test_upload_creates_file(self, tmp_path):
        dest = tmp_path / "dest"
        dest.mkdir()
        provider = LocalProvider(root=str(dest))

        from mediatransfer.providers.base import MediaAsset
        asset = MediaAsset(
            id="photo.jpg",
            filename="photo.jpg",
            mime_type="image/jpeg",
            size=10,
        )
        provider.upload(asset, b"pixels", "2023/07/04/photo.jpg")
        assert (dest / "2023" / "07" / "04" / "photo.jpg").read_bytes() == b"pixels"

    def test_exists_true(self, tmp_path):
        dest = tmp_path / "dest"
        dest.mkdir()
        (dest / "photo.jpg").write_bytes(b"x")
        provider = LocalProvider(root=str(dest))
        assert provider.exists("photo.jpg") is True

    def test_exists_false(self, tmp_path):
        provider = LocalProvider(root=str(tmp_path))
        assert provider.exists("nonexistent.jpg") is False
