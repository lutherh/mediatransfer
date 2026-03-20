/**
 * @file Catalog Albums Page – Browse and manage albums (like Google Photos Albums tab).
 *
 * Shows all albums as a grid of cards. Each card displays the cover thumbnail,
 * album name, and photo count. A "New Album" button creates an empty album.
 *
 * @pattern Google Photos albums grid
 */
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  catalogThumbnailUrl,
  createAlbum,
  deleteAlbum,
  encodeS3Key,
  fetchAlbums,
  type Album,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { useApiToken } from '@/lib/use-api-token';

// ── Album card ─────────────────────────────────────────────────────────────

function AlbumCover({
  album,
  apiToken,
}: {
  album: Album;
  apiToken: string | undefined;
}) {
  const coverKey = album.coverKey ?? album.keys[0];
  const [failed, setFailed] = useState(false);

  if (!coverKey || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-200 text-slate-400">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-10 w-10">
          <rect x="2" y="2" width="20" height="20" rx="3" />
          <path d="M2 14l5-5 4 4 3-3 8 8" />
          <circle cx="15" cy="8" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      </div>
    );
  }

  const encodedKey = encodeS3Key(coverKey);
  const thumbUrl = catalogThumbnailUrl(encodedKey, 'small', apiToken);

  return (
    <img
      src={thumbUrl}
      alt={album.name}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
      onError={() => setFailed(true)}
    />
  );
}

function AlbumCard({
  album,
  apiToken,
}: {
  album: Album;
  apiToken: string | undefined;
}) {
  return (
    <Link
      to={`/catalog/albums/${album.id}`}
      className="group block overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition-shadow"
    >
      <div className="aspect-square overflow-hidden bg-slate-100">
        <AlbumCover album={album} apiToken={apiToken} />
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-slate-900">{album.name}</p>
        <p className="text-xs text-slate-500">
          {album.keys.length.toLocaleString()} photo{album.keys.length !== 1 ? 's' : ''}
        </p>
      </div>
    </Link>
  );
}

// ── New album dialog ───────────────────────────────────────────────────────

function NewAlbumDialog({
  onClose,
  onCreated,
  apiToken,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  apiToken: string | undefined;
}) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (albumName: string) => createAlbum(albumName, apiToken),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      onCreated(result.id);
    },
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed) createMutation.mutate(trimmed);
    },
    [name, createMutation],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-base font-semibold text-slate-900">New Album</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="Album name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {createMutation.isError && (
            <p className="text-xs text-red-600">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : 'Failed to create album'}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createMutation.isPending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Albums page ────────────────────────────────────────────────────────────

export function CatalogAlbumsPage() {
  const apiToken = useApiToken();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showNewAlbum, setShowNewAlbum] = useState(false);

  const albumsQuery = useQuery({
    queryKey: ['albums'],
    queryFn: () => fetchAlbums(apiToken),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (albumId: string) => deleteAlbum(albumId, apiToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
    },
  });

  const albums = albumsQuery.data?.albums ?? [];

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/catalog"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Photos
          </Link>
          <h1 className="text-lg font-bold text-slate-900">Albums</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowNewAlbum(true)}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New Album
        </button>
      </div>

      {/* ── Loading skeleton ────────────────────────────────────────── */}
      {albumsQuery.isLoading && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-slate-200">
              <div className="aspect-square animate-pulse bg-slate-200" />
              <div className="space-y-1.5 p-3">
                <div className="h-3.5 animate-pulse rounded bg-slate-200" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────── */}
      {albumsQuery.isError && (
        <Card className="p-4">
          <p className="text-sm text-red-700">
            {albumsQuery.error instanceof Error
              ? albumsQuery.error.message
              : 'Failed to load albums'}
          </p>
        </Card>
      )}

      {/* ── Empty state ─────────────────────────────────────────────── */}
      {!albumsQuery.isLoading && albums.length === 0 && !albumsQuery.isError && (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-8 w-8">
              <rect x="2" y="2" width="20" height="20" rx="3" />
              <path d="M2 14l5-5 4 4 3-3 8 8" />
              <circle cx="15" cy="8" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-slate-800">No albums yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Create an album to group your photos together.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewAlbum(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Create your first album
          </button>
        </div>
      )}

      {/* ── Albums grid ─────────────────────────────────────────────── */}
      {albums.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {albums.map((album) => (
            <AlbumCard key={album.id} album={album} apiToken={apiToken} />
          ))}
        </div>
      )}

      {/* ── New album dialog ─────────────────────────────────────────── */}
      {showNewAlbum && (
        <NewAlbumDialog
          apiToken={apiToken}
          onClose={() => setShowNewAlbum(false)}
          onCreated={(id) => {
            setShowNewAlbum(false);
            navigate(`/catalog/albums/${id}`);
          }}
        />
      )}

      {deleteMutation.isError && (
        <p className="text-sm text-red-600">
          {deleteMutation.error instanceof Error
            ? deleteMutation.error.message
            : 'Failed to delete album'}
        </p>
      )}
    </div>
  );
}
