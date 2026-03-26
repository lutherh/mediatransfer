import { useCallback, useSyncExternalStore } from 'react';

/**
 * Read an optional `apiToken` query-parameter from the URL.
 * Reacts to popstate / pushState changes so the token stays current.
 */
export function useApiToken(): string | undefined {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener('popstate', onStoreChange);
    return () => window.removeEventListener('popstate', onStoreChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get('apiToken') ?? undefined,
    () => undefined, // SSR snapshot
  );
}
