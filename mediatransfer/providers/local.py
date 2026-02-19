"""Local filesystem provider.

Useful for transferring to/from a home NAS or mounted drive.
"""

from __future__ import annotations

import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .base import BaseProvider, MediaAsset

_MEDIA_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif", ".webp",
    ".heic", ".heif", ".raw", ".cr2", ".nef", ".arw", ".dng",
    ".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v", ".3gp",
}


class LocalProvider(BaseProvider):
    """Read/write provider for a local directory (NAS, mounted drive, …)."""

    def __init__(self, root: str) -> None:
        self.root = Path(root)

    # ------------------------------------------------------------------ #
    # Listing                                                              #
    # ------------------------------------------------------------------ #

    def list_assets(self) -> Iterator[MediaAsset]:
        """Yield every media file under *root* recursively."""
        for path in sorted(self.root.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in _MEDIA_EXTENSIONS:
                continue

            stat = path.stat()
            mime_type, _ = mimetypes.guess_type(str(path))
            created_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            rel = path.relative_to(self.root)

            yield MediaAsset(
                id=str(rel),
                filename=path.name,
                mime_type=mime_type or "application/octet-stream",
                size=stat.st_size,
                created_at=created_at,
                metadata={"path": str(path)},
            )

    # ------------------------------------------------------------------ #
    # Download                                                             #
    # ------------------------------------------------------------------ #

    def download(self, asset: MediaAsset) -> bytes:
        return (self.root / asset.id).read_bytes()

    # ------------------------------------------------------------------ #
    # Upload                                                               #
    # ------------------------------------------------------------------ #

    def upload(self, asset: MediaAsset, data: bytes, dest_path: str) -> None:
        dest = self.root / dest_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)

    # ------------------------------------------------------------------ #
    # Existence check                                                      #
    # ------------------------------------------------------------------ #

    def exists(self, dest_path: str) -> bool:
        return (self.root / dest_path).exists()
