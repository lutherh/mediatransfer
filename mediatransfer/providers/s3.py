"""S3-compatible provider (AWS S3, Scaleway Object Storage, MinIO, …).

Configuration is read from the standard boto3 environment variables
(``AWS_ACCESS_KEY_ID``, ``AWS_SECRET_ACCESS_KEY``, ``AWS_DEFAULT_REGION``)
or supplied explicitly.  Set ``endpoint_url`` for non-AWS services such
as Scaleway (``https://s3.<region>.scw.cloud``).
"""

from __future__ import annotations

import io
import mimetypes
import os
from datetime import datetime, timezone
from typing import Iterator, Optional

import boto3
from botocore.exceptions import ClientError

from .base import BaseProvider, MediaAsset

_MEDIA_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif", ".webp",
    ".heic", ".heif", ".raw", ".cr2", ".nef", ".arw", ".dng",
    ".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v", ".3gp",
}


class S3Provider(BaseProvider):
    """Read/write provider for any S3-compatible object store."""

    def __init__(
        self,
        bucket: str,
        prefix: str = "",
        endpoint_url: Optional[str] = None,
        aws_access_key_id: Optional[str] = None,
        aws_secret_access_key: Optional[str] = None,
        region_name: Optional[str] = None,
    ) -> None:
        self.bucket = bucket
        self.prefix = prefix.rstrip("/")
        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint_url or os.environ.get("S3_ENDPOINT_URL"),
            aws_access_key_id=aws_access_key_id or os.environ.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=aws_secret_access_key
            or os.environ.get("AWS_SECRET_ACCESS_KEY"),
            region_name=region_name or os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        )

    # ------------------------------------------------------------------ #
    # Listing                                                              #
    # ------------------------------------------------------------------ #

    def list_assets(self) -> Iterator[MediaAsset]:
        """Yield every media object in *bucket* under *prefix*."""
        paginator = self._s3.get_paginator("list_objects_v2")
        kwargs: dict = {"Bucket": self.bucket}
        if self.prefix:
            kwargs["Prefix"] = self.prefix + "/"

        for page in paginator.paginate(**kwargs):
            for obj in page.get("Contents", []):
                key: str = obj["Key"]
                ext = "." + key.rsplit(".", 1)[-1].lower() if "." in key else ""
                if _MEDIA_EXTENSIONS and ext not in _MEDIA_EXTENSIONS:
                    continue

                mime_type, _ = mimetypes.guess_type(key)
                yield MediaAsset(
                    id=key,
                    filename=key.split("/")[-1],
                    mime_type=mime_type or "application/octet-stream",
                    size=obj["Size"],
                    created_at=obj.get("LastModified"),
                    metadata={"key": key, "etag": obj.get("ETag", "").strip('"')},
                )

    # ------------------------------------------------------------------ #
    # Download                                                             #
    # ------------------------------------------------------------------ #

    def download(self, asset: MediaAsset) -> bytes:
        """Return the raw bytes stored at *asset.id* (the S3 key)."""
        buf = io.BytesIO()
        self._s3.download_fileobj(self.bucket, asset.id, buf)
        return buf.getvalue()

    # ------------------------------------------------------------------ #
    # Upload                                                               #
    # ------------------------------------------------------------------ #

    def upload(self, asset: MediaAsset, data: bytes, dest_path: str) -> None:
        """Put *data* at *dest_path* in the bucket, carrying content-type."""
        mime_type, _ = mimetypes.guess_type(asset.filename)
        extra_args: dict = {}
        if mime_type:
            extra_args["ContentType"] = mime_type

        # Preserve original creation date as S3 metadata
        if asset.created_at:
            extra_args["Metadata"] = {
                "original-created-at": asset.created_at.isoformat(),
                "original-filename": asset.filename,
            }
            if asset.description:
                extra_args["Metadata"]["description"] = asset.description

        self._s3.put_object(
            Bucket=self.bucket,
            Key=dest_path,
            Body=data,
            **extra_args,
        )

    # ------------------------------------------------------------------ #
    # Existence check                                                      #
    # ------------------------------------------------------------------ #

    def exists(self, dest_path: str) -> bool:
        try:
            self._s3.head_object(Bucket=self.bucket, Key=dest_path)
            return True
        except ClientError as exc:
            if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
                return False
            raise

    # ------------------------------------------------------------------ #
    # Checksum                                                             #
    # ------------------------------------------------------------------ #

    def get_etag(self, dest_path: str) -> Optional[str]:
        """Return the ETag (MD5 for single-part uploads) of an object."""
        try:
            resp = self._s3.head_object(Bucket=self.bucket, Key=dest_path)
            return resp.get("ETag", "").strip('"')
        except ClientError:
            return None
