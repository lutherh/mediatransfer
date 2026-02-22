import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchTransferDetail } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProgressBar } from '@/components/ui/progress-bar';

type TransferProgressStepProps = {
  jobId: string;
  totalItems: number;
  onStartNew: () => void;
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'text-amber-600' },
  IN_PROGRESS: { label: 'In Progress', color: 'text-blue-600' },
  COMPLETED: { label: 'Completed', color: 'text-green-600' },
  FAILED: { label: 'Failed', color: 'text-red-600' },
  CANCELLED: { label: 'Cancelled', color: 'text-slate-500' },
};

export function TransferProgressStep({ jobId, totalItems, onStartNew }: TransferProgressStepProps) {
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['transfer', jobId],
    queryFn: () => fetchTransferDetail(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
        return false;
      }
      return 2000;
    },
  });

  if (isLoading) {
    return (
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          <span className="text-sm text-slate-600">Loading transfer status...</span>
        </div>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Alert variant="error">Failed to load transfer status.</Alert>
        <Button onClick={() => navigate(`/transfers/${jobId}`)}>View Transfer Details</Button>
      </div>
    );
  }

  const { job, logs } = data;
  const statusInfo = STATUS_LABELS[job.status] ?? { label: job.status, color: 'text-slate-600' };
  const isFinished = job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED';

  return (
    <div className="space-y-4">
      {/* Status card */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Transfer Status</h2>
            <p className={`text-sm font-medium ${statusInfo.color}`}>{statusInfo.label}</p>
          </div>
          {job.status === 'COMPLETED' && (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <span className="text-2xl">✓</span>
            </div>
          )}
          {job.status === 'FAILED' && (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <span className="text-2xl">✗</span>
            </div>
          )}
          {(job.status === 'IN_PROGRESS' || job.status === 'PENDING') && (
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-blue-600" />
          )}
        </div>

        <ProgressBar value={job.progress} label="Transfer progress" />

        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-2xl font-bold text-slate-900">{totalItems}</p>
            <p className="text-xs text-slate-500">Total Items</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-2xl font-bold text-slate-900">{Math.round(job.progress * 100)}%</p>
            <p className="text-xs text-slate-500">Progress</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className={`text-2xl font-bold ${statusInfo.color}`}>{statusInfo.label}</p>
            <p className="text-xs text-slate-500">Status</p>
          </div>
        </div>
      </Card>

      {/* Completed/Failed alerts */}
      {job.status === 'COMPLETED' && (
        <Alert variant="success">
          Transfer completed successfully! All {totalItems} items have been transferred.
        </Alert>
      )}

      {job.status === 'FAILED' && (
        <Alert variant="error">
          Transfer failed. Check the logs below for details.
        </Alert>
      )}

      {/* Logs */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-700">Transfer Logs</h3>
        {logs.length > 0 ? (
          <div className="max-h-48 overflow-y-auto space-y-1">
            {logs.map((log) => (
              <div
                key={log.id}
                className={`rounded px-2 py-1 text-xs font-mono ${
                  log.level === 'ERROR'
                    ? 'bg-red-50 text-red-700'
                    : log.level === 'WARN'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-slate-50 text-slate-600'
                }`}
              >
                <span className="font-semibold">[{log.level}]</span> {log.message}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            {isFinished ? 'No logs recorded.' : 'Waiting for logs...'}
          </p>
        )}
      </Card>

      {/* Actions */}
      <div className="flex gap-3">
        {isFinished && (
          <Button onClick={onStartNew}>
            Start New Transfer
          </Button>
        )}
        <Button
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          onClick={() => navigate(`/transfers/${jobId}`)}
        >
          View Full Details
        </Button>
        <Button
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          onClick={() => navigate('/')}
        >
          All Transfers
        </Button>
      </div>
    </div>
  );
}
