import { describe, it, expect } from 'vitest';
import { buildRowModel, estimateRowHeight, sectionDateToRowIndex, type VirtualRow } from './virtual-row-model';
import type { CatalogItem } from '@/lib/api';

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    key: 'photo.jpg',
    encodedKey: 'enc1',
    size: 1000,
    lastModified: '2025-06-16T12:00:00Z',
    capturedAt: '2025-06-16T10:00:00Z',
    mediaType: 'image',
    sectionDate: '2025-06-16',
    ...overrides,
  };
}

describe('buildRowModel', () => {
  it('returns empty for empty sections', () => {
    expect(buildRowModel([], 4)).toEqual([]);
  });

  it('produces month-divider + section-header + items-row for 1 section / 1 item', () => {
    const sections: [string, CatalogItem[]][] = [
      ['2025-06-16', [makeItem()]],
    ];
    const rows = buildRowModel(sections, 3);
    expect(rows).toHaveLength(3); // month-divider, section-header, items-row
    expect(rows[0].type).toBe('month-divider');
    expect(rows[1].type).toBe('section-header');
    expect(rows[2].type).toBe('items-row');
    expect((rows[2] as any).items).toHaveLength(1);
    expect((rows[2] as any).startIndex).toBe(0);
  });

  it('chunks items into rows of cols width', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      makeItem({ encodedKey: `e${i}`, key: `p${i}.jpg` }),
    );
    const sections: [string, CatalogItem[]][] = [['2025-06-16', items]];
    const rows = buildRowModel(sections, 3);
    const itemRows = rows.filter((r) => r.type === 'items-row');
    expect(itemRows).toHaveLength(3); // 3 + 3 + 1
    expect((itemRows[0] as any).items).toHaveLength(3);
    expect((itemRows[1] as any).items).toHaveLength(3);
    expect((itemRows[2] as any).items).toHaveLength(1);
  });

  it('emits one month-divider for two sections in the same month', () => {
    const sections: [string, CatalogItem[]][] = [
      ['2025-06-16', [makeItem({ sectionDate: '2025-06-16' })]],
      ['2025-06-15', [makeItem({ sectionDate: '2025-06-15' })]],
    ];
    const rows = buildRowModel(sections, 4);
    const dividers = rows.filter((r) => r.type === 'month-divider');
    expect(dividers).toHaveLength(1);
    expect((dividers[0] as any).itemCount).toBe(2);
  });

  it('emits separate month-dividers for different months', () => {
    const sections: [string, CatalogItem[]][] = [
      ['2025-06-16', [makeItem({ sectionDate: '2025-06-16' })]],
      ['2024-03-10', [makeItem({ sectionDate: '2024-03-10' })]],
    ];
    const rows = buildRowModel(sections, 4);
    const dividers = rows.filter((r) => r.type === 'month-divider');
    expect(dividers).toHaveLength(2);
  });

  it('marks only the first section-header with isFirst=true', () => {
    const sections: [string, CatalogItem[]][] = [
      ['2025-06-16', [makeItem({ sectionDate: '2025-06-16' })]],
      ['2025-06-15', [makeItem({ sectionDate: '2025-06-15' })]],
      ['2024-03-10', [makeItem({ sectionDate: '2024-03-10' })]],
    ];
    const rows = buildRowModel(sections, 4);
    const headers = rows.filter((r) => r.type === 'section-header') as
      Array<Extract<typeof rows[number], { type: 'section-header' }>>;
    expect(headers).toHaveLength(3);
    expect(headers[0].isFirst).toBe(true);
    expect(headers[1].isFirst).toBe(false);
    expect(headers[2].isFirst).toBe(false);
  });

  it('computes startIndex correctly across sections', () => {
    const sections: [string, CatalogItem[]][] = [
      ['2025-06-16', [
        makeItem({ encodedKey: 'a' }),
        makeItem({ encodedKey: 'b' }),
        makeItem({ encodedKey: 'c' }),
      ]],
      ['2024-03-10', [
        makeItem({ encodedKey: 'd' }),
        makeItem({ encodedKey: 'e' }),
      ]],
    ];
    const rows = buildRowModel(sections, 3);
    const itemRows = rows.filter((r): r is Extract<VirtualRow, { type: 'items-row' }> =>
      r.type === 'items-row',
    );
    // First section: startIndex 0 (3 items, 1 row)
    expect(itemRows[0].startIndex).toBe(0);
    // Second section: startIndex 3 (2 items, 1 row)
    expect(itemRows[1].startIndex).toBe(3);
  });

  it('month-divider picks image coverItem over video', () => {
    const sections: [string, CatalogItem[]][] = [
      ['2025-06-16', [
        makeItem({ mediaType: 'video', encodedKey: 'v1' }),
        makeItem({ mediaType: 'image', encodedKey: 'img1' }),
      ]],
    ];
    const rows = buildRowModel(sections, 4);
    const divider = rows.find((r) => r.type === 'month-divider')!;
    expect((divider as any).coverItem.encodedKey).toBe('img1');
  });

  it('adapts to different column counts', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      makeItem({ encodedKey: `e${i}` }),
    );
    const sections: [string, CatalogItem[]][] = [['2025-06-16', items]];

    const rows4 = buildRowModel(sections, 4);
    const rows8 = buildRowModel(sections, 8);
    expect(rows4.filter((r) => r.type === 'items-row')).toHaveLength(2); // 4+4
    expect(rows8.filter((r) => r.type === 'items-row')).toHaveLength(1); // 8
  });
});

describe('estimateRowHeight', () => {
  it('returns 200 for month-divider', () => {
    const row: VirtualRow = {
      type: 'month-divider', monthKey: '2025-06',
      label: 'June', year: '2025', itemCount: 5, coverItem: undefined,
    };
    expect(estimateRowHeight(row, 1024, 8)).toBe(200);
  });

  it('returns 52 for section-header', () => {
    const row: VirtualRow = { type: 'section-header', date: '2025-06-16', items: [], isFirst: false };
    expect(estimateRowHeight(row, 1024, 8)).toBe(52);
  });

  it('returns tile height + gap for items-row', () => {
    const row: VirtualRow = { type: 'items-row', items: [], startIndex: 0 };
    // 1024 / 8 = 128 + 4 = 132
    expect(estimateRowHeight(row, 1024, 8)).toBe(132);
  });

  it('returns fallback for zero-width container', () => {
    const row: VirtualRow = { type: 'items-row', items: [], startIndex: 0 };
    expect(estimateRowHeight(row, 0, 8)).toBe(120);
  });
});

describe('sectionDateToRowIndex', () => {
  it('finds the row index of a section header', () => {
    const rows = buildRowModel(
      [['2025-06-16', [makeItem()]]],
      4,
    );
    const idx = sectionDateToRowIndex(rows, '2025-06-16');
    expect(idx).toBeDefined();
    expect(rows[idx!].type).toBe('section-header');
  });

  it('returns undefined for unknown date', () => {
    const rows = buildRowModel(
      [['2025-06-16', [makeItem()]]],
      4,
    );
    expect(sectionDateToRowIndex(rows, '2020-01-01')).toBeUndefined();
  });
});
