"""Metadata utilities – read and embed EXIF data in images.

Supports reading EXIF from JPEG/TIFF files and embedding a creation
timestamp back into an image's EXIF when the original lacks one.
"""

from __future__ import annotations

import io
from datetime import datetime
from typing import Optional

try:
    import piexif
    _PIEXIF_AVAILABLE = True
except ImportError:  # pragma: no cover
    _PIEXIF_AVAILABLE = False

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:  # pragma: no cover
    _PIL_AVAILABLE = False

_EXIF_DATE_FMT = "%Y:%m:%d %H:%M:%S"


def read_exif_date(data: bytes) -> Optional[datetime]:
    """Extract the original capture date from *data* (JPEG/TIFF bytes).

    Returns *None* when EXIF is absent or the date cannot be parsed.
    """
    if not _PIEXIF_AVAILABLE:
        return None
    try:
        exif = piexif.load(data)
        raw = (
            exif.get("Exif", {}).get(piexif.ExifIFD.DateTimeOriginal)
            or exif.get("0th", {}).get(piexif.ImageIFD.DateTime)
        )
        if raw:
            return datetime.strptime(raw.decode(), _EXIF_DATE_FMT)
    except Exception:  # noqa: BLE001
        pass
    return None


def embed_metadata(data: bytes, asset_metadata: dict) -> bytes:
    """Return *data* with updated EXIF metadata from *asset_metadata*.

    Accepts JPEG/TIFF bytes.  Returns the original *data* unchanged when
    EXIF writing is not supported for the format.
    """
    if not (_PIEXIF_AVAILABLE and _PIL_AVAILABLE):
        return data

    created_at: Optional[datetime] = asset_metadata.get("created_at")
    if not created_at:
        return data

    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in ("JPEG", "TIFF"):
            return data

        try:
            exif_dict = piexif.load(img.info.get("exif", b""))
        except Exception:  # noqa: BLE001
            exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}}

        date_str = created_at.strftime(_EXIF_DATE_FMT).encode()
        exif_dict.setdefault("Exif", {})[piexif.ExifIFD.DateTimeOriginal] = date_str
        exif_dict.setdefault("0th", {})[piexif.ImageIFD.DateTime] = date_str

        if asset_metadata.get("description"):
            exif_dict["0th"][piexif.ImageIFD.ImageDescription] = (
                asset_metadata["description"].encode()
            )

        exif_bytes = piexif.dump(exif_dict)
        out = io.BytesIO()
        img.save(out, format=img.format, exif=exif_bytes)
        return out.getvalue()
    except Exception:  # noqa: BLE001
        return data
