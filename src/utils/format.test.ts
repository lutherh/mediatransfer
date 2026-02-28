import { describe, it, expect } from 'vitest';
import { formatDuration, formatBytes } from './format.js';

describe('utils/format', () => {
  describe('formatDuration', () => {
    it('formats seconds only', () => {
      expect(formatDuration(5_000)).toBe('5s');
      expect(formatDuration(0)).toBe('0s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(125_000)).toBe('2m 5s');
    });

    it('formats hours, minutes, and seconds', () => {
      expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
    });
  });

  describe('formatBytes', () => {
    it('formats zero and invalid values', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(-1)).toBe('0 B');
      expect(formatBytes(NaN)).toBe('0 B');
    });

    it('formats bytes', () => {
      expect(formatBytes(512)).toBe('512 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('formats megabytes with one decimal', () => {
      expect(formatBytes(1_536_000)).toBe('1.5 MB');
    });

    it('formats gigabytes', () => {
      expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
    });
  });
});
