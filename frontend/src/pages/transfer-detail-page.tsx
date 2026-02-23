import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTransferDetail, pauseTransfer, resumeTransfer } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border border-amber-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border border-blue-200',
  COMPLETED: 'bg-green-50 text-green-700 border border-green-200',
  FAILED: 'bg-red-50 text-red-700 border border-red-200',
  CANCELLED: 'bg-slate-100 text-slate-600 border border-slate-200',
};

export function TransferDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['transfer', id],
    queryFn: () => fetchTransferDetail(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const transfer = query.state.data as { job?: { status?: string } } | undefined;
      const status = transfer?.job?.status;
      return status === 'IN_PROGRESS' || status === 'PENDING' ? 2_000 : false;
    },
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
  const canResume = data.job.status === 'CANCELLED' || data.job.status === 'FAILED';
  const isFailed = data.job.status === 'FAILED';
  const isTransferActive = data.job.status === 'PENDING' || data.job.status === 'IN_PROGRESS';
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
            {isFailed ? 'Retry transfer' : 'Resume transfer'}
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

      {isTransferActive ? (
        <Card className="flex items-start gap-3 border-blue-200 bg-blue-50">
          <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-blue-600" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-blue-900">Transfer in progress</p>
            <p className="text-sm text-blue-800">
              This transfer is running in the background. Progress updates automatically every few seconds.
            </p>
          </div>
        </Card>
      ) : null}

      {canResume ? (
        <Card className="border-amber-200 bg-amber-50">
          <p className="text-sm font-medium text-amber-900">{isFailed ? 'Transfer failed' : 'Transfer paused'}</p>
          <p className="text-sm text-amber-800">
            Click <span className="font-semibold">{isFailed ? 'Retry transfer' : 'Resume transfer'}</span> to continue from where it stopped.
          </p>
        </Card>
      ) : null}

      <Card>
        <div className="space-y-3">
          <p className="font-medium">{data.job.sourceProvider} → {data.job.destProvider}</p>
          <p>
            <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[data.job.status] ?? 'bg-slate-100 text-slate-700 border border-slate-200'}`}>
              {statusLabel}
            </span>
          </p>
          <ProgressBar value={data.job.progress} label="Progress" />
        </div>
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
