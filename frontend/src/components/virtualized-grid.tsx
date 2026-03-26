import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { CatalogItem } from '@/lib/api';
import { buildRowModel, estimateRowHeight, sectionDateToRowIndex } from '@/lib/virtual-row-model';
import { getColumnCount } from '@/lib/grid-columns';
import { Thumbnail } from '@/components/catalog/thumbnail';
import { SectionHeader } from '@/components/catalog/section-header';
import { MonthDivider } from '@/components/catalog/month-divider';

export interface VirtualizedGridProps {
  sections: [string, CatalogItem[]][];
  selected: Set<string>;
  selectionMode: boolean;
  apiToken: string | undefined;
  onToggleSelect: (encodedKey: string, flatIndex: number) => void;
  onOpenLightbox: (index: number) => void;
  onShiftClick: (index: number) => void;
  onToggleSection: (keys: string[], select: boolean) => void;
  /** Mutable ref map from section date → DOM element, used by DateScroller */
  sectionRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  /**
   * Called once (and whenever the row model changes) with a function that
   * scrolls the virtualizer to the section for the given date string.
   * CatalogPage wires this up to DateScroller's onScrollToDate prop.
   */
  onRegisterScrollToDate?: (fn: (date: string) => void) => void;
}

/**
 * Virtualized photo grid with item-row-level virtualization.
 *
 * Each row of photos, section header, and month divider is a separate virtual
 * row. Only rows near the viewport are mounted in the DOM, keeping node count
 * low even with thousands of items.
 *
 * @pattern Immich section-level virtual list (useWindowVirtualizer)
 */
export function VirtualizedGrid({
  sections,
  selected,
  selectionMode,
  apiToken,
  onToggleSelect,
  onOpenLightbox,
  onShiftClick,
  onToggleSection,
  sectionRefs,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onRegisterScrollToDate,
}: VirtualizedGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Observe container width to keep column count in sync with resize
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

  // Build the flat virtual row list from sections + column count
  const rowModel = useMemo(
    () => buildRowModel(sections, cols),
    [sections, cols],
  );

  // scrollMargin = distance from top of window to top of grid container
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        setScrollMargin(containerRef.current.getBoundingClientRect().top + window.scrollY);
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [sections]);

  const virtualizer = useWindowVirtualizer({
    count: rowModel.length,
    estimateSize: useCallback(
      (i: number) => estimateRowHeight(rowModel[i], containerWidth, cols),
      [rowModel, containerWidth, cols],
    ),
    overscan: 10,
    scrollMargin,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Register scrollToDate with parent so DateScroller can trigger it
  useEffect(() => {
    if (!onRegisterScrollToDate) return;
    onRegisterScrollToDate((date: string) => {
      const idx = sectionDateToRowIndex(rowModel, date);
      if (idx !== undefined) {
        virtualizer.scrollToIndex(idx, { align: 'start', behavior: 'auto' });
        requestAnimationFrame(() => window.scrollBy(0, -60));
      }
    });
  }, [onRegisterScrollToDate, rowModel, virtualizer]);

  // Infinite scroll: fetch next page when near the end of the row model
  const lastItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (!lastItem) return;
    if (lastItem.index >= rowModel.length - 5 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastItem?.index, rowModel.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Update sectionRefs for DateScroller: register visible section-header rows
  useEffect(() => {
    sectionRefs.current.clear();
    for (const vItem of virtualItems) {
      const row = rowModel[vItem.index];
      if (row.type === 'section-header') {
        const el = document.querySelector<HTMLElement>(`[data-virtual-index="${vItem.index}"]`);
        if (el) sectionRefs.current.set(row.date, el);
      }
    }
  }, [virtualItems, rowModel, sectionRefs]);

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
              key={vItem.key}
              data-index={vItem.index}
              data-virtual-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vItem.start - scrollMargin}px)`,
              }}
            >
              {row.type === 'month-divider' && (
                <MonthDivider
                  monthLabel={row.label}
                  year={row.year}
                  itemCount={row.itemCount}
                  coverItem={row.coverItem}
                  apiToken={apiToken}
                />
              )}

              {row.type === 'section-header' && (
                <div className={!row.isFirst ? 'pt-2' : ''}>
                  <SectionHeader
                    date={row.date}
                    items={row.items}
                    selected={selected}
                    onToggleAll={onToggleSection}
                  />
                </div>
              )}

              {row.type === 'items-row' && (
                <div
                  className="grid gap-0.5"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                  role="grid"
                  aria-label="Photo grid"
                >
                  {row.items.map((item, i) => (
                    <Thumbnail
                      key={item.encodedKey}
                      item={item}
                      apiToken={apiToken}
                      selected={selected.has(item.encodedKey)}
                      selectionMode={selectionMode}
                      lightboxIndex={row.startIndex + i}
                      onToggleSelect={() => onToggleSelect(item.encodedKey, row.startIndex + i)}
                      onOpenLightbox={onOpenLightbox}
                      onShiftClick={onShiftClick}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Loading indicator */}
      {isFetchingNextPage && (
        <div className="flex h-8 items-center justify-center gap-2" role="status">
          <span className="sr-only">Loading more items</span>
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
        </div>
      )}
    </div>
  );
}
