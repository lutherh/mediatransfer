import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  catalogThumbnailUrl,
  catalogMediaUrl,
  encodeS3Key,
  fetchImmichOrphans,
  remapImmichAssets,
  resolveImmichAsset,
  type OrphanMatch,
  type MatchConfidence,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { useApiToken } from '@/lib/use-api-token';

// ── Helpers ────────────────────────────────────────────────────────────────

const S3_MOUNT = '/usr/src/app/upload/s3transfers';

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function confidenceLabel(c: MatchConfidence): string {
  switch (c) {
    case 'exact-date':
      return 'Exact date';
    case 'fuzzy-date':
      return 'Fuzzy date (±3d)';
    case 'single-candidate':
      return 'Single candidate';
    case 'ambiguous':
      return 'No match';
  }
}

function confidenceColor(c: MatchConfidence): string {
  switch (c) {
    case 'exact-date':
      return 'bg-emerald-100 text-emerald-800';
    case 'fuzzy-date':
      return 'bg-amber-100 text-amber-800';
    case 'single-candidate':
      return 'bg-orange-100 text-orange-800';
    case 'ambiguous':
      return 'bg-red-100 text-red-800';
  }
}

function confidenceRing(c: MatchConfidence): string {
  switch (c) {
    case 'exact-date':
      return 'ring-emerald-400';
    case 'fuzzy-date':
      return 'ring-amber-400';
    case 'single-candidate':
      return 'ring-orange-400';
    case 'ambiguous':
      return 'ring-red-400';
  }
}

type Filter = 'all' | MatchConfidence;

// ── S3 Thumbnail ───────────────────────────────────────────────────────────

function S3Thumb({ s3Key, apiToken, size = 'h-24 w-24' }: { s3Key: string; apiToken: string | undefined; size?: string }) {
  const encodedKey = encodeS3Key(s3Key);
  const thumbUrl = catalogThumbnailUrl(encodedKey, 'small', apiToken);
  const fullUrl = catalogMediaUrl(encodedKey, apiToken);
  const [useFallback, setUseFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgSrc = failed ? undefined : (useFallback ? fullUrl : thumbUrl);

  if (failed) {
    return (
      <div className={`flex ${size} items-center justify-center rounded bg-slate-200 text-slate-400`}>
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </div>
    );
  }

  return (
    <a href={fullUrl} target="_blank" rel="noopener noreferrer">
      <img
        src={imgSrc}
        loading="lazy"
        className={`${size} rounded object-cover`}
        onError={() => {
          if (!useFallback) setUseFallback(true);
          else setFailed(true);
        }}
      />
    </a>
  );
}

// ── OrphanRow ──────────────────────────────────────────────────────────────

function OrphanRow({
  orphan,
  apiToken,
  approved,
  onApprove,
  onReject,
  onResolve,
}: {
  orphan: OrphanMatch;
  apiToken: string | undefined;
  approved: boolean | null; // null = undecided
  onApprove: () => void;
  onReject: () => void;
  onResolve: (s3Path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(orphan.s3Path);

  const dateStr = new Date(orphan.fileCreatedAt).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const hasMultipleCandidates = orphan.s3Candidates.length > 1;

  return (
    <div
      className={`rounded-lg border bg-white transition-colors ${
        approved === true
          ? 'border-emerald-300 bg-emerald-50/30'
          : approved === false
            ? 'border-red-200 bg-red-50/20 opacity-60'
            : 'border-slate-200'
      }`}
    >
      {/* Summary */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* S3 thumbnail */}
        <div className={`flex-shrink-0 overflow-hidden rounded ring-2 ${confidenceRing(orphan.confidence)}`}>
          {orphan.s3Path ? (
            <S3Thumb s3Key={orphan.s3Path} apiToken={apiToken} size="h-16 w-16" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center bg-slate-100 text-slate-400">
              <span className="text-xs">?</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800" title={orphan.filename}>
            {orphan.filename}
          </p>
          <p className="text-xs text-slate-500">
            {dateStr} · <span className="font-mono">{orphan.immichPath.replace(/^\/usr\/src\/app\/upload\//, '')}</span>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${confidenceColor(orphan.confidence)}`}>
              {confidenceLabel(orphan.confidence)}
            </span>
            {orphan.s3Path && (
              <span className="truncate text-[10px] text-slate-400" title={orphan.s3Path}>
                → {orphan.s3Path}
              </span>
            )}
            {hasMultipleCandidates && (
              <button
                type="button"
                className="text-[10px] text-blue-500 underline"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? 'hide' : `${orphan.s3Candidates.length} candidates`}
              </button>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-shrink-0 gap-2">
          {orphan.s3Path && (
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                approved === true
                  ? 'bg-emerald-600 text-white'
                  : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
              }`}
              onClick={onApprove}
            >
              {approved === true ? '✓ Approved' : 'Approve'}
            </button>
          )}
          <button
            type="button"
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              approved === false
                ? 'bg-red-600 text-white'
                : 'bg-red-100 text-red-800 hover:bg-red-200'
            }`}
            onClick={onReject}
          >
            {approved === false ? '✓ Skip' : 'Skip'}
          </button>
        </div>
      </div>

      {/* Expanded: show all candidates */}
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-2 text-xs font-semibold text-slate-600">All S3 candidates:</p>
          <div className="grid gap-2">
            {orphan.s3Candidates.map((candidate) => (
              <div key={candidate} className="flex items-center gap-3">
                <S3Thumb s3Key={candidate} apiToken={apiToken} size="h-12 w-12" />
                <span className="min-w-0 flex-1 truncate text-xs font-mono text-slate-600" title={candidate}>
                  {candidate}
                </span>
                <button
                  type="button"
                  className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                    selectedCandidate === candidate
                      ? 'bg-blue-600 text-white'
                      : 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                  }`}
                  onClick={() => {
                    setSelectedCandidate(candidate);
                    onResolve(candidate);
                  }}
                >
                  {selectedCandidate === candidate ? 'Selected' : 'Use this'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function ImmichComparePage() {
  const apiToken = useApiToken();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<Filter>('all');
  const [decisions, setDecisions] = useState<Map<string, { approved: boolean; s3Path: string | null }>>(new Map);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set);

  // Fetch orphans
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['immich-orphans'],
    queryFn: fetchImmichOrphans,
    staleTime: 5 * 60_000,
  });

  // Batch remap mutation
  const remapMut = useMutation({
    mutationFn: async () => {
      const remaps: { assetId: string; newPath: string }[] = [];
      for (const [assetId, decision] of decisions) {
        if (decision.approved && decision.s3Path) {
          remaps.push({ assetId, newPath: `${S3_MOUNT}/${decision.s3Path}` });
        }
      }
      if (remaps.length === 0) throw new Error('No approved remaps to apply');

      // Apply in batches of 200
      let totalApplied = 0;
      for (let i = 0; i < remaps.length; i += 200) {
        const batch = remaps.slice(i, i + 200);
        const result = await remapImmichAssets(batch);
        totalApplied += result.applied;
      }
      return totalApplied;
    },
    onSuccess: (applied) => {
      const newApplied = new Set(appliedIds);
      for (const [assetId, d] of decisions) {
        if (d.approved) newApplied.add(assetId);
      }
      setAppliedIds(newApplied);
      alert(`Successfully remapped ${applied} assets.`);
    },
  });

  // Filter + sort
  const filteredOrphans = useMemo(() => {
    if (!data) return [];
    let list = data.orphans;
    if (filter !== 'all') {
      list = list.filter((o) => o.confidence === filter);
    }
    // Hide already applied
    list = list.filter((o) => !appliedIds.has(o.assetId));
    return list;
  }, [data, filter, appliedIds]);

  // Counts per confidence
  const counts = useMemo(() => {
    if (!data) return { all: 0, 'exact-date': 0, 'fuzzy-date': 0, 'single-candidate': 0, ambiguous: 0 };
    const c = { all: 0, 'exact-date': 0, 'fuzzy-date': 0, 'single-candidate': 0, ambiguous: 0 };
    for (const o of data.orphans) {
      if (appliedIds.has(o.assetId)) continue;
      c.all++;
      c[o.confidence]++;
    }
    return c;
  }, [data, appliedIds]);

  // Decision helpers
  const approvedCount = useMemo(() => {
    let n = 0;
    for (const [, d] of decisions) {
      if (d.approved) n++;
    }
    return n;
  }, [decisions]);

  const setDecision = useCallback((assetId: string, approved: boolean, s3Path: string | null) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(assetId, { approved, s3Path });
      return next;
    });
  }, []);

  // Batch approve all visible with matches
  const approveAllVisible = useCallback(() => {
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const o of filteredOrphans) {
        if (o.s3Path) {
          next.set(o.assetId, { approved: true, s3Path: o.s3Path });
        }
      }
      return next;
    });
  }, [filteredOrphans]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Immich → S3 Comparison</h1>
          <p className="text-sm text-slate-500">
            Review orphan Immich assets and approve remapping to S3 paths.{' '}
            <Link to="/catalog/dedup" className="text-blue-600 underline">
              Back to Dedup
            </Link>
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            {isLoading ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <Card className="border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error instanceof Error ? error.message : 'Failed to load orphans'}
        </Card>
      )}

      {/* Stats */}
      {data && (
        <Card className="flex flex-wrap gap-4 p-4 text-sm">
          <span>
            <strong>{data.totalAssets.toLocaleString()}</strong> total Immich assets
          </span>
          <span className="text-slate-300">|</span>
          <span>
            <strong>{counts.all.toLocaleString()}</strong> orphans
          </span>
          <span className="text-slate-300">|</span>
          <span className="text-emerald-700">
            <strong>{counts['exact-date']}</strong> exact
          </span>
          <span className="text-amber-700">
            <strong>{counts['fuzzy-date']}</strong> fuzzy
          </span>
          <span className="text-orange-700">
            <strong>{counts['single-candidate']}</strong> single
          </span>
          <span className="text-red-700">
            <strong>{counts.ambiguous}</strong> no match
          </span>
        </Card>
      )}

      {/* Filter tabs + batch actions */}
      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1">
            {(['all', 'exact-date', 'fuzzy-date', 'single-candidate', 'ambiguous'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  filter === f ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : confidenceLabel(f as MatchConfidence)} ({counts[f]})
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-emerald-100 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-200"
              onClick={approveAllVisible}
            >
              Approve all visible ({filteredOrphans.filter((o) => o.s3Path).length})
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                approvedCount > 0
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
              disabled={approvedCount === 0 || remapMut.isPending}
              onClick={() => remapMut.mutate()}
            >
              {remapMut.isPending
                ? 'Applying…'
                : `Apply ${approvedCount} remap${approvedCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {/* Mutation error */}
      {remapMut.error && (
        <Card className="border-red-200 bg-red-50 p-3 text-xs text-red-800">
          Remap failed: {remapMut.error instanceof Error ? remapMut.error.message : 'Unknown error'}
        </Card>
      )}

      {/* Loading state */}
      {isLoading && (
        <Card className="p-8 text-center text-slate-500">
          <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          Scanning Immich DB and matching against S3 catalog…
        </Card>
      )}

      {/* Orphan list */}
      {filteredOrphans.length > 0 && (
        <div className="space-y-2">
          {filteredOrphans.map((orphan) => {
            const decision = decisions.get(orphan.assetId);
            return (
              <OrphanRow
                key={orphan.assetId}
                orphan={orphan}
                apiToken={apiToken}
                approved={decision?.approved ?? null}
                onApprove={() => setDecision(orphan.assetId, true, orphan.s3Path)}
                onReject={() => setDecision(orphan.assetId, false, null)}
                onResolve={(s3Path) => setDecision(orphan.assetId, true, s3Path)}
              />
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {data && filteredOrphans.length === 0 && !isLoading && (
        <Card className="p-8 text-center text-slate-500">
          {appliedIds.size > 0
            ? `All done! ${appliedIds.size} assets remapped.`
            : 'No orphan assets found matching the current filter.'}
        </Card>
      )}
    </div>
  );
}
