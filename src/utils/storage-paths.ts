/**
 * Logical S3 namespace used by MediaTransfer uploads.
 *
 * Combined with `SCW_PREFIX` (typically `immich`), the final S3 keys look like
 * `immich/s3transfers/YYYY/MM/DD/<filename>`. The constant intentionally has no
 * trailing slash — callers compose paths with template literals.
 */
export const S3TRANSFERS_PREFIX = 's3transfers';

/** Logical S3 namespace used for catalog-side persisted thumbnails. */
export const THUMBS_PREFIX = '_thumbs';

/** S3 date-path segment used for media files whose capture date could not be determined. */
export const UNDATED_PREFIX = 'unknown-date';

/** Full key prefix `s3transfers/unknown-date` for keys whose date is unknown. */
export const UNDATED_KEY_PREFIX = `${S3TRANSFERS_PREFIX}/${UNDATED_PREFIX}`;

/** Convert a Date to a `YYYY/MM/DD` path segment. */
export function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}
