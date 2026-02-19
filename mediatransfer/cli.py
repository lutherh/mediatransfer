"""Command-line interface for mediatransfer.

Usage examples
--------------
Transfer Google Photos → Scaleway S3::

    mediatransfer transfer \\
        --from google-photos \\
        --to s3 \\
        --to-bucket my-media-bucket \\
        --to-endpoint https://s3.fr-par.scw.cloud \\
        --verify

List assets in an S3 bucket::

    mediatransfer list \\
        --provider s3 \\
        --bucket my-media-bucket \\
        --endpoint https://s3.fr-par.scw.cloud

List local assets::

    mediatransfer list --provider local --local-path /mnt/nas/photos

Verify that every Google Photos asset exists in S3::

    mediatransfer verify \\
        --from google-photos \\
        --to s3 \\
        --to-bucket my-media-bucket
"""

from __future__ import annotations

import logging
import os
import sys

import click

from .providers.google_photos import GooglePhotosProvider
from .providers.local import LocalProvider
from .providers.s3 import S3Provider
from .transfer import TransferResult, build_dest_path, transfer as run_transfer

logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Shared option groups                                                         #
# --------------------------------------------------------------------------- #

_source_options = [
    click.option(
        "--from",
        "source",
        required=True,
        type=click.Choice(["google-photos", "s3", "local"], case_sensitive=False),
        help="Source provider.",
    ),
    click.option("--client-secrets", default=None, help="Path to Google client_secrets.json."),
    click.option("--from-bucket", default=None, help="Source S3 bucket name."),
    click.option("--from-prefix", default="", help="Source S3 key prefix."),
    click.option("--from-endpoint", default=None, help="Source S3 endpoint URL."),
    click.option("--from-path", default=None, help="Source local directory path."),
]

_dest_options = [
    click.option(
        "--to",
        "destination",
        required=True,
        type=click.Choice(["s3", "local"], case_sensitive=False),
        help="Destination provider.",
    ),
    click.option("--to-bucket", default=None, help="Destination S3 bucket name."),
    click.option("--to-prefix", default="", help="Destination S3 key prefix / sub-path."),
    click.option("--to-endpoint", default=None, help="Destination S3 endpoint URL."),
    click.option("--to-path", default=None, help="Destination local directory path."),
]


def _add_options(options):
    def decorator(func):
        for option in reversed(options):
            func = option(func)
        return func
    return decorator


# --------------------------------------------------------------------------- #
# Provider factories                                                           #
# --------------------------------------------------------------------------- #

def _make_source(source, client_secrets, from_bucket, from_prefix, from_endpoint, from_path):
    if source == "google-photos":
        return GooglePhotosProvider(client_secrets_file=client_secrets)
    if source == "s3":
        if not from_bucket:
            raise click.UsageError("--from-bucket is required for S3 source.")
        return S3Provider(bucket=from_bucket, prefix=from_prefix, endpoint_url=from_endpoint)
    if source == "local":
        if not from_path:
            raise click.UsageError("--from-path is required for local source.")
        return LocalProvider(root=from_path)
    raise click.UsageError(f"Unknown source provider: {source}")


def _make_dest(destination, to_bucket, to_prefix, to_endpoint, to_path):
    if destination == "s3":
        if not to_bucket:
            raise click.UsageError("--to-bucket is required for S3 destination.")
        return S3Provider(bucket=to_bucket, prefix=to_prefix, endpoint_url=to_endpoint)
    if destination == "local":
        if not to_path:
            raise click.UsageError("--to-path is required for local destination.")
        return LocalProvider(root=to_path)
    raise click.UsageError(f"Unknown destination provider: {destination}")


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #

@click.group()
@click.version_option()
def main() -> None:
    """mediatransfer – move media between cloud providers with metadata intact."""


# ------------------------------------------------------------------ transfer

@main.command()
@_add_options(_source_options)
@_add_options(_dest_options)
@click.option("--verify/--no-verify", default=True, show_default=True,
              help="Verify each asset after upload via MD5 checksum.")
@click.option("--skip-existing/--no-skip-existing", default=True, show_default=True,
              help="Skip assets already present at the destination.")
@click.option("--preserve-metadata/--no-preserve-metadata", default=True, show_default=True,
              help="Embed EXIF metadata into JPEG/TIFF files.")
@click.option("-v", "--verbose", is_flag=True, default=False, help="Enable verbose logging.")
def transfer(
    source, client_secrets,
    from_bucket, from_prefix, from_endpoint, from_path,
    destination,
    to_bucket, to_prefix, to_endpoint, to_path,
    verify, skip_existing, preserve_metadata, verbose,
) -> None:
    """Transfer all media from SOURCE to DESTINATION."""
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    src = _make_source(source, client_secrets, from_bucket, from_prefix, from_endpoint, from_path)
    dst = _make_dest(destination, to_bucket, to_prefix, to_endpoint, to_path)

    click.echo(f"Transferring from {source} → {destination} …")
    result: TransferResult = run_transfer(
        source=src,
        destination=dst,
        dest_prefix=to_prefix,
        verify=verify,
        skip_existing=skip_existing,
        preserve_metadata=preserve_metadata,
    )

    _print_result(result)
    sys.exit(0 if result.success else 1)


# -------------------------------------------------------------------- list

@main.command("list")
@click.option(
    "--provider",
    required=True,
    type=click.Choice(["google-photos", "s3", "local"], case_sensitive=False),
    help="Provider to list assets from.",
)
@click.option("--client-secrets", default=None, help="Path to Google client_secrets.json.")
@click.option("--bucket", default=None, help="S3 bucket name.")
@click.option("--prefix", default="", help="S3 key prefix.")
@click.option("--endpoint", default=None, help="S3 endpoint URL.")
@click.option("--local-path", default=None, help="Local directory path.")
def list_assets(provider, client_secrets, bucket, prefix, endpoint, local_path) -> None:
    """List and display assets from a provider, sorted by date."""
    if provider == "google-photos":
        prov = GooglePhotosProvider(client_secrets_file=client_secrets)
    elif provider == "s3":
        if not bucket:
            raise click.UsageError("--bucket is required for S3.")
        prov = S3Provider(bucket=bucket, prefix=prefix, endpoint_url=endpoint)
    elif provider == "local":
        if not local_path:
            raise click.UsageError("--local-path is required for local provider.")
        prov = LocalProvider(root=local_path)
    else:
        raise click.UsageError(f"Unknown provider: {provider}")

    assets = list(prov.list_assets())
    if not assets:
        click.echo("No assets found.")
        return

    prov.display_assets(assets)


# ------------------------------------------------------------------- verify

@main.command()
@_add_options(_source_options)
@_add_options(_dest_options)
def verify(
    source, client_secrets,
    from_bucket, from_prefix, from_endpoint, from_path,
    destination,
    to_bucket, to_prefix, to_endpoint, to_path,
) -> None:
    """Verify that every SOURCE asset exists at DESTINATION."""
    src = _make_source(source, client_secrets, from_bucket, from_prefix, from_endpoint, from_path)
    dst = _make_dest(destination, to_bucket, to_prefix, to_endpoint, to_path)

    click.echo(f"Verifying {source} → {destination} …")
    assets = list(src.list_assets())
    missing: list[str] = []

    with click.progressbar(assets, label="Checking") as bar:
        for asset in bar:
            dest_path = build_dest_path(asset, to_prefix)
            if not dst.exists(dest_path):
                missing.append(asset.filename)

    if missing:
        click.echo(f"\n❌  {len(missing)} asset(s) missing from destination:")
        for name in missing:
            click.echo(f"   • {name}")
        sys.exit(1)
    else:
        click.echo(f"\n✅  All {len(assets)} asset(s) are present at the destination.")


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #

def _print_result(result: TransferResult) -> None:
    click.echo(f"\n{'─' * 50}")
    click.echo(f"  Total assets :  {result.total}")
    click.echo(f"  Transferred  :  {result.transferred}")
    click.echo(f"  Skipped      :  {result.skipped}")
    click.echo(f"  Failed       :  {len(result.failed)}")
    if result.verified:
        click.echo(f"  Verified ✓   :  {result.verified}")
    if result.verification_failures:
        click.echo(f"  Verify fail  :  {len(result.verification_failures)}")
    click.echo(f"{'─' * 50}")
    if result.failed:
        click.echo("\nFailed assets:")
        for name in result.failed:
            click.echo(f"  • {name}")
    if result.verification_failures:
        click.echo("\nVerification failures:")
        for path in result.verification_failures:
            click.echo(f"  • {path}")
    status = "✅  Transfer complete." if result.success else "❌  Transfer finished with errors."
    click.echo(f"\n{status}")
