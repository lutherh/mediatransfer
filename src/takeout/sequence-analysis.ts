/**
 * Analyse takeout archive names for gaps in their numbering sequences.
 *
 * Google Takeout archives follow the pattern:
 *   takeout-20260308T081854Z-3-001.tgz
 *   takeout-20260308T081854Z-3-002.tgz
 *   ...
 * where the middle number is an export identifier and the last number is
 * the 1-based part index.  Browser re-downloads may add a " (1)" suffix
 * (e.g. "takeout-…-109 (1).tgz") which is stripped before parsing.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type SequenceGroup = {
  /** The date-based prefix, e.g. "takeout-20260308T081854Z" */
  prefix: string;
  /** Export identifier from the filename (the N in `-N-XXX`) */
  exportNumber: number;
  /** Extension shared by entries in this group (e.g. ".tgz") */
  extension: string;
  /** Sequence indices present (1-based) */
  present: number[];
  /** Sequence indices that are missing (gaps between 1 and maxSeen) */
  missing: number[];
  /** Whether we have all parts 1…maxSeen with no gaps */
  isComplete: boolean;
  /** The highest sequence number seen */
  maxSeen: number;
};

export type SequenceAnalysis = {
  /** Groups keyed by their normalised prefix + export number */
  groups: SequenceGroup[];
  /** Total archives analysed */
  totalArchives: number;
  /** Archives whose names didn't match the expected pattern */
  unrecognised: string[];
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Strip browser download-duplicate suffix like " (1)", " (2)" etc.
 * e.g. `takeout-…-109 (1).tgz` → `takeout-…-109.tgz`
 */
export function normaliseArchiveName(name: string): string {
  return name.replace(/\s*\(\d+\)(?=\.[a-z.]+$)/i, '');
}

// ─── Pattern ───────────────────────────────────────────────────────────────

/**
 * Captures (after normalisation):
 *  1 – prefix        e.g. "takeout-20260308T081854Z"
 *  2 – export number e.g. "3"
 *  3 – part index    e.g. "001"
 *  4 – extension     e.g. ".tgz"
 */
const ARCHIVE_NAME_RE =
  /^(takeout-\d{8}T\d{6}Z)-(\d+)-(\d+)(\.[a-z.]+)$/i;

// ─── Analysis ──────────────────────────────────────────────────────────────

export function analyseArchiveSequences(archiveNames: string[]): SequenceAnalysis {
  const groupMap = new Map<string, {
    prefix: string;
    exportNumber: number;
    extension: string;
    indices: Set<number>;
  }>();
  const unrecognised: string[] = [];

  for (const name of archiveNames) {
    const normalised = normaliseArchiveName(name);
    const match = ARCHIVE_NAME_RE.exec(normalised);
    if (!match) {
      unrecognised.push(name);
      continue;
    }

    const [, prefix, exportStr, seqStr, ext] = match;
    const exportNumber = Number(exportStr);
    const seqIndex = Number(seqStr);
    const key = `${prefix}|${exportNumber}|${ext}`;

    let group = groupMap.get(key);
    if (!group) {
      group = { prefix, exportNumber, extension: ext, indices: new Set() };
      groupMap.set(key, group);
    }
    group.indices.add(seqIndex);
  }

  const groups: SequenceGroup[] = [];

  for (const g of groupMap.values()) {
    const present = [...g.indices].sort((a, b) => a - b);
    const maxSeen = present.length > 0 ? present[present.length - 1] : 0;

    const missing: number[] = [];
    for (let i = 1; i <= maxSeen; i++) {
      if (!g.indices.has(i)) {
        missing.push(i);
      }
    }

    groups.push({
      prefix: g.prefix,
      exportNumber: g.exportNumber,
      extension: g.extension,
      present,
      missing,
      isComplete: missing.length === 0 && maxSeen > 0,
      maxSeen,
    });
  }

  // Sort groups by prefix then by export number
  groups.sort((a, b) =>
    a.prefix.localeCompare(b.prefix) || a.exportNumber - b.exportNumber,
  );

  return {
    groups,
    totalArchives: archiveNames.length,
    unrecognised,
  };
}
