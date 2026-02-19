import type { ProviderFactory } from './types.js';

/**
 * In-memory registry of cloud-provider factories.
 *
 * Providers register themselves at startup; consumer code obtains a factory by
 * name and calls it with provider-specific configuration to get a
 * `CloudProvider` instance.
 */
const factories = new Map<string, ProviderFactory>();

/**
 * Register a provider factory under a unique name.
 *
 * @param name     Identifier used to look up the provider (e.g. "s3", "gcs").
 * @param factory  A function that creates a `CloudProvider` from config.
 * @throws {Error} If a factory with the same name is already registered.
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  const key = name.toLowerCase();
  if (factories.has(key)) {
    throw new Error(`Provider "${key}" is already registered`);
  }
  factories.set(key, factory);
}

/**
 * Retrieve a registered provider factory by name.
 *
 * @param name  The provider identifier.
 * @returns The factory function.
 * @throws {Error} If no provider with the given name is registered.
 */
export function getProviderFactory(name: string): ProviderFactory {
  const key = name.toLowerCase();
  const factory = factories.get(key);
  if (!factory) {
    throw new Error(
      `Unknown provider "${key}". Registered providers: ${listProviderNames().join(', ') || '(none)'}`,
    );
  }
  return factory;
}

/**
 * List the names of all registered providers (sorted alphabetically).
 */
export function listProviderNames(): string[] {
  return [...factories.keys()].sort();
}

/**
 * Remove all registered providers. Intended for test teardown.
 */
export function clearProviders(): void {
  factories.clear();
}
