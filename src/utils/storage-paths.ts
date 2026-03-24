/** S3 date-path segment used for media files whose capture date could not be determined. */
export const UNDATED_PREFIX = 'unknown-date';

/** Convert a Date to a `YYYY/MM/DD` path segment. */
export function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}
