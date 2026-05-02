import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPauseFlag,
  isPauseRequested,
  pauseFlagPath,
  readPauseFlag,
  requestPause,
} from './pause-flag.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pause-flag-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('takeout/pause-flag', () => {
  it('reports false when no flag exists', async () => {
    expect(await isPauseRequested(tempDir)).toBe(false);
    expect(await readPauseFlag(tempDir)).toBeNull();
  });

  it('writes and reads back the flag', async () => {
    await requestPause(tempDir, 'user clicked pause');
    expect(await isPauseRequested(tempDir)).toBe(true);
    const info = await readPauseFlag(tempDir);
    expect(info?.reason).toBe('user clicked pause');
    expect(info?.pausedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('creates work directory if missing', async () => {
    const nested = path.join(tempDir, 'nested', 'work');
    await requestPause(nested);
    expect(await isPauseRequested(nested)).toBe(true);
  });

  it('clearPauseFlag is idempotent', async () => {
    await clearPauseFlag(tempDir); // no-op when absent
    await requestPause(tempDir);
    await clearPauseFlag(tempDir);
    expect(await isPauseRequested(tempDir)).toBe(false);
    await clearPauseFlag(tempDir); // no-op when already gone
  });

  it('treats a malformed flag file as "set"', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(pauseFlagPath(tempDir), 'not-json', 'utf8');
    expect(await isPauseRequested(tempDir)).toBe(true);
    const info = await readPauseFlag(tempDir);
    expect(info).not.toBeNull();
    expect(info?.reason).toBeNull();
  });

  it('requestPause overwrites an existing flag', async () => {
    await requestPause(tempDir, 'first');
    await requestPause(tempDir, 'second');
    const info = await readPauseFlag(tempDir);
    expect(info?.reason).toBe('second');
  });
});
