import { describe, it, expect } from 'vitest';
import { inferDateFromFilename } from './exif.js';

describe('inferDateFromFilename', () => {
  it('parses IMG_YYYYMMDD_HHMMSS pattern', () => {
    const date = inferDateFromFilename('IMG_20231215_143022.jpg');
    expect(date).toEqual(new Date(Date.UTC(2023, 11, 15)));
  });

  it('parses YYYYMMDD_HHMMSS pattern', () => {
    const date = inferDateFromFilename('20231215_143022.jpg');
    expect(date).toEqual(new Date(Date.UTC(2023, 11, 15)));
  });

  it('parses PXL_YYYYMMDD pattern', () => {
    const date = inferDateFromFilename('PXL_20240101_120000.mp4');
    expect(date).toEqual(new Date(Date.UTC(2024, 0, 1)));
  });

  it('parses YYYY-MM-DD pattern', () => {
    const date = inferDateFromFilename('2023-12-15 14.30.22.jpg');
    expect(date).toEqual(new Date(Date.UTC(2023, 11, 15)));
  });

  it('parses Screenshot_YYYY-MM-DD pattern', () => {
    const date = inferDateFromFilename('Screenshot_2023-12-15-14-30-22.png');
    expect(date).toEqual(new Date(Date.UTC(2023, 11, 15)));
  });

  it('returns null for filenames without date patterns', () => {
    expect(inferDateFromFilename('photo.jpg')).toBeNull();
    expect(inferDateFromFilename('vacation-pic.png')).toBeNull();
  });

  it('returns null for invalid dates', () => {
    expect(inferDateFromFilename('IMG_20231315_143022.jpg')).toBeNull(); // month 13
  });

  it('returns null for years out of range', () => {
    expect(inferDateFromFilename('IMG_19001215_143022.jpg')).toBeNull(); // year < 1970
  });
});
