import type { CatalogItem } from '@/lib/api';

/**
 * Minimal month divider — a slim separator shown at each month boundary
 * in the timeline. Shows month name and year with a subtle horizontal rule.
 *
 * @pattern Google Photos subtle month transitions in the timeline
 */
export function MonthDivider({
  monthLabel,
  year,
  itemCount,
}: {
  monthLabel: string;
  year: string;
  itemCount: number;
  coverItem: CatalogItem | undefined;
  apiToken: string | undefined;
}) {
  return (
    <div className="flex items-center gap-3 pb-1 pt-4" data-testid="month-divider">
      <h2 className="whitespace-nowrap text-sm font-semibold text-slate-700">
        {monthLabel} {year}
      </h2>
      <div className="h-px flex-1 bg-slate-200/60" />
      <span className="whitespace-nowrap text-[11px] text-slate-500">
        {itemCount.toLocaleString()} item{itemCount !== 1 ? 's' : ''}
      </span>
    </div>
  );
}
