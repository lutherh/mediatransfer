/**
 * Analyse takeout archive names for gaps in their numbering sequences.
 *
 * Google Takeout archives follow the pattern:
 *   takeout-20260308T081854Z-3-001.tgz
 *   takeout-20260308T081854Z-3-002.tgz
 *   ...
 * where the middle number is the declared total parts and the last number is
 * the 1-based sequence index.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type SequenceGroup = {
  /** The date-based prefix, e.g. "takeout-20260308T081854Z" */
  prefix: string;
  /** Declared total parts from the filename (the N in `-N-XXX`) */
  declaredTotal: number;
  /** Extension shared by entries in this group (e.g. ".tgz") */
  extension: string;
  /** Sequence indices present (1-based) */
  present: number[];
  /** Sequence indices that are missing */
  missing: number[];
  /** Whether we have all parts 1…declaredTotal */
  isComplete: boolean;
  /** The highest sequence number seen */
  maxSeen: number;
};

export type SequenceAnalysis = {
  /** Groups keyed by their normalised prefix + declared total */
  groups: SequenceGroup[];
  /** Total archives analysed */
  totalArchives: number;
  /** Archives whose names didn't match the expected pattern */
  unrecognised: string[];
};

// ─── Pattern ───────────────────────────────────────────────────────────────

/**
 * Captures:
 *  1 – prefix  e.g. "takeout-20260308T081854Z"
 *  2 – declared total  e.g. "3"
 *  3 – sequence index  e.g. "001"
 *  4 – extension  e.g. ".tgz"
 */
const ARCHIVE_NAME_RE =
  /^(takeout-\d{8}T\d{6}Z)-(\d+)-(\d+)(\.[a-z.]+)$/i;

// ─── Analysis ──────────────────────────────────────────────────────────────

export function analyseArchiveSequences(archiveNames: string[]): SequenceAnalysis {
  const groupMap = new Map<string, {
    prefix: string;
    declaredTotal: number;
    extension: string;
    indices: Set<number>;
  }>();
  const unrecognised: string[] = [];

  for (const name of archiveNames) {
    const match = ARCHIVE_NAME_RE.exec(name);
    if (!match) {
      unrecognised.push(name);
      continue;
    }

    const [, prefix, totalStr, seqStr, ext] = match;
    const declaredTotal = Number(totalStr);
    const seqIndex = Number(seqStr);
    const key = `${prefix}|${declaredTotal}|${ext}`;

    let group = groupMap.get(key);
    if (!group) {
      group = { prefix, declaredTotal, extension: ext, indices: new Set() };
      groupMap.set(key, group);
    }
    group.indices.add(seqIndex);
  }

  const groups: SequenceGroup[] = [];

  for (const g of groupMap.values()) {
    const present = [...g.indices].sort((a, b) => a - b);
    const maxSeen = present.length > 0 ? present[present.length - 1] : 0;
    const expectedMax = Math.max(g.declaredTotal, maxSeen);

    const missing: number[] = [];
    for (let i = 1; i <= expectedMax; i++) {
      if (!g.indices.has(i)) {
        missing.push(i);
      }
    }

    groups.push({
      prefix: g.prefix,
      declaredTotal: g.declaredTotal,
      extension: g.extension,
      present,
      missing,
      isComplete: missing.length === 0 && present.length === g.declaredTotal,
      maxSeen,
    });
  }

  // Sort groups by prefix then by declared total
  groups.sort((a, b) =>
    a.prefix.localeCompare(b.prefix) || a.declaredTotal - b.declaredTotal,
  );

  return {
    groups,
    totalArchives: archiveNames.length,
    unrecognised,
  };
}
