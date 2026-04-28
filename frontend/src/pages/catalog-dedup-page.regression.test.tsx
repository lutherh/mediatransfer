import { describe, it, expect } from 'vitest';
import { pathNamespaceBadge } from './catalog-dedup-page';

/**
 * Regression suite for namespace badge logic.
 *
 * Bug history:
 *  - 2026-04-29: dated-transfers regex was `(?:19|20)\d{4}` (6-digit year)
 *    so it never matched real keys like `s3transfers/2020/03/15/...`.
 *    All dated transfers were mis-labelled as "Transfers (no date)".
 */
describe('pathNamespaceBadge', () => {
  it('labels dated s3transfers/ keys as "Transfers (dated)" (regression: 4-digit year regex)', () => {
    const cases = [
      's3transfers/2020/03/15/photo.jpg',
      's3transfers/1999/12/31/Album/file.heic',
      's3transfers/2026/01/05/Photos_from_2026/IMG_0001.MOV',
    ];
    for (const key of cases) {
      const badge = pathNamespaceBadge(key);
      expect(badge?.label, `key=${key}`).toBe('Transfers (dated)');
    }
  });

  it('labels undated s3transfers/ keys as "Transfers (no date)"', () => {
    expect(pathNamespaceBadge('s3transfers/unknown-date/photo.jpg')?.label).toBe(
      'Transfers (no date)',
    );
    expect(pathNamespaceBadge('s3transfers/Album/file.jpg')?.label).toBe(
      'Transfers (no date)',
    );
  });

  it('labels immich/ namespaces correctly', () => {
    expect(pathNamespaceBadge('immich/library/u1/asset.jpg')?.label).toBe('Immich library');
    expect(pathNamespaceBadge('immich/upload/u1/asset.jpg')?.label).toBe('Immich upload');
    expect(pathNamespaceBadge('immich/profile/u1.jpg')?.label).toBe('Immich');
  });

  it('returns null for unrecognised keys', () => {
    expect(pathNamespaceBadge('random/key.jpg')).toBeNull();
  });

  it('does NOT match 6-digit pseudo-years (regression guard)', () => {
    // The previous broken regex would have erroneously matched these.
    // The fixed regex must NOT accept them as "dated".
    const badge = pathNamespaceBadge('s3transfers/199912/03/15/photo.jpg');
    expect(badge?.label).toBe('Transfers (no date)');
  });
});
