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
