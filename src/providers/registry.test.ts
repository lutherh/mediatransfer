import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  getProviderFactory,
  listProviderNames,
  clearProviders,
} from './registry.js';
import type { CloudProvider, ProviderConfig, ProviderFactory } from './types.js';

// ── Helpers ────────────────────────────────────────────────────

/** Minimal stub that satisfies the CloudProvider interface. */
function stubProvider(name: string): CloudProvider {
  return {
    name,
    list: async () => [],
    download: async () => {
      throw new Error('not implemented');
    },
    upload: async () => {},
    delete: async () => {},
  } as unknown as CloudProvider;
}

/** A factory that returns a stub provider. */
const stubFactory: ProviderFactory = (config: ProviderConfig) =>
  stubProvider(config.provider);

// ── Tests ──────────────────────────────────────────────────────

describe('providers/registry', () => {
  beforeEach(() => {
    clearProviders();
  });

  // ── registerProvider ────────────────────────────────────────

  describe('registerProvider', () => {
    it('should register a provider factory successfully', () => {
      registerProvider('s3', stubFactory);

      expect(listProviderNames()).toContain('s3');
    });

    it('should normalise names to lowercase', () => {
      registerProvider('S3', stubFactory);

      expect(listProviderNames()).toContain('s3');
      expect(getProviderFactory('s3')).toBe(stubFactory);
    });

    it('should throw when registering the same name twice', () => {
      registerProvider('s3', stubFactory);

      expect(() => registerProvider('s3', stubFactory)).toThrow(
        'Provider "s3" is already registered',
      );
    });

    it('should throw for duplicate names regardless of casing', () => {
      registerProvider('GCS', stubFactory);

      expect(() => registerProvider('gcs', stubFactory)).toThrow(
        'Provider "gcs" is already registered',
      );
    });
  });

  // ── getProviderFactory ─────────────────────────────────────

  describe('getProviderFactory', () => {
    it('should return the registered factory', () => {
      registerProvider('s3', stubFactory);

      const factory = getProviderFactory('s3');
      expect(factory).toBe(stubFactory);
    });

    it('should look up names case-insensitively', () => {
      registerProvider('gcs', stubFactory);

      expect(getProviderFactory('GCS')).toBe(stubFactory);
    });

    it('should throw for an unknown provider', () => {
      expect(() => getProviderFactory('unknown')).toThrow(
        /Unknown provider "unknown"/,
      );
    });

    it('should list registered providers in the error message', () => {
      registerProvider('s3', stubFactory);
      registerProvider('gcs', stubFactory);

      expect(() => getProviderFactory('azure')).toThrow(
        /Registered providers: gcs, s3/,
      );
    });

    it('should show "(none)" when no providers are registered', () => {
      expect(() => getProviderFactory('foo')).toThrow(
        /Registered providers: \(none\)/,
      );
    });

    it('should return a functional factory that creates a provider', () => {
      registerProvider('s3', stubFactory);

      const factory = getProviderFactory('s3');
      const provider = factory({ provider: 's3', bucket: 'my-bucket' });

      expect(provider.name).toBe('s3');
      expect(typeof provider.list).toBe('function');
      expect(typeof provider.download).toBe('function');
      expect(typeof provider.upload).toBe('function');
      expect(typeof provider.delete).toBe('function');
    });
  });

  // ── listProviderNames ──────────────────────────────────────

  describe('listProviderNames', () => {
    it('should return an empty array when no providers are registered', () => {
      expect(listProviderNames()).toEqual([]);
    });

    it('should return all registered names sorted alphabetically', () => {
      registerProvider('gcs', stubFactory);
      registerProvider('azure-blob', stubFactory);
      registerProvider('s3', stubFactory);

      expect(listProviderNames()).toEqual(['azure-blob', 'gcs', 's3']);
    });
  });

  // ── clearProviders ─────────────────────────────────────────

  describe('clearProviders', () => {
    it('should remove all registered providers', () => {
      registerProvider('s3', stubFactory);
      registerProvider('gcs', stubFactory);

      clearProviders();

      expect(listProviderNames()).toEqual([]);
    });
  });
});
