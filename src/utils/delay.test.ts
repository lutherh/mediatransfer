import { vi } from 'vitest';
import { delay, computeBackoff } from './delay.js';

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves only after the given time has elapsed', async () => {
    const order: string[] = [];
    const p = delay(1000).then(() => order.push('delay'));

    await vi.advanceTimersByTimeAsync(999);
    await Promise.resolve();
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['delay']);
  });

  it('resolves multiple delays in chronological order', async () => {
    const order: number[] = [];
    const p1 = delay(100).then(() => order.push(100));
    const p2 = delay(50).then(() => order.push(50));
    const p3 = delay(200).then(() => order.push(200));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([50, 100, 200]);
  });

  it('delay(0) resolves on next tick', async () => {
    let resolved = false;
    const p = delay(0).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });
});

describe('computeBackoff', () => {
  it('returns >= baseMs for attempt=1', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoff(1)).toBeGreaterThanOrEqual(500);
    }
  });

  it('grows roughly 2^(attempt-1) * baseMs for small attempts', () => {
    const baseMs = 500;
    const maxJitter = Math.max(50, Math.floor(baseMs * 0.2));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const expected = baseMs * 2 ** (attempt - 1);
      for (let i = 0; i < 20; i++) {
        const v = computeBackoff(attempt, baseMs, 5000);
        expect(v).toBeGreaterThanOrEqual(expected);
        expect(v).toBeLessThanOrEqual(expected + maxJitter);
      }
    }
  });

  it('never exceeds maxMs', () => {
    for (let i = 0; i < 100; i++) {
      expect(computeBackoff(20)).toBeLessThanOrEqual(5000);
    }
  });

  it('respects custom baseMs/maxMs overrides', () => {
    for (let i = 0; i < 50; i++) {
      const v = computeBackoff(1, 100, 250);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(250);
    }
    for (let i = 0; i < 50; i++) {
      expect(computeBackoff(15, 100, 250)).toBeLessThanOrEqual(250);
    }
  });

  it('jitter is non-negative and bounded over many iterations', () => {
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      samples.push(computeBackoff(1, 500, 5000));
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(500);
    expect(max).toBeLessThanOrEqual(500 + 100);
    expect(max).toBeGreaterThan(min);
  });
});
