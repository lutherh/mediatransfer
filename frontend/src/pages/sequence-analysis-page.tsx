import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { fetchSequenceAnalysis, type SequenceGroup, type SequenceAnalysis, type ArchiveDetail } from '@/lib/api';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatArchiveName(prefix: string, exportNumber: number, seq: number, ext: string): string {
  return `${prefix}-${exportNumber}-${String(seq).padStart(3, '0')}${ext}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── Summary cards ──────────────────────────────────────────────────────────

function SummaryCards({ analysis }: { analysis: SequenceAnalysis }) {
  const totalGroups = analysis.groups.length;
  const completeGroups = analysis.groups.filter((g) => g.isComplete).length;
  const incompleteGroups = totalGroups - completeGroups;
  const totalMissing = analysis.groups.reduce((sum, g) => sum + g.missing.length, 0);
  const totalSizeBytes = analysis.groups.reduce((sum, g) => sum + g.totalSizeBytes, 0);
  const totalEntries = analysis.groups.reduce((sum, g) => sum + g.totalEntries, 0);
  const totalFailed = analysis.groups.reduce((sum, g) => sum + g.totalFailed, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="text-center">
          <div className="text-2xl font-bold text-slate-900">{analysis.totalArchives}</div>
          <div className="text-xs text-slate-500">Total Archives</div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-bold text-green-600">{completeGroups}</div>
          <div className="text-xs text-slate-500">Complete Sets</div>
        </Card>
        <Card className="text-center">
          <div className={`text-2xl font-bold ${incompleteGroups > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
            {incompleteGroups}
          </div>
          <div className="text-xs text-slate-500">Incomplete Sets</div>
        </Card>
        <Card className="text-center">
          <div className={`text-2xl font-bold ${totalMissing > 0 ? 'text-red-600' : 'text-slate-400'}`}>
            {totalMissing}
          </div>
          <div className="text-xs text-slate-500">Missing Parts</div>
        </Card>
      </div>
      {(totalSizeBytes > 0 || totalEntries > 0) && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="text-center">
            <div className="text-lg font-bold text-slate-800">{formatBytes(totalSizeBytes)}</div>
            <div className="text-xs text-slate-500">Total Archive Size</div>
          </Card>
          <Card className="text-center">
            <div className="text-lg font-bold text-slate-800">{totalEntries.toLocaleString()}</div>
            <div className="text-xs text-slate-500">Total Entries</div>
          </Card>
          <Card className="text-center">
            <div className={`text-lg font-bold ${totalFailed > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {totalFailed > 0 ? totalFailed.toLocaleString() : 'None'}
            </div>
            <div className="text-xs text-slate-500">Failed Entries</div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Sequence number visualisation ──────────────────────────────────────────

function SequenceGrid({ group, archiveDetails }: { group: SequenceGroup; archiveDetails: Record<string, ArchiveDetail> }) {
  const presentSet = new Set(group.present);

  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: group.maxSeen }, (_, i) => {
        const seq = i + 1;
        const isPresent = presentSet.has(seq);
        const archiveName = formatArchiveName(group.prefix, group.exportNumber, seq, group.extension);
        const detail = archiveDetails[archiveName];
        const status = detail?.status;

        let bgClass = 'bg-red-100 border-red-300 text-red-700'; // missing
        let title = `#${seq} — MISSING`;

        if (isPresent) {
          const detailParts: string[] = [];
          if (detail?.archiveSizeBytes) detailParts.push(formatBytes(detail.archiveSizeBytes));
          if (detail?.entryCount) detailParts.push(`${detail.entryCount} entries`);
          if (detail?.uploadedCount) detailParts.push(`${detail.uploadedCount} uploaded`);
          if (detail?.failedCount) detailParts.push(`${detail.failedCount} failed`);
          if (detail?.error) detailParts.push(`Error: ${detail.error}`);
          const detailStr = detailParts.length > 0 ? `\n${detailParts.join(' · ')}` : '';

          if (status === 'completed') {
            bgClass = 'bg-green-100 border-green-300 text-green-700';
            title = `#${seq} — Completed${detailStr}`;
          } else if (status === 'failed') {
            bgClass = 'bg-red-100 border-red-300 text-red-700';
            title = `#${seq} — Failed${detailStr}`;
          } else if (status === 'uploading' || status === 'extracting') {
            bgClass = 'bg-blue-100 border-blue-300 text-blue-700';
            title = `#${seq} — ${status.charAt(0).toUpperCase() + status.slice(1)}${detailStr}`;
          } else {
            bgClass = 'bg-slate-100 border-slate-300 text-slate-600';
            title = `#${seq} — ${status ?? 'Present'}${detailStr}`;
          }
        }

        return (
          <span
            key={seq}
            title={title}
            className={`inline-flex h-8 w-8 items-center justify-center rounded border text-xs font-mono font-medium ${bgClass}`}
          >
            {seq}
          </span>
        );
      })}
    </div>
  );
}

// ── Group card ─────────────────────────────────────────────────────────────

function GroupCard({ group, archiveDetails }: { group: SequenceGroup; archiveDetails: Record<string, ArchiveDetail> }) {
  return (
    <Card className="space-y-3">
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900 text-sm break-all">
            {group.prefix}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {group.extension} &middot; Export #{group.exportNumber} &middot; Found: {group.present.length}/{group.maxSeen}
          </p>
        </div>
        <div>
          {group.isComplete ? (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
              Complete
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
              {group.missing.length} missing
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      {(group.totalSizeBytes > 0 || group.totalEntries > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          {group.totalSizeBytes > 0 && (
            <span>Size: <span className="font-medium text-slate-700">{formatBytes(group.totalSizeBytes)}</span></span>
          )}
          {group.totalEntries > 0 && (
            <span>Entries: <span className="font-medium text-slate-700">{group.totalEntries.toLocaleString()}</span></span>
          )}
          {group.totalUploaded > 0 && (
            <span>Uploaded: <span className="font-medium text-green-700">{group.totalUploaded.toLocaleString()}</span></span>
          )}
          {group.totalSkipped > 0 && (
            <span>Skipped: <span className="font-medium text-slate-600">{group.totalSkipped.toLocaleString()}</span></span>
          )}
          {group.totalFailed > 0 && (
            <span>Failed: <span className="font-medium text-red-600">{group.totalFailed.toLocaleString()}</span></span>
          )}
        </div>
      )}

      {/* Sequence grid */}
      <SequenceGrid group={group} archiveDetails={archiveDetails} />

      {/* Missing list */}
      {group.missing.length > 0 && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
          <p className="text-xs font-medium text-red-800 mb-1">Missing archives:</p>
          <div className="flex flex-wrap gap-1">
            {group.missing.map((seq) => (
              <code key={seq} className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                {formatArchiveName(group.prefix, group.exportNumber, seq, group.extension)}
              </code>
            ))}
          </div>
        </div>
      )}

      {/* Errors */}
      {group.errors.length > 0 && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
          <p className="text-xs font-medium text-red-800 mb-1">Processing errors:</p>
          <ul className="text-xs text-red-700 list-disc pl-4 space-y-0.5">
            {group.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ── Legend ──────────────────────────────────────────────────────────────────

function Legend() {
  const items = [
    { color: 'bg-green-100 border-green-300', label: 'Completed' },
    { color: 'bg-blue-100 border-blue-300', label: 'In progress' },
    { color: 'bg-slate-100 border-slate-300', label: 'Present' },
    { color: 'bg-red-100 border-red-300', label: 'Missing / Failed' },
  ];

  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-600">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-3 w-3 rounded border ${item.color}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function SequenceAnalysisPage(): ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sequence-analysis'],
    queryFn: fetchSequenceAnalysis,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  return (
    <div className="space-y-4">
      {/* Breadcrumb / back link */}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link to="/takeout" className="hover:text-slate-700 underline">
          Takeout
        </Link>
        <span>/</span>
        <span className="text-slate-900 font-medium">Sequence Analysis</span>
      </div>

      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold text-slate-900">Archive Sequence Analysis</h1>
      </div>
      <p className="text-sm text-slate-600">
        Checks whether any parts are missing from your Google Takeout archive sets.
        Each set shares a timestamp prefix and export number.
      </p>

      {isLoading && (
        <Card className="py-8 text-center text-sm text-slate-500">
          Loading archive data…
        </Card>
      )}

      {error && (
        <Alert variant="error">
          Failed to load sequence analysis: {error instanceof Error ? error.message : 'Unknown error'}
        </Alert>
      )}

      {data && (
        <div className="space-y-4">
          <SummaryCards analysis={data} />

          <Legend />

          {data.groups.length === 0 && (
            <Card className="py-8 text-center text-sm text-slate-500">
              No takeout archives found. Archives will appear here once you start importing.
            </Card>
          )}

          {/* Incomplete groups first */}
          {data.groups.filter((g) => !g.isComplete).length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-amber-700">Incomplete Sets</h2>
              {data.groups
                .filter((g) => !g.isComplete)
                .map((g) => (
                  <GroupCard
                    key={`${g.prefix}-${g.exportNumber}`}
                    group={g}
                    archiveDetails={data.archiveDetails}
                  />
                ))}
            </div>
          )}

          {/* Complete groups */}
          {data.groups.filter((g) => g.isComplete).length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-green-700">Complete Sets</h2>
              {data.groups
                .filter((g) => g.isComplete)
                .map((g) => (
                  <GroupCard
                    key={`${g.prefix}-${g.exportNumber}`}
                    group={g}
                    archiveDetails={data.archiveDetails}
                  />
                ))}
            </div>
          )}

          {/* Unrecognised archives */}
          {data.unrecognised.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-700">Unrecognised Archives</h2>
              <Card className="space-y-1">
                <p className="text-xs text-slate-500">
                  These archive names didn't match the expected Google Takeout naming pattern:
                </p>
                <div className="flex flex-wrap gap-1">
                  {data.unrecognised.map((name) => (
                    <code key={name} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {name}
                    </code>
                  ))}
                </div>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
