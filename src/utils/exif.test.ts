import { describe, it, expect } from 'vitest';
import { inferDateFromFilename, extractVideoCreationDateFromBuffer, extractVideoCreationDateFromMoov } from './exif.js';

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

// ── Video container date extraction (buffer-based) ─────────────────

/** Mac epoch offset used by ISO BMFF containers (seconds between 1904-01-01 and 1970-01-01) */
const MAC_EPOCH_OFFSET = 2082844800;

/** Build a minimal MP4 buffer with ftyp + moov(mvhd) atoms containing a creation date. */
function buildMp4WithMoov(unixTimestamp: number): Buffer {
  const macTime = unixTimestamp + MAC_EPOCH_OFFSET;

  // mvhd atom: 8 (header) + 1 (version=0) + 3 (flags) + 4 (creation_time) = 16 bytes min
  // We need at least version(1) + flags(3) + creation_time(4) + modification_time(4) + timescale(4) + duration(4) = 20 data bytes
  const mvhdDataSize = 20;
  const mvhdSize = 8 + mvhdDataSize;
  const mvhdBuf = Buffer.alloc(mvhdSize);
  mvhdBuf.writeUInt32BE(mvhdSize, 0);
  mvhdBuf.write('mvhd', 4);
  mvhdBuf.writeUInt8(0, 8);         // version 0
  // flags = 0 (bytes 9-11)
  mvhdBuf.writeUInt32BE(macTime, 12); // creation_time

  // moov atom wrapping mvhd
  const moovSize = 8 + mvhdSize;
  const moovBuf = Buffer.alloc(moovSize);
  moovBuf.writeUInt32BE(moovSize, 0);
  moovBuf.write('moov', 4);
  mvhdBuf.copy(moovBuf, 8);

  // ftyp atom (minimal — 8 bytes)
  const ftypSize = 8;
  const ftypBuf = Buffer.alloc(ftypSize);
  ftypBuf.writeUInt32BE(ftypSize, 0);
  ftypBuf.write('ftyp', 4);

  return Buffer.concat([ftypBuf, moovBuf]);
}

/** Build a minimal MP4 buffer where moov is after mdat (common for streaming-optimised files). */
function buildMp4WithMoovAfterMdat(unixTimestamp: number): Buffer {
  const macTime = unixTimestamp + MAC_EPOCH_OFFSET;

  // ftyp
  const ftypBuf = Buffer.alloc(8);
  ftypBuf.writeUInt32BE(8, 0);
  ftypBuf.write('ftyp', 4);

  // mdat with 64 bytes of fake media data
  const mdatDataSize = 64;
  const mdatSize = 8 + mdatDataSize;
  const mdatBuf = Buffer.alloc(mdatSize);
  mdatBuf.writeUInt32BE(mdatSize, 0);
  mdatBuf.write('mdat', 4);

  // mvhd
  const mvhdDataSize = 20;
  const mvhdSize = 8 + mvhdDataSize;
  const mvhdBuf = Buffer.alloc(mvhdSize);
  mvhdBuf.writeUInt32BE(mvhdSize, 0);
  mvhdBuf.write('mvhd', 4);
  mvhdBuf.writeUInt8(0, 8);
  mvhdBuf.writeUInt32BE(macTime, 12);

  // moov wrapping mvhd
  const moovSize = 8 + mvhdSize;
  const moovBuf = Buffer.alloc(moovSize);
  moovBuf.writeUInt32BE(moovSize, 0);
  moovBuf.write('moov', 4);
  mvhdBuf.copy(moovBuf, 8);

  return Buffer.concat([ftypBuf, mdatBuf, moovBuf]);
}

describe('extractVideoCreationDateFromBuffer', () => {
  it('extracts date from moov at start of file', () => {
    // 2023-06-15T12:00:00Z
    const unixTs = Math.floor(new Date('2023-06-15T12:00:00Z').getTime() / 1000);
    const buf = buildMp4WithMoov(unixTs);
    const result = extractVideoCreationDateFromBuffer(buf);
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date!.getUTCFullYear()).toBe(2023);
    expect(result.date!.getUTCMonth()).toBe(5); // June
    expect(result.date!.getUTCDate()).toBe(15);
    expect(result.moovOffset).toBeUndefined();
  });

  it('returns moovOffset when moov is after mdat and beyond buffer', () => {
    const unixTs = Math.floor(new Date('2023-06-15T12:00:00Z').getTime() / 1000);
    const fullBuf = buildMp4WithMoovAfterMdat(unixTs);
    // Only give it the ftyp + mdat portion (moov is beyond)
    const partialBuf = fullBuf.subarray(0, 8 + 8 + 64); // ftyp(8) + mdat header(8) + mdat data(64)
    const result = extractVideoCreationDateFromBuffer(partialBuf);
    expect(result.date).toBeNull();
    expect(result.moovOffset).toBeDefined();
    expect(result.moovOffset).toBe(8 + 8 + 64); // after ftyp + mdat
  });

  it('extracts date when full buffer includes moov after mdat', () => {
    const unixTs = Math.floor(new Date('2020-01-01T00:00:00Z').getTime() / 1000);
    const buf = buildMp4WithMoovAfterMdat(unixTs);
    const result = extractVideoCreationDateFromBuffer(buf);
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date!.getUTCFullYear()).toBe(2020);
    expect(result.date!.getUTCMonth()).toBe(0); // January
    expect(result.date!.getUTCDate()).toBe(1);
  });

  it('returns null for empty buffer', () => {
    const result = extractVideoCreationDateFromBuffer(Buffer.alloc(0));
    expect(result.date).toBeNull();
    expect(result.moovOffset).toBeUndefined();
  });

  it('returns null for too-small buffer', () => {
    const result = extractVideoCreationDateFromBuffer(Buffer.alloc(4));
    expect(result.date).toBeNull();
  });

  it('returns null when creation_time is 0 (no date)', () => {
    const buf = buildMp4WithMoov(0 - MAC_EPOCH_OFFSET); // makes macTime = 0
    const result = extractVideoCreationDateFromBuffer(buf);
    expect(result.date).toBeNull();
  });
});

describe('extractVideoCreationDateFromMoov', () => {
  it('parses date from standalone moov buffer', () => {
    const unixTs = Math.floor(new Date('2022-08-20T10:30:00Z').getTime() / 1000);
    const macTime = unixTs + MAC_EPOCH_OFFSET;

    // Build a moov buffer with mvhd inside
    const mvhdDataSize = 20;
    const mvhdSize = 8 + mvhdDataSize;
    const mvhdBuf = Buffer.alloc(mvhdSize);
    mvhdBuf.writeUInt32BE(mvhdSize, 0);
    mvhdBuf.write('mvhd', 4);
    mvhdBuf.writeUInt8(0, 8);
    mvhdBuf.writeUInt32BE(macTime, 12);

    const moovSize = 8 + mvhdSize;
    const moovBuf = Buffer.alloc(moovSize);
    moovBuf.writeUInt32BE(moovSize, 0);
    moovBuf.write('moov', 4);
    mvhdBuf.copy(moovBuf, 8);

    const date = extractVideoCreationDateFromMoov(moovBuf);
    expect(date).toBeInstanceOf(Date);
    expect(date!.getUTCFullYear()).toBe(2022);
    expect(date!.getUTCMonth()).toBe(7); // August
    expect(date!.getUTCDate()).toBe(20);
  });

  it('returns null for non-moov buffer', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(16, 0);
    buf.write('mdat', 4);
    expect(extractVideoCreationDateFromMoov(buf)).toBeNull();
  });

  it('returns null for too-small buffer', () => {
    expect(extractVideoCreationDateFromMoov(Buffer.alloc(4))).toBeNull();
  });
});

describe('extractExifMetadataFull', () => {
  it('returns both metadata and raw from a single parse call', async () => {
    const { extractExifMetadataFull } = await import('./exif.js');
    // With an empty buffer, exifr will return nothing
    const result = await extractExifMetadataFull(Buffer.alloc(100));
    expect(result).toHaveProperty('metadata');
    expect(result).toHaveProperty('raw');
    // metadata should be an ExifMetadata (possibly empty)
    expect(typeof result.metadata).toBe('object');
  });

  it('does not throw on invalid input', async () => {
    const { extractExifMetadataFull } = await import('./exif.js');
    const result = await extractExifMetadataFull(Buffer.from('not an image'));
    expect(result.metadata).toEqual({});
    expect(result.raw).toBeUndefined();
  });
});
