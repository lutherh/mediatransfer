import { describe, it, expect } from 'vitest';
import {
  S3TRANSFERS_PREFIX,
  THUMBS_PREFIX,
  UNDATED_PREFIX,
  UNDATED_KEY_PREFIX,
  toDatePath,
} from './storage-paths';

/**
 * These constants form the canonical S3 namespace contract for both
 * MediaTransfer uploads and the Immich-co-located catalog. The literal
 * values are wire-format — changing them silently is a breaking change
 * that requires an S3-side data move (see April 2026 namespace migration).
 */
describe('storage-paths constants', () => {
  it('S3TRANSFERS_PREFIX is "s3transfers" (no trailing slash)', () => {
    expect(S3TRANSFERS_PREFIX).toBe('s3transfers');
    expect(S3TRANSFERS_PREFIX.endsWith('/')).toBe(false);
  });

  it('THUMBS_PREFIX is "_thumbs"', () => {
    expect(THUMBS_PREFIX).toBe('_thumbs');
  });

  it('UNDATED_PREFIX is "unknown-date"', () => {
    expect(UNDATED_PREFIX).toBe('unknown-date');
  });

  it('UNDATED_KEY_PREFIX is composed correctly from S3TRANSFERS_PREFIX + UNDATED_PREFIX', () => {
    expect(UNDATED_KEY_PREFIX).toBe('s3transfers/unknown-date');
    expect(UNDATED_KEY_PREFIX).toBe(`${S3TRANSFERS_PREFIX}/${UNDATED_PREFIX}`);
  });

  it('toDatePath produces zero-padded YYYY/MM/DD', () => {
    expect(toDatePath(new Date(Date.UTC(2020, 2, 5)))).toBe('2020/03/05');
    expect(toDatePath(new Date(Date.UTC(1999, 11, 31)))).toBe('1999/12/31');
  });
});
