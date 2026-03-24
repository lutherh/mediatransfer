import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createTransfer, checkTransferDuplicates, type PickedMediaItem, type DuplicateCheckResult } from '@/lib/api';
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

  // Check for duplicates against S3
  const duplicateCheck = useQuery({
    queryKey: ['check-duplicates', items.map((i) => i.id).join(',')],
    queryFn: () => checkTransferDuplicates(
      items.map((item) => ({
        id: item.id,
        filename: item.filename,
        createTime: item.createTime,
      })),
    ),
    staleTime: 60_000,
  });

  const duplicateIds = new Set(
    duplicateCheck.data?.items.filter((r) => r.exists).map((r) => r.id) ?? [],
  );
  const newItemCount = items.length - duplicateIds.size;

  const transferMutation = useMutation({
    mutationFn: createTransfer,
    onSuccess: (result) => {
      onTransferCreated(result.job.id);
    },
  });

  const handleStartTransfer = () => {
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

        {/* Duplicate warning */}
        {duplicateCheck.isSuccess && duplicateIds.size > 0 && (
          <Alert variant="warning">
            <strong>{duplicateIds.size} of {items.length} item{items.length !== 1 ? 's' : ''} already exist{duplicateIds.size === 1 ? 's' : ''} in cloud storage</strong>
            {' '}and will be skipped during transfer.
            {newItemCount > 0
              ? ` ${newItemCount} new item${newItemCount !== 1 ? 's' : ''} will be uploaded.`
              : ' All selected items are already uploaded — nothing new to transfer.'}
          </Alert>
        )}

        {duplicateCheck.isSuccess && duplicateIds.size === 0 && (
          <Alert variant="success">
            All {items.length} item{items.length !== 1 ? 's are' : ' is'} new — no duplicates found.
          </Alert>
        )}

        {duplicateCheck.isLoading && (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Checking for duplicates in cloud storage...
          </div>
        )}

        {duplicateCheck.isError && (
          <Alert variant="error">
            Could not check for duplicates: {duplicateCheck.error?.message ?? 'Unknown error'}
          </Alert>
        )}

        {/* Summary */}
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 uppercase tracking-wide">Transfer Summary</h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
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
            {duplicateCheck.isSuccess && (
              <>
                <div>
                  <dt className="text-slate-500">New items</dt>
                  <dd className="font-medium text-green-600">{newItemCount}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Already in cloud</dt>
                  <dd className="font-medium text-amber-600">{duplicateIds.size}</dd>
                </div>
              </>
            )}
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
          <div className="mt-2 max-h-48 overflow-y-auto overflow-x-auto rounded-lg border border-slate-100 bg-slate-50 p-2">
            <table className="w-full text-xs min-w-[400px]">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="pb-1 pr-2">#</th>
                  <th className="pb-1 pr-2">Filename</th>
                  <th className="pb-1 pr-2">Type</th>
                  <th className="pb-1 pr-2">Date</th>
                  <th className="pb-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const isDuplicate = duplicateIds.has(item.id);
                  return (
                    <tr key={item.id} className={`border-t border-slate-100 ${isDuplicate ? 'opacity-50' : ''}`}>
                      <td className="py-1 pr-2 text-slate-400">{index + 1}</td>
                      <td className="py-1 pr-2 font-medium truncate max-w-[200px]">
                        {item.filename ?? 'Unknown'}
                      </td>
                      <td className="py-1 pr-2 text-slate-500">{item.mimeType ?? '—'}</td>
                      <td className="py-1 pr-2 text-slate-500">
                        {item.createTime ? new Date(item.createTime).toLocaleDateString() : '—'}
                      </td>
                      <td className="py-1">
                        {duplicateCheck.isSuccess ? (
                          isDuplicate
                            ? <span className="text-amber-600 font-medium">Already uploaded</span>
                            : <span className="text-green-600 font-medium">New</span>
                        ) : duplicateCheck.isLoading ? (
                          <span className="text-slate-400">Checking...</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
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

      <div className="flex flex-wrap gap-2 sm:gap-3">
        <Button
          onClick={handleStartTransfer}
          disabled={transferMutation.isPending || duplicateCheck.isLoading}
        >
          {transferMutation.isPending
            ? 'Starting Transfer...'
            : duplicateCheck.isSuccess && duplicateIds.size === items.length
              ? 'All Items Already Uploaded'
              : duplicateCheck.isSuccess && duplicateIds.size > 0
                ? `Start Transfer (${newItemCount} new item${newItemCount !== 1 ? 's' : ''})`
                : `Start Transfer (${items.length} items)`}
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
