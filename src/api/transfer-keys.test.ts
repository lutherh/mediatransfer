import { describe, it, expect } from 'vitest';
import { buildDestinationKey, createDatePath } from './transfer-keys.js';

describe('createDatePath', () => {
  it('returns YYYY/MM/DD for valid ISO dates', () => {
    expect(createDatePath('2026-03-21T10:30:00.000Z')).toBe('2026/03/21');
    expect(createDatePath('2025-01-05T00:00:00.000Z')).toBe('2025/01/05');
  });

  it('pads single-digit months and days', () => {
    expect(createDatePath('2025-02-03T12:00:00Z')).toBe('2025/02/03');
  });

  it('returns unknown-date for undefined', () => {
    expect(createDatePath(undefined)).toBe('unknown-date');
  });

  it('returns unknown-date for invalid date string', () => {
    expect(createDatePath('not-a-date')).toBe('unknown-date');
  });
});

describe('buildDestinationKey', () => {
  it('builds key with date path, item id and sanitized filename', () => {
    const key = buildDestinationKey('Summer Vacation.jpg', 'abc123', '2025-07-15T10:30:00Z');
    expect(key).toBe('transfers/2025/07/15/abc123-Summer_Vacation.jpg');
  });

  it('preserves safe characters in filename', () => {
    const key = buildDestinationKey('IMG_1234.HEIC', 'item-1', '2026-03-21T00:00:00Z');
    expect(key).toBe('transfers/2026/03/21/item-1-IMG_1234.HEIC');
  });

  it('sanitizes special characters in filename', () => {
    const key = buildDestinationKey('photo (1) [copy].jpg', 'id1', '2025-01-01T00:00:00Z');
    expect(key).toBe('transfers/2025/01/01/id1-photo__1___copy_.jpg');
  });

  it('uses unknown-date when createTime is missing', () => {
    const key = buildDestinationKey('photo.jpg', 'id1');
    expect(key).toBe('transfers/unknown-date/id1-photo.jpg');
  });
});
