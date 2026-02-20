import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchTransfers } from '@/lib/api';
import { Card } from '@/components/ui/card';

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
        data.map((job) => (
          <Card key={job.id} className="flex items-center justify-between">
            <div>
              <p className="font-medium">{job.sourceProvider} → {job.destProvider}</p>
              <p className="text-sm text-slate-600">Status: {job.status}</p>
            </div>
            <Link className="text-sm font-medium text-blue-600 hover:underline" to={`/transfers/${job.id}`}>
              View details
            </Link>
          </Card>
        ))
      ) : (
        <Card>
          <p className="text-slate-600">No transfer jobs yet.</p>
        </Card>
      )}
    </div>
  );
}
