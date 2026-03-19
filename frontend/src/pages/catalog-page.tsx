/**
 * @file Catalog Page – Browse, select, and manage media stored in object storage.
 *
 * This page is modeled after three best-in-class photo management UIs:
 *   • **Google Photos** – human-friendly date headers, larger tiles, rounded corners
 *   • **Immich** – skeleton loading, shift-click range select, user-select-none grid
 *   • **Ente** – enhanced lightbox with toolbar auto-hide, zoom, metadata overlay
 *
 * Architecture: a single-file page component that uses React Query for data,
 * IntersectionObserver for infinite scroll, and a flat sorted array for
 * cross-section lightbox navigation and range selection.
 *
 * @pattern Google Photos timeline grid with date-grouped sections
 * @pattern Immich virtualized gallery with skeleton placeholders
 * @pattern Ente full-screen viewer with metadata panel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  catalogMediaUrl,
  catalogThumbnailUrl,
  deleteCatalogItems,
  fetchCatalogItems,
  fetchCatalogStats,
  type CatalogItem,
  type CatalogStats,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { DateScroller } from '@/components/date-scroller';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format raw byte count into a human-readable string (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Read an optional `apiToken` query-parameter from the URL. Memoized so the
 * URLSearchParams parse happens only once per mount.
 */
function useApiToken(): string | undefined {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('apiToken') ?? undefined;
  }, []);
}

// ── Date formatting ────────────────────────────────────────────────────────

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Convert an ISO date string (e.g. "2025-06-16") into a human-friendly label.
 *
 * Rules (inspired by Google Photos timeline headers):
 *   • Same calendar day → "Today"
 *   • Previous calendar day → "Yesterday"
 *   • Within the past 7 days → "Mon, Jun 16"
 *   • Same year → "Jun 16, 2025"
 *   • Older → "Jun 16, 2024"
 *
 * @pattern Google Photos human-friendly section headers
 */
function formatSectionDate(dateStr: string): string {
  // Parse as local date (the YYYY-MM-DD from sectionDate is already local)
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1; // 0-indexed
  const day = Number(parts[2]);
  const date = new Date(year, month, day);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = today.getTime() - date.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 0 && diffDays < 7) {
    return `${DAY_NAMES[date.getDay()]}, ${SHORT_MONTHS[month]} ${day}`;
  }
  // Same year → omit year for brevity; otherwise include it
  if (year === now.getFullYear()) {
    return `${SHORT_MONTHS[month]} ${day}`;
  }
  return `${SHORT_MONTHS[month]} ${day}, ${year}`;
}

// ── Stats bar ──────────────────────────────────────────────────────────────

/**
 * Compact summary row showing total files, size, photo/video counts, and
 * date range. Placed inside a Card at the top of the catalog page.
 */
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

/**
 * Sticky action bar that appears when ≥ 1 item is selected.
 * Provides select-all, clear, and delete (with confirmation) controls.
 *
 * @pattern Google Photos blue selection bar with two-step delete confirmation
 */
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

/** Minimum / maximum zoom scale bounds for the lightbox viewer. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
/** Toolbar auto-hides after this many ms of inactivity. */
const TOOLBAR_HIDE_MS = 3000;

/**
 * Full-screen media viewer with navigation, zoom, download, and info panel.
 *
 * Features (inspired by Immich & Ente lightbox UIs):
 *   • Gradient toolbar at top that auto-hides after 3 s of inactivity
 *   • Filename centered in toolbar
 *   • Download (⬇) opens media in new tab; keyboard shortcut: D
 *   • Info toggle (ⓘ) shows metadata overlay; keyboard shortcut: I
 *   • Zoom via mouse-wheel or +/- keys; reset with 0
 *   • Counter display "3 / 42"
 *   • Arrow keys + Escape for navigation
 *
 * @pattern Immich lightbox with swipe navigation and zoom
 * @pattern Ente info panel overlay with EXIF metadata
 */
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
  // Full-resolution URL for download only
  const fullMediaUrl = catalogMediaUrl(item.encodedKey, apiToken);
  // Lightbox preview: use large (1920px) thumbnail for images, full URL for videos
  const previewUrl = item.mediaType === 'video'
    ? fullMediaUrl
    : catalogThumbnailUrl(item.encodedKey, 'large', apiToken);

  // ── Zoom state ──
  const [zoom, setZoom] = useState(1);
  // ── Info panel toggle ──
  const [showInfo, setShowInfo] = useState(false);
  // ── Toolbar auto-hide ──
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Reset transient lightbox state whenever the viewed item changes. */
  useEffect(() => {
    setZoom(1);
    setShowInfo(false);
  }, [index]);

  /** Restart the toolbar auto-hide timer on any mouse movement. */
  const resetToolbarTimer = useCallback(() => {
    setToolbarVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setToolbarVisible(false), TOOLBAR_HIDE_MS);
  }, []);

  useEffect(() => {
    resetToolbarTimer();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [resetToolbarTimer]);

  /** Open the full-resolution media URL in a new browser tab for download. */
  const handleDownload = useCallback(() => {
    window.open(fullMediaUrl, '_blank', 'noopener');
  }, [fullMediaUrl]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape': onClose(); break;
        case 'ArrowLeft': if (index > 0) onNavigate(index - 1); break;
        case 'ArrowRight': if (index < items.length - 1) onNavigate(index + 1); break;
        // D → download, I → info toggle (Ente-inspired shortcuts)
        case 'd': case 'D': handleDownload(); break;
        case 'i': case 'I': setShowInfo((v) => !v); break;
        // Zoom: +/= to zoom in, - to zoom out, 0 to reset
        case '+': case '=': setZoom((z) => Math.min(z + 0.25, ZOOM_MAX)); break;
        case '-': setZoom((z) => Math.max(z - 0.25, ZOOM_MIN)); break;
        case '0': setZoom(1); break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [index, items.length, onClose, onNavigate, handleDownload]);

  /** Mouse-wheel zoom (Immich pattern). Prevents default page scroll. */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const next = z + (e.deltaY < 0 ? 0.25 : -0.25);
      return Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX);
    });
  }, []);

  // Extract filename from the key for the toolbar display
  const filename = item.key.split('/').pop() ?? item.key;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
      onClick={onClose}
      onMouseMove={resetToolbarTimer}
    >
      {/* ── Gradient toolbar (auto-hides) ────────────────────────────── */}
      <div
        className={`absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 py-3 transition-opacity duration-300 ${
          toolbarVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Counter */}
        <span className="text-sm font-medium text-white/80">
          {index + 1} / {items.length}
        </span>

        {/* Filename */}
        <span className="max-w-[40vw] truncate text-sm text-white/90" title={item.key}>
          {filename}
        </span>

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button
            className="text-lg text-white/80 hover:text-white"
            onClick={handleDownload}
            aria-label="Download"
            title="Download (D)"
          >⬇</button>
          <button
            className={`text-lg hover:text-white ${showInfo ? 'text-blue-400' : 'text-white/80'}`}
            onClick={() => setShowInfo((v) => !v)}
            aria-label="Toggle info"
            title="Info (I)"
          >ⓘ</button>
          <button
            className="text-xl font-bold text-white/80 hover:text-white"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >✕</button>
        </div>
      </div>

      {/* ── Navigation arrows ──────────────────────────────────────── */}
      {index > 0 && (
        <button
          className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          aria-label="Previous"
        >‹</button>
      )}
      {index < items.length - 1 && (
        <button
          className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          aria-label="Next"
        >›</button>
      )}

      {/* ── Media content ──────────────────────────────────────────── */}
      <div
        className="relative flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
      >
        {item.mediaType === 'video' ? (
          <video
            key={previewUrl}
            src={previewUrl}
            controls
            autoPlay
            className="max-h-[88vh] max-w-[88vw] rounded-lg transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
          />
        ) : (
          <img
            key={previewUrl}
            src={previewUrl}
            alt={item.key}
            className="max-h-[88vh] max-w-[88vw] rounded-lg object-contain transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
          />
        )}

        {/* Bottom caption: date · size · counter */}
        <p className="mt-2 text-xs text-white/60">
          {item.capturedAt.slice(0, 10)} · {formatBytes(item.size)} · {index + 1} / {items.length}
        </p>

        {/* Zoom indicator — only shown when zoomed */}
        {zoom !== 1 && (
          <span className="absolute bottom-12 rounded bg-black/60 px-2 py-0.5 text-xs text-white/80">
            {Math.round(zoom * 100)}%
          </span>
        )}
      </div>

      {/* ── Info / metadata overlay (Ente-inspired) ────────────────── */}
      {showInfo && (
        <div
          className="absolute bottom-0 right-0 top-0 z-20 w-72 overflow-y-auto border-l border-white/10 bg-black/80 p-4 backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="mb-3 text-sm font-semibold text-white">Details</h3>
          <dl className="space-y-2 text-xs text-white/70">
            <div>
              <dt className="font-medium text-white/50">Key</dt>
              <dd className="break-all">{item.key}</dd>
            </div>
            <div>
              <dt className="font-medium text-white/50">Size</dt>
              <dd>{formatBytes(item.size)}</dd>
            </div>
            <div>
              <dt className="font-medium text-white/50">Captured</dt>
              <dd>{item.capturedAt}</dd>
            </div>
            <div>
              <dt className="font-medium text-white/50">Last Modified</dt>
              <dd>{item.lastModified}</dd>
            </div>
            <div>
              <dt className="font-medium text-white/50">Type</dt>
              <dd>{item.mediaType}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

// ── Thumbnail ──────────────────────────────────────────────────────────────

/**
 * Single grid cell representing one media item. Uses IntersectionObserver to
 * only start loading the thumbnail when the cell is near the viewport (200px
 * margin). This prevents hundreds of concurrent requests when scrolling through
 * thousands of items.
 *
 * Both images and videos use the small thumbnail endpoint — videos are never
 * loaded as full media files in the grid.
 *
 * @pattern Immich skeleton-to-fade thumbnail loading
 * @pattern Google Photos rounded-lg tiles with hover scale
 */
function Thumbnail({
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
  const cellRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  // Observe when the cell enters a 200px margin around the viewport
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const thumbUrl = catalogThumbnailUrl(item.encodedKey, 'small', apiToken);
  // Fallback for videos if the server can't generate a thumbnail (415)
  const fallbackUrl = thumbError && item.mediaType === 'video'
    ? catalogMediaUrl(item.encodedKey, apiToken)
    : undefined;

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
      ref={cellRef}
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-slate-200 ${
        selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
      }`}
      onClick={handleClick}
      role="button"
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

      {/* Only render the img tag when the cell is near the viewport */}
      {isNearViewport && (
        <img
          src={fallbackUrl ?? thumbUrl}
          className={`h-full w-full select-none object-cover transition-all duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${!selectionMode ? 'group-hover:scale-105' : ''} ${selected ? 'brightness-75' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (!thumbError && item.mediaType === 'video') {
              // Thumbnail generation failed for this video — fall back to poster frame
              setThumbError(true);
            } else {
              setLoaded(true);
            }
          }}
          draggable={false}
        />
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

// ── Section header with select-all ────────────────────────────────────────

/**
 * Date section header with a tri-state checkbox (none / some / all selected).
 * Uses `formatSectionDate` for human-friendly labels instead of raw ISO dates.
 *
 * @pattern Google Photos date-grouped section with select-all toggle
 */
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
      <p className="text-sm font-semibold text-slate-600">{formatSectionDate(date)}</p>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

/**
 * Friendly empty state shown when the catalog has no items (or the prefix
 * filter yields zero results). Uses a centered camera icon with muted guidance.
 *
 * @pattern Immich empty-library illustration with call-to-action text
 */
function EmptyState({ prefix }: { prefix: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {/* Camera SVG icon */}
      <svg
        className="mb-4 h-16 w-16 text-slate-300"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
      <p className="text-sm font-medium text-slate-500">
        {prefix ? `No media found matching "${prefix}"` : 'No media in the catalog yet'}
      </p>
      <p className="mt-1 text-xs text-slate-400">
        {prefix
          ? 'Try a different prefix filter or clear the search.'
          : 'Upload photos or run a transfer to get started.'}
      </p>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

/**
 * Main catalog page component. Renders a date-grouped media grid with
 * infinite scroll, multi-select, bulk delete, lightbox, and date scroller.
 *
 * Key design decisions:
 *   • `sortedItems` is a flat array derived from sections, used as the single
 *     source of truth for lightbox navigation and shift-click range selection.
 *   • Selection state is a Set<encodedKey> – O(1) lookups keep re-renders fast
 *     even with thousands of thumbnails.
 *   • `lastSelectedIndex` ref persists across renders for shift-click without
 *     causing unnecessary re-renders.
 *   • The grid uses `select-none` to prevent accidental text selection during
 *     multi-select drag operations (Immich pattern).
 *
 * @pattern Google Photos date-timeline infinite-scroll grid
 * @pattern Immich shift-click range selection with lastSelectedIndex tracking
 */
export function CatalogPage() {
  const apiToken = useApiToken();
  const queryClient = useQueryClient();

  const [prefixInput, setPrefixInput] = useState('');
  const [prefix, setPrefix] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sortNewestFirst, setSortNewestFirst] = useState(() => {
    try {
      const saved = localStorage.getItem('catalog-sort-newest-first');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  /**
   * Tracks the index (in `sortedItems`) of the last individually clicked
   * thumbnail. Used for shift-click range selection across section boundaries.
   * Stored in a ref to avoid re-renders on every click.
   * @pattern Immich shift-click range selection
   */
  const lastSelectedIndexRef = useRef<number | null>(null);

  // Persist sort preference
  useEffect(() => {
    try { localStorage.setItem('catalog-sort-newest-first', String(sortNewestFirst)); } catch { /* test/SSR */ }
  }, [sortNewestFirst]);

  const selectionMode = selected.size > 0;

  // ── Debounce prefix filter ──
  // 400 ms delay prevents spamming the API on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setPrefix(prefixInput.trim()), 400);
    return () => clearTimeout(t);
  }, [prefixInput]);

  // ── Clear selection on prefix change ──
  // Stale selection keys would reference items no longer in the filtered set
  useEffect(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, [prefix]);

  // ── Data queries ──

  const statsQuery = useQuery({
    queryKey: ['catalog-stats', apiToken],
    queryFn: () => fetchCatalogStats(apiToken),
    retry: false,
    staleTime: 60_000,
  });

  const sortDirection = sortNewestFirst ? 'desc' : 'asc';

  const itemsQuery = useInfiniteQuery({
    queryKey: ['catalog-items', prefix, sortDirection, apiToken],
    queryFn: ({ pageParam }) =>
      fetchCatalogItems({ token: pageParam as string | undefined, prefix: prefix || undefined, max: 100, sort: sortDirection, apiToken }),
    getNextPageParam: (lastPage) => lastPage.nextToken,
    initialPageParam: undefined as string | undefined,
  });

  /** All loaded items across every fetched page (unsorted). */
  const allItems = useMemo(
    () => itemsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [itemsQuery.data],
  );

  /**
   * Group items by `sectionDate`, then sort both sections and intra-section
   * items according to the user's chosen sort direction.
   */
  const sections = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const item of allItems) {
      if (!map.has(item.sectionDate)) map.set(item.sectionDate, []);
      map.get(item.sectionDate)!.push(item);
    }
    const dir = sortNewestFirst ? -1 : 1;
    return [...map.entries()]
      .sort(([a], [b]) => dir * a.localeCompare(b))
      .map(([date, items]) => [date, items.sort((a, b) => dir * a.capturedAt.localeCompare(b.capturedAt))] as [string, CatalogItem[]]);
  }, [allItems, sortNewestFirst]);

  /**
   * Flat sorted list matching the visual order on screen. Used as the single
   * source of truth for lightbox index and shift-click range operations.
   */
  const sortedItems = useMemo(
    () => sections.flatMap(([, items]) => items),
    [sections],
  );

  // ── Infinite scroll via IntersectionObserver ──
  // A sentinel div at the bottom of the page triggers the next page fetch
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

  // ── Global keyboard shortcuts (when lightbox is closed) ──
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

  // ── Selection callbacks ──

  /**
   * Toggle a single item's selection state. Only updates lastSelectedIndex
   * when selecting (adding), not when deselecting — so shift-click ranges
   * anchor from the last *selected* item, not the last *toggled* item.
   */
  const toggleSelect = useCallback((encodedKey: string, flatIndex: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(encodedKey)) {
        next.delete(encodedKey);
      } else {
        next.add(encodedKey);
        lastSelectedIndexRef.current = flatIndex;
      }
      return next;
    });
  }, []);

  /**
   * Shift-click range selection: select every item between the last-clicked
   * index and the current index (inclusive). Works across section boundaries
   * because it operates on the flat `sortedItems` array.
   *
   * @pattern Immich shift-click range selection
   */
  const handleShiftClick = useCallback((currentIndex: number) => {
    const anchor = lastSelectedIndexRef.current;
    if (anchor === null) {
      // No prior click — treat as a normal toggle
      lastSelectedIndexRef.current = currentIndex;
      setSelected((prev) => {
        const next = new Set(prev);
        const key = sortedItems[currentIndex]?.encodedKey;
        if (key) next.add(key);
        return next;
      });
      return;
    }
    const lo = Math.min(anchor, currentIndex);
    const hi = Math.max(anchor, currentIndex);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) {
        const key = sortedItems[i]?.encodedKey;
        if (key) next.add(key);
      }
      return next;
    });
    lastSelectedIndexRef.current = currentIndex;
  }, [sortedItems]);

  /** Toggle all items in a section (used by the section header checkbox). */
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

  // ── Bulk delete mutation ──
  // Batches deletions in chunks of 200 to stay within API limits
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

  // Running offset tracks the flat index for each section's first item
  let runningOffset = 0;

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────────── */}
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

      {/* ── Selection toolbar ───────────────────────────────────────── */}
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

      {/* ── Stats card ──────────────────────────────────────────────── */}
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

      {/* ── Prefix filter + sort toggle ─────────────────────────────── */}
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
        <button
          type="button"
          onClick={() => setSortNewestFirst((p) => !p)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
          title={sortNewestFirst ? 'Showing newest first' : 'Showing oldest first'}
        >
          {sortNewestFirst ? '↓ Newest first' : '↑ Oldest first'}
        </button>
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

      {/* ── Date-grouped grid ───────────────────────────────────────── */}
      {itemsQuery.isLoading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : sections.length === 0 ? (
        <EmptyState prefix={prefix} />
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
              {/*
                Larger tiles: 3/4/6/8 cols (Google Photos style) with rounded-lg
                and gap-1.5 for breathing room. select-none is applied per-image
                to prevent drag selection while keeping dates accessible.
              */}
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
                {items.map((item, i) => (
                  <Thumbnail
                    key={item.encodedKey}
                    item={item}
                    apiToken={apiToken}
                    selected={selected.has(item.encodedKey)}
                    selectionMode={selectionMode}
                    lightboxIndex={sectionOffset + i}
                    onToggleSelect={() => toggleSelect(item.encodedKey, sectionOffset + i)}
                    onOpenLightbox={setLightboxIndex}
                    onShiftClick={handleShiftClick}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* ── Infinite scroll sentinel ────────────────────────────────── */}
      <div ref={sentinelRef} className="flex h-8 items-center justify-center">
        {itemsQuery.isFetchingNextPage && (
          <p className="text-xs text-slate-500">Loading more…</p>
        )}
      </div>

      {/* ── Date scroller (right-edge timeline) ─────────────────────── */}
      <DateScroller sections={sections} sectionRefs={sectionRefs} />

      {/* ── Lightbox ────────────────────────────────────────────────── */}
      {lightboxIndex !== null && sortedItems.length > 0 && (
        <Lightbox
          items={sortedItems}
          index={lightboxIndex}
          apiToken={apiToken}
          onClose={handleClose}
          onNavigate={handleNavigate}
        />
      )}
    </div>
  );
}
