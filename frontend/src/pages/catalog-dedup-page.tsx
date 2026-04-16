import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  catalogMediaUrl,
  catalogThumbnailUrl,
  deleteCatalogItems,
  encodeS3Key,
  fetchDedupScanStatus,
  scanDuplicatesStream,
  type DuplicateGroup,
  type DuplicatesResult,
  type DupScanProgress,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { formatBytes } from '@/lib/format';
import { useApiToken } from '@/lib/use-api-token';

function basename(key: string): string {
  return key.split('/').pop() ?? key;
}

/** Returns a human-readable namespace label and Tailwind colour classes for an S3 key. */
function pathNamespaceBadge(key: string): { label: string; className: string } | null {
  if (key.startsWith('immich/library/')) {
    return { label: 'Immich library', className: 'bg-blue-100 text-blue-700' };
  }
  if (key.startsWith('immich/upload/')) {
    return { label: 'Immich upload', className: 'bg-blue-100 text-blue-700' };
  }
  if (key.startsWith('immich/')) {
    return { label: 'Immich', className: 'bg-blue-100 text-blue-700' };
  }
  if (/^transfers\/((?:19|20)\d{4})\/\d{2}\/\d{2}\//.test(key)) {
    return { label: 'Transfers (dated)', className: 'bg-emerald-100 text-emerald-700' };
  }
  if (key.startsWith('transfers/')) {
    return { label: 'Transfers (no date)', className: 'bg-amber-100 text-amber-700' };
  }
  return null;
}

// ── Thumb ──────────────────────────────────────────────────────────────────

function Thumb({
  s3Key,
  apiToken,
  label,
  variant,
  onSelect,
  selected,
}: {
  s3Key: string;
  apiToken: string | undefined;
  label: string;
  variant: 'keep' | 'delete';
  onSelect?: () => void;
  selected?: boolean;
}) {
  const encodedKey = encodeS3Key(s3Key);
  const thumbUrl = catalogThumbnailUrl(encodedKey, 'small', apiToken);
  const fullUrl = catalogMediaUrl(encodedKey, apiToken);
  const [useFallback, setUseFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgSrc = failed ? undefined : (useFallback ? fullUrl : thumbUrl);
  const ringColor =
    variant === 'keep'
      ? 'ring-2 ring-emerald-500'
      : selected
        ? 'ring-2 ring-red-500'
        : 'ring-1 ring-slate-200 opacity-70';

  return (
    <button
      type="button"
      className={`group relative flex h-20 w-20 flex-shrink-0 cursor-pointer flex-col items-center overflow-hidden rounded-lg bg-slate-100 transition-all ${ringColor}`}
      onClick={onSelect}
      title={s3Key}
    >
      {imgSrc && (
        <img
          src={imgSrc}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => {
            if (!useFallback) setUseFallback(true);
            else setFailed(true);
          }}
        />
      )}
      {/* Fallback icon when neither thumbnail nor full image could load */}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-200 text-slate-400">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
      )}
      {/* overlay label */}
      <span
        className={`absolute bottom-0 left-0 right-0 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-white ${
          variant === 'keep' ? 'bg-emerald-600/80' : 'bg-red-600/80'
        }`}
      >
        {label}
      </span>
      {/* checkbox for delete items */}
      {variant === 'delete' && (
        <span
          className={`absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full border ${
            selected ? 'border-red-500 bg-red-500' : 'border-white bg-black/30'
          }`}
        >
          {selected && (
            <svg className="h-2.5 w-2.5 text-white" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
          )}
        </span>
      )}
    </button>
  );
}

/** Compact thumbnail for the GroupRow summary — tries small thumb, falls back to full media, then icon. */
function DedupSummaryThumb({ s3Key, apiToken }: { s3Key: string; apiToken: string | undefined }) {
  const encodedKey = encodeS3Key(s3Key);
  const thumbUrl = catalogThumbnailUrl(encodedKey, 'small', apiToken);
  const fullUrl = catalogMediaUrl(encodedKey, apiToken);
  const [useFallback, setUseFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgSrc = failed ? undefined : (useFallback ? fullUrl : thumbUrl);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-200 text-slate-400">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={imgSrc}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => {
        if (!useFallback) setUseFallback(true);
        else setFailed(true);
      }}
    />
  );
}

// ── GroupRow ───────────────────────────────────────────────────────────────

function GroupRow({
  group,
  apiToken,
  onDeleted,
}: {
  group: DuplicateGroup;
  apiToken: string | undefined;
  onDeleted: (keys: string[]) => void;
}) {
  // Which keys the user has chosen to delete (defaults: all duplicateKeys)
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(
    () => new Set(group.duplicateKeys),
  );
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'deleting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const toggleKey = useCallback((key: string) => {
    setSelectedForDelete((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async () => {
    if (selectedForDelete.size === 0) return;
    setStatus('deleting');
    setErrorMsg('');
    try {
      const encodedKeys = [...selectedForDelete].map(encodeS3Key);
      await deleteCatalogItems(encodedKeys);
      setStatus('done');
      onDeleted([...selectedForDelete]);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [selectedForDelete, onDeleted]);

  if (status === 'done') return null;

  const totalCopies = 1 + group.duplicateKeys.length;
  const wastedBytes = group.size * group.duplicateKeys.length;

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      {/* Cross-namespace warning strip */}
      {group.crossNamespace && (
        <div className="flex items-center gap-2 rounded-t-lg border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          <span>
            <strong>Cross-namespace duplicate</strong> — Immich copy is kept; the{' '}
            <span className="font-mono">transfers/</span> copy will be deleted. Safe to proceed.
          </span>
        </div>
      )}

      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Compact keep thumb */}
        <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded border-2 border-emerald-400 bg-slate-100">
          <DedupSummaryThumb s3Key={group.keepKey} apiToken={apiToken} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-slate-800" title={group.keepKey}>
              {basename(group.keepKey)}
            </p>
            {(() => {
              const badge = pathNamespaceBadge(group.keepKey);
              return badge ? (
                <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}>
                  {badge.label}
                </span>
              ) : null;
            })()}
          </div>
          <p className="text-xs text-slate-500">
            {totalCopies} copies · {formatBytes(group.size)} each ·{' '}
            <span className="text-red-600 font-medium">{formatBytes(wastedBytes)} wasted</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-800"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Collapse ▲' : 'Expand ▼'}
          </button>

          {status === 'error' && (
            <span className="text-xs text-red-600" title={errorMsg}>
              ⚠ Error
            </span>
          )}

          <button
            type="button"
            disabled={selectedForDelete.size === 0 || status === 'deleting'}
            onClick={handleDelete}
            className="min-w-[100px] rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'deleting'
              ? 'Deleting…'
              : `Delete ${selectedForDelete.size} cop${selectedForDelete.size === 1 ? 'y' : 'ies'}`}
          </button>
        </div>
      </div>

      {/* Expanded thumbnail strip */}
      {expanded && (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 px-4 pb-3 pt-3">
          {/* Keep */}
          <div className="flex flex-col items-center gap-1">
            <Thumb
              s3Key={group.keepKey}
              apiToken={apiToken}
              label="Keep"
              variant="keep"
            />
            <p className="max-w-[80px] truncate text-center text-[9px] text-slate-500" title={group.keepKey}>
              {basename(group.keepKey)}
            </p>
            {(() => {
              const badge = pathNamespaceBadge(group.keepKey);
              return badge ? (
                <span className={`rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${badge.className}`}>
                  {badge.label}
                </span>
              ) : null;
            })()}
          </div>

          {/* Duplicates */}
          {group.duplicateKeys.map((key) => (
            <div key={key} className="flex flex-col items-center gap-1">
              <Thumb
                s3Key={key}
                apiToken={apiToken}
                label="Delete"
                variant="delete"
                selected={selectedForDelete.has(key)}
                onSelect={() => toggleKey(key)}
              />
              <p className="max-w-[80px] truncate text-center text-[9px] text-slate-500" title={key}>
                {basename(key)}
              </p>
              {(() => {
                const badge = pathNamespaceBadge(key);
                return badge ? (
                  <span className={`rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${badge.className}`}>
                    {badge.label}
                  </span>
                ) : null;
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

type SortOrder = 'wasted-desc' | 'copies-desc' | 'size-desc';

const DELETE_BATCH_SIZE = 200;

export function CatalogDedupPage() {
  const apiToken = useApiToken();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('wasted-desc');
  const [confirming, setConfirming] = useState(false);

  // Scan state
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [data, setData] = useState<DuplicatesResult | null>(null);
  const [progress, setProgress] = useState<{ listed: number; totalFiles: number | null }>({ listed: 0, totalFiles: null });
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Local list of deleted raw keys (to hide groups optimistically)
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(() => new Set());

  // Progress tracking for batch deletion
  const [deleteProgress, setDeleteProgress] = useState<{ deleted: number; total: number } | null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Stop any running poll interval. */
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** Start polling `/scan/status` until the server scan finishes. */
  const pollForResult = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await fetchDedupScanStatus();
        if (status.status === 'scanning') {
          setProgress({ listed: status.listed, totalFiles: status.totalFiles });
        } else if (status.status === 'done') {
          stopPolling();
          setData({ groups: status.groups, totalDuplicates: status.totalDuplicates, bytesFreed: status.bytesFreed });
          setScanStatus('done');
        } else if (status.status === 'error') {
          stopPolling();
          setScanError(status.message);
          setScanStatus('error');
        } else {
          // idle — scan apparently finished while we weren't looking
          stopPolling();
          setScanStatus('error');
          setScanError('Scan ended without results — please retry');
        }
      } catch {
        // Network error — keep polling
      }
    }, 3_000);
  }, [stopPolling]);

  /** Kick off a new scan via SSE, with automatic fallback to polling. */
  const startScan = useCallback(() => {
    // Abort any in-flight scan / polling
    abortRef.current?.abort();
    stopPolling();
    const controller = new AbortController();
    abortRef.current = controller;

    setScanStatus('scanning');
    setScanError(null);
    setData(null);
    setDeletedKeys(new Set());
    setFilter('');
    setProgress({ listed: 0, totalFiles: null });

    scanDuplicatesStream(
      (event: DupScanProgress) => {
        if (event.phase === 'started' || event.phase === 'listing') {
          setProgress({ listed: 'listed' in event ? event.listed : 0, totalFiles: event.totalFiles });
        }
      },
      controller.signal,
    )
      .then((result) => {
        setData(result);
        setScanStatus('done');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : '';
        // If the server says a scan is already running, or the SSE stream
        // dropped mid-scan, fall back to polling for the cached result.
        if (msg === 'SCAN_ALREADY_RUNNING' || msg === 'STREAM_ENDED_UNEXPECTEDLY') {
          pollForResult();
          return;
        }
        setScanError(msg || 'Scan failed');
        setScanStatus('error');
      });
  }, [pollForResult, stopPolling]);

  // On mount: check if the server already has scan results or a scan in progress
  useEffect(() => {
    let cancelled = false;
    fetchDedupScanStatus()
      .then((status) => {
        if (cancelled) return;
        if (status.status === 'done') {
          setData({ groups: status.groups, totalDuplicates: status.totalDuplicates, bytesFreed: status.bytesFreed });
          setScanStatus('done');
        } else if (status.status === 'scanning') {
          setScanStatus('scanning');
          setProgress({ listed: status.listed, totalFiles: status.totalFiles });
          pollForResult();
        }
        // idle / error — leave at idle, user can start a new scan
      })
      .catch(() => {
        // Catalog unavailable — show idle, user can retry
      });
    return () => { cancelled = true; };
  }, [pollForResult]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopPolling();
    };
  }, [stopPolling]);

  const isLoading = scanStatus === 'scanning';
  const isError = scanStatus === 'error';
  const scanned = scanStatus !== 'idle';

  const handleDeleted = useCallback((keys: string[]) => {
    setDeletedKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  }, []);

  // Filter out fully-deleted groups and immich-only groups (this tool can't safely handle those)
  const visibleGroups = useMemo(() => {
    if (!data) return [];
    return data.groups.filter(
      (g) =>
        !g.immichOnly &&
        !deletedKeys.has(g.keepKey) &&
        !g.duplicateKeys.every((k) => deletedKeys.has(k)),
    );
  }, [data, deletedKeys]);

  // Count of immich-only groups excluded from the list
  const immichOnlyCount = useMemo(
    () => data?.groups.filter((g) => g.immichOnly).length ?? 0,
    [data],
  );

  // Count of cross-namespace groups (immich/ + transfers/ mixed)
  const crossNamespaceCount = useMemo(
    () => visibleGroups.filter((g) => g.crossNamespace).length,
    [visibleGroups],
  );

  // Apply search filter + sort
  const filteredGroups = useMemo(() => {
    const q = filter.toLowerCase().trim();
    const groups = q
      ? visibleGroups.filter(
          (g) =>
            g.keepKey.toLowerCase().includes(q) ||
            g.duplicateKeys.some((k) => k.toLowerCase().includes(q)),
        )
      : visibleGroups;

    return [...groups].sort((a, b) => {
      if (sortOrder === 'wasted-desc')
        return b.size * b.duplicateKeys.length - a.size * a.duplicateKeys.length;
      if (sortOrder === 'copies-desc')
        return b.duplicateKeys.length - a.duplicateKeys.length;
      return b.size - a.size;
    });
  }, [visibleGroups, filter, sortOrder]);

  // Stats based on visible (not-yet-deleted) groups
  const stats = useMemo(() => {
    const totalGroups = visibleGroups.length;
    const totalDuplicates = visibleGroups.reduce((s, g) => s + g.duplicateKeys.length, 0);
    const totalWasted = visibleGroups.reduce((s, g) => s + g.size * g.duplicateKeys.length, 0);
    return { totalGroups, totalDuplicates, totalWasted };
  }, [visibleGroups]);

  // Delete ALL visible duplicates
  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      const allDupKeys = visibleGroups.flatMap((g) => g.duplicateKeys);
      const encodedKeys = allDupKeys.map(encodeS3Key);
      const total = encodedKeys.length;
      setDeleteProgress({ deleted: 0, total });
      // Delete in batches of 200 to respect body size limits
      for (let i = 0; i < encodedKeys.length; i += DELETE_BATCH_SIZE) {
        await deleteCatalogItems(encodedKeys.slice(i, i + DELETE_BATCH_SIZE));
        setDeleteProgress({ deleted: Math.min(i + DELETE_BATCH_SIZE, total), total });
      }
      return allDupKeys;
    },
    onSuccess: (deletedRawKeys) => {
      handleDeleted(deletedRawKeys);
      setConfirming(false);
      setDeleteProgress(null);
      void queryClient.invalidateQueries({ queryKey: ['catalog-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-items'] });
    },
    onError: () => {
      setDeleteProgress(null);
    },
  });

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link
              to="/catalog"
              className="text-sm text-slate-500 hover:text-slate-800"
            >
              ← Catalog
            </Link>
          </div>
          <h1 className="mt-1 text-xl font-semibold sm:text-2xl">Deduplication</h1>
          <p className="text-sm text-slate-600">
            Find and remove duplicate media files. The oldest / best-dated copy is kept automatically.
          </p>
        </div>

        <button
          type="button"
          onClick={startScan}
          disabled={isLoading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isLoading ? 'Scanning…' : scanned ? '↺ Rescan' : 'Scan for duplicates'}
        </button>
      </div>

      {/* Not scanned yet */}
      {!scanned && (
        <Card>
          <div className="py-6 text-center">
            <p className="text-4xl">🔍</p>
            <p className="mt-3 font-medium text-slate-700">Ready to scan your catalog</p>
            <p className="mt-1 text-sm text-slate-500">
              The scanner compares files by size and ETag to find exact duplicates.
              It selects the best-dated copy to keep and marks the rest for deletion.
            </p>
            <p className="mt-2 text-xs text-slate-400">
              The scan runs on the server — you can keep browsing other pages while it completes.
            </p>
            <button
              type="button"
              onClick={startScan}
              className="mt-4 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Start scan
            </button>
          </div>
        </Card>
      )}

      {/* Loading with progress */}
      {isLoading && (
        <Card>
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
            <p className="text-sm font-medium text-slate-700">Scanning all objects…</p>

            {/* Progress bar */}
            <div className="w-full max-w-sm px-4 sm:max-w-md">
              <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-300 ease-out"
                  style={{
                    width: progress.totalFiles && progress.totalFiles > 0
                      ? `${Math.min(100, (progress.listed / progress.totalFiles) * 100)}%`
                      : '100%',
                    ...(!(progress.totalFiles && progress.totalFiles > 0) && {
                      animation: 'indeterminate 1.5s ease-in-out infinite',
                    }),
                  }}
                />
              </div>
              <p className="mt-1.5 text-center text-xs text-slate-500">
                {progress.listed.toLocaleString()} objects scanned
                {progress.totalFiles ? (
                  <> of ~{progress.totalFiles.toLocaleString()} ({Math.round((progress.listed / progress.totalFiles) * 100)}%)</>
                ) : null}
              </p>
            </div>

            <p className="text-xs text-slate-400">
              This runs server-side — you can navigate away and come back.
            </p>
          </div>
          <style>{`
            @keyframes indeterminate {
              0% { width: 30%; margin-left: 0%; }
              50% { width: 50%; margin-left: 25%; }
              100% { width: 30%; margin-left: 70%; }
            }
          `}</style>
        </Card>
      )}

      {/* Error */}
      {isError && (
        <Card>
          <p className="text-sm text-red-600">
            {scanError ?? 'Scan failed'} —{' '}
            <button type="button" className="underline" onClick={startScan}>
              retry
            </button>
          </p>
        </Card>
      )}

      {/* Results */}
      {data && !isLoading && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            <Card>
              <p className="text-xs text-slate-500">Duplicate groups</p>
              <p className="mt-0.5 text-2xl font-bold text-slate-800">
                {stats.totalGroups.toLocaleString()}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Files to delete</p>
              <p className="mt-0.5 text-2xl font-bold text-red-600">
                {stats.totalDuplicates.toLocaleString()}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Space to reclaim</p>
              <p className="mt-0.5 text-2xl font-bold text-emerald-600">
                {formatBytes(stats.totalWasted)}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Already cleaned</p>
              <p className="mt-0.5 text-2xl font-bold text-slate-500">
                {deletedKeys.size.toLocaleString()} files
              </p>
            </Card>
          </div>

          {/* Immich-only exclusion notice */}
          {immichOnlyCount > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <svg className="mt-0.5 h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
              </svg>
              <span>
                <strong>{immichOnlyCount.toLocaleString()} Immich-only group{immichOnlyCount !== 1 ? 's' : ''} excluded</strong> —
                these duplicates exist entirely within <span className="font-mono">immich/</span> paths.
                This tool cannot safely delete them without corrupting Immich's database.
                Use Immich's built-in deduplication instead.
              </span>
            </div>
          )}

          {/* Cross-namespace advisory */}
          {crossNamespaceCount > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <svg className="mt-0.5 h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              <span>
                <strong>{crossNamespaceCount.toLocaleString()} cross-namespace group{crossNamespaceCount !== 1 ? 's' : ''}</strong> —
                these contain both an <span className="font-mono">immich/</span> copy and a{' '}
                <span className="font-mono">transfers/</span> copy of the same file.
                The <strong>Immich copy is kept</strong> and the transfers copy is marked for deletion.
                This is safe to proceed with.
              </span>
            </div>
          )}

          {visibleGroups.length === 0 ? (
            <Card>
              <p className="py-4 text-center text-sm text-emerald-700 font-medium">
                ✓ No duplicates found — your catalog is clean!
              </p>
            </Card>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  placeholder="Filter by filename…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="w-full max-w-xs rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="wasted-desc">Sort: most space wasted</option>
                  <option value="copies-desc">Sort: most copies</option>
                  <option value="size-desc">Sort: largest file</option>
                </select>
                <span className="text-xs text-slate-500">
                  {filteredGroups.length.toLocaleString()} group{filteredGroups.length !== 1 ? 's' : ''}
                </span>

                <div className="ml-auto">
                  {deleteAllMutation.isPending && deleteProgress ? (
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className="h-full rounded-full bg-red-500 transition-all duration-300 ease-out"
                            style={{
                              width: `${Math.round((deleteProgress.deleted / deleteProgress.total) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="whitespace-nowrap text-xs font-medium text-red-700">
                          {deleteProgress.deleted.toLocaleString()} / {deleteProgress.total.toLocaleString()} deleted
                        </span>
                      </div>
                    </div>
                  ) : confirming ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-red-700">
                        Delete {stats.totalDuplicates.toLocaleString()} files?
                      </span>
                      <button
                        type="button"
                        className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        disabled={deleteAllMutation.isPending}
                        onClick={() => deleteAllMutation.mutate()}
                      >
                        Confirm delete all
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                        onClick={() => setConfirming(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
                    >
                      Delete all duplicates ({formatBytes(stats.totalWasted)})
                    </button>
                  )}
                </div>
              </div>

              {deleteAllMutation.isError && (
                <p className="text-sm text-red-600">
                  {deleteAllMutation.error instanceof Error
                    ? deleteAllMutation.error.message
                    : 'Delete failed'}
                </p>
              )}

              {/* Groups list */}
              <div className="space-y-2">
                {filteredGroups.map((group) => (
                  <GroupRow
                    key={group.fingerprint}
                    group={group}
                    apiToken={apiToken}
                    onDeleted={handleDeleted}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
