import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  catalogMediaUrl,
  deleteCatalogItems,
  fetchCatalogItems,
  fetchCatalogStats,
  type CatalogItem,
  type CatalogStats,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { DateScroller } from '@/components/date-scroller';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function useApiToken(): string | undefined {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('apiToken') ?? undefined;
  }, []);
}

// ── Stats bar ──────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: CatalogStats }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-sm text-slate-700 sm:grid-cols-3 lg:grid-cols-6">
      <div><span className="font-medium">Files:</span> {stats.totalFiles.toLocaleString()}</div>
      <div><span className="font-medium">Size:</span> {formatBytes(stats.totalBytes)}</div>
      <div><span className="font-medium">Photos:</span> {stats.imageCount.toLocaleString()}</div>
      <div><span className="font-medium">Videos:</span> {stats.videoCount.toLocaleString()}</div>
      {stats.oldestDate && (
        <div><span className="font-medium">Oldest:</span> {stats.oldestDate.slice(0, 10)}</div>
      )}
      {stats.newestDate && (
        <div><span className="font-medium">Newest:</span> {stats.newestDate.slice(0, 10)}</div>
      )}
    </div>
  );
}

// ── Selection toolbar ──────────────────────────────────────────────────────

function SelectionBar({
  count,
  totalItems,
  onSelectAll,
  onClearAll,
  onDelete,
  isDeleting,
  confirmDelete,
  onConfirmDelete,
  onCancelConfirm,
}: {
  count: number;
  totalItems: number;
  onSelectAll: () => void;
  onClearAll: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  confirmDelete: boolean;
  onConfirmDelete: () => void;
  onCancelConfirm: () => void;
}) {
  return (
    <div className="sticky top-0 z-40 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 shadow-sm">
      <button
        type="button"
        onClick={onClearAll}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700"
        title="Clear selection"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <span className="text-sm font-semibold text-blue-900">
        {count.toLocaleString()} selected
      </span>

      {count < totalItems && (
        <button
          type="button"
          onClick={onSelectAll}
          className="text-xs text-blue-700 underline hover:text-blue-900"
        >
          Select all {totalItems.toLocaleString()}
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {confirmDelete ? (
          <>
            <span className="text-sm font-medium text-red-700">
              Permanently delete {count.toLocaleString()} file{count !== 1 ? 's' : ''}?
            </span>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={isDeleting}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
              <path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" />
            </svg>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ── Lightbox ───────────────────────────────────────────────────────────────

function Lightbox({
  items,
  index,
  apiToken,
  onClose,
  onNavigate,
}: {
  items: CatalogItem[];
  index: number;
  apiToken: string | undefined;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const item = items[index];
  const mediaUrl = catalogMediaUrl(item.encodedKey, apiToken);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && index < items.length - 1) onNavigate(index + 1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [index, items.length, onClose, onNavigate]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
      onClick={onClose}
    >
      <button
        className="absolute right-4 top-3 text-2xl font-bold leading-none text-white/80 hover:text-white"
        onClick={onClose}
        aria-label="Close"
      >✕</button>
      {index > 0 && (
        <button
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          aria-label="Previous"
        >‹</button>
      )}
      {index < items.length - 1 && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          aria-label="Next"
        >›</button>
      )}
      <div className="relative flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {item.mediaType === 'video' ? (
          <video key={mediaUrl} src={mediaUrl} controls autoPlay className="max-h-[88vh] max-w-[88vw] rounded-lg" />
        ) : (
          <img key={mediaUrl} src={mediaUrl} alt={item.key} className="max-h-[88vh] max-w-[88vw] rounded-lg object-contain" />
        )}
        <p className="mt-2 text-xs text-white/60">
          {item.capturedAt.slice(0, 10)} · {formatBytes(item.size)} · {index + 1} / {items.length}
        </p>
      </div>
    </div>
  );
}

// ── Thumbnail ──────────────────────────────────────────────────────────────

function Thumbnail({
  item,
  apiToken,
  selected,
  selectionMode,
  lightboxIndex,
  onToggleSelect,
  onOpenLightbox,
}: {
  item: CatalogItem;
  apiToken: string | undefined;
  selected: boolean;
  selectionMode: boolean;
  lightboxIndex: number;
  onToggleSelect: () => void;
  onOpenLightbox: (index: number) => void;
}) {
  const handleClick = useCallback(() => {
    if (selectionMode) onToggleSelect();
    else onOpenLightbox(lightboxIndex);
  }, [selectionMode, onToggleSelect, onOpenLightbox, lightboxIndex]);

  const handleCheckClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelect();
  }, [onToggleSelect]);

  return (
    <div
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded bg-slate-100 ${
        selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
      }`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      title={item.capturedAt.slice(0, 10)}
    >
      <img
        src={catalogMediaUrl(item.encodedKey, apiToken)}
        loading="lazy"
        className={`h-full w-full object-cover transition-transform duration-200 ${
          !selectionMode ? 'group-hover:scale-105' : ''
        } ${selected ? 'brightness-75' : ''}`}
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />

      {/* Video play icon */}
      {item.mediaType === 'video' && !selected && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-full bg-black/50 p-1.5">
            <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Checkbox — always visible when selected, hover-only otherwise */}
      <button
        type="button"
        aria-label={selected ? 'Deselect' : 'Select'}
        onClick={handleCheckClick}
        className={`absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-all ${
          selected
            ? 'border-blue-500 bg-blue-500 opacity-100'
            : 'border-white bg-black/30 opacity-0 group-hover:opacity-100'
        }`}
      >
        {selected && (
          <svg viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth={2.5} className="h-3 w-3">
            <path d="M2 6l3 3 5-5" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ── Section header with select-all ────────────────────────────────────────

function SectionHeader({
  date,
  items,
  selected,
  onToggleAll,
}: {
  date: string;
  items: CatalogItem[];
  selected: Set<string>;
  onToggleAll: (keys: string[], select: boolean) => void;
}) {
  const keys = items.map((i) => i.encodedKey);
  const allSelected = keys.length > 0 && keys.every((k) => selected.has(k));
  const someSelected = !allSelected && keys.some((k) => selected.has(k));

  return (
    <div className="mb-1.5 flex items-center gap-2">
      <button
        type="button"
        onClick={() => onToggleAll(keys, !allSelected)}
        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
          allSelected
            ? 'border-blue-500 bg-blue-500'
            : someSelected
              ? 'border-blue-400 bg-blue-100'
              : 'border-slate-300 bg-white hover:border-blue-400'
        }`}
        aria-label={allSelected ? 'Deselect section' : 'Select section'}
      >
        {allSelected && (
          <svg viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth={2.5} className="h-3 w-3">
            <path d="M2 6l3 3 5-5" />
          </svg>
        )}
        {someSelected && !allSelected && (
          <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
        )}
      </button>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{date}</p>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function CatalogPage() {
  const apiToken = useApiToken();
  const queryClient = useQueryClient();

  const [prefixInput, setPrefixInput] = useState('');
  const [prefix, setPrefix] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const selectionMode = selected.size > 0;

  // Debounce prefix filter
  useEffect(() => {
    const t = setTimeout(() => setPrefix(prefixInput.trim()), 400);
    return () => clearTimeout(t);
  }, [prefixInput]);

  // Clear selection on prefix change
  useEffect(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, [prefix]);

  const statsQuery = useQuery({
    queryKey: ['catalog-stats', apiToken],
    queryFn: () => fetchCatalogStats(apiToken),
    retry: false,
    staleTime: 60_000,
  });

  const itemsQuery = useInfiniteQuery({
    queryKey: ['catalog-items', prefix, apiToken],
    queryFn: ({ pageParam }) =>
      fetchCatalogItems({ token: pageParam as string | undefined, prefix: prefix || undefined, max: 100, apiToken }),
    getNextPageParam: (lastPage) => lastPage.nextToken,
    initialPageParam: undefined as string | undefined,
  });

  const allItems = useMemo(
    () => itemsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [itemsQuery.data],
  );

  const sections = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const item of allItems) {
      if (!map.has(item.sectionDate)) map.set(item.sectionDate, []);
      map.get(item.sectionDate)!.push(item);
    }
    // Newest dates first; within each section, newest items first
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, items]) => [date, items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))] as [string, CatalogItem[]]);
  }, [allItems]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && itemsQuery.hasNextPage && !itemsQuery.isFetchingNextPage) {
          void itemsQuery.fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [itemsQuery.hasNextPage, itemsQuery.isFetchingNextPage, itemsQuery.fetchNextPage]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (lightboxIndex !== null) return;
      if (e.key === 'Escape' && selectionMode) {
        setSelected(new Set());
        setConfirmDelete(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && allItems.length > 0) {
        e.preventDefault();
        setSelected(new Set(allItems.map((i) => i.encodedKey)));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [lightboxIndex, selectionMode, allItems]);

  const toggleSelect = useCallback((encodedKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(encodedKey)) next.delete(encodedKey);
      else next.add(encodedKey);
      return next;
    });
  }, []);

  const toggleSection = useCallback((keys: string[], select: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (select) keys.forEach((k) => next.add(k));
      else keys.forEach((k) => next.delete(k));
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(allItems.map((i) => i.encodedKey)));
  }, [allItems]);

  const clearAll = useCallback(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, []);

  const deleteMutation = useMutation({
    mutationFn: async (encodedKeys: string[]) => {
      for (let i = 0; i < encodedKeys.length; i += 200) {
        await deleteCatalogItems(encodedKeys.slice(i, i + 200), apiToken);
      }
    },
    onSuccess: () => {
      setSelected(new Set());
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: ['catalog-items'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
    },
  });

  const handleClose = useCallback(() => setLightboxIndex(null), []);
  const handleNavigate = useCallback((i: number) => setLightboxIndex(i), []);

  let runningOffset = 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">Catalog</h1>
          <p className="text-sm text-slate-600">Browse media stored in Scaleway Object Storage.</p>
        </div>
        <Link
          to="/catalog/dedup"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          🔍 Deduplication
        </Link>
      </div>

      {/* Selection toolbar */}
      {selectionMode && (
        <SelectionBar
          count={selected.size}
          totalItems={allItems.length}
          onSelectAll={selectAll}
          onClearAll={clearAll}
          onDelete={() => setConfirmDelete(true)}
          isDeleting={deleteMutation.isPending}
          confirmDelete={confirmDelete}
          onConfirmDelete={() => deleteMutation.mutate([...selected])}
          onCancelConfirm={() => setConfirmDelete(false)}
        />
      )}

      {deleteMutation.isError && (
        <p className="text-sm text-red-600">
          {deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Delete failed'}
        </p>
      )}

      {/* Stats */}
      <Card>
        {statsQuery.isLoading ? (
          <p className="text-sm text-slate-600">Loading stats…</p>
        ) : statsQuery.isError ? (
          <p className="text-sm text-amber-700">
            {statsQuery.error instanceof Error ? statsQuery.error.message : 'Catalog unavailable — check SCW_* env vars'}
          </p>
        ) : statsQuery.data ? (
          <StatsBar stats={statsQuery.data} />
        ) : null}
      </Card>

      {/* Prefix filter */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter by prefix (e.g. 2024/06)…"
          className="w-full max-w-xs rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={prefixInput}
          onChange={(e) => setPrefixInput(e.target.value)}
        />
        {prefix && (
          <button
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
            onClick={() => { setPrefixInput(''); setPrefix(''); }}
          >
            Clear
          </button>
        )}
        <span className="text-xs text-slate-500">
          {allItems.length.toLocaleString()} item{allItems.length !== 1 ? 's' : ''}
          {itemsQuery.hasNextPage ? '+' : ''}
          {selectionMode && (
            <> · <span className="font-medium text-blue-600">{selected.size.toLocaleString()} selected</span></>
          )}
        </span>
      </div>

      {itemsQuery.isError && (
        <p className="text-sm text-red-600">
          {itemsQuery.error instanceof Error ? itemsQuery.error.message : 'Failed to load catalog'}
        </p>
      )}

      {/* Date-grouped grid */}
      {itemsQuery.isLoading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : sections.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">
            {prefix ? `No media found matching prefix "${prefix}".` : 'No media found in the catalog.'}
          </p>
        </Card>
      ) : (
        sections.map(([date, items]) => {
          const sectionOffset = runningOffset;
          runningOffset += items.length;
          return (
            <div key={date} ref={(el) => { if (el) sectionRefs.current.set(date, el); else sectionRefs.current.delete(date); }}>
              <SectionHeader
                date={date}
                items={items}
                selected={selected}
                onToggleAll={toggleSection}
              />
              <div className="grid grid-cols-4 gap-1 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {items.map((item, i) => (
                  <Thumbnail
                    key={item.encodedKey}
                    item={item}
                    apiToken={apiToken}
                    selected={selected.has(item.encodedKey)}
                    selectionMode={selectionMode}
                    lightboxIndex={sectionOffset + i}
                    onToggleSelect={() => toggleSelect(item.encodedKey)}
                    onOpenLightbox={setLightboxIndex}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} className="flex h-8 items-center justify-center">
        {itemsQuery.isFetchingNextPage && (
          <p className="text-xs text-slate-500">Loading more…</p>
        )}
      </div>

      {/* Date scroller */}
      <DateScroller sections={sections} sectionRefs={sectionRefs} />

      {/* Lightbox */}
      {lightboxIndex !== null && allItems.length > 0 && (
        <Lightbox
          items={allItems}
          index={lightboxIndex}
          apiToken={apiToken}
          onClose={handleClose}
          onNavigate={handleNavigate}
        />
      )}
    </div>
  );
}
