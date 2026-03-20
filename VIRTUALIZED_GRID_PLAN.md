# Virtualized Catalog Grid — Implementation Guide

> **Branch:** `feature/virtualized-catalog-grid`  
> **Goal:** Replace the DOM-heavy infinite-scroll grid with a section-aware
> virtualized renderer. The catalog must stay responsive with 10k+ items.  
> **Rule:** Every step ends with a test checkpoint. Do not proceed until green.

---

## Context for the Implementer

### Current pain points (measured)
- `allItems` = `pages.flatMap(p => p.items)` — never pruned, grows forever
- Every item = 1 real DOM node with `IntersectionObserver`, event listeners
- `sections` + `sortedItems` + `sectionOffsets` recompute on the full array each page
- At 5k items: ~5000 DOM thumbnail nodes, ~5000 IntersectionObservers

### What stays unchanged
- `useInfiniteQuery` data fetching (queryKey, queryFn, pagination)
- `sortedItems: CatalogItem[]` flat array (lightbox + shift-click source of truth)
- `selected: Set<string>` (O(1) lookups)
- `sections: [string, CatalogItem[]][]` grouping logic
- `Lightbox` component (operates on `sortedItems[index]`)
- `fetchCatalogStats`, `fetchCatalogItems` API layer
- `useThumbnailQueue` concurrency limiter (30 slots)

### Key types (from `@/lib/api`)
```ts
type CatalogItem = {
  key: string; encodedKey: string; size: number;
  lastModified: string; capturedAt: string;
  mediaType: 'image' | 'video' | 'other'; sectionDate: string;
};
type CatalogPage = { items: CatalogItem[]; nextToken?: string };
```

### Test infrastructure
- Framework: vitest + @testing-library/react + jsdom
- Setup: `frontend/src/test/setup.ts` — mocks `IntersectionObserver`
- Run: `cd frontend && npm test` (or `npx vitest run`)
- Path alias: `@/` → `./src/`
- Globals: `vi`, `describe`, `it`, `expect` are global (vitest globals: true)

### Breakpoint → column mapping (Tailwind classes in current grid)
```
grid-cols-3              → width < 640         → 3 cols
sm:grid-cols-4           → 640 ≤ width < 768   → 4 cols
md:grid-cols-6           → 768 ≤ width < 1024  → 6 cols
lg:grid-cols-8           → width ≥ 1024        → 8 cols
```

---

## Phase 1 — Pure Logic Layer (no UI changes)

> Build and fully test the row model + helpers before touching any components.

### Step 1.1 · Install @tanstack/react-virtual

**Command:**
```bash
cd frontend && npm install @tanstack/react-virtual
```

**Verify:**
```bash
npm ls @tanstack/react-virtual   # must show version, exit 0
```

**No test file needed — dependency install only.**

---

### Step 1.2 · `getColumnCount()` pure function

**File:** `frontend/src/lib/grid-columns.ts`

This is a **pure function** (not a hook). The virtualizer will call it with a
measured container width. No React dependency, no ResizeObserver — that
belongs in the component layer (Phase 2).

```ts
/** Map container width to column count matching the Tailwind breakpoints. */
export function getColumnCount(width: number): number {
  if (width >= 1024) return 8;
  if (width >= 768) return 6;
  if (width >= 640) return 4;
  return 3;
}
```

**Test file:** `frontend/src/lib/grid-columns.test.ts`

Write these exact tests:
```ts
import { describe, it, expect } from 'vitest';
import { getColumnCount } from './grid-columns';

describe('getColumnCount', () => {
  it('returns 3 for narrow screens (< 640)', () => {
    expect(getColumnCount(0)).toBe(3);
    expect(getColumnCount(320)).toBe(3);
    expect(getColumnCount(639)).toBe(3);
  });

  it('returns 4 for sm breakpoint (640–767)', () => {
    expect(getColumnCount(640)).toBe(4);
    expect(getColumnCount(767)).toBe(4);
  });

  it('returns 6 for md breakpoint (768–1023)', () => {
    expect(getColumnCount(768)).toBe(6);
    expect(getColumnCount(1023)).toBe(6);
  });

  it('returns 8 for lg breakpoint (≥ 1024)', () => {
    expect(getColumnCount(1024)).toBe(8);
    expect(getColumnCount(1920)).toBe(8);
  });
});
```

**Checkpoint:** `cd frontend && npx vitest run src/lib/grid-columns.test.ts` — all green.

---

### Step 1.3 · Row model builder

**File:** `frontend/src/lib/virtual-row-model.ts`

This is the core algorithm. Pure function, no React imports. It converts
the existing `sections` array into a flat `VirtualRow[]` that the
virtualizer will iterate.

**Types:**
```ts
import type { CatalogItem } from '@/lib/api';

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
    }
  | {
      type: 'items-row';
      items: CatalogItem[];  // 1..cols items in this row
      startIndex: number;    // offset into the global sortedItems flat array
    };
```

**Function signature:**
```ts
export function buildRowModel(
  sections: [string, CatalogItem[]][],
  cols: number,
): VirtualRow[]
```

**Algorithm (copy the month-boundary logic from the existing rendering block):**
```
globalIndex = 0
prevMonthKey = null
for each [date, items] in sections:
  curMonthKey = date.slice(0, 7)     // "2025-06"
  if curMonthKey !== prevMonthKey:
    emit month-divider { monthKey, label=FULL_MONTHS[month], year, itemCount, coverItem }
    prevMonthKey = curMonthKey
  emit section-header { date, items }
  chunk items into rows of `cols`:
    for i=0; i < items.length; i += cols:
      emit items-row { items: items.slice(i, i+cols), startIndex: globalIndex + i }
  globalIndex += items.length
```

The month-divider `itemCount` and `coverItem` must accumulate across all
sections in the same month (same logic as existing `buildMonthGroups`).
Pre-scan sections to build a `Map<monthKey, {itemCount, coverItem}>` before
the main loop. Reuse the existing `FULL_MONTHS` array (export it or
duplicate the 12 strings).

**Also export `estimateRowHeight`:**
```ts
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
```

**Also export a helper to find the row index for a given section date:**
```ts
export function sectionDateToRowIndex(
  rowModel: VirtualRow[],
  date: string,
): number | undefined {
  const idx = rowModel.findIndex(
    (r) => r.type === 'section-header' && r.date === date,
  );
  return idx >= 0 ? idx : undefined;
}
```

**Test file:** `frontend/src/lib/virtual-row-model.test.ts`

Write these tests — use inline mock `CatalogItem` factories:

```ts
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
    const row: VirtualRow = { type: 'section-header', date: '2025-06-16', items: [] };
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
```

**Checkpoint:** `cd frontend && npx vitest run src/lib/virtual-row-model.test.ts src/lib/grid-columns.test.ts` — all green.

---

## Phase 2 — Extract Components + Build VirtualizedGrid

> Extract the existing inline components to their own files, then build the
> virtualizer wrapper. No changes to CatalogPage rendering yet.

### Step 2.1 · Extract Thumbnail, SectionHeader, MonthDivider

Extract these from `catalog-page.tsx` into separate files. **No logic
changes** — cut-paste + add imports/exports.

| Component | From (lines in catalog-page.tsx) | To |
|-----------|-----------------------------------|-----|
| `Thumbnail` | ~587–721 | `frontend/src/components/catalog/thumbnail.tsx` |
| `SectionHeader` | ~699–737 | `frontend/src/components/catalog/section-header.tsx` |
| `MonthDivider` | ~801–857 | `frontend/src/components/catalog/month-divider.tsx` |

Each extracted file:
1. Imports what it needs (`useCallback`, `useEffect`, `useState`, `useRef`,
   `useThumbnailQueue`, `catalogThumbnailUrl`, `type CatalogItem`).
2. Exports the component as a named export.
3. `catalog-page.tsx` imports from the new paths instead of defining inline.

Also export the helper functions these components need:
- `formatSectionDate` → export from `catalog-page.tsx` or move to a shared
  `frontend/src/lib/format-dates.ts`.
- `formatBytes` → same.

**Tests:**
- Run existing `catalog-page.test.tsx` — must still pass with zero changes
  to the test file (the test imports `CatalogPage`, not the sub-components).
- Add per-component tests only if time permits (they are optional since the
  integration tests cover the behavior).

**Checkpoint:** `cd frontend && npx vitest run` — all existing tests green.

---

### Step 2.2 · Remove per-Thumbnail IntersectionObserver

In the extracted `thumbnail.tsx`, remove:
- `isNearViewport` state
- The `useEffect` that creates a per-cell `IntersectionObserver`
- The `cellRef` (only used for IO — reconsider if needed for anything else)

Replace:
```ts
// OLD: const wantUrl = isNearViewport ? catalogThumbnailUrl(...) : null;
// NEW:
const wantUrl = catalogThumbnailUrl(item.encodedKey, 'small', apiToken);
```

The virtualizer guarantees that if a Thumbnail is mounted, it's within the
visible window + overscan. The `useThumbnailQueue(30)` concurrency limit
still prevents browser flooding.

**Tests:**
- Existing tests pass (the jsdom mock for IntersectionObserver becomes unused
  by Thumbnail but doesn't break anything).
- Thumbnail now requests its thumbnail URL immediately on mount — verify
  by checking that `catalogThumbnailUrl` is called during render (already
  covered by existing tests).

**Checkpoint:** `cd frontend && npx vitest run` — all green.

---

### Step 2.3 · Build VirtualizedGrid component

**File:** `frontend/src/components/virtualized-grid.tsx`

This is the main new component. It replaces the `sections.map()` block in
CatalogPage.

**Props interface:**
```ts
import type { CatalogItem } from '@/lib/api';

export interface VirtualizedGridProps {
  sections: [string, CatalogItem[]][];
  sortedItems: CatalogItem[];
  selected: Set<string>;
  selectionMode: boolean;
  apiToken: string | undefined;
  onToggleSelect: (encodedKey: string, flatIndex: number) => void;
  onOpenLightbox: (index: number) => void;
  onShiftClick: (index: number) => void;
  onToggleSection: (keys: string[], select: boolean) => void;
  // Needed for DateScroller — updated from virtual items
  sectionRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  // Infinite scroll triggers
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}
```

**Implementation outline:**
```tsx
export function VirtualizedGrid(props: VirtualizedGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 1. Observe container width via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = getColumnCount(containerWidth);

  // 2. Build row model
  const rowModel = useMemo(
    () => buildRowModel(props.sections, cols),
    [props.sections, cols],
  );

  // 3. Create virtualizer (window scroll mode)
  const virtualizer = useWindowVirtualizer({
    count: rowModel.length,
    estimateSize: (i) => estimateRowHeight(rowModel[i], containerWidth, cols),
    overscan: 5,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  });

  // 4. Infinite scroll: fetch next page when near bottom
  const virtualItems = virtualizer.getVirtualItems();
  const lastItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (!lastItem) return;
    if (
      lastItem.index >= rowModel.length - 5 &&
      props.hasNextPage &&
      !props.isFetchingNextPage
    ) {
      props.fetchNextPage();
    }
  }, [lastItem?.index, rowModel.length, props.hasNextPage, props.isFetchingNextPage]);

  // 5. Update sectionRefs for DateScroller
  useEffect(() => {
    // Clear stale refs, then set refs for visible section-headers
    props.sectionRefs.current.clear();
    for (const vItem of virtualItems) {
      const row = rowModel[vItem.index];
      if (row.type === 'section-header') {
        const el = document.querySelector(`[data-virtual-index="${vItem.index}"]`);
        if (el instanceof HTMLElement) {
          props.sectionRefs.current.set(row.date, el);
        }
      }
    }
  });

  // 6. Render
  return (
    <div ref={containerRef}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((vItem) => {
          const row = rowModel[vItem.index];
          return (
            <div
              key={vItem.index}
              data-virtual-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vItem.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {row.type === 'month-divider' && (
                <MonthDivider ... />
              )}
              {row.type === 'section-header' && (
                <SectionHeader ... />
              )}
              {row.type === 'items-row' && (
                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                  {row.items.map((item, i) => (
                    <Thumbnail
                      key={item.encodedKey}
                      item={item}
                      apiToken={props.apiToken}
                      selected={props.selected.has(item.encodedKey)}
                      selectionMode={props.selectionMode}
                      lightboxIndex={row.startIndex + i}
                      onToggleSelect={() => props.onToggleSelect(item.encodedKey, row.startIndex + i)}
                      onOpenLightbox={props.onOpenLightbox}
                      onShiftClick={props.onShiftClick}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Loading indicator */}
      {props.isFetchingNextPage && (
        <div className="flex h-8 items-center justify-center gap-2">
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
        </div>
      )}
    </div>
  );
}
```

**Important:** Use `useWindowVirtualizer` (not `useVirtualizer`) so the page
scrolls naturally with the window. This preserves the scroll-to-top FAB,
the `showScrollTop` logic, and the DateScroller position tracking.

**Test file:** `frontend/src/components/virtualized-grid.test.tsx`

```ts
describe('VirtualizedGrid', () => {
  it('renders section headers for each section');
  it('renders month dividers at month boundaries');
  it('renders thumbnail items within visible rows');
  it('calls onToggleSelect when a thumbnail is clicked in selection mode');
  it('calls onOpenLightbox when a thumbnail is clicked outside selection mode');
  it('triggers fetchNextPage when scrolled near the end');
  it('does not fetch when already fetching');
  it('shows loading indicator while fetching next page');
});
```

Mock `useWindowVirtualizer` or use `jsdom` with explicit scroll simulation.
Since jsdom has no real scroll, a pragmatic approach: test the row model
rendering by mocking `@tanstack/react-virtual` to return all rows as
visible. The virtualization correctness is library-tested; we test our
row→component dispatch.

**Checkpoint:** `cd frontend && npx vitest run` — all green.

---

## Phase 3 — Integration: Swap Grid in CatalogPage

### Step 3.1 · Replace rendering block

In `catalog-page.tsx`, replace the entire `sections.map()` block + sentinel
div (lines ~1332–1393) with:

```tsx
<VirtualizedGrid
  sections={sections}
  sortedItems={sortedItems}
  selected={selected}
  selectionMode={selectionMode}
  apiToken={apiToken}
  onToggleSelect={toggleSelect}
  onOpenLightbox={setLightboxIndex}
  onShiftClick={handleShiftClick}
  onToggleSection={toggleSection}
  sectionRefs={sectionRefs}
  hasNextPage={!!itemsQuery.hasNextPage}
  isFetchingNextPage={itemsQuery.isFetchingNextPage}
  fetchNextPage={() => void itemsQuery.fetchNextPage()}
/>
```

**Remove from CatalogPage:**
- `sentinelRef` useRef
- `sectionOffsets` useMemo
- The infinite scroll `IntersectionObserver` useEffect
- The sentinel `<div ref={sentinelRef}>` block
- Inline `MonthDivider`, `SectionHeader`, `Thumbnail` definitions (already
  extracted in Phase 2)

**Keep:**
- `SkeletonGrid` + `EmptyState` — still used for loading/empty states
- All state variables, selection callbacks, lightbox
- `monthGroups` useMemo — may still be needed for stats; if not, remove

**Tests:**
- Update `catalog-page.test.tsx` — the mock for `@/components/date-scroller`
  stays. May need to also mock `@tanstack/react-virtual` if jsdom can't
  handle `useWindowVirtualizer`.
- All existing test assertions must still pass:
  - Page heading, stats bar, dedup link
  - Item count, section headers, thumbnails
  - Sort toggle, prefix filter
  - Month dividers with "Best of" labels
  - Selection checkboxes

**Checkpoint:** `cd frontend && npx vitest run` — all green.

---

### Step 3.2 · Adapt DateScroller

The `DateScroller` component receives `sectionRefs: Map<string, HTMLElement>`.
With virtualization, only visible section headers have real DOM elements.

**Approach (Option B — most robust):**

Add a new optional prop to DateScroller:
```ts
interface DateScrollerProps {
  sections: [string, unknown[]][];
  sectionRefs: React.RefObject<Map<string, HTMLElement>>;
  /** If provided, used to scroll to a section by row index. */
  scrollToIndex?: (index: number) => void;
  /** Map from section date → row index in the virtual list. */
  sectionRowIndices?: Map<string, number>;
}
```

When `scrollToIndex` + `sectionRowIndices` are provided, the "scroll to
date" action uses `scrollToIndex(sectionRowIndices.get(date))` instead of
`el.scrollIntoView()`. The "current date indicator" still works by scanning
`sectionRefs` for visible sections — this is populated by the virtualizer's
effect in Step 2.3.

**Tests:**
- Existing date-scroller tests pass (optional props default to undefined)
- New test: when `scrollToIndex` is provided, clicking calls it with correct index

**Checkpoint:** `cd frontend && npx vitest run` — all green.

---

## Phase 4 — Data Layer + Cleanup

### Step 4.1 · Cap React Query pages (optional)

Add `maxPages` to prevent unbounded memory:

```ts
const itemsQuery = useInfiniteQuery({
  queryKey: ['catalog-items', prefix, sortDirection, apiToken],
  queryFn: ({ pageParam }) => fetchCatalogItems({ ... }),
  getNextPageParam: (lastPage) => lastPage.nextToken,
  initialPageParam: undefined,
  maxPages: 50,   // ← NEW: cap at ~5000 items in memory
  staleTime: 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
```

**Note:** `maxPages` evicts the oldest pages. If the user scrolls back up,
those sections will be empty. This is acceptable — the virtualizer shows
nothing for evicted rows, and scrolling triggers a re-fetch via
`getPreviousPageParam`. However, backward pagination requires the API to
support reverse tokens, which may not be implemented yet.

**If backward pagination is not ready:** skip this step entirely. The
virtualization alone (Phase 2–3) solves the DOM/render bottleneck. Memory
growth is secondary — 50k `CatalogItem` objects ≈ 40 MB, which is tolerable.

**Tests (if implemented):**
- Mock 5 pages of data, set `maxPages: 3`
- Verify `allItems` only contains the latest 3 pages
- Verify scrolling back up triggers `fetchPreviousPage`

**Checkpoint:** `cd frontend && npx vitest run` — all green.

---

### Step 4.2 · Remove dead code

After all phases are integrated, clean up:

| Remove | Location |
|--------|----------|
| `sentinelRef` | CatalogPage state |
| Sentinel IntersectionObserver `useEffect` | CatalogPage |
| `sectionOffsets` useMemo | CatalogPage |
| `contentVisibility` / `containIntrinsicSize` CSS | Removed with rendering block |
| Inline MonthDivider, SectionHeader, Thumbnail | Already extracted in Phase 2 |
| `isNearViewport` + IO in Thumbnail | Already removed in Phase 2.2 |
| Unused imports | `catalog-page.tsx` |

**Tests:**
```bash
cd frontend && npx vitest run       # all tests green
cd frontend && npx tsc --noEmit     # no type errors
```

**Checkpoint:** Both commands exit 0.

---

## Phase 5 — Validation

### Step 5.1 · Verify preserved features

Run the full test suite and manually verify:

| Feature | How to verify |
|---------|--------------|
| Lightbox navigation | Open item → arrow keys → crosses section boundaries |
| Shift-click range | Click item A → shift-click item B across sections |
| Section checkbox | Toggle selects/deselects all items in section |
| Ctrl+A | Selects ALL items (including items outside virtual window) |
| Esc | Clears selection |
| Sort toggle | Newest/oldest works, items re-group correctly |
| Prefix search | Type date → items filter → clear → all items return |
| DateScroller | Drag → scrolls to correct date; tooltip shows date |
| Scroll-to-top FAB | Appears after scrolling; click scrolls to top |
| Month dividers | "Best of June" cards appear at month boundaries |
| Drag-and-drop overlay | Drag a file over → blue overlay appears |
| Keyboard `?` | Opens shortcuts dialog |
| Stats bar | Shows correct file count, size, date range |

### Step 5.2 · Performance validation (manual)

```
1. Load catalog with > 2000 items
2. Chrome DevTools → Performance → Record
3. Scroll continuously for 30 seconds
4. Stop recording
5. Check:
   - DOM nodes: should stay < 500 (was 2000+ before)
   - JS heap: should plateau (no linear growth)
   - FPS: should stay > 30
   - No "Recalculate Style" warnings > 50ms
```

### Step 5.3 · Final test run

```bash
cd frontend && npx vitest run       # frontend tests
cd .. && npx vitest run             # backend tests (verify no regressions)
npx tsc --noEmit                    # type safety
```

All must exit 0.

---

## File Inventory (final state)

### New files
| File | Purpose |
|------|---------|
| `frontend/src/lib/grid-columns.ts` | Pure width→cols function |
| `frontend/src/lib/grid-columns.test.ts` | Tests |
| `frontend/src/lib/virtual-row-model.ts` | Row model builder + height estimator |
| `frontend/src/lib/virtual-row-model.test.ts` | Tests |
| `frontend/src/components/virtualized-grid.tsx` | Virtualized grid wrapper |
| `frontend/src/components/virtualized-grid.test.tsx` | Tests |
| `frontend/src/components/catalog/thumbnail.tsx` | Extracted Thumbnail |
| `frontend/src/components/catalog/section-header.tsx` | Extracted SectionHeader |
| `frontend/src/components/catalog/month-divider.tsx` | Extracted MonthDivider |

### Modified files
| File | Changes |
|------|---------|
| `frontend/package.json` | Add `@tanstack/react-virtual` |
| `frontend/src/pages/catalog-page.tsx` | Remove inline components, replace grid with VirtualizedGrid |
| `frontend/src/pages/catalog-page.test.tsx` | Adapt for new component structure |
| `frontend/src/components/date-scroller.tsx` | Add optional `scrollToIndex` prop |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| `useWindowVirtualizer` requires DOM measurements | jsdom tests mock the library; real behavior tested manually |
| DateScroller loses refs for off-screen sections | Tooltip works from `sections` array (always complete); scroll-to uses `scrollToIndex` |
| Lightbox index becomes stale if pages evicted | `sortedItems` rebuilds from current pages; clamp index to bounds |
| Shift-click spans evicted pages | `Set<string>` survives; visual selection works for loaded items |
| Tests rely on DOM structure of the grid | Mock `@tanstack/react-virtual` to render all rows in tests |
