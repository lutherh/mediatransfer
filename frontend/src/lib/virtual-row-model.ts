import type { CatalogItem } from '@/lib/api';

export const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type VirtualRow =
  | {
      type: 'month-divider';
      monthKey: string;      // "2025-06"
      label: string;         // "June"
      year: string;          // "2025"
      itemCount: number;
      coverItem: CatalogItem | undefined;
    }
  | {
      type: 'section-header';
      date: string;          // "2025-06-16"
      items: CatalogItem[];  // all items in this section (for select-all checkbox)
      isFirst: boolean;      // true for the very first section-header in the list
    }
  | {
      type: 'items-row';
      items: CatalogItem[];  // 1..cols items in this row
      startIndex: number;    // offset into the global sortedItems flat array
    };

/**
 * Convert the `sections` array (date → items) into a flat VirtualRow[] for
 * use with a virtualizer. Inserts month-divider rows at each month boundary.
 */
export function buildRowModel(
  sections: [string, CatalogItem[]][],
  cols: number,
): VirtualRow[] {
  // Pre-scan: build per-month metadata (itemCount, coverItem)
  const monthMeta = new Map<string, { itemCount: number; coverItem: CatalogItem | undefined }>();
  for (const [date, items] of sections) {
    const mk = date.slice(0, 7);
    const existing = monthMeta.get(mk);
    if (existing) {
      existing.itemCount += items.length;
      if (!existing.coverItem || existing.coverItem.mediaType !== 'image') {
        existing.coverItem =
          items.find((it) => it.mediaType === 'image') ?? existing.coverItem ?? items[0];
      }
    } else {
      monthMeta.set(mk, {
        itemCount: items.length,
        coverItem: items.find((it) => it.mediaType === 'image') ?? items[0],
      });
    }
  }

  const rows: VirtualRow[] = [];
  let globalIndex = 0;
  let prevMonthKey: string | null = null;
  let isFirstSection = true;

  for (const [date, items] of sections) {
    const curMonthKey = date.slice(0, 7); // "2025-06"

    if (curMonthKey !== prevMonthKey) {
      const meta = monthMeta.get(curMonthKey)!;
      const m = parseInt(date.slice(5, 7), 10) - 1; // 0-indexed month
      rows.push({
        type: 'month-divider',
        monthKey: curMonthKey,
        label: FULL_MONTHS[m],
        year: date.slice(0, 4),
        itemCount: meta.itemCount,
        coverItem: meta.coverItem,
      });
      prevMonthKey = curMonthKey;
    }

    rows.push({ type: 'section-header', date, items, isFirst: isFirstSection });
    isFirstSection = false;

    for (let i = 0; i < items.length; i += cols) {
      rows.push({
        type: 'items-row',
        items: items.slice(i, i + cols),
        startIndex: globalIndex + i,
      });
    }

    globalIndex += items.length;
  }

  return rows;
}

/**
 * Estimate the rendered height of a virtual row.
 * Used by the virtualizer as the initial/estimated row height.
 */
export function estimateRowHeight(
  row: VirtualRow,
  containerWidth: number,
  cols: number,
): number {
  switch (row.type) {
    case 'month-divider': return 200;
    case 'section-header': return 52;
    case 'items-row': return containerWidth > 0
      ? Math.floor(containerWidth / cols) + 4   // tile + 4px gap
      : 120;
  }
}

/**
 * Find the row index of a section-header row for a given ISO date string.
 * Returns undefined if not found.
 */
export function sectionDateToRowIndex(
  rowModel: VirtualRow[],
  date: string,
): number | undefined {
  const idx = rowModel.findIndex(
    (r) => r.type === 'section-header' && r.date === date,
  );
  return idx >= 0 ? idx : undefined;
}
