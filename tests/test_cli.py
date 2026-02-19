"""Tests for the CLI."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterator
from unittest.mock import patch, MagicMock

import pytest
from click.testing import CliRunner

from mediatransfer.cli import main
from mediatransfer.providers.base import BaseProvider, MediaAsset


def _asset(filename="photo.jpg"):
    return MediaAsset(
        id=filename,
        filename=filename,
        mime_type="image/jpeg",
        size=1024,
        created_at=datetime(2023, 7, 4, tzinfo=timezone.utc),
    )


class FakeProvider(BaseProvider):
    def __init__(self, assets=None):
        self._assets = assets or []
        self._store: dict[str, bytes] = {}

    def list_assets(self) -> Iterator[MediaAsset]:
        yield from self._assets

    def download(self, asset: MediaAsset) -> bytes:
        return self._store.get(asset.id, b"data")

    def upload(self, asset: MediaAsset, data: bytes, dest_path: str) -> None:
        self._store[dest_path] = data

    def exists(self, dest_path: str) -> bool:
        return dest_path in self._store


@pytest.fixture()
def runner():
    return CliRunner()


class TestListCommand:
    def test_list_local(self, runner, tmp_path):
        (tmp_path / "photo.jpg").write_bytes(b"\xff\xd8" + b"\x00" * 50)

        result = runner.invoke(
            main,
            ["list", "--provider", "local", "--local-path", str(tmp_path)],
        )
        assert result.exit_code == 0
        assert "photo.jpg" in result.output

    def test_list_no_assets(self, runner, tmp_path):
        result = runner.invoke(
            main,
            ["list", "--provider", "local", "--local-path", str(tmp_path)],
        )
        assert result.exit_code == 0
        assert "No assets found" in result.output

    def test_list_missing_path(self, runner):
        result = runner.invoke(main, ["list", "--provider", "local"])
        assert result.exit_code != 0

    def test_list_s3_missing_bucket(self, runner):
        result = runner.invoke(main, ["list", "--provider", "s3"])
        assert result.exit_code != 0


class TestTransferCommand:
    def test_transfer_local_to_local(self, runner, tmp_path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "photo.jpg").write_bytes(b"\xff\xd8" + b"\x00" * 50)

        result = runner.invoke(
            main,
            [
                "transfer",
                "--from", "local", "--from-path", str(src),
                "--to", "local", "--to-path", str(dst),
                "--no-verify",
            ],
        )
        assert result.exit_code == 0
        assert "Transfer complete" in result.output

    def test_transfer_missing_to_bucket(self, runner, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        result = runner.invoke(
            main,
            [
                "transfer",
                "--from", "local", "--from-path", str(src),
                "--to", "s3",
                "--no-verify",
            ],
        )
        assert result.exit_code != 0


class TestVerifyCommand:
    def test_verify_all_present(self, runner, tmp_path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()

        (src / "photo.jpg").write_bytes(b"\xff\xd8" + b"\x00" * 50)

        # Pre-populate destination with date-based path
        from mediatransfer.providers.local import LocalProvider
        from mediatransfer.transfer import build_dest_path

        src_provider = LocalProvider(root=str(src))
        assets = list(src_provider.list_assets())
        dst_provider = LocalProvider(root=str(dst))
        for asset in assets:
            dest_path = build_dest_path(asset)
            dst_provider.upload(asset, b"data", dest_path)

        result = runner.invoke(
            main,
            [
                "verify",
                "--from", "local", "--from-path", str(src),
                "--to", "local", "--to-path", str(dst),
            ],
        )
        assert result.exit_code == 0
        assert "All" in result.output

    def test_verify_missing_assets(self, runner, tmp_path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "photo.jpg").write_bytes(b"\xff\xd8" + b"\x00" * 50)

        result = runner.invoke(
            main,
            [
                "verify",
                "--from", "local", "--from-path", str(src),
                "--to", "local", "--to-path", str(dst),
            ],
        )
        assert result.exit_code == 1
        assert "missing" in result.output.lower()
