import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// vi.mock is hoisted; use a closure-captured spy so tests can configure return values.
const spawnMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: spawnMock };
});

const MODULE_PATH = './caffeinate.js';

function makeFakeChild() {
  const ee = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
  };
  ee.pid = 99999;
  ee.killed = false;
  ee.kill = vi.fn(() => {
    ee.killed = true;
    return true;
  });
  ee.unref = vi.fn();
  return ee;
}

describe('ensureCaffeinate', () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env.MEDIATRANSFER_CAFFEINATE;

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    delete process.env.MEDIATRANSFER_CAFFEINATE;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalEnv === undefined) delete process.env.MEDIATRANSFER_CAFFEINATE;
    else process.env.MEDIATRANSFER_CAFFEINATE = originalEnv;
  });

  it('is a no-op on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { ensureCaffeinate } = await import(MODULE_PATH);
    const release = ensureCaffeinate();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(typeof release).toBe('function');
    release();
  });

  it('is a no-op when MEDIATRANSFER_CAFFEINATE=0', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.MEDIATRANSFER_CAFFEINATE = '0';

    const { ensureCaffeinate } = await import(MODULE_PATH);
    ensureCaffeinate();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns caffeinate -dimsu -w <pid> on darwin and unrefs the child', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { ensureCaffeinate } = await import(MODULE_PATH);
    ensureCaffeinate();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'caffeinate',
      ['-dimsu', '-w', String(process.pid)],
      expect.objectContaining({ stdio: 'ignore', detached: false }),
    );
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second call within the same process does not spawn twice', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { ensureCaffeinate } = await import(MODULE_PATH);
    ensureCaffeinate();
    ensureCaffeinate();
    ensureCaffeinate();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returned release function kills the child', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { ensureCaffeinate } = await import(MODULE_PATH);
    const release = ensureCaffeinate();
    release();

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('survives ENOENT (caffeinate not installed) without throwing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const { ensureCaffeinate } = await import(MODULE_PATH);
    expect(() => ensureCaffeinate()).not.toThrow();

    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(() => fakeChild.emit('error', enoent)).not.toThrow();
  });

  it('survives a synchronous spawn() throw without crashing the caller', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EAGAIN');
    });

    const { ensureCaffeinate } = await import(MODULE_PATH);
    expect(() => ensureCaffeinate()).not.toThrow();
  });

  it('clears internal state when the child exits, allowing a fresh spawn next call', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const firstChild = makeFakeChild();
    const secondChild = makeFakeChild();
    spawnMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);

    const { ensureCaffeinate } = await import(MODULE_PATH);
    ensureCaffeinate();
    firstChild.emit('exit', 0, null);
    ensureCaffeinate();

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
