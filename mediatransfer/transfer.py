"""Transfer engine – orchestrates the movement of assets between providers.

Features
--------
* Skip-if-exists – avoid re-transferring assets already at the destination.
* Checksum verification – MD5 digest is compared after every upload.
* Date-based path layout – assets are organised as ``YYYY/MM/DD/filename``.
* Metadata preservation – EXIF timestamps are embedded into JPEG/TIFF files.
* Progress reporting via *tqdm*.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional

from tqdm import tqdm

from .metadata import embed_metadata
from .providers.base import BaseProvider, MediaAsset, compute_md5

logger = logging.getLogger(__name__)


@dataclass
class TransferResult:
    """Summary of a completed transfer session."""

    total: int = 0
    transferred: int = 0
    skipped: int = 0
    failed: List[str] = field(default_factory=list)
    verified: int = 0
    verification_failures: List[str] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return len(self.failed) == 0 and len(self.verification_failures) == 0


def build_dest_path(asset: MediaAsset, prefix: str = "") -> str:
    """Return the destination key/path for *asset*.

    Layout: ``[prefix/]YYYY/MM/DD/filename``
    """
    parts = [p for p in [prefix, asset.date_path, asset.filename] if p]
    return "/".join(parts)


def transfer(
    source: BaseProvider,
    destination: BaseProvider,
    dest_prefix: str = "",
    verify: bool = True,
    skip_existing: bool = True,
    preserve_metadata: bool = True,
) -> TransferResult:
    """Transfer all assets from *source* to *destination*.

    Parameters
    ----------
    source:
        Provider to read assets from.
    destination:
        Provider to write assets to.
    dest_prefix:
        Optional path prefix prepended to every destination key.
    verify:
        When *True*, compare MD5 checksums after each upload.
    skip_existing:
        When *True*, skip assets whose destination path already exists.
    preserve_metadata:
        When *True*, embed EXIF metadata into JPEG/TIFF images.

    Returns
    -------
    TransferResult
        Detailed summary of the operation.
    """
    result = TransferResult()

    assets = list(source.list_assets())
    result.total = len(assets)

    with tqdm(total=result.total, unit="asset", desc="Transferring") as progress:
        for asset in assets:
            dest_path = build_dest_path(asset, dest_prefix)
            try:
                if skip_existing and destination.exists(dest_path):
                    logger.debug("Skipping existing asset: %s", dest_path)
                    result.skipped += 1
                    progress.update(1)
                    continue

                data = source.download(asset)

                if preserve_metadata:
                    meta = dict(asset.metadata)
                    meta["created_at"] = asset.created_at
                    meta["description"] = asset.description
                    data = embed_metadata(data, meta)

                source_md5 = compute_md5(data)

                destination.upload(asset, data, dest_path)
                result.transferred += 1

                if verify:
                    _verify_upload(destination, dest_path, source_md5, result)

            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to transfer %s: %s", asset.filename, exc)
                result.failed.append(asset.filename)
            finally:
                progress.update(1)

    return result


def _verify_upload(
    destination: BaseProvider,
    dest_path: str,
    source_md5: str,
    result: TransferResult,
) -> None:
    """Download and checksum-verify the uploaded object."""
    # For S3Provider we can use the ETag to avoid a full re-download
    from .providers.s3 import S3Provider  # local import to avoid circularity

    if isinstance(destination, S3Provider):
        etag = destination.get_etag(dest_path)
        if etag and etag == source_md5:
            result.verified += 1
            return
        if etag and etag != source_md5:
            logger.warning(
                "Checksum mismatch for %s (expected %s, got %s)",
                dest_path,
                source_md5,
                etag,
            )
            result.verification_failures.append(dest_path)
            return

    # Fallback: re-download and compare
    try:
        uploaded_data = destination.download(
            MediaAsset(
                id=dest_path,
                filename=dest_path.split("/")[-1],
                mime_type="application/octet-stream",
                size=0,
            )
        )
        uploaded_md5 = compute_md5(uploaded_data)
        if uploaded_md5 == source_md5:
            result.verified += 1
        else:
            logger.warning(
                "Checksum mismatch for %s (expected %s, got %s)",
                dest_path,
                source_md5,
                uploaded_md5,
            )
            result.verification_failures.append(dest_path)
    except Exception as exc:  # noqa: BLE001
        logger.error("Verification download failed for %s: %s", dest_path, exc)
        result.verification_failures.append(dest_path)
