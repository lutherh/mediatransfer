/**
 * @file Inline date/time editor inspired by Windows 11 Photos "Info" panel.
 *
 * Renders editable day / month / year fields and read-only hour : minute
 * (derived from the item's capturedAt timestamp).  When the user changes the
 * date and clicks **Save Date**, the parent receives the new `YYYY/MM/DD`
 * prefix so it can move the media item to the corresponding S3 folder.
 *
 * @pattern Windows 11 Photos — Info panel date editing
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Parse an ISO-8601 string into individual UTC date/time parts. */
function parseDateParts(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    day: d.getUTCDate(),
    month: d.getUTCMonth(), // 0-based
    year: d.getUTCFullYear(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Extract the `YYYY/MM/DD` prefix from an S3 object key, or `null`. */
function extractDatePrefix(key: string): string | null {
  const m = /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\//.exec(key);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ── Component ──────────────────────────────────────────────────────────────

export type DateTimeEditorProps = {
  /** Current captured-at timestamp (ISO 8601). */
  capturedAt: string;
  /** S3 object key — used to derive the current date-folder prefix. */
  itemKey: string;
  /** Called with the new `YYYY/MM/DD` prefix when the user saves. */
  onSave: (newDatePrefix: string) => void;
  /** True while the save/move operation is in flight. */
  isSaving: boolean;
  /** Set after save completes (`null` while idle or in-flight). */
  saveResult: 'success' | 'error' | null;
  /** Human-readable error message when `saveResult` is `'error'`. */
  errorMessage?: string;
};

export function DateTimeEditor({
  capturedAt,
  itemKey,
  onSave,
  isSaving,
  saveResult,
  errorMessage,
}: DateTimeEditorProps) {
  const parsed = useMemo(() => parseDateParts(capturedAt), [capturedAt]);

  const [day, setDay] = useState(parsed?.day ?? 1);
  const [month, setMonth] = useState(parsed?.month ?? 0);
  const [year, setYear] = useState(parsed?.year ?? new Date().getUTCFullYear());

  // Re-sync local state when the viewed item changes (lightbox navigation).
  useEffect(() => {
    if (parsed) {
      setDay(parsed.day);
      setMonth(parsed.month);
      setYear(parsed.year);
    }
  }, [parsed]);

  const maxDay = daysInMonth(year, month);
  const effectiveDay = Math.min(day, maxDay);

  const origPrefix = extractDatePrefix(itemKey);
  const newPrefix = `${year}/${pad2(month + 1)}/${pad2(effectiveDay)}`;

  // Show save when the S3 path needs to change:
  //   • origPrefix is null → file is in unknown-date/ and needs a proper folder
  //   • origPrefix differs from the new date → user edited the date
  const changed = origPrefix === null || origPrefix !== newPrefix;
  const valid =
    effectiveDay >= 1 && effectiveDay <= maxDay && year >= 1900 && year <= 2100;

  const handleSave = useCallback(() => {
    if (changed && valid && !isSaving) onSave(newPrefix);
  }, [changed, valid, isSaving, newPrefix, onSave]);

  // Shared Tailwind classes for the editable number inputs.
  const inputBase =
    'rounded border border-white/20 bg-white/10 px-1.5 py-1 text-center text-xs tabular-nums text-white ' +
    'focus:border-amber-500 focus:outline-none transition-colors';

  return (
    <div className="space-y-2">
      {/* ── Date row ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {/* Calendar icon */}
        <svg
          className="h-4 w-4 shrink-0 text-white/40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>

        <div className="flex items-center gap-1">
          <input
            type="number"
            aria-label="Day"
            value={effectiveDay}
            min={1}
            max={maxDay}
            onChange={(e) =>
              setDay(clamp(Number(e.target.value) || 1, 1, 31))
            }
            className={`${inputBase} w-11`}
          />

          <select
            aria-label="Month"
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className={`${inputBase} w-auto px-1`}
          >
            {MONTH_NAMES.map((name, i) => (
              <option
                key={i}
                value={i}
                className="bg-neutral-800 text-white"
              >
                {name}
              </option>
            ))}
          </select>

          <input
            type="number"
            aria-label="Year"
            value={year}
            min={1900}
            max={2100}
            onChange={(e) =>
              setYear(clamp(Number(e.target.value) || 2000, 1900, 2100))
            }
            className={`${inputBase} w-16`}
          />
        </div>
      </div>

      {/* ── Time row (read-only, derived from capturedAt / EXIF) ── */}
      {parsed && (
        <div className="flex items-center gap-2">
          {/* Clock icon */}
          <svg
            className="h-4 w-4 shrink-0 text-white/40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>

          <div className="flex items-center gap-1">
            <span
              className={`inline-block w-11 ${inputBase} cursor-default border-white/10 bg-white/5 text-white/50`}
            >
              {pad2(parsed.hour)}
            </span>
            <span className="text-xs text-white/30">:</span>
            <span
              className={`inline-block w-11 ${inputBase} cursor-default border-white/10 bg-white/5 text-white/50`}
            >
              {pad2(parsed.minute)}
            </span>
          </div>
        </div>
      )}

      {/* ── Action / feedback ────────────────────────────────── */}
      {changed && valid && saveResult !== 'success' && (
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="w-full rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
        >
          {isSaving ? 'Moving…' : 'Save Date'}
        </button>
      )}

      {changed && !valid && (
        <p className="text-[10px] text-amber-400">Invalid date</p>
      )}

      {saveResult === 'success' && (
        <p className="text-[10px] text-green-400">
          ✓ Moved to {newPrefix}
        </p>
      )}

      {saveResult === 'error' && (
        <p className="text-[10px] text-red-400">
          {errorMessage ?? 'Failed to update date'}
        </p>
      )}
    </div>
  );
}
