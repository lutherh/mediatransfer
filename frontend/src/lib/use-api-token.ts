import { useCallback, useSyncExternalStore } from 'react';

const ENV_TOKEN: string | undefined = import.meta.env.VITE_API_TOKEN ?? undefined;

/**
 * Read an API token to embed in media URLs (for &lt;img&gt; / &lt;video&gt; src attributes
 * where the Authorization header cannot be used).
 *
 * Priority: `?apiToken=` query-parameter in the URL → `VITE_API_TOKEN` env var.
 * Reacts to popstate / pushState changes so the token stays current.
 */
export function useApiToken(): string | undefined {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener('popstate', onStoreChange);
    return () => window.removeEventListener('popstate', onStoreChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get('apiToken') ?? ENV_TOKEN,
    () => ENV_TOKEN, // SSR snapshot
  );
}
