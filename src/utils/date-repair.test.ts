import { describe, it, expect } from 'vitest';
import {
  parseSidecarDate,
  isWrongDate,
  extractAlbumFile,
  isVideoKey,
  buildSidecarLookup,
  resolveSidecar,
} from './date-repair.js';
import { toDatePath, computeNewKey } from '../../scripts/lib/repair-helpers.js';
import type { SidecarMetadata } from '../takeout/archive-metadata.js';

// ── parseSidecarDate ────────────────────────────────────────────

describe('parseSidecarDate', () => {
  it('parses a unix timestamp (seconds) from photoTakenTime', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '1700000000' };
    const d = parseSidecarDate(sidecar)!;
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('returns undefined when only creationTime is present (not used for cross-file resolution)', () => {
    const sidecar: SidecarMetadata = { creationTime: '1700000000' };
    expect(parseSidecarDate(sidecar)).toBeUndefined();
  });

  it('prefers photoTakenTime over creationTime', () => {
    const sidecar: SidecarMetadata = {
      photoTakenTime: '1600000000', // 2020-09-13
      creationTime: '1700000000',   // 2023-11-14
    };
    const d = parseSidecarDate(sidecar)!;
    expect(d.getUTCFullYear()).toBe(2020);
  });

  it('parses informal date string "19 Jul 2025, 14:27:41 UTC"', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '19 Jul 2025, 14:27:41 UTC' };
    const d = parseSidecarDate(sidecar)!;
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(6); // July = 6
    expect(d.getUTCDate()).toBe(19);
  });

  it('parses ISO-8601 date string', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '2023-12-25T10:30:00.000Z' };
    const d = parseSidecarDate(sidecar)!;
    expect(d.getUTCFullYear()).toBe(2023);
    expect(d.getUTCMonth()).toBe(11);
    expect(d.getUTCDate()).toBe(25);
  });

  it('parses informal date string with day/month names', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '3 Jun 2016, 06:22:40 UTC' };
    const d = parseSidecarDate(sidecar)!;
    expect(d.getUTCFullYear()).toBe(2016);
    expect(d.getUTCMonth()).toBe(5); // June = 5
    expect(d.getUTCDate()).toBe(3);
  });

  it('returns undefined when photoTakenTime is unparseable (does not fall back to creationTime)', () => {
    const sidecar: SidecarMetadata = {
      photoTakenTime: 'not-a-date-at-all',
      creationTime: '1700000000',
    };
    expect(parseSidecarDate(sidecar)).toBeUndefined();
  });

  it('returns undefined when both fields are absent', () => {
    const sidecar: SidecarMetadata = {};
    expect(parseSidecarDate(sidecar)).toBeUndefined();
  });

  it('returns undefined when both fields are unparseable', () => {
    const sidecar: SidecarMetadata = {
      photoTakenTime: 'garbage',
      creationTime: 'also garbage',
    };
    expect(parseSidecarDate(sidecar)).toBeUndefined();
  });

  it('treats zero string as year 2000 (Date constructor quirk)', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '0' };
    // Number("0") = 0 which is not > 0, falls to new Date("0") which parses as Sat Jan 01 2000
    const d = parseSidecarDate(sidecar)!;
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBeLessThanOrEqual(2000);
  });

  it('treats negative string as ancient date (Date constructor quirk)', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '-100' };
    // Number("-100") = -100 which is not > 0, falls to new Date("-100") → year 100 BC-ish
    const d = parseSidecarDate(sidecar)!;
    expect(d).toBeInstanceOf(Date);
    // These ancient dates will be caught by isWrongDate (true for pre-1990)
  });
});

// ── isWrongDate ─────────────────────────────────────────────────

describe('isWrongDate', () => {
  it('returns true for far-future date (2040)', () => {
    expect(isWrongDate(new Date('2040-03-15T00:00:00Z'))).toBe(true);
  });

  it('returns true for pre-1990 date', () => {
    expect(isWrongDate(new Date('1989-12-31T23:59:59Z'))).toBe(true);
  });

  it('returns true for year 1970 (unix epoch)', () => {
    expect(isWrongDate(new Date('1970-01-01T00:00:00Z'))).toBe(true);
  });

  it('returns false for current year date (2026)', () => {
    expect(isWrongDate(new Date('2026-03-15T00:00:00Z'))).toBe(false);
  });

  it('returns false for 2025', () => {
    expect(isWrongDate(new Date('2025-12-31T23:59:59Z'))).toBe(false);
  });

  it('returns false for 2020', () => {
    expect(isWrongDate(new Date('2020-06-15T12:00:00Z'))).toBe(false);
  });

  it('returns false for year 2000', () => {
    expect(isWrongDate(new Date('2000-01-01T00:00:00Z'))).toBe(false);
  });

  it('returns false for 1990 (boundary)', () => {
    expect(isWrongDate(new Date('1990-01-01T00:00:00Z'))).toBe(false);
  });
});

// ── extractAlbumFile ────────────────────────────────────────────

describe('extractAlbumFile', () => {
  it('extracts album/filename from standard date path', () => {
    expect(
      extractAlbumFile('transfers/2020/07/19/Summer_Trip/IMG_1234.jpg'),
    ).toBe('Summer_Trip/IMG_1234.jpg');
  });

  it('extracts album/filename from 2026 wrong-date path', () => {
    expect(
      extractAlbumFile('transfers/2026/03/15/Archive/photo.jpg'),
    ).toBe('Archive/photo.jpg');
  });

  it('handles nested album paths', () => {
    expect(
      extractAlbumFile('transfers/2020/01/01/Family/Vacation/pic.jpg'),
    ).toBe('Family/Vacation/pic.jpg');
  });

  it('handles filename-only (no album folder)', () => {
    expect(
      extractAlbumFile('transfers/2020/01/01/pic.jpg'),
    ).toBe('pic.jpg');
  });

  it('returns empty string when path has exactly 4 segments', () => {
    // This edge case shouldn't happen in practice
    expect(extractAlbumFile('transfers/2020/01/01')).toBe('');
  });
});

// ── isVideoKey ──────────────────────────────────────────────────

describe('isVideoKey', () => {
  it.each([
    'video.mp4', 'video.MP4', 'video.mov', 'video.MOV',
    'video.m4v', 'video.3gp', 'video.3g2',
    'video.avi', 'video.AVI', 'video.mkv', 'video.webm',
  ])('returns true for %s', (key) => {
    expect(isVideoKey(`transfers/2026/03/15/Album/${key}`)).toBe(true);
  });

  it.each([
    'photo.jpg', 'photo.JPG', 'photo.jpeg', 'photo.HEIC',
    'photo.png', 'photo.gif', 'photo.tiff', 'document.pdf',
  ])('returns false for %s', (key) => {
    expect(isVideoKey(`transfers/2026/03/15/Album/${key}`)).toBe(false);
  });

  it('returns false for extensionless files', () => {
    expect(isVideoKey('transfers/2026/03/15/Album/README')).toBe(false);
  });
});

// ── toDatePath ──────────────────────────────────────────────────

describe('toDatePath', () => {
  it('formats date as YYYY/MM/DD', () => {
    expect(toDatePath(new Date('2023-12-25T00:00:00Z'))).toBe('2023/12/25');
  });

  it('zero-pads single-digit months and days', () => {
    expect(toDatePath(new Date('2020-01-05T00:00:00Z'))).toBe('2020/01/05');
  });

  it('handles new year boundary', () => {
    expect(toDatePath(new Date('2019-12-31T23:59:59Z'))).toBe('2019/12/31');
  });

  it('handles leap day', () => {
    expect(toDatePath(new Date('2024-02-29T12:00:00Z'))).toBe('2024/02/29');
  });
});

// ── computeNewKey ───────────────────────────────────────────────

describe('computeNewKey', () => {
  it('rewrites date path for standard key', () => {
    expect(
      computeNewKey('transfers/2026/03/15/Album/photo.jpg', '2020/06/15'),
    ).toBe('transfers/2020/06/15/Album/photo.jpg');
  });

  it('preserves album and filename', () => {
    expect(
      computeNewKey('transfers/2026/02/24/Familie_og_venner_1_/IMG_0643.MOV', '2016/05/26'),
    ).toBe('transfers/2016/05/26/Familie_og_venner_1_/IMG_0643.MOV');
  });

  it('handles unknown-date paths', () => {
    expect(
      computeNewKey('transfers/unknown-date/Album/photo.jpg', '2020/06/15'),
    ).toBe('transfers/2020/06/15/Album/photo.jpg');
  });

  it('handles nested album paths', () => {
    expect(
      computeNewKey('transfers/2026/01/01/Family/Trip/photo.jpg', '2019/08/20'),
    ).toBe('transfers/2019/08/20/Family/Trip/photo.jpg');
  });

  it('returns same key when date path is identical', () => {
    expect(
      computeNewKey('transfers/2020/06/15/Album/photo.jpg', '2020/06/15'),
    ).toBe('transfers/2020/06/15/Album/photo.jpg');
  });
});

// ── buildSidecarLookup & resolveSidecar ─────────────────────────

describe('buildSidecarLookup', () => {
  const items = [
    {
      destinationKey: 'transfers/2020/07/19/Summer/IMG_1234.jpg',
      sidecar: { photoTakenTime: '1595174400' } as SidecarMetadata, // 2020-07-19
    },
    {
      destinationKey: 'transfers/2021/03/10/Winter/IMG_5678.jpg',
      sidecar: { creationTime: '1615334400' } as SidecarMetadata,
    },
    // Duplicate basename — same filename in different albums
    {
      destinationKey: 'transfers/2019/01/01/AlbumA/photo.jpg',
      sidecar: { photoTakenTime: '1546300800' } as SidecarMetadata,
    },
    {
      destinationKey: 'transfers/2018/06/15/AlbumB/photo.jpg',
      sidecar: { photoTakenTime: '1529020800' } as SidecarMetadata,
    },
    // Item without sidecar — should be skipped
    {
      destinationKey: 'transfers/2020/01/01/Other/no-sidecar.jpg',
    },
    // Item with empty sidecar (no dates) — should be skipped
    {
      destinationKey: 'transfers/2020/01/01/Other/empty-sidecar.jpg',
      sidecar: { title: 'vacation' } as SidecarMetadata,
    },
  ];

  const lookup = buildSidecarLookup(items);

  it('includes only items with sidecar dates', () => {
    expect(lookup.byKey.size).toBe(4);
  });

  it('builds byAlbumFile map correctly', () => {
    expect(lookup.byAlbumFile.has('Summer/IMG_1234.jpg')).toBe(true);
    expect(lookup.byAlbumFile.has('Winter/IMG_5678.jpg')).toBe(true);
  });

  it('builds byBasename with arrays for duplicates', () => {
    expect(lookup.byBasename.get('photo.jpg')?.length).toBe(2);
    expect(lookup.byBasename.get('IMG_1234.jpg')?.length).toBe(1);
  });

  it('does not include items without sidecar', () => {
    expect(lookup.byKey.has('transfers/2020/01/01/Other/no-sidecar.jpg')).toBe(false);
  });

  it('does not include items with empty sidecar (no dates)', () => {
    expect(lookup.byKey.has('transfers/2020/01/01/Other/empty-sidecar.jpg')).toBe(false);
  });
});

describe('resolveSidecar', () => {
  const sidecarA: SidecarMetadata = { photoTakenTime: '1595174400' };
  const sidecarB: SidecarMetadata = { photoTakenTime: '1546300800' };
  const sidecarC: SidecarMetadata = { photoTakenTime: '1529020800' };
  const sidecarUnique: SidecarMetadata = { photoTakenTime: '1615334400' };

  const items = [
    { destinationKey: 'transfers/2020/07/19/Summer/IMG_1234.jpg', sidecar: sidecarA },
    { destinationKey: 'transfers/2021/03/10/Winter/unique-name.jpg', sidecar: sidecarUnique },
    // Duplicate basename → ambiguous
    { destinationKey: 'transfers/2019/01/01/AlbumA/photo.jpg', sidecar: sidecarB },
    { destinationKey: 'transfers/2018/06/15/AlbumB/photo.jpg', sidecar: sidecarC },
  ];

  const lookup = buildSidecarLookup(items);

  it('resolves by exact key', () => {
    const result = resolveSidecar(lookup, 'transfers/2020/07/19/Summer/IMG_1234.jpg');
    expect(result).toBe(sidecarA);
  });

  it('resolves by album+filename when exact key misses', () => {
    // Key with wrong date, but same album/filename
    const result = resolveSidecar(lookup, 'transfers/2026/03/15/Summer/IMG_1234.jpg');
    expect(result).toBe(sidecarA);
  });

  it('resolves by unique basename when album path also misses', () => {
    // Different album name, but unique filename
    const result = resolveSidecar(lookup, 'transfers/2026/03/15/DifferentAlbum/unique-name.jpg');
    expect(result).toBe(sidecarUnique);
  });

  it('returns undefined for ambiguous basename (multiple matches)', () => {
    // "photo.jpg" exists in two albums → can't resolve unambiguously
    const result = resolveSidecar(lookup, 'transfers/2026/03/15/UnknownAlbum/photo.jpg');
    expect(result).toBeUndefined();
  });

  it('resolves ambiguous basename if album matches', () => {
    // "photo.jpg" is ambiguous by basename, but album+filename is unique
    const result = resolveSidecar(lookup, 'transfers/2026/03/15/AlbumA/photo.jpg');
    expect(result).toBe(sidecarB);
  });

  it('returns undefined for completely unknown file', () => {
    const result = resolveSidecar(lookup, 'transfers/2026/01/01/Random/unknown.jpg');
    expect(result).toBeUndefined();
  });
});

// ── Integration: end-to-end key rewrite ─────────────────────────

describe('end-to-end key rewrite', () => {
  it('resolves sidecar → correct date path', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '26 May 2016, 18:24:45 UTC' };
    const date = parseSidecarDate(sidecar)!;
    expect(isWrongDate(date)).toBe(false);
    const newDatePath = toDatePath(date);
    expect(newDatePath).toBe('2016/05/26');
    const newKey = computeNewKey(
      'transfers/2026/02/24/Familie_og_venner_1_/IMG_0643.MOV',
      newDatePath,
    );
    expect(newKey).toBe('transfers/2016/05/26/Familie_og_venner_1_/IMG_0643.MOV');
  });

  it('accepts sidecar with current-year date (2026)', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '15 Mar 2026, 10:00:00 UTC' };
    const date = parseSidecarDate(sidecar)!;
    expect(isWrongDate(date)).toBe(false);
  });

  it('rejects sidecar with far-future date', () => {
    const sidecar: SidecarMetadata = { photoTakenTime: '15 Mar 2040, 10:00:00 UTC' };
    const date = parseSidecarDate(sidecar)!;
    expect(isWrongDate(date)).toBe(true);
  });

  it('end-to-end with unix timestamp sidecar', () => {
    // Unix 1466294400 = 2016-06-19T00:00:00Z
    const sidecar: SidecarMetadata = { photoTakenTime: '1466294400' };
    const date = parseSidecarDate(sidecar)!;
    expect(isWrongDate(date)).toBe(false);
    const newKey = computeNewKey(
      'transfers/2026/03/15/Photos_from_2016/IMG_0786.MOV',
      toDatePath(date),
    );
    expect(newKey).toBe('transfers/2016/06/19/Photos_from_2016/IMG_0786.MOV');
  });

  it('end-to-end with lookup + key rewrite', () => {
    const items = [
      {
        destinationKey: 'transfers/2025/07/19/Norway_2025/IMG_5323.MOV',
        sidecar: { photoTakenTime: '19 Jul 2025, 14:27:41 UTC' } as SidecarMetadata,
      },
    ];
    const lookup = buildSidecarLookup(items);

    // Simulate the wrong-date key
    const wrongKey = 'transfers/2026/02/24/Norway_2025/IMG_5323.MOV';
    const sidecar = resolveSidecar(lookup, wrongKey);
    expect(sidecar).toBeDefined();

    const date = parseSidecarDate(sidecar!)!;
    expect(isWrongDate(date)).toBe(false);

    const newKey = computeNewKey(wrongKey, toDatePath(date));
    expect(newKey).toBe('transfers/2025/07/19/Norway_2025/IMG_5323.MOV');
  });

  it('fallback chain: sidecar miss → basename unique → resolves', () => {
    const items = [
      {
        destinationKey: 'transfers/2020/05/01/OtherAlbum/unique-video.mp4',
        sidecar: { photoTakenTime: '1588291200' } as SidecarMetadata, // 2020-05-01
      },
    ];
    const lookup = buildSidecarLookup(items);

    // Wrong date, different album, but unique filename
    const wrongKey = 'transfers/2026/03/15/DifferentAlbum/unique-video.mp4';
    const sidecar = resolveSidecar(lookup, wrongKey);
    expect(sidecar).toBeDefined();

    const date = parseSidecarDate(sidecar!)!;
    const newKey = computeNewKey(wrongKey, toDatePath(date));
    expect(newKey).toBe('transfers/2020/05/01/DifferentAlbum/unique-video.mp4');
  });
});
