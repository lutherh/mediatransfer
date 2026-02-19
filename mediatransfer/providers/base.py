"""Abstract base class for all media providers."""

from __future__ import annotations

import hashlib
import io
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterator, Optional


@dataclass
class MediaAsset:
    """Represents a single media asset (photo, video, …)."""

    id: str
    filename: str
    mime_type: str
    size: int
    created_at: Optional[datetime] = None
    description: Optional[str] = None
    # Provider-specific extra fields (e.g. GPS, camera model, …)
    metadata: dict = field(default_factory=dict)

    @property
    def extension(self) -> str:
        return self.filename.rsplit(".", 1)[-1].lower() if "." in self.filename else ""

    @property
    def date_path(self) -> str:
        """Return a YYYY/MM/DD sub-path derived from *created_at*."""
        if self.created_at:
            return self.created_at.strftime("%Y/%m/%d")
        return "unknown"


def compute_md5(data: bytes) -> str:
    """Return the hex MD5 digest of *data*."""
    return hashlib.md5(data).hexdigest()  # noqa: S324  (used for integrity, not security)


class BaseProvider(ABC):
    """Interface every provider must implement."""

    # ------------------------------------------------------------------ #
    # Listing                                                              #
    # ------------------------------------------------------------------ #

    @abstractmethod
    def list_assets(self) -> Iterator[MediaAsset]:
        """Yield every asset available in this provider."""

    # ------------------------------------------------------------------ #
    # Download                                                             #
    # ------------------------------------------------------------------ #

    @abstractmethod
    def download(self, asset: MediaAsset) -> bytes:
        """Return the raw bytes for *asset*."""

    # ------------------------------------------------------------------ #
    # Upload                                                               #
    # ------------------------------------------------------------------ #

    @abstractmethod
    def upload(self, asset: MediaAsset, data: bytes, dest_path: str) -> None:
        """Store *data* at *dest_path* in this provider."""

    # ------------------------------------------------------------------ #
    # Existence check                                                      #
    # ------------------------------------------------------------------ #

    @abstractmethod
    def exists(self, dest_path: str) -> bool:
        """Return *True* if an object at *dest_path* already exists."""

    # ------------------------------------------------------------------ #
    # Display                                                              #
    # ------------------------------------------------------------------ #

    def display_assets(self, assets: list[MediaAsset]) -> None:
        """Print a human-readable table of *assets* sorted by date."""
        sorted_assets = sorted(
            assets,
            key=lambda a: a.created_at or datetime.min,
        )
        print(f"{'Date':<22} {'Filename':<40} {'Size':>10}  Type")
        print("-" * 80)
        for asset in sorted_assets:
            date_str = asset.created_at.isoformat() if asset.created_at else "unknown"
            size_kb = f"{asset.size / 1024:.1f} KB" if asset.size else "-"
            print(f"{date_str:<22} {asset.filename:<40} {size_kb:>10}  {asset.mime_type}")
        print(f"\nTotal: {len(sorted_assets)} asset(s)")
