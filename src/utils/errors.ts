/** Shared error inspection helpers. */

/** Extract a human-readable message from an unknown thrown value. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the error has a Node `code` property matching `expected`. */
function hasSystemCode(error: unknown, expected: string): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === expected,
  );
}

/** ENOENT – file or directory does not exist. */
export function isFileNotFoundError(error: unknown): boolean {
  return hasSystemCode(error, 'ENOENT');
}

/** EXDEV – rename across filesystem boundaries. */
export function isCrossDeviceError(error: unknown): boolean {
  return hasSystemCode(error, 'EXDEV');
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TRANSIENT_NETWORK_NAMES = new Set([
  'NetworkingError',
  'TimeoutError',
  'AbortError',
]);

function matchesTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && TRANSIENT_NETWORK_NAMES.has(name)) return true;
  return false;
}

/**
 * True when the error looks like a transient infrastructure failure
 * (DNS, TCP/TLS, idle timeout) that is worth retrying with a longer
 * backoff. Distinct from S3-side failures (4xx/5xx with a body), which
 * the AWS SDK already retries.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (matchesTransientNetworkError(error)) return true;
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (matchesTransientNetworkError(cause)) return true;
  }
  return false;
}
