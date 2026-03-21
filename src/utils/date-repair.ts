/**
 * Pure functions for the date-repair pipeline.
 *
 * Extracted here so both repair scripts and unit tests can consume them
 * without pulling in S3 / dotenv side-effects.
 */
import type { SidecarMetadata } from '../takeout/archive-metadata.js';

// ── Sidecar date parsing ────────────────────────────────────────

/**
 * Parse a date from Google sidecar metadata.
 *
 * Handles:
 *  - Unix timestamps (as strings, seconds since epoch)
 *  - ISO-8601 strings
 *  - Informal date strings like `"19 Jul 2025, 14:27:41 UTC"`
 */
export function parseSidecarDate(sidecar: SidecarMetadata): Date | undefined {
  // Only use photoTakenTime for cross-file date resolution.
  // creationTime is when the photo was added to Google Photos, not when it
  // was captured — using it would assign upload dates to unrelated files.
  return parseDateField(sidecar.photoTakenTime);
}

function parseDateField(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  // Try as numeric unix timestamp (seconds)
  const ts = Number(value);
  if (Number.isFinite(ts) && ts > 0) {
    return new Date(ts * 1000);
  }
  // Try as date string
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return undefined;
}

// ── Date validation ─────────────────────────────────────────────

/**
 * Returns true if the date is clearly not a real capture date:
 * - Before 1990 (pre-consumer digital cameras)
 * - More than 1 day in the future (likely a clock error or bogus metadata)
 */
export function isWrongDate(date: Date): boolean {
  if (date.getUTCFullYear() < 1990) return true;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return date > tomorrow;
}

// ── Path helpers ────────────────────────────────────────────────

/**
 * Extract `album/filename` from a destination key like
 * `transfers/2020/07/19/Summer_Trip/IMG_1234.jpg` → `Summer_Trip/IMG_1234.jpg`.
 */
export function extractAlbumFile(key: string): string {
  return key.split('/').slice(4).join('/');
}

// ── Video extension check ───────────────────────────────────────

const VIDEO_EXT = new Set([
  'mp4', 'mov', 'm4v', '3gp', '3g2', 'avi', 'mkv', 'webm',
]);

export function isVideoKey(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXT.has(ext);
}

// ── Sidecar lookup builder ──────────────────────────────────────

export type SidecarLookup = {
  byKey: Map<string, SidecarMetadata>;
  byAlbumFile: Map<string, SidecarMetadata>;
  byBasename: Map<string, SidecarMetadata[]>;
};

/**
 * Build three-level sidecar lookup maps from archive metadata items.
 * Only includes items with `photoTakenTime` or `creationTime`.
 */
export function buildSidecarLookup(
  items: Array<{ destinationKey: string; sidecar?: SidecarMetadata }>,
): SidecarLookup {
  const byKey = new Map<string, SidecarMetadata>();
  const byAlbumFile = new Map<string, SidecarMetadata>();
  const byBasename = new Map<string, SidecarMetadata[]>();

  for (const item of items) {
    if (!item.sidecar || (!item.sidecar.photoTakenTime && !item.sidecar.creationTime)) continue;
    byKey.set(item.destinationKey, item.sidecar);
    byAlbumFile.set(extractAlbumFile(item.destinationKey), item.sidecar);
    const basename = item.destinationKey.split('/').pop()!;
    if (!byBasename.has(basename)) byBasename.set(basename, []);
    byBasename.get(basename)!.push(item.sidecar);
  }

  return { byKey, byAlbumFile, byBasename };
}

/**
 * Resolve sidecar metadata for a given key using the three-level lookup.
 *
 * Priority: exact key → album+filename → unique basename.
 * Returns undefined if no unambiguous match is found.
 */
export function resolveSidecar(
  lookup: SidecarLookup,
  key: string,
): SidecarMetadata | undefined {
  const filename = key.split('/').pop() ?? '';
  return (
    lookup.byKey.get(key) ??
    lookup.byAlbumFile.get(extractAlbumFile(key)) ??
    (() => {
      const entries = lookup.byBasename.get(filename);
      return entries?.length === 1 ? entries[0] : undefined;
    })()
  );
}
