import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  fetchTakeoutActionStatus,
  fetchTakeoutStatus,
  runTakeoutAction,
  type TakeoutAction,
} from '@/lib/api';

export function TakeoutProgressPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['takeout-status'],
    queryFn: fetchTakeoutStatus,
    refetchInterval: 3000,
  });

  const {
    data: actionStatus,
    isLoading: isLoadingActionStatus,
  } = useQuery({
    queryKey: ['takeout-action-status'],
    queryFn: fetchTakeoutActionStatus,
    refetchInterval: 1500,
  });

  const actionMutation = useMutation({
    mutationFn: runTakeoutAction,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['takeout-action-status'] }),
        queryClient.invalidateQueries({ queryKey: ['takeout-status'] }),
      ]);
    },
  });

  if (isLoading) {
    return <p>Loading Takeout progress...</p>;
  }

  if (error || !data) {
    return <p>Failed to load Takeout progress.</p>;
  }

  const progressPercent = Math.round(data.progress * 100);
  const isActionRunning = Boolean(actionStatus?.running);
  const lastOutput = actionStatus?.output ?? [];
  const hasManifest = data.counts.total > 0;
  const mutationErrorMessage = actionMutation.error instanceof Error
    ? actionMutation.error.message
    : 'Failed to start action.';
  const actionFailureReason = getActionFailureReason(actionStatus?.output ?? []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">Takeout Transfer Progress</h1>

      <Card className="space-y-2">
        <p className="text-sm font-medium text-slate-900">Where to put Google Takeout files</p>
        <p className="text-xs text-slate-600">Drop all downloaded Takeout archives (.zip/.tar/.tgz) into this folder:</p>
        <p className="text-xs text-slate-500 break-all font-mono">{data.paths.inputDir}</p>
        <p className="text-xs text-slate-600">Do not place files in the work directory — it is managed automatically by the app during scan/upload.</p>
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-medium text-slate-900">Run transfer actions (no terminal)</p>
        <p className="text-xs text-slate-600">Recommended order: <span className="font-semibold">Start Services → Scan → Upload → Verify</span>. Use Resume if interrupted.</p>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            action="start-services"
            isRunning={isActionRunning}
            isPending={actionMutation.isPending}
            onRun={actionMutation.mutate}
          >
            1) Start Services
          </ActionButton>
          <ActionButton
            action="scan"
            isRunning={isActionRunning}
            isPending={actionMutation.isPending}
            onRun={actionMutation.mutate}
          >
            2) Scan
          </ActionButton>
          <ActionButton
            action="upload"
            isRunning={isActionRunning}
            isPending={actionMutation.isPending}
            disabled={!hasManifest}
            onRun={actionMutation.mutate}
          >
            3) Upload
          </ActionButton>
          <ActionButton
            action="verify"
            isRunning={isActionRunning}
            isPending={actionMutation.isPending}
            disabled={!hasManifest}
            onRun={actionMutation.mutate}
          >
            4) Verify
          </ActionButton>
          <ActionButton
            action="resume"
            isRunning={isActionRunning}
            isPending={actionMutation.isPending}
            disabled={!hasManifest}
            onRun={actionMutation.mutate}
          >
            Resume
          </ActionButton>
        </div>
        {actionMutation.isError ? (
          <p className="text-xs text-red-600">{mutationErrorMessage}</p>
        ) : null}
        {!hasManifest ? (
          <p className="text-xs text-slate-600">No manifest found yet. Run <strong>Scan</strong> first.</p>
        ) : null}
        {isLoadingActionStatus ? null : (
          <div className="space-y-1">
            <p className="text-xs text-slate-600">
              {renderActionStatus(actionStatus?.action, isActionRunning, actionStatus?.success, actionStatus?.exitCode)}
            </p>
            {!isActionRunning && actionStatus?.success === false ? (
              <p className="text-xs text-red-600 break-all">
                {actionFailureReason ?? 'Action failed. See "Latest command output" below for details.'}
              </p>
            ) : null}
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">Overall progress</p>
          <p className="text-sm font-semibold text-slate-900">{progressPercent}%</p>
        </div>
        <div className="h-3 w-full rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-slate-900 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <p className="text-xs text-slate-500">Updated at: {formatDateTime(data.stateUpdatedAt)}</p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Total" value={data.counts.total} />
        <MetricCard label="Processed" value={data.counts.processed} />
        <MetricCard label="Pending" value={data.counts.pending} />
        <MetricCard label="Uploaded" value={data.counts.uploaded} />
        <MetricCard label="Skipped" value={data.counts.skipped} />
        <MetricCard label="Failed" value={data.counts.failed} />
      </div>

      <Card className="space-y-2">
        <p className="text-sm font-medium text-slate-900">Current files</p>
        <p className="text-xs text-slate-500 break-all">Work dir: {data.paths.workDir}</p>
        <p className="text-xs text-slate-500 break-all">Manifest: {data.paths.manifestPath}</p>
        <p className="text-xs text-slate-500 break-all">State: {data.paths.statePath}</p>
      </Card>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Recent failures</h2>
        {data.recentFailures.length ? (
          data.recentFailures.map((failure) => (
            <Card key={`${failure.key}-${failure.updatedAt}`} className="space-y-1 py-3">
              <p className="text-sm font-medium text-slate-900 break-all">{failure.key}</p>
              <p className="text-xs text-slate-600">Attempts: {failure.attempts}</p>
              <p className="text-xs text-slate-600">Updated: {formatDateTime(failure.updatedAt)}</p>
              {failure.error ? <p className="text-xs text-red-600 break-all">{failure.error}</p> : null}
            </Card>
          ))
        ) : (
          <Card>
            <p className="text-sm text-slate-600">No failures recorded.</p>
          </Card>
        )}
      </div>

      <Card className="space-y-2">
        <p className="text-sm font-medium text-slate-900">Latest command output</p>
        {lastOutput.length ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
            {lastOutput.join('\n')}
          </pre>
        ) : (
          <p className="text-sm text-slate-600">No command has been run yet.</p>
        )}
      </Card>
    </div>
  );
}

function ActionButton({
  action,
  isRunning,
  isPending,
  disabled,
  onRun,
  children,
}: {
  action: TakeoutAction;
  isRunning: boolean;
  isPending: boolean;
  disabled?: boolean;
  onRun: (action: TakeoutAction) => void;
  children: string;
}): ReactElement {
  return (
    <Button
      className="border border-slate-500 bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-500 disabled:border-slate-700 disabled:bg-slate-800"
      type="button"
      disabled={disabled || isRunning || isPending}
      onClick={() => onRun(action)}
    >
      {children}
    </Button>
  );
}

function renderActionStatus(
  action: TakeoutAction | undefined,
  running: boolean,
  success: boolean | undefined,
  exitCode: number | undefined,
): string {
  if (running && action) {
    return `Running: ${action}`;
  }

  if (typeof success === 'boolean' && action) {
    return success
      ? `Last run: ${action} completed successfully`
      : `Last run: ${action} failed (exit code ${typeof exitCode === 'number' ? exitCode : 'unknown'})`;
  }

  return 'No action is running.';
}

function MetricCard({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-2xl font-semibold text-slate-900">{value}</p>
    </Card>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  return date.toLocaleString();
}

function getActionFailureReason(output: string[]): string | undefined {
  if (!output.length) {
    return undefined;
  }

  const patterns = [
    /\berror\b/i,
    /\bfailed\b/i,
    /\bnot found\b/i,
    /\bECONNREFUSED\b/i,
    /\bEACCES\b/i,
    /\bENOENT\b/i,
    /\bCannot\b/i,
  ];

  const reversed = [...output].reverse();
  for (const line of reversed) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\$\s/.test(trimmed)) continue;
    if (/^Action finished with code/i.test(trimmed)) continue;

    if (patterns.some((pattern) => pattern.test(trimmed))) {
      return trimmed;
    }
  }

  for (const line of reversed) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\$\s/.test(trimmed)) continue;
    if (/^Action finished with code/i.test(trimmed)) continue;
    return trimmed;
  }

  return undefined;
}
