import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { createTransfer } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function NewTransferPage() {
  const navigate = useNavigate();
  const [sourceProvider, setSourceProvider] = useState('google-photos');
  const [destProvider, setDestProvider] = useState('scaleway');
  const [keys, setKeys] = useState('');

  const mutation = useMutation({
    mutationFn: createTransfer,
    onSuccess: (result) => {
      navigate(`/transfers/${result.job.id}`);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsedKeys = keys
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);

    mutation.mutate({
      sourceProvider,
      destProvider,
      keys: parsedKeys.length ? parsedKeys : undefined,
    });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">New Transfer</h1>
      <Card>
        <p className="text-sm font-medium text-slate-900">Before you create a transfer</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li>This page is an advanced/manual flow for provider + key based jobs.</li>
          <li>Most users should use <span className="font-semibold">Photo Transfer</span> or <span className="font-semibold">Takeout</span>.</li>
          <li>Leave keys empty to transfer all items available from the selected source.</li>
        </ul>
      </Card>
      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="mb-1 block text-sm font-medium">Source Provider</label>
            <input className="w-full rounded-md border border-slate-300 px-3 py-2" value={sourceProvider} onChange={(e) => setSourceProvider(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Destination Provider</label>
            <input className="w-full rounded-md border border-slate-300 px-3 py-2" value={destProvider} onChange={(e) => setDestProvider(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Keys (one per line)</label>
            <textarea className="min-h-24 w-full rounded-md border border-slate-300 px-3 py-2" value={keys} onChange={(e) => setKeys(e.target.value)} />
          </div>
          {mutation.isError && <p className="text-sm text-red-600">Failed to create transfer.</p>}
          <Button disabled={mutation.isPending} type="submit">
            {mutation.isPending ? 'Creating...' : 'Create Transfer'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
