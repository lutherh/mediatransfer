import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTransferDetail, pauseTransfer, resumeTransfer } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function TransferDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['transfer', id],
    queryFn: () => fetchTransferDetail(id),
    enabled: Boolean(id),
  });

  const pauseMutation = useMutation({
    mutationFn: pauseTransfer,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['transfer', id] }),
        queryClient.invalidateQueries({ queryKey: ['transfers'] }),
      ]);
    },
  });

  const resumeMutation = useMutation({
    mutationFn: resumeTransfer,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['transfer', id] }),
        queryClient.invalidateQueries({ queryKey: ['transfers'] }),
      ]);
    },
  });

  if (isLoading) {
    return <p>Loading transfer detail...</p>;
  }

  if (error || !data) {
    return <p>Failed to load transfer detail.</p>;
  }

  const canPause = data.job.status === 'PENDING' || data.job.status === 'IN_PROGRESS';
  const canResume = data.job.status === 'CANCELLED';
  const isActionPending = pauseMutation.isPending || resumeMutation.isPending;
  const statusLabel = data.job.status === 'CANCELLED' ? 'PAUSED' : data.job.status;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Transfer Detail</h1>
      <div className="flex gap-3">
        {canPause && (
          <Button
            className="bg-amber-600 text-white hover:bg-amber-700"
            onClick={() => pauseMutation.mutate(id)}
            disabled={isActionPending}
          >
            Pause transfer
          </Button>
        )}
        {canResume && (
          <Button
            onClick={() => resumeMutation.mutate(id)}
            disabled={isActionPending}
          >
            Resume transfer
          </Button>
        )}
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
      {(pauseMutation.isError || resumeMutation.isError) ? (
        <p className="text-sm text-red-600">
          {pauseMutation.error instanceof Error
            ? pauseMutation.error.message
            : resumeMutation.error instanceof Error
              ? resumeMutation.error.message
              : 'Failed to update transfer state.'}
        </p>
      ) : null}
      <Card>
        <p className="font-medium">{data.job.sourceProvider} → {data.job.destProvider}</p>
        <p className="text-sm text-slate-600">Status: {statusLabel}</p>
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
