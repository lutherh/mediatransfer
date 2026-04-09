import { useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/* ─── Types ────────────────────────────────────────────────────── */
type ScheduleTask = {
  id: string;
  label: string;
  description: string;
  icon: string;
  cronExpression: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
};

const DEFAULT_SCHEDULES: ScheduleTask[] = [
  {
    id: 'takeout-sync',
    label: 'Google Takeout Sync',
    description: 'Download new photos from Google Takeout archives',
    icon: '📦',
    cronExpression: '0 2 * * *',
    enabled: true,
    lastRun: null,
    nextRun: null,
  },
  {
    id: 's3-upload',
    label: 'Upload to S3',
    description: 'Sync processed photos to Scaleway S3 cloud storage',
    icon: '☁️',
    cronExpression: '0 3 * * *',
    enabled: true,
    lastRun: null,
    nextRun: null,
  },
  {
    id: 'immich-import',
    label: 'Immich Import',
    description: 'Import new S3 photos into your Immich library',
    icon: '🏠',
    cronExpression: '0 4 * * *',
    enabled: true,
    lastRun: null,
    nextRun: null,
  },
  {
    id: 'local-cleanup',
    label: 'Local Cleanup',
    description: 'Remove local copies of files verified in S3 to free disk space',
    icon: '🧹',
    cronExpression: '0 5 * * 0',
    enabled: false,
    lastRun: null,
    nextRun: null,
  },
];

/* ─── Cron presets for non-technical users ─────────────────────── */
const CRON_PRESETS = [
  { label: 'Every night at 2 AM', value: '0 2 * * *' },
  { label: 'Every night at 3 AM', value: '0 3 * * *' },
  { label: 'Every night at 4 AM', value: '0 4 * * *' },
  { label: 'Every night at 5 AM', value: '0 5 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Every Sunday at 5 AM', value: '0 5 * * 0' },
  { label: 'Every Monday at 1 AM', value: '0 1 * * 1' },
  { label: 'First of every month', value: '0 2 1 * *' },
] as const;

function cronToHuman(cron: string): string {
  const preset = CRON_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;

  // Basic fallback for common patterns
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (dom === '*' && dow === '*' && !hour.includes('/')) {
    return `Daily at ${hour}:${min.padStart(2, '0')}`;
  }
  if (dow !== '*' && dom === '*') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Every ${days[Number(dow)] ?? dow} at ${hour}:${min.padStart(2, '0')}`;
  }
  return cron;
}

/* ─── Single schedule row ──────────────────────────────────────── */
function ScheduleRow({
  task,
  onToggle,
  onChangeCron,
  onRunNow,
}: {
  task: ScheduleTask;
  onToggle: () => void;
  onChangeCron: (cron: string) => void;
  onRunNow: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);

  const handleRunNow = () => {
    setRunning(true);
    onRunNow();
    // TODO: replace with actual job status polling when backend is ready
    setTimeout(() => setRunning(false), 3000);
  };

  return (
    <div
      className={`
        flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border p-3 sm:p-4
        transition-all duration-200
        ${task.enabled
          ? 'border-slate-600/50 bg-slate-800/40'
          : 'border-slate-700/30 bg-slate-900/30 opacity-60'
        }
      `}
    >
      {/* Icon + info */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-xl flex-shrink-0">{task.icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-200 truncate">{task.label}</p>
          <p className="text-xs text-slate-400 truncate">{task.description}</p>
        </div>
      </div>

      {/* Schedule selector + Run Now */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {editing ? (
          <select
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
            value={task.cronExpression}
            onChange={(e) => {
              onChangeCron(e.target.value);
              setEditing(false);
            }}
            autoFocus
          >
            {CRON_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md bg-slate-700/60 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
            title="Click to change schedule"
          >
            🕐 {cronToHuman(task.cronExpression)}
          </button>
        )}

        {/* Run Now */}
        <button
          type="button"
          onClick={handleRunNow}
          disabled={running}
          className={`
            rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200
            ${running
              ? 'bg-sky-700/50 text-sky-300 cursor-wait'
              : 'bg-sky-600/20 text-sky-400 hover:bg-sky-600/40 hover:text-sky-300'
            }
          `}
          title="Run this job immediately"
        >
          {running ? (
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
              Running…
            </span>
          ) : (
            '▶ Run'
          )}
        </button>

        {/* Toggle switch */}
        <button
          type="button"
          role="switch"
          aria-checked={task.enabled}
          onClick={onToggle}
          className={`
            relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full
            transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900
            ${task.enabled ? 'bg-sky-600' : 'bg-slate-600'}
          `}
        >
          <span
            className={`
              inline-block h-4 w-4 transform rounded-full bg-white shadow-sm
              transition-transform duration-200
              ${task.enabled ? 'translate-x-6' : 'translate-x-1'}
            `}
          />
        </button>
      </div>
    </div>
  );
}

/* ─── Main schedule config ─────────────────────────────────────── */
export function ScheduleConfig() {
  const [schedules, setSchedules] = useState<ScheduleTask[]>(DEFAULT_SCHEDULES);
  const [saved, setSaved] = useState(false);

  const handleToggle = useCallback((id: string) => {
    setSchedules((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
    setSaved(false);
  }, []);

  const handleChangeCron = useCallback((id: string, cron: string) => {
    setSchedules((prev) =>
      prev.map((s) => (s.id === id ? { ...s, cronExpression: cron } : s)),
    );
    setSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    // TODO: POST to /api/schedules when backend is ready
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, []);

  const handleRunNow = useCallback((id: string) => {
    // TODO: POST to /api/schedules/:id/run when backend is ready
    console.log(`[schedule] Manual trigger: ${id}`);
  }, []);

  const enabledCount = schedules.filter((s) => s.enabled).length;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base sm:text-lg font-semibold text-slate-100 flex items-center gap-2">
            ⏰ Automated Schedule
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Set up automatic jobs so your photos stay synced without manual work.
            {enabledCount > 0 && (
              <span className="ml-1 text-sky-400">{enabledCount} active</span>
            )}
          </p>
        </div>
        <Button
          onClick={handleSave}
          className={saved ? '!bg-emerald-600 hover:!bg-emerald-600' : ''}
          disabled={saved}
        >
          {saved ? '✓ Saved' : 'Save'}
        </Button>
      </div>

      <div className="space-y-2">
        {schedules.map((task) => (
          <ScheduleRow
            key={task.id}
            task={task}
            onToggle={() => handleToggle(task.id)}
            onChangeCron={(cron) => handleChangeCron(task.id, cron)}
            onRunNow={() => handleRunNow(task.id)}
          />
        ))}
      </div>

      {/* How it works box */}
      <div className="mt-4 rounded-lg bg-slate-800/40 border border-slate-700/50 p-3">
        <p className="text-xs font-medium text-slate-300 mb-1.5">💡 How scheduling works</p>
        <ul className="text-xs text-slate-400 space-y-1 list-disc pl-4">
          <li>Jobs run automatically in the background at the times you choose</li>
          <li>Each job only runs if the previous step completed successfully</li>
          <li>The <strong className="text-slate-300">Local Cleanup</strong> job has triple-safety checks — files
            are only removed after verification in S3</li>
          <li>You can run any job manually from the Transfers page at any time</li>
        </ul>
      </div>
    </Card>
  );
}
