/**
 * @file Catalog Album Detail Page – View and manage a single album.
 *
 * Displays all photos in the album as a grid of thumbnails. Supports:
 *   • Selection with checkbox + shift-click range
 *   • Remove selected items from the album
 *   • Rename the album inline
 *   • Delete the entire album (with confirmation)
 *   • Full-screen lightbox via click
 *
 * @pattern Google Photos album view
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  catalogMediaUrl,
  catalogThumbnailUrl,
  deleteAlbum,
  encodeS3Key,
  fetchAlbums,
  updateAlbum,
  type Album,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { useApiToken } from '@/lib/use-api-token';

// ── Item thumbnail ─────────────────────────────────────────────────────────

function AlbumThumb({
  s3Key,
  apiToken,
  selected,
  selectionMode,
  onClick,
  onCheckClick,
}: {
  s3Key: string;
  apiToken: string | undefined;
  selected: boolean;
  selectionMode: boolean;
  onClick: () => void;
  onCheckClick: () => void;
}) {
  const encodedKey = useMemo(() => encodeS3Key(s3Key), [s3Key]);
  const ext = s3Key.split('.').pop()?.toLowerCase() ?? '';
  const isBrowserNative = ext === 'heic' || ext === 'heif';
  const thumbUrl = isBrowserNative
    ? catalogMediaUrl(encodedKey, apiToken)
    : catalogThumbnailUrl(encodedKey, 'small', apiToken);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-slate-200 ${
        selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
      }`}
      onClick={onClick}
      role="gridcell"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
    >
      {/* Skeleton */}
      {!loaded && <div className="absolute inset-0 animate-pulse bg-slate-300" />}

      {!failed && (
        <img
          src={thumbUrl}
          loading="lazy"
          decoding="async"
          className={`h-full w-full select-none object-cover transition-all duration-300 ${loaded ? 'opacity-100' : 'opacity-0'} ${!selectionMode ? 'group-hover:scale-105' : ''} ${selected ? 'brightness-75' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => { setFailed(true); setLoaded(true); }}
          draggable={false}
        />
      )}

      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-200 text-slate-400">
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
      )}

      {/* Checkbox */}
      <button
        type="button"
        aria-label={selected ? 'Deselect' : 'Select'}
        onClick={(e) => { e.stopPropagation(); onCheckClick(); }}
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

// ── Lightbox ───────────────────────────────────────────────────────────────

function AlbumLightbox({
  keys,
  index,
  apiToken,
  onNavigate,
  onClose,
}: {
  keys: string[];
  index: number;
  apiToken: string | undefined;
  onNavigate: (i: number) => void;
  onClose: () => void;
}) {
  const s3Key = keys[index];
  const encodedKey = encodeS3Key(s3Key);
  const ext = s3Key.split('.').pop()?.toLowerCase() ?? '';
  const isBrowserNative = ext === 'heic' || ext === 'heif';
  const thumbUrl = isBrowserNative
    ? catalogMediaUrl(encodedKey, apiToken)
    : catalogThumbnailUrl(encodedKey, 'large', apiToken);
  const mediaUrl = catalogMediaUrl(encodedKey, apiToken);
  const [useFull, setUseFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const filename = s3Key.split('/').pop() ?? s3Key;

  const hasPrev = index > 0;
  const hasNext = index < keys.length - 1;

  useEffect(() => {
    setUseFull(false);
    setFailed(false);
  }, [index]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [index, hasPrev, hasNext, onNavigate, onClose]);

  const imgSrc = failed ? undefined : (useFull ? mediaUrl : thumbUrl);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={onClose}
    >
      {/* Toolbar */}
      <div
        className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-sm font-medium text-white/90">{filename}</span>
        <div className="flex items-center gap-2">
          <a
            href={mediaUrl}
            download={filename}
            target="_blank"
            rel="noreferrer"
            className="rounded-full p-2 text-white/80 hover:bg-white/20"
            title="Download"
            onClick={(e) => e.stopPropagation()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
              <path d="M12 5v10M7 15l5 5 5-5M3 19h18" />
            </svg>
          </a>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="rounded-full p-2 text-white/80 hover:bg-white/20"
            title="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Image */}
      {imgSrc && (
        <img
          src={imgSrc}
          alt={filename}
          className="max-h-screen max-w-full object-contain"
          onClick={(e) => e.stopPropagation()}
          onError={() => {
            if (!useFull) { setUseFull(true); }
            else setFailed(true);
          }}
          draggable={false}
        />
      )}
      {failed && (
        <div className="flex flex-col items-center gap-2 text-white/60" onClick={(e) => e.stopPropagation()}>
          <svg className="h-12 w-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <span className="text-sm">Could not load image</span>
        </div>
      )}

      {/* Prev/Next arrows */}
      {hasPrev && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-5 w-5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-5 w-5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      )}

      {/* Counter */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
        {index + 1} / {keys.length}
      </div>
    </div>
  );
}

// ── Album detail page ──────────────────────────────────────────────────────

export function CatalogAlbumDetailPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const apiToken = useApiToken();
  const queryClient = useQueryClient();

  // ── Data ──
  const albumsQuery = useQuery({
    queryKey: ['albums'],
    queryFn: () => fetchAlbums(apiToken),
    staleTime: 30_000,
  });

  const album: Album | undefined = albumsQuery.data?.albums.find((a) => a.id === albumId);

  // ── Rename ──
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');

  const renameMutation = useMutation({
    mutationFn: (name: string) => updateAlbum(albumId!, { name }, apiToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      setEditing(false);
    },
  });

  const handleRenameStart = useCallback(() => {
    setNameInput(album?.name ?? '');
    setEditing(true);
  }, [album]);

  const handleRenameSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = nameInput.trim();
      if (trimmed && trimmed !== album?.name) renameMutation.mutate(trimmed);
      else setEditing(false);
    },
    [nameInput, album, renameMutation],
  );

  // ── Delete album ──
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteAlbumMutation = useMutation({
    mutationFn: () => deleteAlbum(albumId!, apiToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      navigate('/catalog/albums');
    },
  });

  // ── Selection ──
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const lastClickedRef = useRef<number | null>(null);

  const selectionMode = selected.size > 0;

  const toggleItem = useCallback((i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      lastClickedRef.current = next.has(i) ? i : null;
      return next;
    });
    lastClickedRef.current = i;
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    lastClickedRef.current = null;
  }, []);

  // ── Remove from album ──
  const [confirmRemove, setConfirmRemove] = useState(false);

  const removeMutation = useMutation({
    mutationFn: (indices: Set<number>) => {
      const keys = album!.keys.filter((_, i) => indices.has(i));
      return updateAlbum(albumId!, { removeKeys: keys }, apiToken);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      setSelected(new Set());
      setConfirmRemove(false);
    },
  });

  // ── Lightbox ──
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const handleThumbClick = useCallback(
    (i: number) => {
      if (selectionMode) toggleItem(i);
      else setLightboxIndex(i);
    },
    [selectionMode, toggleItem],
  );

  // ── Render ──
  if (albumsQuery.isLoading) {
    return (
      <div className="space-y-5">
        <div className="h-7 w-48 animate-pulse rounded bg-slate-200" />
        <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-slate-200" />
          ))}
        </div>
      </div>
    );
  }

  if (albumsQuery.isError || (!albumsQuery.isLoading && !album)) {
    return (
      <Card className="p-6">
        <p className="text-sm text-red-700">
          {albumsQuery.isError
            ? (albumsQuery.error instanceof Error ? albumsQuery.error.message : 'Failed to load albums')
            : 'Album not found'}
        </p>
        <Link to="/catalog/albums" className="mt-3 block text-sm text-blue-600 hover:underline">
          ← Back to Albums
        </Link>
      </Card>
    );
  }

  const keys = album!.keys;

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/catalog/albums"
            className="flex-shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Albums
          </Link>
          {editing ? (
            <form onSubmit={handleRenameSubmit} className="flex items-center gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus
                maxLength={200}
                className="rounded-md border border-blue-400 px-2.5 py-1 text-lg font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
              />
              <button
                type="submit"
                disabled={!nameInput.trim() || renameMutation.isPending}
                className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {renameMutation.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="truncate text-lg font-bold text-slate-900">{album!.name}</h1>
              <button
                type="button"
                onClick={handleRenameStart}
                className="flex-shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title="Rename album"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {confirmDelete ? (
            <>
              <span className="text-sm text-red-700">Delete this album?</span>
              <button
                type="button"
                onClick={() => deleteAlbumMutation.mutate()}
                disabled={deleteAlbumMutation.isPending}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleteAlbumMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                <path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" />
              </svg>
              Delete album
            </button>
          )}
        </div>
      </div>

      {/* ── Sub-header: count + selection actions ──────────────────── */}
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <span>{keys.length.toLocaleString()} photo{keys.length !== 1 ? 's' : ''}</span>
        {selectionMode && (
          <div className="sticky top-0 z-40 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 shadow-sm">
            <button
              type="button"
              onClick={clearSelection}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700"
              title="Clear selection"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <span className="text-sm font-semibold text-blue-900">
              {selected.size.toLocaleString()} selected
            </span>
            <div className="ml-auto flex items-center gap-2">
              {confirmRemove ? (
                <>
                  <span className="text-sm font-medium text-red-700">
                    Remove {selected.size} from album?
                  </span>
                  <button
                    type="button"
                    onClick={() => removeMutation.mutate(selected)}
                    disabled={removeMutation.isPending}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {removeMutation.isPending ? 'Removing…' : 'Remove'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                >
                  Remove from album
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Error: remove failed ─────────────────────────────────────── */}
      {removeMutation.isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {removeMutation.error instanceof Error ? removeMutation.error.message : 'Failed to remove items'}
        </div>
      )}

      {/* ── Empty album ──────────────────────────────────────────────── */}
      {keys.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-7 w-7">
              <rect x="2" y="2" width="20" height="20" rx="3" />
              <path d="M2 14l5-5 4 4 3-3 8 8" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-slate-800">This album is empty</p>
            <p className="mt-1 text-sm text-slate-500">
              Go to{' '}
              <Link to="/catalog" className="text-blue-600 hover:underline">
                Photos
              </Link>{' '}
              and select items to add them here.
            </p>
          </div>
        </div>
      )}

      {/* ── Photo grid ───────────────────────────────────────────────── */}
      {keys.length > 0 && (
        <div
          className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
          role="grid"
          aria-label={`Album: ${album!.name}`}
        >
          {keys.map((key, i) => (
            <AlbumThumb
              key={key}
              s3Key={key}
              apiToken={apiToken}
              selected={selected.has(i)}
              selectionMode={selectionMode}
              onClick={() => handleThumbClick(i)}
              onCheckClick={() => toggleItem(i)}
            />
          ))}
        </div>
      )}

      {/* ── Lightbox ─────────────────────────────────────────────────── */}
      {lightboxIndex !== null && (
        <AlbumLightbox
          keys={keys}
          index={lightboxIndex}
          apiToken={apiToken}
          onNavigate={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
