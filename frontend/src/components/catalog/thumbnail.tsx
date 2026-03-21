import { useCallback, useState } from 'react';
import { catalogThumbnailUrl } from '@/lib/api';
import { useThumbnailQueue, isThumbnailFailed, markThumbnailFailed } from '@/lib/thumbnail-queue';
import type { CatalogItem } from '@/lib/api';

/**
 * Single grid cell representing one media item. Since the parent virtualizer
 * guarantees this cell is near the viewport when mounted, thumbnails load
 * immediately without a per-cell IntersectionObserver.
 *
 * Images use the small thumbnail endpoint. Videos keep a lightweight tile
 * with a play affordance.
 *
 * @pattern Immich skeleton-to-fade thumbnail loading
 * @pattern Google Photos rounded-lg tiles with hover scale
 */
export function Thumbnail({
  item,
  apiToken,
  selected,
  selectionMode,
  lightboxIndex,
  onToggleSelect,
  onOpenLightbox,
  onShiftClick,
}: {
  item: CatalogItem;
  apiToken: string | undefined;
  selected: boolean;
  selectionMode: boolean;
  lightboxIndex: number;
  onToggleSelect: () => void;
  onOpenLightbox: (index: number) => void;
  /** Called when the user shift-clicks a thumbnail for range selection. */
  onShiftClick: (index: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const isVideo = item.mediaType === 'video';

  // The virtualizer ensures this cell is visible — load immediately.
  const wantUrl = catalogThumbnailUrl(item.encodedKey, 'small', apiToken);
  const alreadyFailed = isThumbnailFailed(wantUrl);
  const [thumbFailed, setThumbFailed] = useState(alreadyFailed);
  const { src: thumbSrc, markComplete } = useThumbnailQueue(alreadyFailed ? null : wantUrl);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) {
      onShiftClick(lightboxIndex);
      return;
    }
    if (selectionMode) onToggleSelect();
    else onOpenLightbox(lightboxIndex);
  }, [selectionMode, onToggleSelect, onOpenLightbox, lightboxIndex, onShiftClick]);

  const handleCheckClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelect();
  }, [onToggleSelect]);

  return (
    <div
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-slate-200 ${
        selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
      }`}
      onClick={handleClick}
      role="gridcell"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (e.shiftKey) onShiftClick(lightboxIndex);
          else if (selectionMode) onToggleSelect();
          else onOpenLightbox(lightboxIndex);
        }
      }}
      title={item.capturedAt.slice(0, 10)}
    >
      {/* Skeleton placeholder – pulsing gray shown until image loads */}
      {!loaded && (
        <div className="absolute inset-0 animate-pulse bg-slate-300" />
      )}

      {/* Render img when the queue grants a slot (images + videos with ffmpeg thumbnails) */}
      {thumbSrc && !thumbFailed && (
        <img
          src={thumbSrc}
          loading="lazy"
          decoding="async"
          className={`h-full w-full select-none object-cover transition-all duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${!selectionMode ? 'group-hover:scale-105' : ''} ${selected ? 'brightness-75' : ''}`}
          onLoad={() => { markComplete(); setLoaded(true); }}
          onError={() => { markComplete(); markThumbnailFailed(wantUrl); setThumbFailed(true); setLoaded(true); }}
          draggable={false}
        />
      )}

      {/* Fallback icon for media whose thumbnail couldn't be generated */}
      {thumbFailed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-200 text-slate-400">
          {isVideo ? (
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />
            </svg>
          ) : (
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          )}
          <span className="mt-0.5 text-[9px] leading-tight">
            {item.key.split('.').pop()?.toUpperCase()}
          </span>
        </div>
      )}

      {/* Video play icon overlay */}
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
