import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { fetchSettingsStatus } from '@/lib/api';
import { ScalewayStep } from './setup/scaleway-step';
import { GoogleStep } from './setup/google-step';
import { ImmichStep } from './setup/immich-step';

type SectionId = 'scaleway' | 'google' | 'immich';

function SectionHeader({
  title,
  configured,
  open,
  onToggle,
}: {
  title: string;
  configured: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between px-4 py-3 text-left"
      onClick={onToggle}
    >
      <span className="flex items-center gap-2 font-medium text-slate-900">
        {title}
        {configured ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">✓ Active</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">⚠ Setup required</span>
        )}
      </span>
      <span className="text-slate-400 text-sm">{open ? '▲' : '▼'}</span>
    </button>
  );
}

export function SettingsPage() {
  const [open, setOpen] = useState<SectionId | null>(null);
  const queryClient = useQueryClient();

  const { data: status, refetch } = useQuery({
    queryKey: ['settings-status'],
    queryFn: fetchSettingsStatus,
    staleTime: 30_000,
  });

  function toggle(id: SectionId) {
    setOpen((current) => (current === id ? null : id));
  }

  function handleSaved() {
    refetch().catch(() => {});
    queryClient.invalidateQueries({ queryKey: ['bootstrap-status'] });
    setOpen(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Configure integrations for S3-compatible Object Storage, Google Photos, and Immich.
        </p>
      </div>

      {status && !status.scaleway && !status.google && !status.immich && (
        <Alert variant="warning">
          No integrations configured yet. Expand a section below to get started.
        </Alert>
      )}

      {!status?.authTokenSet && (
        <Alert variant="warning">
          <strong>API_AUTH_TOKEN is not set.</strong> Set it in your <code>.env</code> file and
          restart to protect this server.
        </Alert>
      )}

      <div className="space-y-3">
        {/* Scaleway */}
        <Card className="overflow-hidden p-0">
          <SectionHeader
            title="Object Storage (S3)"
            configured={status?.scaleway ?? false}
            open={open === 'scaleway'}
            onToggle={() => toggle('scaleway')}
          />
          {open === 'scaleway' && (
            <div className="border-t border-slate-100 px-4 py-4">
              <ScalewayStep compact onSaved={handleSaved} />
            </div>
          )}
        </Card>

        {/* Google */}
        <Card className="overflow-hidden p-0">
          <SectionHeader
            title="Google Photos OAuth"
            configured={status?.google ?? false}
            open={open === 'google'}
            onToggle={() => toggle('google')}
          />
          {open === 'google' && (
            <div className="border-t border-slate-100 px-4 py-4">
              <GoogleStep compact onSaved={handleSaved} />
            </div>
          )}
        </Card>

        {/* Immich */}
        <Card className="overflow-hidden p-0">
          <SectionHeader
            title="Immich"
            configured={status?.immich ?? false}
            open={open === 'immich'}
            onToggle={() => toggle('immich')}
          />
          {open === 'immich' && (
            <div className="border-t border-slate-100 px-4 py-4">
              <ImmichStep compact onSaved={handleSaved} />
            </div>
          )}
        </Card>
      </div>

      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-xs text-blue-900 space-y-1">
        <p className="font-medium">Server startup settings (not editable here)</p>
        <p className="text-blue-800">These must be set in your <code className="bg-blue-100 px-1 rounded">.env</code> file and require a server restart to take effect:</p>
        <p><code className="bg-blue-100 px-1 rounded">DATABASE_URL</code> · <code className="bg-blue-100 px-1 rounded">ENCRYPTION_SECRET</code> · <code className="bg-blue-100 px-1 rounded">REDIS_*</code> · <code className="bg-blue-100 px-1 rounded">HOST</code> · <code className="bg-blue-100 px-1 rounded">PORT</code></p>
      </div>
    </div>
  );
}
