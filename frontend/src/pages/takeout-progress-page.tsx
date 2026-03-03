import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Stepper } from '@/components/ui/stepper';
import {
  fetchTakeoutActionStatus,
  fetchTakeoutStatus,
  runTakeoutAction,
  type TakeoutAction,
  type ScanProgress,
} from '@/lib/api';

// ─── Workflow step definitions ─────────────────────────────────────────────

const WORKFLOW_STEPS = [
  { label: 'Scan',    description: 'Index archives' },
  { label: 'Upload',  description: 'Send to cloud'  },
  { label: 'Verify',  description: 'Confirm files'  },
  { label: 'Cleanup', description: 'Reclaim disk'   },
];

// ─── Page ──────────────────────────────────────────────────────────────────

export function TakeoutProgressPage() {
  const queryClient = useQueryClient();
  const [detailsOpen, setDetailsOpen] = useState(false);

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
    return (
      <div className="flex items-center gap-3 py-12 text-slate-500 text-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
        Loading…
      </div>
    );
  }

  if (error || !data) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return (
      <Alert variant="error" className="space-y-1">
        <p className="font-medium">Could not load Takeout status</p>
        <p className="text-xs">{message}</p>
        <p className="text-xs opacity-75">Check that the backend API is running on localhost:3000.</p>
      </Alert>
    );
  }

  // ─── Derived state ──────────────────────────────────────────────────────

  const isActionRunning = Boolean(actionStatus?.running);
  const lastOutput = actionStatus?.output ?? [];
  const hasManifest = data.counts.total > 0;
  const allUploaded = hasManifest && data.counts.pending === 0 && data.counts.failed === 0;
  const hasFailed = data.counts.failed > 0;
  const isCleanupAction = actionStatus?.action === 'cleanup-move' || actionStatus?.action === 'cleanup-delete';
  const cleanupRunning = isActionRunning && isCleanupAction;
  const cleanupSucceeded = !isActionRunning && isCleanupAction && actionStatus?.success === true;
  const mutationErrorMessage = actionMutation.error instanceof Error
    ? actionMutation.error.message
    : 'Failed to start action.';
  const actionFailureReason = getActionFailureReason(actionStatus?.output ?? []);
  const lastScanFailed = !isActionRunning && actionStatus?.action === 'scan' && actionStatus?.success === false;
  const staleStats = lastScanFailed && hasManifest;
  const lastActionFailed = !isActionRunning && actionStatus?.success === false;

  // Stepper: 0=Scan, 1=Upload, 2=Verify, 3=Cleanup
  const currentStep = !hasManifest
    ? 0
    : !allUploaded
      ? 1
      : (cleanupRunning || cleanupSucceeded)
        ? 3
        : 2;

  const run = (action: TakeoutAction) => actionMutation.mutate(action);

  return (
    <div className="space-y-5">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900">Google Takeout</h1>
          <p className="text-sm text-slate-500 mt-0.5">Migrate your full Google Photos library to Scaleway</p>
        </div>
        {!isLoadingActionStatus && (
          <StatusBadge
            running={isActionRunning}
            action={actionStatus?.action}
            success={actionStatus?.success}
          />
        )}
      </div>

      {/* ── Overall progress ─────────────────────────────────────────────── */}
      <Card className={staleStats ? 'opacity-60 space-y-4' : 'space-y-4'}>
        <ProgressBar value={data.progress} label="Uploaded to cloud" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <StatChip label="Total"    value={data.counts.total}    />
          <StatChip label="Uploaded" value={data.counts.uploaded} color="green" />
          <StatChip label="Skipped"  value={data.counts.skipped}  />
          <StatChip label="Failed"   value={data.counts.failed}   color={hasFailed ? 'red' : 'slate'} />
        </div>
        <p className="text-[11px] text-slate-400">Updated {formatDateTime(data.stateUpdatedAt)}</p>
      </Card>

      {staleStats && (
        <Alert variant="warning">
          ⚠ Stats above are from a previous scan — the last scan failed.
          Fix the error and re-run Scan to refresh.
        </Alert>
      )}

      {/* ── Workflow stepper ─────────────────────────────────────────────── */}
      <Stepper steps={WORKFLOW_STEPS} currentStep={currentStep} />

      {/* ── Action panel ─────────────────────────────────────────────────── */}
      <Card className="space-y-4">
        {/* Contextual prompt */}
        <div>
          <p className="text-sm font-medium text-slate-900">
            {currentStep === 0 && 'Next: scan your archive folder'}
            {currentStep === 1 && 'Next: upload files to Scaleway'}
            {currentStep === 2 && 'Next: verify files, then clean up'}
            {currentStep === 3 && 'Cleanup in progress or completed'}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            {currentStep === 0 && <>Drop <span className="font-mono">.zip / .tar / .tgz</span> files into <span className="font-mono break-all">{data.paths.inputDir}</span>, then run Scan.</>}
            {currentStep === 1 && <>{data.counts.pending.toLocaleString()} file{data.counts.pending !== 1 ? 's' : ''} pending upload{hasFailed ? ` · ${data.counts.failed} failed` : ''}.</>}
            {currentStep === 2 && 'All files are uploaded. Verify confirms they landed in the cloud; Cleanup reclaims local disk space.'}
            {currentStep === 3 && (cleanupRunning
              ? 'Cleanup is running. Local extracted files and archives are being processed.'
              : 'Cleanup completed. Local extracted files were reclaimed according to your selected mode.')}
          </p>
        </div>

        {/* Primary action for current step */}
        <div className="flex flex-wrap gap-2">
          {currentStep === 0 && (
            <PrimaryButton action="scan" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
              Scan Archives
            </PrimaryButton>
          )}
          {currentStep === 1 && (
            <>
              <PrimaryButton action="upload" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
                Upload
              </PrimaryButton>
              <SecondaryButton action="resume" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
                Resume
              </SecondaryButton>
            </>
          )}
          {currentStep === 2 && (
            <PrimaryButton action="verify" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
              Verify
            </PrimaryButton>
          )}
          {currentStep === 3 && (
            <SecondaryButton action="verify" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
              Re-run Verify
            </SecondaryButton>
          )}
        </div>

        {/* Scan progress */}
        {isActionRunning && actionStatus?.action === 'scan' && actionStatus?.scanProgress ? (
          <ScanProgressBar progress={actionStatus.scanProgress} startedAt={actionStatus.startedAt} />
        ) : null}

        {/* Errors */}
        {actionMutation.isError ? (
          <Alert variant="error" className="text-xs">{mutationErrorMessage}</Alert>
        ) : null}
        {lastActionFailed && actionFailureReason ? (
          <Alert variant="error" className="text-xs font-mono whitespace-pre-wrap break-all">
            {actionFailureReason}
          </Alert>
        ) : null}

        {/* All other actions (secondary) */}
        <details>
          <summary className="cursor-pointer select-none text-xs text-slate-400 hover:text-slate-600 pt-1">
            All actions
          </summary>
          <div className="flex flex-wrap gap-2 mt-3">
            <SecondaryButton action="start-services" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
              Start Services
            </SecondaryButton>
            <SecondaryButton action="scan" isRunning={isActionRunning} isPending={actionMutation.isPending} onRun={run}>
              Scan
            </SecondaryButton>
            <SecondaryButton action="upload" isRunning={isActionRunning} isPending={actionMutation.isPending} disabled={!hasManifest} onRun={run}>
              Upload
            </SecondaryButton>
            <SecondaryButton action="verify" isRunning={isActionRunning} isPending={actionMutation.isPending} disabled={!hasManifest} onRun={run}>
              Verify
            </SecondaryButton>
            <SecondaryButton action="resume" isRunning={isActionRunning} isPending={actionMutation.isPending} disabled={!hasManifest} onRun={run}>
              Resume
            </SecondaryButton>
          </div>
        </details>
      </Card>

      {/* ── Cleanup ──────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
        <div className="flex items-start gap-2">
          <span className="text-amber-500 text-base leading-none mt-0.5" aria-hidden>⚠</span>
          <div>
            <p className="text-sm font-semibold text-amber-900">Reclaim disk space</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Only files confirmed uploaded or skipped are removed — failed items are never touched.
              Run after a successful Upload + Verify.
            </p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <CleanupOption
            action="cleanup-move"
            label="Move archives (recommended)"
            description="Deletes extracted work files · moves .zip / .tgz to uploaded-archives/"
            variant="safe"
            disabled={!hasManifest || isActionRunning || actionMutation.isPending}
            onRun={run}
          />
          <CleanupOption
            action="cleanup-delete"
            label="Delete archives"
            description="Deletes extracted work files · permanently removes .zip / .tgz from disk"
            variant="destructive"
            disabled={!hasManifest || isActionRunning || actionMutation.isPending}
            onRun={run}
          />
        </div>
        {!hasManifest && (
          <p className="text-xs text-amber-700">Run <strong>Scan</strong> first so cleanup can verify uploaded items.</p>
        )}
      </div>

      {/* ── Failures ─────────────────────────────────────────────────────── */}
      {hasFailed && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-red-700">
            Failed uploads ({data.counts.failed})
          </h2>
          {data.recentFailures.map((failure) => (
            <Alert key={`${failure.key}-${failure.updatedAt}`} variant="error" className="space-y-1">
              <p className="font-medium text-xs break-all">{failure.key}</p>
              <p className="text-xs opacity-75">
                {failure.attempts} attempt{failure.attempts !== 1 ? 's' : ''} · {formatDateTime(failure.updatedAt)}
              </p>
              {failure.error ? <p className="text-xs break-all">{failure.error}</p> : null}
            </Alert>
          ))}
        </div>
      )}

      {/* ── Technical details (collapsed) ────────────────────────────────── */}
      <details
        open={detailsOpen}
        onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none text-xs text-slate-400 hover:text-slate-600 py-1">
          {detailsOpen ? '▾' : '▸'} Technical details
        </summary>
        <div className="mt-3 space-y-3">
          <Card className="space-y-2 text-xs">
            <p className="font-medium text-slate-700">File paths</p>
            <PathRow label="Input" value={data.paths.inputDir} />
            <PathRow label="Work"  value={data.paths.workDir} />
            <PathRow label="Manifest" value={data.paths.manifestPath} />
            <PathRow label="State" value={data.paths.statePath} />
          </Card>
          <Card className="space-y-2">
            <p className="text-xs font-medium text-slate-700">Command output</p>
            {lastOutput.length ? (
              <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100 leading-relaxed">
                {lastOutput.join('\n')}
              </pre>
            ) : (
              <p className="text-xs text-slate-500">No output yet.</p>
            )}
          </Card>
        </div>
      </details>
    </div>
  );
}

// ─── Status badge ──────────────────────────────────────────────────────────

function StatusBadge({
  running,
  action,
  success,
}: {
  running: boolean;
  action?: TakeoutAction;
  success?: boolean;
}): ReactElement {
  if (running && action) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-800 shrink-0">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        {mapActionLabel(action)}…
      </span>
    );
  }
  if (success === true && action) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 shrink-0">
        ✓ {mapActionLabel(action)} done
      </span>
    );
  }
  if (success === false && action) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800 shrink-0">
        ✗ {mapActionLabel(action)} failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500 shrink-0">
      Idle
    </span>
  );
}

// ─── Stat chip ─────────────────────────────────────────────────────────────

function StatChip({
  label,
  value,
  color = 'slate',
}: {
  label: string;
  value: number;
  color?: 'green' | 'red' | 'slate';
}): ReactElement {
  const valueClass =
    color === 'green' ? 'text-green-700' :
    color === 'red'   ? 'text-red-700'   :
    'text-slate-800';

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums leading-none ${valueClass}`}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

// ─── Action buttons ────────────────────────────────────────────────────────

function PrimaryButton({
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
      type="button"
      disabled={disabled || isRunning || isPending}
      onClick={() => onRun(action)}
    >
      {children}
    </Button>
  );
}

function SecondaryButton({
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
      className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100 disabled:opacity-40"
      type="button"
      disabled={disabled || isRunning || isPending}
      onClick={() => onRun(action)}
    >
      {children}
    </Button>
  );
}

// ─── Cleanup option card ───────────────────────────────────────────────────

function CleanupOption({
  action,
  label,
  description,
  variant,
  disabled,
  onRun,
}: {
  action: TakeoutAction;
  label: string;
  description: string;
  variant: 'safe' | 'destructive';
  disabled?: boolean;
  onRun: (action: TakeoutAction) => void;
}): ReactElement {
  const btnClass = variant === 'destructive'
    ? 'border border-red-300 bg-white text-red-700 hover:bg-red-50 active:bg-red-100 disabled:opacity-40'
    : 'border border-green-300 bg-white text-green-800 hover:bg-green-50 active:bg-green-100 disabled:opacity-40';

  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3 space-y-2">
      <div>
        <p className="text-xs font-semibold text-slate-800">{label}</p>
        <p className="text-[11px] text-slate-500 mt-0.5">{description}</p>
      </div>
      <Button className={btnClass} type="button" disabled={disabled} onClick={() => onRun(action)}>
        Run
      </Button>
    </div>
  );
}

// ─── Path row ─────────────────────────────────────────────────────────────

function PathRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-slate-400 shrink-0 w-16">{label}</span>
      <span className="text-slate-600 break-all font-mono min-w-0">{value}</span>
    </div>
  );
}

// ─── Scan progress bar ────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  discover: 'Discovering archives',
  extract:  'Extracting archives',
  normalize: 'Normalizing folders',
  manifest: 'Building manifest',
  done:     'Complete',
};

function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (minutes < 60) return `~${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `~${hours}h ${mins}m`;
}

function ScanProgressBar({
  progress,
  startedAt,
}: {
  progress: ScanProgress;
  startedAt?: string;
}): ReactElement {
  const prevRef = useRef<{ percent: number; timestamp: number } | null>(null);
  const etaRef = useRef<number | null>(null);

  const percent = progress.percent;
  const phaseLabel = PHASE_LABELS[progress.phase] ?? progress.phase;

  // Compute ETA based on elapsed time and progress
  if (startedAt && percent > 0 && percent < 100) {
    const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
    const etaFromStart = elapsed * ((100 - percent) / percent);

    // Also compute rate-based ETA from last update for smoothing
    const prev = prevRef.current;
    let etaFromRate: number | null = null;
    if (prev && percent > prev.percent) {
      const dt = (Date.now() - prev.timestamp) / 1000;
      const dp = percent - prev.percent;
      const rate = dp / dt; // percent per second
      if (rate > 0) {
        etaFromRate = (100 - percent) / rate;
      }
    }

    // Blend: prefer rate-based when available, otherwise use elapsed-based
    const eta = etaFromRate != null
      ? etaFromRate * 0.6 + etaFromStart * 0.4
      : etaFromStart;

    etaRef.current = eta;
  } else if (percent >= 100) {
    etaRef.current = 0;
  }

  // Track last known percent for rate calculation
  if (!prevRef.current || prevRef.current.percent !== percent) {
    prevRef.current = { percent, timestamp: Date.now() };
  }

  const detailText = progress.detail ?? '';
  const etaText = etaRef.current != null && etaRef.current > 0 ? formatEta(etaRef.current) : '';

  return (
    <div className="space-y-1.5 mt-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-700 font-medium">
          {phaseLabel}{detailText ? `: ${detailText}` : ''}
        </span>
        <span className="text-slate-500 tabular-nums">
          {percent}%{etaText ? ` · ETA ${etaText}` : ''}
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-slate-200 overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-600 transition-all duration-700 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      {progress.total > 0 && progress.phase !== 'done' ? (
        <p className="text-[11px] text-slate-400 tabular-nums">
          {progress.current} / {progress.total}
          {progress.phase === 'extract' ? ' archives' : progress.phase === 'manifest' ? ' files' : ''}
        </p>
      ) : null}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function mapActionLabel(action: TakeoutAction): string {
  if (action === 'cleanup-move')   return 'cleanup (move archives)';
  if (action === 'cleanup-delete') return 'cleanup (delete archives)';
  return action;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function getActionFailureReason(output: string[]): string | undefined {
  if (!output.length) {
    return undefined;
  }

  // Look for the "❌ ... failed:" marker that starts a multi-line error block
  const failMarkerIndex = output.findIndex((line) => /❌.*failed:/i.test(line));
  if (failMarkerIndex >= 0) {
    // Collect lines from the marker until the next blank line or "Action finished"
    const errorLines: string[] = [];
    for (let i = failMarkerIndex; i < output.length; i++) {
      const line = output[i].trim();
      if (/^Action finished with code/i.test(line)) break;
      if (line) errorLines.push(line);
    }
    if (errorLines.length > 0) {
      return errorLines.join('\n');
    }
  }

  // Fallback: find a single line with an error pattern
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
    if (patterns.some((pattern) => pattern.test(trimmed))) return trimmed;
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
