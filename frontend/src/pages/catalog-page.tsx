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
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  catalogMediaUrl,
  catalogThumbnailUrl,
  deleteCatalogItems,
  fetchCatalogExif,
  fetchCatalogItems,
  fetchCatalogStats,
  fetchAlbums,
  createAlbum,
  updateAlbum,
  moveCatalogItem,
  type Album,
  type CatalogItem,
  type CatalogStats,
  type ExifData,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { DateScroller } from '@/components/date-scroller';
import { VirtualizedGrid } from '@/components/virtualized-grid';
import { formatBytes } from '@/lib/format';
import { DateTimeEditor } from '@/components/catalog/date-time-editor';
import { useApiToken } from '@/lib/use-api-token';

// ── Stats bar ──────────────────────────────────────────────────────────────

/**
 * Compact summary row showing total files, size, photo/video counts, and
 * date range. Placed inside a Card at the top of the catalog page.
 */
function StatsBar({ stats }: { stats: CatalogStats }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-700 sm:grid-cols-3 lg:grid-cols-6">
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

// ── Add to Album modal ────────────────────────────────────────────────────

/**
 * Modal dialog that lets the user pick an existing album (or create a new one)
 * to add the current selection to.
 *
 * @pattern Google Photos "Add to album" picker
 */
function AddToAlbumModal({
  onClose,
  onAdd,
  apiToken,
}: {
  onClose: () => void;
  onAdd: (albumId: string) => void;
  apiToken: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [newAlbumMode, setNewAlbumMode] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');

  const albumsQuery = useQuery({
    queryKey: ['albums'],
    queryFn: () => fetchAlbums(apiToken),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => createAlbum(name, apiToken),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      onAdd(result.id);
    },
  });

  const albums = albumsQuery.data?.albums ?? [];

  const handleCreateSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = newAlbumName.trim();
      if (trimmed) createMutation.mutate(trimmed);
    },
    [newAlbumName, createMutation],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Add to Album</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-64 overflow-y-auto p-2">
          {albumsQuery.isLoading && (
            <div className="space-y-1 p-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          )}

          {albums.length === 0 && !albumsQuery.isLoading && !newAlbumMode && (
            <p className="py-4 text-center text-sm text-slate-500">No albums yet</p>
          )}

          {albums.map((album: Album) => (
            <button
              key={album.id}
              type="button"
              onClick={() => onAdd(album.id)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-50"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
                  <rect x="2" y="2" width="20" height="20" rx="3" />
                  <path d="M2 14l5-5 4 4 3-3 8 8" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{album.name}</p>
                <p className="text-xs text-slate-500">{album.keys.length.toLocaleString()} photo{album.keys.length !== 1 ? 's' : ''}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="border-t border-slate-200 p-3">
          {newAlbumMode ? (
            <form onSubmit={handleCreateSubmit} className="flex items-center gap-2">
              <input
                type="text"
                placeholder="New album name"
                autoFocus
                value={newAlbumName}
                onChange={(e) => setNewAlbumName(e.target.value)}
                maxLength={200}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={!newAlbumName.trim() || createMutation.isPending}
                className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {createMutation.isPending ? '…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => setNewAlbumMode(false)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setNewAlbumMode(true)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New album
            </button>
          )}
          {createMutation.isError && (
            <p className="mt-1.5 text-xs text-red-600">
              {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create album'}
            </p>
          )}
        </div>
      </div>
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
  onAddToAlbum,
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
  onAddToAlbum: () => void;
}) {
  return (
    <div className="sticky top-0 z-40 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 shadow-sm">
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
          <>
            <button
              type="button"
              onClick={onAddToAlbum}
              className="flex items-center gap-1.5 rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                <rect x="2" y="2" width="20" height="20" rx="3" />
                <path d="M2 14l5-5 4 4 3-3 8 8" />
                <path d="M18 8v8M14 12h8" />
              </svg>
              Add to Album
            </button>
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
          </>
        )}
      </div>
    </div>
  );
}

// ── Lightbox info panel ────────────────────────────────────────────────────

/**
 * Rich metadata overlay for the lightbox. Shows basic file properties plus
 * EXIF data (dimensions, camera, GPS) fetched on demand via `fetchCatalogExif`.
 *
 * @pattern Google Photos info panel with camera details and location
 * @pattern Ente metadata sidebar
 */
function InfoPanel({
  item,
  apiToken,
  onDateChanged,
}: {
  item: CatalogItem;
  apiToken: string | undefined;
  /** Called after a successful date-move so the parent can close the lightbox and refresh. */
  onDateChanged?: () => void;
}) {
  const queryClient = useQueryClient();

  const exifQuery = useQuery({
    queryKey: ['catalog-exif', item.encodedKey],
    queryFn: () => fetchCatalogExif(item.encodedKey, apiToken),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const exif = exifQuery.data;

  // ── Date-edit mutation (moves the S3 object to a new YYYY/MM/DD folder) ──
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const moveMutation = useMutation({
    mutationFn: ({ encodedKey, newDatePrefix }: { encodedKey: string; newDatePrefix: string }) =>
      moveCatalogItem(encodedKey, newDatePrefix, apiToken),
    onSuccess: () => {
      setSaveResult('success');
      // Pre-invalidate so the grid is ready when the lightbox closes.
      void queryClient.invalidateQueries({ queryKey: ['catalog-items'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
      // Brief delay so the user sees the success confirmation, then close.
      setTimeout(() => onDateChanged?.(), 1500);
    },
    onError: (err) => {
      setSaveResult('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
    },
  });

  // Reset feedback when the viewed item changes.
  useEffect(() => {
    setSaveResult(null);
    setErrorMsg('');
  }, [item.encodedKey]);

  const handleDateSave = useCallback(
    (newDatePrefix: string) => {
      setSaveResult(null);
      moveMutation.mutate({ encodedKey: item.encodedKey, newDatePrefix });
    },
    [item.encodedKey, moveMutation],
  );

  return (
    <div
      className="absolute z-20 overflow-y-auto bg-black/80 p-4 backdrop-blur-sm inset-x-0 bottom-0 max-h-[50vh] border-t border-white/10 sm:inset-x-auto sm:max-h-none sm:right-0 sm:top-0 sm:w-72 sm:border-l sm:border-t-0"
      onClick={(e) => e.stopPropagation()}
      role="complementary"
      aria-label="File details"
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

        {/* ── Editable date (Windows 11 Photos style) ── */}
        <div>
          <dt className="mb-1.5 font-medium text-white/50">Captured</dt>
          <dd>
            <DateTimeEditor
              capturedAt={item.capturedAt}
              itemKey={item.key}
              onSave={handleDateSave}
              isSaving={moveMutation.isPending}
              saveResult={saveResult}
              errorMessage={errorMsg}
            />
          </dd>
        </div>

        <div>
          <dt className="font-medium text-white/50">Last Modified</dt>
          <dd>{item.lastModified}</dd>
        </div>
        <div>
          <dt className="font-medium text-white/50">Type</dt>
          <dd>{item.mediaType}</dd>
        </div>

        {/* ── EXIF data (fetched on demand) ── */}
        {exifQuery.isLoading && (
          <div className="pt-2 text-[10px] text-white/40">Loading EXIF…</div>
        )}
        {exif && (
          <>
            {(exif.width || exif.height) && (
              <div>
                <dt className="font-medium text-white/50">Dimensions</dt>
                <dd>{exif.width} × {exif.height}</dd>
              </div>
            )}
            {(exif.make || exif.model) && (
              <div>
                <dt className="font-medium text-white/50">Camera</dt>
                <dd>{[exif.make, exif.model].filter(Boolean).join(' ')}</dd>
              </div>
            )}
            {exif.capturedAt && (
              <div>
                <dt className="font-medium text-white/50">EXIF Date</dt>
                <dd>{exif.capturedAt}</dd>
              </div>
            )}
            {exif.latitude != null && exif.longitude != null && (
              <div>
                <dt className="font-medium text-white/50">Location</dt>
                <dd>{exif.latitude.toFixed(6)}, {exif.longitude.toFixed(6)}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </div>
  );
}

// ── Lightbox ───────────────────────────────────────────────────────────────

/** Minimum / maximum zoom scale bounds for the lightbox viewer. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
/** Toolbar auto-hides after this many ms of inactivity. */
const TOOLBAR_HIDE_MS = 3000;
/** Minimum horizontal distance (px) for a touch gesture to count as a swipe. */
const SWIPE_THRESHOLD_PX = 50;
/** Horizontal distance must exceed vertical distance × this factor for a swipe. */
const SWIPE_HORIZONTAL_RATIO = 1.5;

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
  onDateChanged,
}: {
  items: CatalogItem[];
  index: number;
  apiToken: string | undefined;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onDateChanged: () => void;
}) {
  const item = items[index];
  // Full-resolution URL for download only
  const fullMediaUrl = catalogMediaUrl(item.encodedKey, apiToken);
  // Lightbox preview: use large (1920px) thumbnail for images, full URL for videos.
  // HEIC/HEIF go straight to full media URL — the browser decodes natively and
  // Sharp cannot resize them (no HEVC support), so skip the doomed 415 round-trip.
  const ext = item.key.split('.').pop()?.toLowerCase() ?? '';
  const isBrowserNative = ext === 'heic' || ext === 'heif';
  const thumbUrl = (item.mediaType === 'video' || isBrowserNative)
    ? fullMediaUrl
    : catalogThumbnailUrl(item.encodedKey, 'large', apiToken);

  // Fall back to the full media URL if the large thumbnail fails.
  const [previewFailed, setPreviewFailed] = useState(false);
  // Second-level: full media URL itself failed (unsupported codec / corrupt)
  const [mediaFailed, setMediaFailed] = useState(false);
  const previewUrl = previewFailed ? fullMediaUrl : thumbUrl;

  // Reset fallback state when navigating to a different item
  useEffect(() => {
    setPreviewFailed(false);
    setMediaFailed(false);
  }, [index]);

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

  // ── Touch swipe navigation (mobile) ──
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      touchStartRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_HORIZONTAL_RATIO) {
      if (dx > 0 && index > 0) onNavigate(index - 1);
      else if (dx < 0 && index < items.length - 1) onNavigate(index + 1);
    }
  }, [index, items.length, onNavigate]);

  // Extract filename from the key for the toolbar display
  const filename = item.key.split('/').pop() ?? item.key;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
      onClick={onClose}
      onMouseMove={resetToolbarTimer}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-label="Media viewer"
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
        <div className="flex items-center gap-1 sm:gap-3">
          <button
            className="flex h-11 w-11 items-center justify-center rounded-full text-lg text-white/80 hover:text-white active:bg-white/10"
            onClick={handleDownload}
            aria-label="Download"
            title="Download (D)"
          >⬇</button>
          <button
            className={`flex h-11 w-11 items-center justify-center rounded-full text-lg hover:text-white active:bg-white/10 ${showInfo ? 'text-blue-400' : 'text-white/80'}`}
            onClick={() => setShowInfo((v) => !v)}
            aria-label="Toggle info"
            title="Info (I)"
          >ⓘ</button>
          <button
            className="flex h-11 w-11 items-center justify-center rounded-full text-xl font-bold text-white/80 hover:text-white active:bg-white/10"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >✕</button>
        </div>
      </div>

      {/* ── Navigation arrows (hidden on mobile — use swipe instead) ── */}
      {index > 0 && (
        <button
          className="absolute left-2 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60 sm:block"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          aria-label="Previous"
        >‹</button>
      )}
      {index < items.length - 1 && (
        <button
          className="absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-3xl text-white hover:bg-black/60 sm:block"
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
        {mediaFailed ? (
          <div className="flex h-48 w-64 flex-col items-center justify-center gap-2 rounded-lg bg-slate-800 text-slate-400">
            <svg className="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span className="text-xs">{item.key.split('/').pop()}</span>
            <span className="text-[10px] text-slate-500">Cannot preview this file</span>
            <a
              href={fullMediaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 rounded bg-slate-600 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-500"
              onClick={(e) => e.stopPropagation()}
            >
              Download to open externally
            </a>
          </div>
        ) : item.mediaType === 'video' ? (
          <video
            key={previewUrl}
            src={previewUrl}
            controls
            autoPlay
            className="max-h-[88vh] max-w-[88vw] rounded-lg transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
            onError={() => setMediaFailed(true)}
          />
        ) : (
          <img
            key={previewUrl}
            src={previewUrl}
            alt={item.key}
            decoding="async"
            className="max-h-[88vh] max-w-[88vw] rounded-lg object-contain transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
            onError={() => {
              if (!previewFailed) setPreviewFailed(true);
              else setMediaFailed(true);
            }}
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

      {/* ── Info / metadata overlay (Ente-inspired + Google Photos EXIF) ── */}
      {showInfo && (
        <InfoPanel item={item} apiToken={apiToken} onDateChanged={onDateChanged} />
      )}
    </div>
  );
}

// ── Thumbnail ──────────────────────────────────────────────────────────────


// ── Skeleton grid ──────────────────────────────────────────────────────────

/**
 * Pulsing placeholder grid shown while the initial catalog data is loading.
 * Mimics the real grid layout so the page doesn't jump when content arrives.
 *
 * @pattern Google Photos skeleton loading tiles
 */
function SkeletonGrid() {
  return (
    <div className="space-y-6">
      {[0, 1, 2].map((section) => (
        <div key={section} className={section > 0 ? 'border-t border-slate-200 pt-4' : ''}>
          <div className="mb-1 h-5 w-28 animate-pulse rounded bg-slate-200" />
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {Array.from({ length: section === 0 ? 16 : 8 }, (_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-lg bg-slate-200" />
            ))}
          </div>
        </div>
      ))}
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

// ── Keyboard shortcuts help dialog ────────────────────────────────────────

/**
 * Modal dialog listing all available keyboard shortcuts. Opened by pressing
 * the `?` key (Google Photos pattern: "Press question mark to see shortcut
 * keys available").
 *
 * @pattern Google Photos keyboard shortcut help dialog
 */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const sections = [
    {
      title: 'Gallery',
      shortcuts: [
        ['Ctrl + A', 'Select all items'],
        ['Esc', 'Clear selection'],
        ['?', 'Show keyboard shortcuts'],
      ],
    },
    {
      title: 'Lightbox',
      shortcuts: [
        ['\u2190 / \u2192', 'Previous / next'],
        ['Esc', 'Close'],
        ['D', 'Download'],
        ['I', 'Toggle info panel'],
        ['+ / \u2212', 'Zoom in / out'],
        ['0', 'Reset zoom'],
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-80 rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {sections.map((sec) => (
          <div key={sec.title} className="mb-3">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{sec.title}</h3>
            <dl className="space-y-1">
              {sec.shortcuts.map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between text-sm">
                  <dt className="text-slate-600">{desc}</dt>
                  <dd><kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-700">{key}</kbd></dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <p className="mt-3 text-center text-[10px] text-slate-400">Press <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px]">?</kbd> or <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px]">Esc</kbd> to close</p>
      </div>
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showAlbumModal, setShowAlbumModal] = useState(false);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

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

  // ── Scroll-to-top FAB visibility ──
  useEffect(() => {
    const handleScroll = () => setShowScrollTop(window.scrollY > 600);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

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
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const sortDirection = sortNewestFirst ? 'desc' : 'asc';

  const itemsQuery = useInfiniteQuery({
    queryKey: ['catalog-items', prefix, sortDirection, apiToken],
    queryFn: ({ pageParam }) =>
      fetchCatalogItems({ token: pageParam as string | undefined, prefix: prefix || undefined, max: 100, sort: sortDirection, apiToken }),
    getNextPageParam: (lastPage) => lastPage.nextToken,
    initialPageParam: undefined as string | undefined,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
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

  // ── Infinite scroll via IntersectionObserver (sentinel) ──
  // Handled inside VirtualizedGrid component.

  // ── Global keyboard shortcuts (when lightbox is closed) ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (lightboxIndex !== null) return;
      // ? key → open keyboard shortcuts dialog (Google Photos pattern)
      if (e.key === '?' && !showShortcuts) {
        setShowShortcuts(true);
        return;
      }
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
  }, [lightboxIndex, selectionMode, allItems, showShortcuts]);

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

  // ── Add to album mutation ──
  // Map from encodedKey → raw S3 key for converting selection to album keys
  const encodedToKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of allItems) m.set(item.encodedKey, item.key);
    return m;
  }, [allItems]);

  const addToAlbumMutation = useMutation({
    mutationFn: (albumId: string) => {
      const rawKeys = [...selected].map((ek) => encodedToKey.get(ek) ?? ek);
      return updateAlbum(albumId, { addKeys: rawKeys }, apiToken);
    },
    onSuccess: () => {
      setShowAlbumModal(false);
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
    },
  });

  const handleClose = useCallback(() => setLightboxIndex(null), []);
  const handleNavigate = useCallback((i: number) => setLightboxIndex(i), []);

  /** Close the lightbox and refresh the grid after a successful date move. */
  const handleDateChanged = useCallback(() => {
    setLightboxIndex(null);
    void queryClient.invalidateQueries({ queryKey: ['catalog-items'] });
    void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
  }, [queryClient]);

  // ── Scroll-to-date (wired from VirtualizedGrid via onRegisterScrollToDate) ──
  const scrollToDateRef = useRef<((date: string) => void) | null>(null);
  const scrollToDate = useCallback((date: string) => {
    scrollToDateRef.current?.(date);
  }, []);

  // ── Drag-and-drop visual overlay ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only deactivate when leaving the container (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Future: handle file upload from drag-and-drop
  }, []);

  return (
    <div
      className="relative space-y-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay (Google Photos pattern) */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-blue-500/10 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-blue-400 bg-white/90 px-8 py-6 shadow-lg">
            <p className="text-sm font-medium text-blue-700">Drop files to upload</p>
          </div>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Catalog</h1>
          <p className="text-xs text-slate-500">Your photos and videos, organized by date.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/catalog/albums"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            📁 Albums
          </Link>
          <Link
            to="/catalog/dedup"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            🔍 Dedup
          </Link>
          {(statsQuery.data?.undatedCount ?? 0) > 0 && (
            <Link
              to="/catalog/undated"
              className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              📅 Undated ({statsQuery.data?.undatedCount.toLocaleString()})
            </Link>
          )}
        </div>
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
          onAddToAlbum={() => setShowAlbumModal(true)}
        />
      )}

      {/* ── Add to Album modal ───────────────────────────────────────── */}
      {showAlbumModal && (
        <AddToAlbumModal
          apiToken={apiToken}
          onClose={() => setShowAlbumModal(false)}
          onAdd={(albumId) => addToAlbumMutation.mutate(albumId)}
        />
      )}

      {deleteMutation.isError && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-800">Delete failed</p>
            <p className="mt-0.5 text-sm text-red-700">
              {deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Something went wrong. Please try again.'}
            </p>
          </div>
        </div>
      )}

      {/* ── Stats card ──────────────────────────────────────────────── */}
      <Card className="p-2.5">
        {statsQuery.isLoading ? (
          /* Stats skeleton: mimics the 6-column grid while data loads */
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-slate-200" />
            ))}
          </div>
        ) : statsQuery.isError ? (
          <p className="text-xs text-amber-700">
            {statsQuery.error instanceof Error ? statsQuery.error.message : 'Catalog unavailable — check SCW_* env vars'}
          </p>
        ) : statsQuery.data ? (
          <StatsBar stats={statsQuery.data} />
        ) : null}
      </Card>

      {/* ── Prefix filter + sort toggle ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          placeholder="Search by date or folder (e.g. 2024/06)…"
          className="w-full max-w-xs rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={prefixInput}
          onChange={(e) => setPrefixInput(e.target.value)}
          aria-label="Filter catalog by prefix"
        />
        {prefix && (
          <button
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            onClick={() => { setPrefixInput(''); setPrefix(''); }}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={() => setSortNewestFirst((p) => !p)}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
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
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load catalog</p>
            <p className="mt-0.5 text-sm text-red-700">
              {itemsQuery.error instanceof Error ? itemsQuery.error.message : 'Check your connection and try refreshing the page.'}
            </p>
            <button
              type="button"
              onClick={() => itemsQuery.refetch()}
              className="mt-2 rounded bg-red-100 px-3 py-1 text-sm font-medium text-red-800 hover:bg-red-200 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Date-grouped grid (Google Photos-style sections) ─────── */}
      {itemsQuery.isLoading ? (
        <SkeletonGrid />
      ) : sections.length === 0 ? (
        <EmptyState prefix={prefix} />
      ) : (
        /*
         * Row-level virtualized grid — only item rows near the viewport are
         * mounted in the DOM, keeping node count low even with thousands of
         * items. VirtualizedGrid handles infinite scroll and sectionRefs.
         *
         * @pattern Immich row-level virtual list (useWindowVirtualizer)
         */
        <VirtualizedGrid
          sections={sections}
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
          onRegisterScrollToDate={(fn) => { scrollToDateRef.current = fn; }}
        />
      )}

      {/* ── Date scroller (right-edge timeline) ─────────────────────── */}
      <DateScroller sections={sections} sectionRefs={sectionRefs} onScrollToDate={scrollToDate} />

      {/* ── Scroll-to-top FAB (Google Photos pattern) ──────────────── */}
      {showScrollTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-6 right-6 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-lg ring-1 ring-slate-200 transition-opacity hover:bg-slate-50"
          aria-label="Scroll to top"
          title="Back to top"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5 text-slate-600">
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      )}

      {/* ── Keyboard shortcut hint (bottom-left) ────────────────────── */}
      {!selectionMode && lightboxIndex === null && !showShortcuts && (
        <button
          type="button"
          onClick={() => setShowShortcuts(true)}
          className="fixed bottom-6 left-6 z-30 flex h-7 w-7 items-center justify-center rounded-md bg-white text-xs font-mono text-slate-400 shadow ring-1 ring-slate-200 transition-opacity hover:text-slate-600"
          title="Keyboard shortcuts (?)"
          aria-label="Show keyboard shortcuts"
        >
          ?
        </button>
      )}

      {/* ── Keyboard shortcuts dialog (Google Photos: press ? key) ──── */}
      {showShortcuts && (
        <ShortcutsDialog onClose={() => setShowShortcuts(false)} />
      )}

      {/* ── Lightbox ────────────────────────────────────────────────── */}
      {lightboxIndex !== null && sortedItems.length > 0 && (
        <Lightbox
          items={sortedItems}
          index={lightboxIndex}
          apiToken={apiToken}
          onClose={handleClose}
          onNavigate={handleNavigate}
          onDateChanged={handleDateChanged}
        />
      )}
    </div>
  );
}
