import { describe, it, expect } from 'vitest';
import { getColumnCount } from './grid-columns';

describe('getColumnCount', () => {
  it('returns 3 for narrow screens (< 640)', () => {
    expect(getColumnCount(0)).toBe(3);
    expect(getColumnCount(320)).toBe(3);
    expect(getColumnCount(639)).toBe(3);
  });

  it('returns 4 for sm breakpoint (640–767)', () => {
    expect(getColumnCount(640)).toBe(4);
    expect(getColumnCount(767)).toBe(4);
  });

  it('returns 6 for md breakpoint (768–1023)', () => {
    expect(getColumnCount(768)).toBe(6);
    expect(getColumnCount(1023)).toBe(6);
  });

  it('returns 8 for lg breakpoint (≥ 1024)', () => {
    expect(getColumnCount(1024)).toBe(8);
    expect(getColumnCount(1920)).toBe(8);
  });
});
