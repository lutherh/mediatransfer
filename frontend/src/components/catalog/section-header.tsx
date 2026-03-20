import type { CatalogItem } from '@/lib/api';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Convert an ISO date string (e.g. "2025-06-16") into a human-friendly label.
 *
 * Rules (modeled after Google Photos timeline headers):
 *   • Same calendar day → "Today"
 *   • Previous calendar day → "Yesterday"
 *   • 2–6 days ago → just the day name: "Tuesday", "Wednesday", etc.
 *   • Same year → "Sat 14 Mar" (abbreviated day + day number + month)
 *   • Older → "Sat 14 Mar 2024" (includes year)
 *
 * @pattern Google Photos human-friendly section headers
 */
export function formatSectionDate(dateStr: string): string {
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  const date = new Date(year, month, day);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = today.getTime() - date.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return DAY_NAMES_FULL[date.getDay()];
  if (year === now.getFullYear()) {
    return `${DAY_NAMES[date.getDay()]} ${day} ${SHORT_MONTHS[month]}`;
  }
  return `${DAY_NAMES[date.getDay()]} ${day} ${SHORT_MONTHS[month]} ${year}`;
}

/**
 * Date section header with a tri-state checkbox (none / some / all selected)
 * and an item count badge. Styled to match Google Photos' prominent date
 * labels that clearly separate timeline sections.
 *
 * @pattern Google Photos date-grouped section with select-all toggle
 */
export function SectionHeader({
  date,
  items,
  selected,
  onToggleAll,
}: {
  date: string;
  items: CatalogItem[];
  selected: Set<string>;
  onToggleAll: (keys: string[], select: boolean) => void;
}) {
  const keys = items.map((i) => i.encodedKey);
  const allSelected = keys.length > 0 && keys.every((k) => selected.has(k));
  const someSelected = !allSelected && keys.some((k) => selected.has(k));

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <button
        type="button"
        onClick={() => onToggleAll(keys, !allSelected)}
        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
          allSelected
            ? 'border-blue-500 bg-blue-500'
            : someSelected
              ? 'border-blue-400 bg-blue-100'
              : 'border-slate-300 bg-white hover:border-blue-400'
        }`}
        aria-label={allSelected ? 'Deselect section' : 'Select section'}
      >
        {allSelected && (
          <svg viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth={2.5} className="h-3 w-3">
            <path d="M2 6l3 3 5-5" />
          </svg>
        )}
        {someSelected && !allSelected && (
          <div className="h-2 w-2 rounded-full bg-blue-500" />
        )}
      </button>
      <h2 className="text-base font-bold text-slate-800">{formatSectionDate(date)}</h2>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{items.length}</span>
    </div>
  );
}
