import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import {
  fetchTakeoutActionStatus,
  fetchTakeoutStatus,
  runTakeoutAction,
  updateTakeoutPath,
  resetTakeoutPath,
  type TakeoutAction,
  type TakeoutArchiveHistoryEntry,
  type ScanProgress,
  type PipelineSummary,
  type StepRecord,
  type StepStatus,
} from '@/lib/api';

// ─── Page states ──────────────────────────────────────────────────────────────

type PageState =
  | 'running'         // a job is actively running
  | 'verify-failed'   // verify found files missing from the cloud → needs upload
  | 'error'           // last job failed (non-verify)
  | 'archives-found'  // archives sitting in input/, no manifest yet
  | 'new-archives'    // new archives in input/ while current batch is fully uploaded
  | 'watching'        // no archives, no manifest — waiting for user to drop files
  | 'upload-ready'    // manifest exists, still have pending/failed uploads
  | 'done';           // all uploaded — show verify + cleanup

// ─── Page ─────────────────────────────────────────────────────────────────────

export function TakeoutProgressPage() {
  const queryClient = useQueryClient();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['takeout-status'],
    queryFn: fetchTakeoutStatus,
    refetchInterval: 3000,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const { data: actionStatus, isLoading: isLoadingActionStatus } = useQuery({
    queryKey: ['takeout-action-status'],
    queryFn: fetchTakeoutActionStatus,
    refetchInterval: 1500,
    staleTime: 10_000,
    gcTime: 5 * 60_000,
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
        Loading...
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

  // Derived state
  const isActionRunning  = Boolean(actionStatus?.running);
  const lastOutput       = actionStatus?.output ?? [];
  const hasManifest      = data.counts.total > 0;
  const allUploaded      = hasManifest && data.counts.pending === 0 && data.counts.failed === 0;
  const hasFailed        = data.counts.failed > 0;
  const lastActionFailed = !isActionRunning && actionStatus?.success === false;
  const archivesInInput  = data.archivesInInput ?? 0;
  const archiveHistory   = data.archiveHistory ?? [];
  const mutationError    = actionMutation.error instanceof Error
    ? actionMutation.error.message
    : 'Failed to start action.';
  const failureReason    = getActionFailureReason(lastOutput);

  const busy = isActionRunning || actionMutation.isPending;
  const disablePathEditing = busy;
  const run  = (action: TakeoutAction) => actionMutation.mutate(action);

  // Parsed verify output
  const verifyMissingCount = getVerifyMissingCount(lastOutput);
  const verifyPresentCount = getVerifyPresentCount(lastOutput);

  // Page state machine
  let pageState: PageState;
  if (isActionRunning) {
    pageState = 'running';
  } else if (lastActionFailed && actionStatus?.action === 'verify') {
    // Verify finishing with missing files is not a scary crash — it just means
    // some files still need uploading. Give a dedicated, friendly page state.
    pageState = 'verify-failed';
  } else if (lastActionFailed) {
    pageState = 'error';
  } else if (archivesInInput > 0 && !hasManifest) {
    pageState = 'archives-found';
  } else if (!hasManifest) {
    pageState = 'watching';
  } else if (!allUploaded) {
    pageState = 'upload-ready';
  } else if (archivesInInput > 0) {
    // Current batch is fully uploaded but there are new/unprocessed archives in input/.
    // Prompt the user to scan + upload the new batch.
    pageState = 'new-archives';
  } else {
    pageState = 'done';
  }

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900">Google Takeout</h1>
          <p className="text-sm text-slate-500 mt-0.5">Migrate your Google Photos library to Scaleway</p>
        </div>
        {!isLoadingActionStatus && (
          <StatusBadge
            running={isActionRunning}
            action={actionStatus?.action}
            success={actionStatus?.success}
          />
        )}
      </div>

      {/* Mutation error */}
      {actionMutation.isError && (
        <Alert variant="error" className="text-xs">{mutationError}</Alert>
      )}

      {/* Pipeline stepper — shows the 4-step workflow visually */}
      {data.pipeline && (
        <PipelineStepper pipeline={data.pipeline} isActionRunning={isActionRunning} currentAction={actionStatus?.action} />
      )}

      {/* Watching: no archives, no manifest */}
      {pageState === 'watching' && (
        <Card className="flex items-start gap-4 py-5">
          <span className="text-3xl mt-0.5 shrink-0" aria-hidden>👁</span>
          <div className="space-y-1 min-w-0">
            <p className="font-semibold text-slate-900">Watching for archives</p>
            <p className="text-sm text-slate-500">
              Drop <code className="rounded bg-slate-100 px-1">.zip</code> or{' '}
              <code className="rounded bg-slate-100 px-1">.tgz</code> Takeout archives into the
              input folder. This page will detect them automatically every few seconds.
            </p>
            <p className="text-xs font-mono text-slate-400 pt-1 break-all">{data.paths.inputDir}</p>
          </div>
        </Card>
      )}

      {/* Archives found: prompt to scan (first run, no manifest) */}
      {pageState === 'archives-found' && (
        <Card className="border-blue-200 bg-blue-50 space-y-3">
          <div className="flex items-start gap-4">
            <span className="text-3xl mt-0.5 shrink-0" aria-hidden>📦</span>
            <div className="space-y-1 min-w-0">
              <p className="font-semibold text-slate-900">
                {archivesInInput} archive{archivesInInput !== 1 ? 's' : ''} detected
              </p>
              <p className="text-sm text-slate-600">
                New files are ready in the input folder. Scan them to build the
                manifest and prepare for upload.
              </p>
            </div>
          </div>
          <Button type="button" disabled={busy} onClick={() => run('scan')}>
            Scan now
          </Button>
        </Card>
      )}

      {/* New archives detected after current batch is fully uploaded */}
      {pageState === 'new-archives' && (
        <div className="space-y-3">
          <Card className="border-green-200 bg-green-50 space-y-1 py-3">
            <div className="flex items-center gap-2">
              <span aria-hidden>✅</span>
              <p className="text-sm font-medium text-green-800">
                Previous batch done — {data.counts.uploaded.toLocaleString()} files safely in the cloud.
              </p>
            </div>
          </Card>
          <Card className="border-blue-200 bg-blue-50 space-y-3">
            <div className="flex items-start gap-4">
              <span className="text-3xl mt-0.5 shrink-0" aria-hidden>📦</span>
              <div className="space-y-1 min-w-0">
                <p className="font-semibold text-slate-900">
                  {archivesInInput} new archive{archivesInInput !== 1 ? 's' : ''} ready to process
                </p>
                <p className="text-sm text-slate-600">
                  These archives haven't been scanned yet. Scan them to find any new photos,
                  then upload — duplicates already in the cloud will be skipped automatically.
                </p>
              </div>
            </div>
            <Button type="button" disabled={busy} onClick={() => run('scan')}>
              Scan &amp; prepare new archives
            </Button>
          </Card>
        </div>
      )}

      {/* Running: show progress */}
      {pageState === 'running' && (
        <Card className="space-y-3">
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-blue-500 animate-pulse shrink-0" />
            <p className="font-semibold text-slate-900">
              {describeAction(actionStatus?.action)} running...
            </p>
          </div>
          {actionStatus?.action === 'scan' && actionStatus.scanProgress
            ? <ScanProgressBar progress={actionStatus.scanProgress} startedAt={actionStatus.startedAt} />
            : (actionStatus?.action === 'upload' || actionStatus?.action === 'resume')
              ? <p className="text-xs text-slate-500">Uploading your photos — when done, archives will be deleted and a note saved to <code className="rounded bg-slate-100 px-1">uploaded-archives/</code> automatically.</p>
              : actionStatus?.action === 'cleanup-move'
                ? <p className="text-xs text-slate-500">Upload finished! Deleting archives and saving notes to <code className="rounded bg-slate-100 px-1">uploaded-archives/</code> to free up disk space.</p>
                : <p className="text-xs text-slate-500">Job is running in the background. Stats refresh automatically.</p>
          }
          {(actionStatus?.action === 'upload' || actionStatus?.action === 'resume') && hasManifest && (
            <div className="space-y-1">
              <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-700 ease-out"
                  style={{ width: `${Math.round(data.progress * 100)}%` }}
                />
              </div>
              <p className="text-xs text-slate-500 tabular-nums">
                {data.counts.uploaded.toLocaleString()} / {data.counts.total.toLocaleString()} files
                {' '}· {Math.round(data.progress * 100)}%
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Verify failed: files missing from cloud — friendly, actionable card */}
      {pageState === 'verify-failed' && (
        <Card className="border-orange-200 bg-orange-50 space-y-4">
          <div className="flex items-start gap-4">
            <span className="text-3xl mt-0.5 shrink-0" aria-hidden>📡</span>
            <div className="space-y-1.5 min-w-0">
              <p className="font-semibold text-slate-900">
                {verifyMissingCount > 0
                  ? `${verifyMissingCount.toLocaleString()} files still need to be uploaded`
                  : 'Some files are missing from the cloud'}
              </p>
              <p className="text-sm text-slate-700">
                {verifyPresentCount > 0 && (
                  <>
                    <span className="font-medium text-green-700">{verifyPresentCount.toLocaleString()} files are safely in the cloud.</span>{' '}
                  </>
                )}
                The rest haven't been sent yet — this usually happens when an upload was
                interrupted. Just re-run the upload and the missing files will be sent automatically.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => run('upload')}>
              Upload missing files
            </Button>
            <Button
              className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              type="button"
              disabled={busy}
              onClick={() => run('verify')}
            >
              Check again
            </Button>
          </div>
          <p className="text-xs text-orange-700 border-t border-orange-200 pt-3">
            After uploading, tap <strong>Check again</strong> to confirm all your files are safely stored in the cloud.
          </p>
        </Card>
      )}

      {/* Error: last action failed (non-verify) */}
      {pageState === 'error' && (
        <Alert variant="error" className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-base" aria-hidden>✗</span>
            <p className="font-semibold text-sm">{describeAction(actionStatus?.action)} failed</p>
          </div>
          {failureReason && (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-red-50 rounded p-2 border border-red-200">
              {failureReason}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            {actionStatus?.action && !isForceCleanupAction(actionStatus.action) && (
              <Button type="button" disabled={busy} onClick={() => run(actionStatus.action!)}>
                Retry {describeAction(actionStatus.action)}
              </Button>
            )}
            {actionStatus?.action === 'scan' && hasManifest && (
              <Button
                className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                type="button"
                disabled={busy}
                onClick={() => run('upload')}
              >
                Continue with upload anyway
              </Button>
            )}
          </div>

          {/* When cleanup failed because some file records are missing, explain in plain English */}
          {isCleanupAction(actionStatus?.action) && isMissingStateError(lastOutput) && (
            <div className="rounded-lg border border-orange-300 bg-orange-50 p-3 space-y-2 text-xs">
              <p className="font-semibold text-orange-900">A few files don't have an upload record yet</p>
              <p className="text-orange-800">
                The app found some files in the list that haven't been uploaded yet (or whose upload
                record doesn't match). The safest fix is to <strong>run Upload first</strong>, then
                come back to clean up.
              </p>
              <p className="text-orange-800">
                If you're confident everything was uploaded correctly and just want to free up disk space now, you can skip the check below.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  className="border border-orange-400 bg-white text-orange-900 hover:bg-orange-100 disabled:opacity-40 text-xs py-1"
                  type="button"
                  disabled={busy}
                  onClick={() => run('upload')}
                >
                  Upload first (recommended)
                </Button>
                <Button
                  className="border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 text-xs py-1"
                  type="button"
                  disabled={busy}
                  onClick={() => run('cleanup-force-move')}
                >
                  Skip check &amp; move archives
                </Button>
                <Button
                  className="border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:opacity-40 text-xs py-1"
                  type="button"
                  disabled={busy}
                  onClick={() => run('cleanup-force-delete')}
                >
                  Skip check &amp; delete archives
                </Button>
              </div>
            </div>
          )}
        </Alert>
      )}

      {/* Upload ready: manifest exists, pending files */}
      {pageState === 'upload-ready' && (
        <Card className="space-y-3">
          <div className="flex items-start gap-4">
            <span className="text-3xl mt-0.5 shrink-0" aria-hidden>⬆️</span>
            <div className="space-y-1 min-w-0">
              <p className="font-semibold text-slate-900">Ready to upload</p>
              <p className="text-sm text-slate-500">
                {data.counts.pending.toLocaleString()} file{data.counts.pending !== 1 ? 's' : ''} pending
                {hasFailed ? ` · ${data.counts.failed.toLocaleString()} previously failed` : ''}.
              </p>
              {archivesInInput > 0 && (
                <p className="text-xs text-slate-400">
                  {archivesInInput} archive{archivesInInput !== 1 ? 's' : ''} still in input
                  folder — re-scan after adding more archives.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => run('upload')}>
              Start upload
            </Button>
            {hasFailed && (
              <Button
                className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                type="button"
                disabled={busy}
                onClick={() => run('resume')}
              >
                Resume (skip failed)
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Done: all uploaded — verify + cleanup */}
      {pageState === 'done' && (
        <div className="space-y-3">
          <Card className="border-green-200 bg-green-50 space-y-3">
            <div className="flex items-start gap-4">
              <span className="text-3xl mt-0.5 shrink-0" aria-hidden>✅</span>
              <div className="space-y-1 min-w-0">
                <p className="font-semibold text-slate-900">All files uploaded</p>
                <p className="text-sm text-slate-600">
                  {data.counts.uploaded.toLocaleString()} uploaded
                  {data.counts.skipped > 0 ? ` · ${data.counts.skipped.toLocaleString()} skipped` : ''}.
                </p>
              </div>
            </div>
            <Button
              className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              type="button"
              disabled={busy}
              onClick={() => run('verify')}
            >
              Verify in cloud
            </Button>
          </Card>

          {/* Only show cleanup zone if archive files are still sitting in the input folder */}
          {archivesInInput > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <span className="text-amber-500 text-base leading-none mt-0.5" aria-hidden>⚠</span>
              <div>
                <p className="text-sm font-semibold text-amber-900">Reclaim disk space</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Only archives confirmed as completed are touched. Run after verifying.
                </p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <CleanupOption
                action="cleanup-move"
                label="Move archives (recommended)"
                description="Deletes extracted work files · saves .txt note and removes .zip / .tgz"
                variant="safe"
                disabled={busy}
                onRun={run}
              />
              <CleanupOption
                action="cleanup-delete"
                label="Delete archives"
                description="Deletes extracted work files · permanently removes .zip / .tgz from disk"
                variant="destructive"
                disabled={busy}
                onRun={run}
              />
            </div>
          </div>
          )}
        </div>
      )}

      {/* Stats row */}
      {hasManifest && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 px-1">
          <StatChip label="Total"    value={data.counts.total}    />
          <StatChip label="Uploaded" value={data.counts.uploaded} color="green" />
          <StatChip label="Skipped"  value={data.counts.skipped}  />
          <StatChip label="Failed"   value={data.counts.failed}   color={hasFailed ? 'red' : 'slate'} />
        </div>
      )}

      {/* Technical details */}
      <details
        open={detailsOpen}
        onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none text-xs text-slate-400 hover:text-slate-600 py-1">
          {detailsOpen ? '▾' : '▸'} Configuration &amp; Logs
        </summary>
        <div className="mt-3 space-y-3">
          <Card className="space-y-2 text-xs">
            <p className="font-medium text-slate-700">File paths <span className="font-normal text-slate-400">(click ✎ to edit)</span></p>
            {disablePathEditing && (
              <p className="text-[11px] text-amber-700">
                Path edits are disabled while a job is running.
              </p>
            )}
            <EditablePathRow
              label="Input"
              value={data.paths.inputDir}
              disabled={disablePathEditing}
              onSave={async (v) => { await updateTakeoutPath('inputDir', v); await queryClient.invalidateQueries({ queryKey: ['takeout-status'] }); }}
              onReset={async ()  => { await resetTakeoutPath('inputDir');    await queryClient.invalidateQueries({ queryKey: ['takeout-status'] }); }}
            />
            <EditablePathRow
              label="Work"
              value={data.paths.workDir}
              disabled={disablePathEditing}
              onSave={async (v) => { await updateTakeoutPath('workDir', v); await queryClient.invalidateQueries({ queryKey: ['takeout-status'] }); }}
              onReset={async ()  => { await resetTakeoutPath('workDir');     await queryClient.invalidateQueries({ queryKey: ['takeout-status'] }); }}
            />
            <PathRow label="Manifest" value={data.paths.manifestPath} />
            <PathRow label="State"    value={data.paths.statePath}    />
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

      {/* Archive history */}
      {archiveHistory.length > 0 && (
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm font-semibold text-slate-900">Archive Upload History</p>
            <p className="text-xs text-slate-500">{archiveHistory.length.toLocaleString()} archive records</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3 font-medium">Archive</th>
                  <th className="py-2 pr-3 font-medium">TGZ Size</th>
                  <th className="py-2 pr-3 font-medium">Handled Data</th>
                  <th className="py-2 pr-3 font-medium">Items</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Finished</th>
                </tr>
              </thead>
              <tbody>
                {archiveHistory.map((record) => (
                  <tr key={record.archiveName} className="border-b border-slate-100 last:border-b-0 align-top">
                    <td className="py-2 pr-3 font-mono text-slate-700 break-all">{record.archiveName}</td>
                    <td className="py-2 pr-3 text-slate-700 tabular-nums">{formatBytesAsGb(record.archiveSizeBytes)}</td>
                    <td className="py-2 pr-3 text-slate-700 tabular-nums">{formatBytesAsGb(record.mediaBytes)}</td>
                    <td className="py-2 pr-3 text-slate-700 tabular-nums">
                      {record.uploadedCount.toLocaleString()} / {record.entryCount.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      <ArchiveStatusPill record={record} />
                    </td>
                    <td className="py-2 text-slate-500 tabular-nums">
                      {record.completedAt ? formatDateTime(record.completedAt) : 'In progress'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Failed upload list */}
      {hasFailed && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-red-700">
            Failed uploads ({data.counts.failed.toLocaleString()})
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
    </div>
  );
}

// ─── Pipeline stepper ─────────────────────────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
  scan:    'Scan',
  upload:  'Upload',
  verify:  'Verify',
  cleanup: 'Cleanup',
};

const STEP_ICONS: Record<StepStatus, string> = {
  pending:       '○',
  'in-progress': '◉',
  completed:     '✓',
  failed:        '✗',
  skipped:       '–',
};

function stepColor(status: StepStatus, isActive: boolean): string {
  if (status === 'completed') return 'text-green-600';
  if (status === 'failed')    return 'text-red-600';
  if (status === 'in-progress' || isActive) return 'text-blue-600';
  return 'text-slate-400';
}

function connectorColor(status: StepStatus): string {
  if (status === 'completed') return 'bg-green-400';
  if (status === 'failed')    return 'bg-red-300';
  return 'bg-slate-200';
}

function PipelineStepper({
  pipeline,
  isActionRunning,
  currentAction,
}: {
  pipeline: PipelineSummary;
  isActionRunning: boolean;
  currentAction?: TakeoutAction;
}): ReactElement {
  const steps = pipeline.steps;

  return (
    <div className="flex items-center gap-0 px-1 py-2" role="list" aria-label="Migration pipeline steps">
      {steps.map((step, i) => {
        const isActive = isActionRunning && step.step === pipeline.currentStep;
        const color = stepColor(step.status, isActive);
        const icon = isActive ? '◉' : STEP_ICONS[step.status];

        return (
          <div key={step.step} className="flex items-center" role="listitem">
            {/* Step circle + label */}
            <div className={`flex flex-col items-center gap-0.5 ${color}`}>
              <span
                className={`
                  flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold
                  ${step.status === 'completed' ? 'border-green-500 bg-green-50' : ''}
                  ${step.status === 'failed' ? 'border-red-400 bg-red-50' : ''}
                  ${step.status === 'in-progress' || isActive ? 'border-blue-500 bg-blue-50' : ''}
                  ${step.status === 'pending' || step.status === 'skipped' ? 'border-slate-300 bg-white' : ''}
                  ${isActive ? 'animate-pulse' : ''}
                `}
                aria-label={`${STEP_LABELS[step.step]}: ${step.status}`}
              >
                {icon}
              </span>
              <span className="text-[10px] font-medium leading-tight whitespace-nowrap">
                {STEP_LABELS[step.step] ?? step.step}
              </span>
              {step.status === 'completed' && step.itemsDone != null && (
                <span className="text-[9px] text-green-600 tabular-nums">
                  {step.itemsDone.toLocaleString()} done
                </span>
              )}
              {step.status === 'failed' && step.itemsFailed != null && step.itemsFailed > 0 && (
                <span className="text-[9px] text-red-500 tabular-nums">
                  {step.itemsFailed.toLocaleString()} failed
                </span>
              )}
            </div>
            {/* Connector line between steps */}
            {i < steps.length - 1 && (
              <div className={`h-0.5 w-6 sm:w-10 mx-1 rounded-full ${connectorColor(step.status)}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

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
        {mapActionLabel(action)}...
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

// ─── Stat chip ────────────────────────────────────────────────────────────────

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

// ─── Cleanup option card ──────────────────────────────────────────────────────

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

function ArchiveStatusPill({ record }: { record: TakeoutArchiveHistoryEntry }): ReactElement {
  const hasItemAccounting = record.entryCount > 0
    || record.uploadedCount > 0
    || record.skippedCount > 0
    || record.failedCount > 0;

  if (record.isFullyUploaded) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
        100% uploaded
      </span>
    );
  }

  if (record.status === 'completed' && !hasItemAccounting) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
        Completed (legacy record)
      </span>
    );
  }

  if (record.status === 'failed') {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800">
        Failed ({record.handledPercent.toFixed(0)}%)
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
      {record.status} ({record.handledPercent.toFixed(0)}%)
    </span>
  );
}

function formatBytesAsGb(value?: number): string {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return 'unknown';
  }
  const gb = value / (1024 ** 3);
  return `${gb.toFixed(2)} GB`;
}

// ─── Path row ─────────────────────────────────────────────────────────────────

function PathRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-slate-400 shrink-0 w-16">{label}</span>
      <span className="text-slate-600 break-all font-mono min-w-0">{value}</span>
    </div>
  );
}

// ─── Editable path row ────────────────────────────────────────────────────────

function EditablePathRow({
  label,
  value,
  disabled,
  onSave,
  onReset,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onSave: (newValue: string) => Promise<void>;
  onReset: () => Promise<void>;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
    // Focus the input after React renders it
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      await onReset();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex gap-2 min-w-0 items-center group">
        <span className="text-slate-400 shrink-0 w-16">{label}</span>
        <span className="text-slate-600 break-all font-mono min-w-0">{value}</span>
        <button
          type="button"
          onClick={startEditing}
          className="shrink-0 text-slate-400 hover:text-blue-500 transition-colors"
          disabled={disabled}
          title={disabled ? 'Path editing is disabled while processing is running' : 'Edit path'}
        >
          ✎
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex gap-2 min-w-0 items-center">
        <span className="text-slate-400 shrink-0 w-16">{label}</span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
          disabled={saving || disabled}
          className="flex-1 min-w-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-mono text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
        />
      </div>
      <div className="flex gap-1.5 ml-[4.5rem]">
        <Button
          type="button"
          className="h-5 px-2 text-[10px]"
          onClick={() => void save()}
          disabled={saving || disabled || !draft.trim()}
        >
          {saving ? '…' : 'Save'}
        </Button>
        <Button
          type="button"
          className="h-5 px-2 text-[10px] bg-slate-100 text-slate-600 hover:bg-slate-200"
          onClick={cancel}
          disabled={saving || disabled}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-5 px-2 text-[10px] bg-amber-50 text-amber-700 hover:bg-amber-100"
          onClick={() => void reset()}
          disabled={saving || disabled}
          title="Reset to default from environment"
        >
          Reset default
        </Button>
      </div>
    </div>
  );
}

// ─── Scan progress bar ────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  discover:  'Discovering archives',
  extract:   'Extracting archives',
  normalize: 'Normalizing folders',
  manifest:  'Building manifest',
  done:      'Complete',
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
  const etaRef  = useRef<number | null>(null);

  const percent    = progress.percent;
  const phaseLabel = PHASE_LABELS[progress.phase] ?? progress.phase;

  if (startedAt && percent > 0 && percent < 100) {
    const elapsed      = (Date.now() - new Date(startedAt).getTime()) / 1000;
    const etaFromStart = elapsed * ((100 - percent) / percent);

    const prev = prevRef.current;
    let etaFromRate: number | null = null;
    if (prev && percent > prev.percent) {
      const dt   = (Date.now() - prev.timestamp) / 1000;
      const dp   = percent - prev.percent;
      const rate = dp / dt;
      if (rate > 0) etaFromRate = (100 - percent) / rate;
    }

    etaRef.current = etaFromRate != null
      ? etaFromRate * 0.6 + etaFromStart * 0.4
      : etaFromStart;
  } else if (percent >= 100) {
    etaRef.current = 0;
  }

  if (!prevRef.current || prevRef.current.percent !== percent) {
    prevRef.current = { percent, timestamp: Date.now() };
  }

  const detailText = progress.detail ?? '';
  const etaText    = etaRef.current != null && etaRef.current > 0 ? formatEta(etaRef.current) : '';

  return (
    <div className="space-y-1.5">
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
          {progress.current.toLocaleString()} / {progress.total.toLocaleString()}
          {progress.phase === 'extract'   ? ' archives' : ''}
          {progress.phase === 'normalize' ? ' files'    : ''}
          {progress.phase === 'manifest'  ? ' files'    : ''}
        </p>
      ) : null}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function describeAction(action?: TakeoutAction): string {
  if (!action) return 'Action';
  return mapActionLabel(action);
}

function isCleanupAction(action?: TakeoutAction): boolean {
  return action === 'cleanup-move' || action === 'cleanup-delete'
    || action === 'cleanup-force-move' || action === 'cleanup-force-delete';
}

function isForceCleanupAction(action: TakeoutAction): boolean {
  return action === 'cleanup-force-move' || action === 'cleanup-force-delete';
}

function isMissingStateError(output: string[]): boolean {
  return output.some((line) => /manifest entries have no upload record/i.test(line));
}

function mapActionLabel(action: TakeoutAction): string {
  const labels: Record<TakeoutAction, string> = {
    scan:                  'Scan',
    upload:                'Upload',
    verify:                'Verify',
    resume:                'Resume',
    'start-services':      'Start services',
    'cleanup-move':        'Cleanup (move archives)',
    'cleanup-delete':      'Cleanup (delete archives)',
    'cleanup-force-move':  'Force cleanup (move archives)',
    'cleanup-force-delete':'Force cleanup (delete archives)',
  };
  return labels[action] ?? action;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function getVerifyMissingCount(output: string[]): number {
  for (const line of output) {
    const m = line.match(/Missing:\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

function getVerifyPresentCount(output: string[]): number {
  for (const line of output) {
    const m = line.match(/Present:\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

function getActionFailureReason(output: string[]): string | undefined {
  if (!output.length) return undefined;

  const failMarkerIndex = output.findIndex((line) => /❌.*failed:/i.test(line));
  if (failMarkerIndex >= 0) {
    const errorLines: string[] = [];
    for (let i = failMarkerIndex; i < output.length; i++) {
      const line = output[i].trim();
      if (/^Action finished with code/i.test(line)) break;
      if (line) errorLines.push(line);
    }
    if (errorLines.length > 0) return errorLines.join('\n');
  }

  const patterns = [/\berror\b/i, /\bfailed\b/i, /\bnot found\b/i, /\bECONNREFUSED\b/i, /\bEACCES\b/i, /\bENOENT\b/i, /\bCannot\b/i];
  const reversed = [...output].reverse();

  for (const line of reversed) {
    const trimmed = line.trim();
    if (!trimmed || /^\$\s/.test(trimmed) || /^Action finished with code/i.test(trimmed)) continue;
    if (patterns.some((p) => p.test(trimmed))) return trimmed;
  }

  for (const line of reversed) {
    const trimmed = line.trim();
    if (!trimmed || /^\$\s/.test(trimmed) || /^Action finished with code/i.test(trimmed)) continue;
    return trimmed;
  }

  return undefined;
}
