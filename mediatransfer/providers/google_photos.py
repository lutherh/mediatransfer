"""Google Photos provider.

Authentication uses OAuth 2.0.  On first run the user is directed to a
consent screen; the resulting token is cached in ``~/.mediatransfer/google_token.json``.

Requires a *client_secrets.json* file (downloaded from Google Cloud Console)
or the environment variables ``GOOGLE_CLIENT_ID`` and ``GOOGLE_CLIENT_SECRET``.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

from .base import BaseProvider, MediaAsset

_SCOPES = ["https://www.googleapis.com/auth/photoslibrary.readonly"]
_TOKEN_PATH = Path.home() / ".mediatransfer" / "google_token.json"
_PHOTOS_API = "https://photoslibrary.googleapis.com/v1"
_PAGE_SIZE = 100


def _parse_google_date(raw: str) -> Optional[datetime]:
    """Parse a Google Photos *creationTime* ISO-8601 string."""
    if not raw:
        return None
    try:
        # Strip trailing 'Z' and parse
        return datetime.fromisoformat(raw.rstrip("Z")).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class GooglePhotosProvider(BaseProvider):
    """Read-only access to a user's Google Photos library."""

    def __init__(
        self,
        client_secrets_file: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
    ) -> None:
        self._client_secrets_file = client_secrets_file
        self._client_id = client_id or os.environ.get("GOOGLE_CLIENT_ID")
        self._client_secret = client_secret or os.environ.get("GOOGLE_CLIENT_SECRET")
        self._creds: Optional[Credentials] = None

    # ------------------------------------------------------------------ #
    # Auth                                                                 #
    # ------------------------------------------------------------------ #

    def authenticate(self) -> None:
        """Obtain (or refresh) OAuth2 credentials."""
        creds: Optional[Credentials] = None

        if _TOKEN_PATH.exists():
            creds = Credentials.from_authorized_user_file(str(_TOKEN_PATH), _SCOPES)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                creds = self._run_flow()

            _TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
            _TOKEN_PATH.write_text(creds.to_json())

        self._creds = creds

    def _run_flow(self) -> Credentials:
        if self._client_secrets_file:
            flow = InstalledAppFlow.from_client_secrets_file(
                self._client_secrets_file, _SCOPES
            )
        elif self._client_id and self._client_secret:
            flow = InstalledAppFlow.from_client_config(
                {
                    "installed": {
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                        "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob"],
                        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                        "token_uri": "https://oauth2.googleapis.com/token",
                    }
                },
                _SCOPES,
            )
        else:
            raise ValueError(
                "Provide --client-secrets, or set GOOGLE_CLIENT_ID and "
                "GOOGLE_CLIENT_SECRET environment variables."
            )
        return flow.run_local_server(port=0)

    def _headers(self) -> dict:
        if self._creds is None:
            self.authenticate()
        return {"Authorization": f"Bearer {self._creds.token}"}

    # ------------------------------------------------------------------ #
    # Listing                                                              #
    # ------------------------------------------------------------------ #

    def list_assets(self) -> Iterator[MediaAsset]:
        """Yield every media item in the authenticated user's library."""
        page_token: Optional[str] = None
        while True:
            params: dict = {"pageSize": _PAGE_SIZE}
            if page_token:
                params["pageToken"] = page_token

            resp = requests.get(
                f"{_PHOTOS_API}/mediaItems",
                headers=self._headers(),
                params=params,
                timeout=30,
            )
            resp.raise_for_status()
            body = resp.json()

            for item in body.get("mediaItems", []):
                yield self._to_asset(item)

            page_token = body.get("nextPageToken")
            if not page_token:
                break

    @staticmethod
    def _to_asset(item: dict) -> MediaAsset:
        meta = item.get("mediaMetadata", {})
        created_at = _parse_google_date(meta.get("creationTime", ""))
        return MediaAsset(
            id=item["id"],
            filename=item["filename"],
            mime_type=item.get("mimeType", "application/octet-stream"),
            size=int(item.get("fileSize", 0)),
            created_at=created_at,
            description=item.get("description"),
            metadata={
                "width": meta.get("width"),
                "height": meta.get("height"),
                "camera_make": meta.get("photo", {}).get("cameraMake"),
                "camera_model": meta.get("photo", {}).get("cameraModel"),
                "focal_length": meta.get("photo", {}).get("focalLength"),
                "aperture_f_number": meta.get("photo", {}).get("apertureFNumber"),
                "iso_equivalent": meta.get("photo", {}).get("isoEquivalent"),
                "exposure_time": meta.get("photo", {}).get("exposureTime"),
            },
        )

    # ------------------------------------------------------------------ #
    # Download                                                             #
    # ------------------------------------------------------------------ #

    def download(self, asset: MediaAsset) -> bytes:
        """Download the full-resolution bytes for *asset*."""
        # First refresh the download URL (base URLs expire after ~60 minutes)
        resp = requests.get(
            f"{_PHOTOS_API}/mediaItems/{asset.id}",
            headers=self._headers(),
            timeout=30,
        )
        resp.raise_for_status()
        base_url: str = resp.json()["baseUrl"]

        # Append download parameter
        download_url = f"{base_url}=d"
        data_resp = requests.get(download_url, timeout=120)
        data_resp.raise_for_status()
        return data_resp.content

    # ------------------------------------------------------------------ #
    # Upload / exists (read-only provider – not supported)                 #
    # ------------------------------------------------------------------ #

    def upload(self, asset: MediaAsset, data: bytes, dest_path: str) -> None:
        raise NotImplementedError("Google Photos is a read-only source provider.")

    def exists(self, dest_path: str) -> bool:
        raise NotImplementedError("Google Photos is a read-only source provider.")
