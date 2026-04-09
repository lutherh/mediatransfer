/**
 * @file Catalog Undated Page – Browse and assign dates to media with no detected capture date.
 *
 * Media files that had no EXIF date, filename-embedded date, or sidecar date
 * are stored under the `unknown-date/` prefix in S3 and excluded from the main
 * catalog grid.  This page surfaces those files and lets the user select one or
 * more and assign a date, which moves them into the proper YYYY/MM/DD path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  bulkMoveCatalogItems,
  catalogThumbnailUrl,
  deleteCatalogItems,
  fetchTakeoutActionStatus,
  fetchUndatedItems,
  runTakeoutAction,
  type CatalogItem,
  type TakeoutActionStatus,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { formatBytes } from '@/lib/format';
import { useApiToken } from '@/lib/use-api-token';

// ── Thumbnail tile ─────────────────────────────────────────────────────────

function UndatedThumbnail({
  item,
  selected,
  onToggle,
  apiToken,
}: {
  item: CatalogItem;
  selected: boolean;
  onToggle: (encodedKey: string) => void;
  apiToken: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const thumbUrl = catalogThumbnailUrl(item.encodedKey, 'small', apiToken);
  const filename = item.key.split('/').pop() ?? item.key;

  return (
    <button
      type="button"
      onClick={() => onToggle(item.encodedKey)}
      className={`group relative aspect-square overflow-hidden rounded-lg border-2 transition-all ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-300'
          : 'border-transparent hover:border-slate-300'
      }`}
      title={filename}
    >
      {failed ? (
        <div className="flex h-full w-full items-center justify-center bg-slate-200 text-slate-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-8 w-8">
            <rect x="2" y="2" width="20" height="20" rx="3" />
            <path d="M2 14l5-5 4 4 3-3 8 8" />
          </svg>
        </div>
      ) : (
        <img
          src={thumbUrl}
          alt={filename}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}

      {/* Selection indicator */}
      <div
        className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
          selected
            ? 'border-blue-500 bg-blue-500 text-white'
            : 'border-white/80 bg-black/20 text-transparent group-hover:border-white'
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="h-3 w-3">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </div>

      {/* Video badge */}
      {item.mediaType === 'video' && (
        <div className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
          ▶ Video
        </div>
      )}

      {/* Filename on hover */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
        <p className="truncate text-[11px] text-white">{filename}</p>
      </div>
    </button>
  );
}

// ── Assign date modal ──────────────────────────────────────────────────────

function AssignDateModal({
  count,
  onClose,
  onAssign,
  isPending,
}: {
  count: number;
  onClose: () => void;
  onAssign: (date: string) => void;
  isPending: boolean;
}) {
  const [dateValue, setDateValue] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (dateValue) onAssign(dateValue);
    },
    [dateValue, onAssign],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-base font-semibold text-slate-900">Assign Date</h2>
        <p className="mb-4 text-sm text-slate-500">
          Move {count.toLocaleString()} file{count !== 1 ? 's' : ''} to a dated folder.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="assign-date" className="mb-1 block text-xs font-medium text-slate-700">
              Capture date
            </label>
            <input
              id="assign-date"
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              min="1990-01-01"
              max={new Date().toISOString().slice(0, 10)}
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
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
              disabled={!dateValue || isPending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isPending ? 'Moving…' : 'Assign Date'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Auto-detect hook ───────────────────────────────────────────────────────

function useAutoDetect(onComplete: () => void) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [actionStatus, setActionStatus] = useState<TakeoutActionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Attach to an already-running repair-dates-s3 action on mount
  useEffect(() => {
    let cancelled = false;
    fetchTakeoutActionStatus().then((s) => {
      if (cancelled) return;
      if (s.running && s.action === 'repair-dates-s3') {
        setStatus('running');
        setActionStatus(s);
      }
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Poll while running
  useEffect(() => {
    if (status !== 'running') return;
    const poll = setInterval(async () => {
      try {
        const s = await fetchTakeoutActionStatus();
        setActionStatus(s);
        if (!s.running && s.action === 'repair-dates-s3') {
          setStatus(s.success ? 'done' : 'error');
          if (!s.success) setError(`Exited with code ${s.exitCode ?? 'unknown'}`);
          stopPolling();
          onComplete();
        }
      } catch {
        // transient fetch error — keep polling
      }
    }, 1500);
    pollRef.current = poll;
    return stopPolling;
  }, [status, stopPolling, onComplete]);

  const start = useCallback(async () => {
    setStatus('running');
    setError(null);
    setActionStatus(null);
    try {
      const res = await runTakeoutAction('repair-dates-s3');
      setActionStatus(res.status);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to start');
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setActionStatus(null);
    setError(null);
  }, []);

  return { status, actionStatus, error, start, reset };
}

// ── Output log viewer ──────────────────────────────────────────────────────

function AutoDetectOutput({ lines }: { lines: string[] }) {
  const containerRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  // Show only the last meaningful lines (skip blanks at the end)
  const trimmed = lines.slice(-30);

  return (
    <pre
      ref={containerRef}
      className="max-h-40 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-200"
    >
      {trimmed.join('\n')}
    </pre>
  );
}

// ── Page component ─────────────────────────────────────────────────────────

export function CatalogUndatedPage() {
  const apiToken = useApiToken();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showDateModal, setShowDateModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refreshUndated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['catalog-undated'] });
    void queryClient.invalidateQueries({ queryKey: ['catalog-items'] });
    void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
  }, [queryClient]);

  const autoDetect = useAutoDetect(refreshUndated);

  const undatedQuery = useQuery({
    queryKey: ['catalog-undated'],
    queryFn: () => fetchUndatedItems(),
    staleTime: 60_000,
  });

  const items: CatalogItem[] = useMemo(
    () => undatedQuery.data?.items ?? [],
    [undatedQuery.data],
  );

  const totalBytes = useMemo(
    () => items.reduce((sum, item) => sum + item.size, 0),
    [items],
  );

  // ── Selection helpers ────────────────────────────────────────────────────

  const toggleSelect = useCallback((encodedKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(encodedKey)) next.delete(encodedKey);
      else next.add(encodedKey);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(items.map((i) => i.encodedKey)));
  }, [items]);

  const clearAll = useCallback(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, []);

  const selectionMode = selected.size > 0;

  // ── Assign date mutation ─────────────────────────────────────────────────

  const assignDateMutation = useMutation({
    mutationFn: async (dateStr: string) => {
      const [year, month, day] = dateStr.split('-');
      const newDatePrefix = `${year}/${month}/${day}`;
      const moves = [...selected].map((encodedKey) => ({ encodedKey, newDatePrefix }));
      // Process in chunks of 100 (backend limit)
      const results = { moved: [] as { from: string; to: string }[], failed: [] as { key: string; error: string }[] };
      for (let i = 0; i < moves.length; i += 100) {
        const batch = moves.slice(i, i + 100);
        const res = await bulkMoveCatalogItems(batch);
        results.moved.push(...res.moved);
        results.failed.push(...res.failed);
      }
      return results;
    },
    onSuccess: () => {
      setSelected(new Set());
      setShowDateModal(false);
      void queryClient.invalidateQueries({ queryKey: ['catalog-undated'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-items'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
    },
  });

  // ── Delete mutation ──────────────────────────────────────────────────────

  const deleteMutation = useMutation({
    mutationFn: async (encodedKeys: string[]) => {
      for (let i = 0; i < encodedKeys.length; i += 200) {
        await deleteCatalogItems(encodedKeys.slice(i, i + 200));
      }
    },
    onSuccess: () => {
      setSelected(new Set());
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: ['catalog-undated'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
    },
  });

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link
            to="/catalog"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Catalog
          </Link>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Undated Media</h1>
            <p className="text-xs text-slate-500">
              Files without a detected capture date. Assign a date to move them into the catalog.
            </p>
          </div>
        </div>
      </div>

      {/* ── Stats card ──────────────────────────────────────────────── */}
      {!undatedQuery.isLoading && items.length > 0 && (
        <Card className="p-2.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-700 sm:grid-cols-3">
            <div><span className="font-medium">Files:</span> {items.length.toLocaleString()}</div>
            <div><span className="font-medium">Size:</span> {formatBytes(totalBytes)}</div>
            <div>
              <span className="font-medium">Photos:</span>{' '}
              {items.filter((i) => i.mediaType === 'image').length.toLocaleString()}
              {' · '}
              <span className="font-medium">Videos:</span>{' '}
              {items.filter((i) => i.mediaType === 'video').length.toLocaleString()}
            </div>
          </div>
        </Card>
      )}

      {/* ── Auto-detect dates panel ─────────────────────────────────── */}
      {!undatedQuery.isLoading && items.length > 0 && (
        <Card className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Auto-detect dates</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Scans files directly in cloud storage to extract dates from EXIF, video metadata, filenames, and cached Google Takeout sidecars. Files with detected dates are moved automatically.
              </p>
            </div>
            {autoDetect.status === 'idle' && (
              <button
                type="button"
                onClick={autoDetect.start}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                  <path d="M12 3v1m0 16v1m8.66-13.66l-.71.71M4.05 19.95l-.71.71M21 12h-1M4 12H3m16.66 7.66l-.71-.71M4.05 4.05l-.71-.71" />
                  <circle cx="12" cy="12" r="4" />
                </svg>
                Detect dates
              </button>
            )}
            {autoDetect.status === 'done' && (
              <button
                type="button"
                onClick={autoDetect.reset}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              >
                Dismiss
              </button>
            )}
            {autoDetect.status === 'error' && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={autoDetect.start}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={autoDetect.reset}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* Running state: progress + live output */}
          {autoDetect.status === 'running' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-amber-100">
                  <div className="h-full animate-pulse rounded-full bg-amber-500" style={{ width: '100%' }} />
                </div>
                <span className="text-xs font-medium text-amber-700">Running…</span>
              </div>
              {autoDetect.actionStatus?.output && autoDetect.actionStatus.output.length > 0 && (
                <AutoDetectOutput lines={autoDetect.actionStatus.output} />
              )}
            </div>
          )}

          {/* Done state */}
          {autoDetect.status === 'done' && autoDetect.actionStatus && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-green-700">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                <span className="font-medium">Complete — refresh to see updated files</span>
              </div>
              <AutoDetectOutput lines={autoDetect.actionStatus.output} />
            </div>
          )}

          {/* Error state */}
          {autoDetect.status === 'error' && (
            <div className="flex items-center gap-2 text-xs text-red-700">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{autoDetect.error ?? 'Date detection failed'}</span>
            </div>
          )}
        </Card>
      )}

      {/* ── Selection toolbar ───────────────────────────────────────── */}
      {selectionMode && (
        <div className="sticky top-0 z-40 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 shadow-sm">
          <button
            type="button"
            onClick={clearAll}
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

          {selected.size < items.length && (
            <button
              type="button"
              onClick={selectAll}
              className="text-xs text-blue-700 underline hover:text-blue-900"
            >
              Select all {items.length.toLocaleString()}
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {confirmDelete ? (
              <>
                <span className="text-sm font-medium text-red-700">
                  Permanently delete {selected.size.toLocaleString()} file{selected.size !== 1 ? 's' : ''}?
                </span>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate([...selected])}
                  disabled={deleteMutation.isPending}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
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
              <>
                <button
                  type="button"
                  onClick={() => setShowDateModal(true)}
                  className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                  Assign Date
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
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
      )}

      {/* ── Error states ──────────────────────────────────────────── */}
      {(assignDateMutation.isError || deleteMutation.isError) && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-800">Operation failed</p>
            <p className="mt-0.5 text-sm text-red-700">
              {(assignDateMutation.error ?? deleteMutation.error) instanceof Error
                ? ((assignDateMutation.error ?? deleteMutation.error) as Error).message
                : 'Something went wrong. Please try again.'}
            </p>
          </div>
        </div>
      )}

      {/* ── Success toast for date assignment ──────────────────────── */}
      {assignDateMutation.isSuccess && (
        <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4">
          <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <div>
            <p className="text-sm font-medium text-green-800">Date assigned</p>
            <p className="mt-0.5 text-sm text-green-700">
              Moved {assignDateMutation.data.moved.length.toLocaleString()} file{assignDateMutation.data.moved.length !== 1 ? 's' : ''} to the catalog.
              {assignDateMutation.data.failed.length > 0 && (
                <> {assignDateMutation.data.failed.length} failed.</>
              )}
            </p>
          </div>
        </div>
      )}

      {/* ── Loading skeleton ────────────────────────────────────────── */}
      {undatedQuery.isLoading && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-slate-200" />
          ))}
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────── */}
      {undatedQuery.isError && (
        <Card className="p-4">
          <p className="text-sm text-red-700">
            {undatedQuery.error instanceof Error
              ? undatedQuery.error.message
              : 'Failed to load undated items'}
          </p>
        </Card>
      )}

      {/* ── Empty state ─────────────────────────────────────────────── */}
      {!undatedQuery.isLoading && items.length === 0 && !undatedQuery.isError && (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-50 text-green-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-8 w-8">
              <circle cx="12" cy="12" r="10" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-slate-800">No undated media</p>
            <p className="mt-1 text-sm text-slate-500">
              All your media files have a detected capture date. 🎉
            </p>
          </div>
          <Link
            to="/catalog"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Back to Catalog
          </Link>
        </div>
      )}

      {/* ── Thumbnails grid ─────────────────────────────────────────── */}
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          {items.map((item) => (
            <UndatedThumbnail
              key={item.encodedKey}
              item={item}
              selected={selected.has(item.encodedKey)}
              onToggle={toggleSelect}
              apiToken={apiToken}
            />
          ))}
        </div>
      )}

      {/* ── Assign Date modal ────────────────────────────────────────── */}
      {showDateModal && (
        <AssignDateModal
          count={selected.size}
          onClose={() => setShowDateModal(false)}
          onAssign={(date) => assignDateMutation.mutate(date)}
          isPending={assignDateMutation.isPending}
        />
      )}
    </div>
  );
}
