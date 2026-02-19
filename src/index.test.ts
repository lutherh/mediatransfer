import { describe, it, expect } from 'vitest';
import { main } from './index.js';

describe('Project setup', () => {
  it('should have the main function defined', () => {
    expect(main).toBeDefined();
    expect(typeof main).toBe('function');
  });

  it('should verify TypeScript compilation works', () => {
    const value: string = 'mediatransfer';
    expect(value).toBe('mediatransfer');
  });

  it('should support ESM imports', async () => {
    const mod = await import('./index.js');
    expect(mod).toHaveProperty('main');
  });
});
