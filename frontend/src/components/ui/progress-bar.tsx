import { cn } from '@/lib/utils';

type ProgressBarProps = {
  value: number; // 0–1
  className?: string;
  label?: string;
};

export function ProgressBar({ value, className, label }: ProgressBarProps) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="text-slate-600">{label}</span>
          <span className="font-medium text-slate-900">{pct}%</span>
        </div>
      )}
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            pct === 100 ? 'bg-green-600' : 'bg-blue-600',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
