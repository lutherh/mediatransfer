import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  catalogMediaUrl,
  fetchCatalogItems,
  fetchCatalogStats,
  type CatalogItem,
  type CatalogStats,
} from '@/lib/api';
import { Card } from '@/components/ui/card';

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
      >
        ✕
      </button>

      {index > 0 && (
        <button
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          aria-label="Previous"
        >
          ‹
        </button>
      )}

      {index < items.length - 1 && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          aria-label="Next"
        >
          ›
        </button>
      )}

      <div className="relative flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {item.mediaType === 'video' ? (
          <video
            key={mediaUrl}
            src={mediaUrl}
            controls
            autoPlay
            className="max-h-[88vh] max-w-[88vw] rounded-lg"
          />
        ) : (
          <img
            key={mediaUrl}
            src={mediaUrl}
            alt={item.key}
            className="max-h-[88vh] max-w-[88vw] rounded-lg object-contain"
          />
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
  onClick,
}: {
  item: CatalogItem;
  apiToken: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      className="group relative aspect-square overflow-hidden rounded bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
      onClick={onClick}
      title={item.capturedAt.slice(0, 10)}
    >
      <img
        src={catalogMediaUrl(item.encodedKey, apiToken)}
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
      {item.mediaType === 'video' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-full bg-black/50 p-1.5">
            <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}
    </button>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function CatalogPage() {
  const apiToken = useApiToken();
  const [prefixInput, setPrefixInput] = useState('');
  const [prefix, setPrefix] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Debounce prefix filter
  useEffect(() => {
    const t = setTimeout(() => setPrefix(prefixInput.trim()), 400);
    return () => clearTimeout(t);
  }, [prefixInput]);

  const statsQuery = useQuery({
    queryKey: ['catalog-stats', apiToken],
    queryFn: () => fetchCatalogStats(apiToken),
    retry: false,
    staleTime: 60_000,
  });

  const itemsQuery = useInfiniteQuery({
    queryKey: ['catalog-items', prefix, apiToken],
    queryFn: ({ pageParam }) =>
      fetchCatalogItems({
        token: pageParam as string | undefined,
        prefix: prefix || undefined,
        max: 100,
        apiToken,
      }),
    getNextPageParam: (lastPage) => lastPage.nextToken,
    initialPageParam: undefined as string | undefined,
  });

  const allItems = useMemo(
    () => itemsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [itemsQuery.data],
  );

  // Group by sectionDate
  const sections = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const item of allItems) {
      if (!map.has(item.sectionDate)) map.set(item.sectionDate, []);
      map.get(item.sectionDate)!.push(item);
    }
    return [...map.entries()];
  }, [allItems]);

  // Infinite scroll via IntersectionObserver
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

  const handleClose = useCallback(() => setLightboxIndex(null), []);
  const handleNavigate = useCallback((i: number) => setLightboxIndex(i), []);

  // Compute running offset outside of map to assign lightbox indices
  let runningOffset = 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Catalog</h1>
          <p className="text-sm text-slate-600">Browse media stored in Scaleway Object Storage.</p>
        </div>
        <Link
          to="/catalog/dedup"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          🔍 Deduplication
        </Link>
      </div>

      {/* Stats */}
      <Card>
        {statsQuery.isLoading ? (
          <p className="text-sm text-slate-600">Loading stats…</p>
        ) : statsQuery.isError ? (
          <p className="text-sm text-amber-700">
            {statsQuery.error instanceof Error
              ? statsQuery.error.message
              : 'Catalog unavailable — check SCW_* env vars'}
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
            <div key={date}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {date}
              </p>
              <div className="grid grid-cols-4 gap-1 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {items.map((item, i) => (
                  <Thumbnail
                    key={item.encodedKey}
                    item={item}
                    apiToken={apiToken}
                    onClick={() => setLightboxIndex(sectionOffset + i)}
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
