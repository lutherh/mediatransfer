import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { fetchTakeoutStatus } from '@/lib/api';

export function TakeoutProgressPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['takeout-status'],
    queryFn: fetchTakeoutStatus,
    refetchInterval: 3000,
  });

  if (isLoading) {
    return <p>Loading Takeout progress...</p>;
  }

  if (error || !data) {
    return <p>Failed to load Takeout progress.</p>;
  }

  const progressPercent = Math.round(data.progress * 100);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Takeout Transfer Progress</h1>

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">Overall progress</p>
          <p className="text-sm font-semibold text-slate-900">{progressPercent}%</p>
        </div>
        <div className="h-3 w-full rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-slate-900 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <p className="text-xs text-slate-500">Updated at: {formatDateTime(data.stateUpdatedAt)}</p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Total" value={data.counts.total} />
        <MetricCard label="Processed" value={data.counts.processed} />
        <MetricCard label="Pending" value={data.counts.pending} />
        <MetricCard label="Uploaded" value={data.counts.uploaded} />
        <MetricCard label="Skipped" value={data.counts.skipped} />
        <MetricCard label="Failed" value={data.counts.failed} />
      </div>

      <Card className="space-y-2">
        <p className="text-sm font-medium text-slate-900">Current files</p>
        <p className="text-xs text-slate-500 break-all">Manifest: {data.paths.manifestPath}</p>
        <p className="text-xs text-slate-500 break-all">State: {data.paths.statePath}</p>
      </Card>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Recent failures</h2>
        {data.recentFailures.length ? (
          data.recentFailures.map((failure) => (
            <Card key={`${failure.key}-${failure.updatedAt}`} className="space-y-1 py-3">
              <p className="text-sm font-medium text-slate-900 break-all">{failure.key}</p>
              <p className="text-xs text-slate-600">Attempts: {failure.attempts}</p>
              <p className="text-xs text-slate-600">Updated: {formatDateTime(failure.updatedAt)}</p>
              {failure.error ? <p className="text-xs text-red-600 break-all">{failure.error}</p> : null}
            </Card>
          ))
        ) : (
          <Card>
            <p className="text-sm text-slate-600">No failures recorded.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-2xl font-semibold text-slate-900">{value}</p>
    </Card>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  return date.toLocaleString();
}
