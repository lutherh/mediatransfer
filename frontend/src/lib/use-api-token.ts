import { useMemo } from 'react';

/**
 * Read an optional `apiToken` query-parameter from the URL. Memoized so the
 * URLSearchParams parse happens only once per mount.
 */
export function useApiToken(): string | undefined {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('apiToken') ?? undefined;
  }, []);
}
