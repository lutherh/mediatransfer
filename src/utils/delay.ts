/** Shared async delay and exponential-backoff helpers. */

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute an exponential-backoff delay with random jitter.
 *
 * @param attempt  1-based attempt number
 * @param baseMs   base delay in milliseconds (default 500)
 * @param maxMs    ceiling in milliseconds (default 5000)
 * @returns delay in milliseconds
 */
export function computeBackoff(
  attempt: number,
  baseMs = 500,
  maxMs = 5000,
): number {
  const exponential = Math.min(baseMs * (2 ** (attempt - 1)), maxMs);
  const jitter = Math.floor(Math.random() * Math.max(50, Math.floor(baseMs * 0.2)));
  return Math.min(exponential + jitter, maxMs);
}
