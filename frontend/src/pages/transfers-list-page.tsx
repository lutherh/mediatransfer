import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCloudUsage, fetchTransfers, type CloudUsageBucketType } from '@/lib/api';
import { Card } from '@/components/ui/card';

const BUCKET_TYPE_SETTING_KEY = 'cloudUsage.bucketType';

function readBucketTypeSetting(): CloudUsageBucketType {
  if (
    typeof window === 'undefined' ||
    !window.localStorage ||
    typeof window.localStorage.getItem !== 'function'
  ) {
    return 'standard';
  }

  const stored = window.localStorage.getItem(BUCKET_TYPE_SETTING_KEY);
  if (stored === 'standard' || stored === 'infrequent' || stored === 'archive') {
    return stored;
  }

  return 'standard';
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border border-amber-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border border-blue-200',
  COMPLETED: 'bg-green-50 text-green-700 border border-green-200',
  FAILED: 'bg-red-50 text-red-700 border border-red-200',
  CANCELLED: 'bg-slate-100 text-slate-600 border border-slate-200',
};

export function TransfersListPage() {
  const [bucketType, setBucketType] = useState<CloudUsageBucketType>(readBucketTypeSetting);

  const { data, isLoading, error } = useQuery({
    queryKey: ['transfers'],
    queryFn: fetchTransfers,
  });

  const cloudUsageQuery = useQuery({
    queryKey: ['cloud-usage', bucketType],
    queryFn: () => fetchCloudUsage(bucketType),
    retry: false,
    staleTime: 30_000,
  });

  const handleBucketTypeChange = (value: CloudUsageBucketType) => {
    setBucketType(value);
    if (
      typeof window !== 'undefined' &&
      window.localStorage &&
      typeof window.localStorage.setItem === 'function'
    ) {
      window.localStorage.setItem(BUCKET_TYPE_SETTING_KEY, value);
    }
  };

  if (isLoading) {
    return <p>Loading transfers...</p>;
  }

  if (error) {
    return <p>Failed to load transfers.</p>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">Transfers</h1>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-900">Cloud usage (S3)</p>
            <p className="text-xs text-slate-600">Simple storage cost overview. Open Costs tab for detailed estimate.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-slate-700">
              Bucket type
              <select
                className="ml-2 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                value={bucketType}
                onChange={(event) => handleBucketTypeChange(event.target.value as CloudUsageBucketType)}
              >
                <option value="standard">Standard</option>
                <option value="infrequent">Infrequent</option>
                <option value="archive">Archive</option>
              </select>
            </label>
            <Link className="text-xs font-medium text-blue-600 hover:underline" to="/costs">
              Detailed costs
            </Link>
          </div>
        </div>

        {cloudUsageQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-600">Loading cloud usage...</p>
        ) : cloudUsageQuery.isError ? (
          <p className="mt-3 text-sm text-amber-700">
            {cloudUsageQuery.error instanceof Error ? cloudUsageQuery.error.message : 'Cloud usage unavailable.'}
          </p>
        ) : cloudUsageQuery.data ? (
          <div className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-4">
            <p><span className="font-medium">Uploaded:</span> {cloudUsageQuery.data.totalGB.toFixed(2)} GB</p>
            <p><span className="font-medium">Objects:</span> {cloudUsageQuery.data.totalObjects.toLocaleString()}</p>
            <p><span className="font-medium">Monthly:</span> ${cloudUsageQuery.data.estimatedMonthlyCost.toFixed(2)} / mo</p>
            <p><span className="font-medium">Rate:</span> ${cloudUsageQuery.data.pricing.pricePerGBMonthly.toFixed(4)} / GB</p>
          </div>
        ) : null}
      </Card>

      {data?.length ? (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block p-0 overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50 text-slate-600 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">ID</th>
                    <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">Source</th>
                    <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">Destination</th>
                    <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">Status</th>
                    <th className="px-3 py-2 text-right font-semibold border-b border-slate-200">Progress</th>
                    <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">Created</th>
                    <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((job) => (
                    <tr key={job.id} className="odd:bg-white even:bg-slate-50/40 hover:bg-blue-50/40">
                      <td className="px-3 py-2 border-b border-slate-100 font-mono text-xs text-slate-700">
                        {job.id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-slate-800">{job.sourceProvider}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-slate-800">{job.destProvider}</td>
                      <td className="px-3 py-2 border-b border-slate-100">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[job.status] ?? 'bg-slate-100 text-slate-700 border border-slate-200'}`}>
                          {job.status === 'CANCELLED' ? 'PAUSED' : job.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums text-slate-700">
                        {Math.round(job.progress * 100)}%
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-slate-600">
                        {new Date(job.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100">
                        <Link className="text-xs font-medium text-blue-600 hover:underline" to={`/transfers/${job.id}`}>
                          View details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile card list */}
          <div className="md:hidden space-y-3">
            {data.map((job) => (
              <Link key={job.id} to={`/transfers/${job.id}`} className="block">
                <Card className="space-y-2 active:bg-slate-50 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[job.status] ?? 'bg-slate-100 text-slate-700 border border-slate-200'}`}>
                      {job.status === 'CANCELLED' ? 'PAUSED' : job.status}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-700">
                      {Math.round(job.progress * 100)}%
                    </span>
                  </div>
                  <p className="text-sm text-slate-800">
                    {job.sourceProvider} → {job.destProvider}
                  </p>
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-mono">{job.id.slice(0, 8)}</span>
                    <span>{new Date(job.createdAt).toLocaleDateString()}</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </>
      ) : (
        <Card>
          <p className="text-slate-600">No transfer jobs yet.</p>
        </Card>
      )}
    </div>
  );
}
