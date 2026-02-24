import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTransferDetail, pauseTransfer, resumeTransfer, retryTransferItem, queueAllTransferItems, type TransferLog } from '@/lib/api';
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
  const refreshTransferQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['transfer', id] }),
      queryClient.invalidateQueries({ queryKey: ['transfers'] }),
    ]);
  };

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
    onSuccess: refreshTransferQueries,
  });

  const resumeMutation = useMutation({
    mutationFn: resumeTransfer,
    onSuccess: refreshTransferQueries,
  });

  const retryItemMutation = useMutation({
    mutationFn: ({ transferId, mediaItemId }: { transferId: string; mediaItemId: string }) =>
      retryTransferItem(transferId, mediaItemId),
    onSuccess: refreshTransferQueries,
  });

  const retryAllItemsMutation = useMutation({
    mutationFn: queueAllTransferItems,
    onSuccess: refreshTransferQueries,
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
  const isActionPending =
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    retryItemMutation.isPending ||
    retryAllItemsMutation.isPending;
  const statusLabel = data.job.status === 'CANCELLED' ? 'PAUSED' : data.job.status;
  const itemProgress = deriveItemProgress(data.job.keys ?? [], data.logs, data.job.progress);
  const canRetryItems =
    data.job.status === 'CANCELLED' ||
    data.job.status === 'FAILED' ||
    data.job.status === 'IN_PROGRESS';
  const retryableItemsCount = itemProgress.items.filter(
    (item) => item.status === 'FAILED' || item.status === 'PENDING',
  ).length;

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">Transfer Detail</h1>
      <div className="flex flex-wrap gap-2 sm:gap-3">
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
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 hidden sm:inline-flex"
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
      {retryItemMutation.isError ? (
        <p className="text-sm text-red-600">
          {retryItemMutation.error instanceof Error
            ? retryItemMutation.error.message
            : 'Failed to retry transfer item.'}
        </p>
      ) : null}
      {retryAllItemsMutation.isError ? (
        <p className="text-sm text-red-600">
          {retryAllItemsMutation.error instanceof Error
            ? retryAllItemsMutation.error.message
            : 'Failed to queue all items.'}
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
          <p className="font-medium text-sm sm:text-base break-all">{data.job.sourceProvider} → {data.job.destProvider}</p>
          <p>
            <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[data.job.status] ?? 'bg-slate-100 text-slate-700 border border-slate-200'}`}>
              {statusLabel}
            </span>
          </p>
          <ProgressBar value={itemProgress.overallProgress} label="Progress" />
          <p className="text-sm text-slate-600">
            {itemProgress.completedItems} / {itemProgress.totalItems} items completed ({Math.round(itemProgress.overallProgress * 100)}%)
          </p>
        </div>
      </Card>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Items</h2>
          {canRetryItems ? (
            <Button
              onClick={() => retryAllItemsMutation.mutate(id)}
              disabled={isActionPending || retryableItemsCount === 0}
            >
              Queue all items ({retryableItemsCount})
            </Button>
          ) : null}
        </div>
        {itemProgress.items.length ? (
          itemProgress.items.map((item) => (
            <Card key={item.key} className="py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium text-slate-900">{item.key}</p>
                  <p className="text-xs text-slate-600">
                    {item.status} · {Math.round(item.progress * 100)}% · attempts: {item.attempts}
                  </p>
                  {item.status === 'IN_PROGRESS' || item.status === 'RETRYING' ? (
                    <div className="flex items-center gap-2 text-xs text-blue-700">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" aria-hidden="true" />
                      {item.status === 'RETRYING' ? 'Retrying item…' : 'Processing item…'}
                    </div>
                  ) : null}
                  {item.lastError ? (
                    <p className="text-xs text-red-600 break-all">{item.lastError}</p>
                  ) : null}
                </div>
                {canRetryItems && (item.status === 'FAILED' || item.status === 'PENDING') ? (
                  <Button
                    className="self-start sm:self-auto shrink-0"
                    onClick={() => retryItemMutation.mutate({ transferId: id, mediaItemId: item.key })}
                    disabled={isActionPending}
                  >
                    Retry item
                  </Button>
                ) : null}
              </div>
            </Card>
          ))
        ) : (
          <Card>
            <p className="text-sm text-slate-600">No item-level details available yet.</p>
          </Card>
        )}
      </div>

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

type ItemStatus = 'PENDING' | 'IN_PROGRESS' | 'RETRYING' | 'FAILED' | 'COMPLETED' | 'SKIPPED';

type ItemProgress = {
  key: string;
  status: ItemStatus;
  progress: number;
  attempts: number;
  lastError?: string;
};

function deriveItemProgress(keys: string[], logs: TransferLog[], fallbackProgress: number): {
  items: ItemProgress[];
  totalItems: number;
  completedItems: number;
  overallProgress: number;
} {
  const orderedKeys: string[] = [];
  const keySet = new Set<string>();
  const addKey = (key: string) => {
    if (!keySet.has(key)) {
      keySet.add(key);
      orderedKeys.push(key);
    }
  };

  for (const key of keys) {
    addKey(key);
  }

  for (const log of logs) {
    const meta = asRecord(log.meta);
    const mediaItemId = typeof meta?.mediaItemId === 'string' ? meta.mediaItemId : undefined;
    if (mediaItemId) {
      addKey(mediaItemId);
    }
  }

  const itemMap = new Map<string, ItemProgress>(
    orderedKeys.map((key) => [
      key,
      {
        key,
        status: 'PENDING' as const,
        progress: 0,
        attempts: 0,
      },
    ]),
  );

  for (const log of logs) {
    const meta = asRecord(log.meta);
    const mediaItemId = typeof meta?.mediaItemId === 'string' ? meta.mediaItemId : undefined;
    if (!mediaItemId) {
      continue;
    }

    const item = itemMap.get(mediaItemId);
    if (!item) {
      continue;
    }

    const attempt = readNumber(meta, 'attempt') ?? readNumber(meta, 'attempts');
    if (attempt !== undefined) {
      item.attempts = Math.max(item.attempts, attempt);
    } else if (item.attempts === 0) {
      item.attempts = 1;
    }

    const status = readString(meta, 'status');
    const maxAttempts = readNumber(meta, 'maxAttempts') ?? 3;

    if (status === 'RETRYING') {
      item.status = 'RETRYING';
      const currentAttempt = readNumber(meta, 'attempt') ?? item.attempts;
      item.progress = Math.max(item.progress, Math.min(0.95, currentAttempt / maxAttempts));
      continue;
    }

    if (status === 'IN_PROGRESS') {
      item.status = 'IN_PROGRESS';
      const currentAttempt = readNumber(meta, 'attempt') ?? Math.max(item.attempts, 1);
      item.progress = Math.max(item.progress, Math.min(0.9, currentAttempt / maxAttempts));
      continue;
    }
    if (status === 'FAILED' || log.message.startsWith('Item failed ')) {
      item.status = 'FAILED';
      item.progress = 0;
      const error = readString(meta, 'error');
      if (error) {
        item.lastError = error;
      }
      continue;
    }

    if (
      status === 'COMPLETED' ||
      status === 'SKIPPED' ||
      log.message.startsWith('Uploaded ') ||
      log.message.startsWith('Skipped existing ')
    ) {
      item.status = status === 'SKIPPED' || log.message.startsWith('Skipped existing ') ? 'SKIPPED' : 'COMPLETED';
      item.progress = 1;
      item.lastError = undefined;
    }
  }

  const items = orderedKeys.map((key) => itemMap.get(key)).filter((item): item is ItemProgress => Boolean(item));
  const sortedItems = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const rankDiff = getItemSortRank(left.item.status) - getItemSortRank(right.item.status);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.item);
  const completedItems = items.filter((item) => item.status === 'COMPLETED' || item.status === 'SKIPPED').length;
  const totalItems = items.length;
  const overallProgress = totalItems > 0 ? completedItems / totalItems : fallbackProgress;

  return {
    items: sortedItems,
    totalItems,
    completedItems,
    overallProgress,
  };
}

function getItemSortRank(status: ItemStatus): number {
  if (status === 'IN_PROGRESS' || status === 'RETRYING') {
    return 0;
  }
  if (status === 'PENDING') {
    return 1;
  }
  if (status === 'FAILED') {
    return 2;
  }
  return 3;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
