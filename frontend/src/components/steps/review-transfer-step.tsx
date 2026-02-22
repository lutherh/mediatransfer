import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createTransfer, type PickedMediaItem } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

type ReviewTransferStepProps = {
  items: PickedMediaItem[];
  sessionId: string;
  onTransferCreated: (jobId: string) => void;
  onBack: () => void;
};

export function ReviewTransferStep({ items, sessionId, onTransferCreated, onBack }: ReviewTransferStepProps) {
  const [destProvider] = useState('scaleway');

  const imageCount = items.filter((item) => item.mimeType?.startsWith('image/')).length;
  const videoCount = items.filter((item) => item.mimeType?.startsWith('video/')).length;
  const otherCount = items.length - imageCount - videoCount;

  const transferMutation = useMutation({
    mutationFn: createTransfer,
    onSuccess: (result) => {
      onTransferCreated(result.job.id);
    },
  });

  const handleStartTransfer = () => {
    // Use media item IDs as keys, with sessionId in sourceConfig
    const keys = items.map((item) => item.id);

    transferMutation.mutate({
      sourceProvider: 'google-photos',
      destProvider,
      keys,
      sourceConfig: {
        sessionId,
      },
    });
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Review Transfer</h2>
        <p className="text-sm text-slate-600">
          Review the details below and start the transfer when ready.
        </p>

        {/* Summary */}
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 uppercase tracking-wide">Transfer Summary</h3>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-500">Source</dt>
              <dd className="font-medium">Google Photos</dd>
            </div>
            <div>
              <dt className="text-slate-500">Destination</dt>
              <dd className="font-medium capitalize">{destProvider}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Total items</dt>
              <dd className="font-medium">{items.length}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Breakdown</dt>
              <dd className="font-medium">
                {[
                  imageCount > 0 && `${imageCount} photos`,
                  videoCount > 0 && `${videoCount} videos`,
                  otherCount > 0 && `${otherCount} other`,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Picker session</dt>
              <dd className="font-mono text-xs text-slate-600 truncate" title={sessionId}>
                {sessionId.slice(0, 16)}...
              </dd>
            </div>
          </dl>
        </div>

        {/* Items preview */}
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 hover:text-slate-900">
            View selected items ({items.length})
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="pb-1 pr-2">#</th>
                  <th className="pb-1 pr-2">Filename</th>
                  <th className="pb-1 pr-2">Type</th>
                  <th className="pb-1">Date</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="py-1 pr-2 text-slate-400">{index + 1}</td>
                    <td className="py-1 pr-2 font-medium truncate max-w-[200px]">
                      {item.filename ?? 'Unknown'}
                    </td>
                    <td className="py-1 pr-2 text-slate-500">{item.mimeType ?? '—'}</td>
                    <td className="py-1 text-slate-500">
                      {item.createTime ? new Date(item.createTime).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      {transferMutation.isError && (
        <Alert variant="error">
          Failed to create transfer: {transferMutation.error?.message ?? 'Unknown error'}
        </Alert>
      )}

      <div className="flex gap-3">
        <Button
          onClick={handleStartTransfer}
          disabled={transferMutation.isPending}
        >
          {transferMutation.isPending ? 'Starting Transfer...' : `Start Transfer (${items.length} items)`}
        </Button>
        <Button
          className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          onClick={onBack}
          disabled={transferMutation.isPending}
        >
          Back
        </Button>
      </div>
    </div>
  );
}
