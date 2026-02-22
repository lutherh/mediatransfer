import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchTransfers } from '@/lib/api';
import { Card } from '@/components/ui/card';

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border border-amber-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border border-blue-200',
  COMPLETED: 'bg-green-50 text-green-700 border border-green-200',
  FAILED: 'bg-red-50 text-red-700 border border-red-200',
  CANCELLED: 'bg-slate-100 text-slate-600 border border-slate-200',
};

export function TransfersListPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['transfers'],
    queryFn: fetchTransfers,
  });

  if (isLoading) {
    return <p>Loading transfers...</p>;
  }

  if (error) {
    return <p>Failed to load transfers.</p>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Transfers</h1>
      {data?.length ? (
        <Card className="p-0 overflow-hidden">
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
                        {job.status}
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
      ) : (
        <Card>
          <p className="text-slate-600">No transfer jobs yet.</p>
        </Card>
      )}
    </div>
  );
}
