import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTransferDetail } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function TransferDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['transfer', id],
    queryFn: () => fetchTransferDetail(id),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return <p>Loading transfer detail...</p>;
  }

  if (error || !data) {
    return <p>Failed to load transfer detail.</p>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Transfer Detail</h1>
      <div className="flex gap-3">
        <Button
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          onClick={() => navigate(-1)}
        >
          Back
        </Button>
        <Button
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          onClick={() => navigate('/')}
        >
          Photo Transfer
        </Button>
        <Button
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          onClick={() => navigate('/transfers')}
        >
          All Transfers
        </Button>
      </div>
      <Card>
        <p className="font-medium">{data.job.sourceProvider} → {data.job.destProvider}</p>
        <p className="text-sm text-slate-600">Status: {data.job.status}</p>
        <p className="text-sm text-slate-600">Progress: {Math.round(data.job.progress * 100)}%</p>
      </Card>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Logs</h2>
        {data.logs.length ? (
          data.logs.map((log) => (
            <Card key={log.id} className="py-3">
              <p className="text-sm font-medium">[{log.level}] {log.message}</p>
            </Card>
          ))
        ) : (
          <Card>
            <p className="text-sm text-slate-600">No logs available.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
