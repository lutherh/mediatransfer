import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

/** A month marker on the scrubber track */
export interface MonthMarker {
  /** "YYYY-MM" key */
  key: string;
  /** Short month name, e.g. "Feb" */
  label: string;
  /** Full month name, e.g. "February" */
  fullLabel: string;
  /** "YYYY" */
  year: string;
  /** First section date falling in this month, e.g. "2025-02-15" */
  firstDate: string;
  /** Proportional position along the track (0 = top, 1 = bottom) */
  position: number;
  /** True if this is the first month seen for its year */
  isFirstOfYear: boolean;
  /** Number of media items in this month group */
  itemCount: number;
}

export interface DateScrollerProps {
  /** Sections array from CatalogPage – [date, items][] where date is "YYYY-MM-DD", newest first */
  sections: [string, unknown[]][];
  /** Map of "YYYY-MM-DD" → DOM element for each section, used for scroll-to and visibility detection */
  sectionRefs: React.RefObject<Map<string, HTMLElement>>;
  /**
   * Optional callback to programmatically scroll to a section by date string.
   * When provided, used instead of `scrollIntoView` so that off-screen virtual
   * sections (not currently in the DOM) can still be scrolled to correctly.
   */
  onScrollToDate?: (date: string) => void;
  /** Optional date distribution from the API — the FULL timeline for all media. */
  dateDistribution?: { months: { month: string; count: number }[]; totalItems: number } | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export const MONTH_NAMES_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Auto-hide delay in ms after last scroll/interaction */
export const AUTO_HIDE_DELAY_MS = 1500;

/** Width of the hover zone (px from right edge) that activates the scrubber */
export const HOVER_ZONE_WIDTH = 64;

export function monthLabel(dateStr: string): string {
  const m = parseInt(dateStr.slice(5, 7), 10) - 1;
  return MONTH_NAMES_SHORT[m] ?? dateStr.slice(5, 7);
}

export function monthLabelFull(dateStr: string): string {
  const m = parseInt(dateStr.slice(5, 7), 10) - 1;
  return MONTH_NAMES_FULL[m] ?? dateStr.slice(5, 7);
}

export function formatTooltip(dateStr: string): string {
  return `${monthLabelFull(dateStr)} ${dateStr.slice(0, 4)}`;
}

/**
 * Build month markers for the full timeline.
 *
 * Primary source: `distribution` (complete server-side month counts) — this
 * covers the entire media library from newest to oldest with density-proportional
 * spacing (Google Photos style).
 *
 * Fallback: builds from loaded `sections` when distribution is unavailable.
 *
 * Markers are returned **newest-first** (top of track = newest).
 */
export function buildMonthMarkers(
  sections: [string, unknown[]][],
  distribution?: { months: { month: string; count: number }[]; totalItems: number } | null,
): MonthMarker[] {
  // ── Primary path: use full distribution data ───────────────────────────
  if (distribution?.months && distribution.months.length > 0) {
    return buildMarkersFromDistribution(distribution, sections);
  }

  // ── Fallback: build from loaded sections only ──────────────────────────
  return buildMarkersFromSections(sections);
}

/** Build from the full date-distribution API (covers entire media library) */
function buildMarkersFromDistribution(
  distribution: { months: { month: string; count: number }[]; totalItems: number },
  sections: [string, unknown[]][],
): MonthMarker[] {
  // Distribution months are sorted ascending — reverse for newest-first
  const distMonths = [...distribution.months].reverse();
  if (distMonths.length === 0) return [];

  // Build a lookup: "YYYY-MM" → first section date in that month (for scroll-to)
  const sectionDateByMonth = new Map<string, string>();
  for (const [date] of sections) {
    const ym = date.slice(0, 7);
    if (!sectionDateByMonth.has(ym)) {
      sectionDateByMonth.set(ym, date);
    }
  }

  const groups: MonthMarker[] = [];
  let lastYear = '';

  for (const dm of distMonths) {
    const ym = dm.month; // "YYYY-MM"
    const year = ym.slice(0, 4);
    const isFirstOfYear = year !== lastYear;
    lastYear = year;

    // Synthetic section date for scroll — use real section date if loaded,
    // else fabricate "YYYY-MM-01" (the virtualizer will scroll to closest)
    const firstDate = sectionDateByMonth.get(ym) ?? `${ym}-01`;

    groups.push({
      key: ym,
      label: monthLabel(`${ym}-01`),
      fullLabel: monthLabelFull(`${ym}-01`),
      year,
      firstDate,
      position: 0, // computed below
      isFirstOfYear,
      itemCount: dm.count,
    });
  }

  computeDensityPositions(groups);
  return groups;
}

/** Fallback: build from loaded sections only */
function buildMarkersFromSections(sections: [string, unknown[]][]): MonthMarker[] {
  if (sections.length === 0) return [];
  const groups: MonthMarker[] = [];
  const seen = new Map<string, number>();
  let lastYear = '';

  for (let i = 0; i < sections.length; i++) {
    const date = sections[i][0];
    const ym = date.slice(0, 7);
    const itemCount = sections[i][1].length;

    const existing = seen.get(ym);
    if (existing !== undefined) {
      groups[existing].itemCount += itemCount;
      continue;
    }

    const year = date.slice(0, 4);
    const isFirstOfYear = year !== lastYear;
    lastYear = year;

    seen.set(ym, groups.length);
    groups.push({
      key: ym,
      label: monthLabel(date),
      fullLabel: monthLabelFull(date),
      year,
      firstDate: date,
      position: 0,
      isFirstOfYear,
      itemCount,
    });
  }

  computeDensityPositions(groups);
  return groups;
}

/**
 * Assign density-proportional positions to markers.
 * Each month gets weight = sqrt(count), so months with more photos
 * occupy proportionally more track space. Minimum weight prevents
 * sparse months from collapsing to zero height.
 */
function computeDensityPositions(groups: MonthMarker[]): void {
  if (groups.length <= 1) {
    if (groups.length === 1) groups[0].position = 0;
    return;
  }

  const MIN_WEIGHT = 0.3;
  const weights = groups.map((g) => Math.max(MIN_WEIGHT, Math.sqrt(g.itemCount)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cumulative = 0;
  for (let i = 0; i < groups.length; i++) {
    groups[i].position = cumulative / totalWeight;
    cumulative += weights[i];
  }
}

/** Clamp a value between 0 and 1 */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ── Component ──────────────────────────────────────────────────────────────

export function DateScroller({ sections, sectionRefs, onScrollToDate, dateDistribution }: DateScrollerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [handleRatio, setHandleRatio] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [tooltipDate, setTooltipDate] = useState<string | null>(null);

  // Derived: scroller visible when hovering, dragging, or recently scrolled
  const isVisible = isDragging || isHovering || isScrolling;

  // ── Month markers (full timeline) ───────────────────────────────────────

  const months = useMemo<MonthMarker[]>(
    () => buildMonthMarkers(sections, dateDistribution),
    [sections, dateDistribution],
  );

  // ── Find the closest section date for a given "YYYY-MM-DD" or "YYYY-MM-01" ──
  // Needed because not all months in the distribution may be loaded yet.

  const closestSectionDate = useCallback(
    (targetDate: string): string | null => {
      if (sections.length === 0) return null;
      // Try exact match first
      const exact = sections.find(([d]) => d === targetDate);
      if (exact) return exact[0];
      // Find closest loaded section by date string comparison
      let best = sections[0][0];
      let bestDiff = Math.abs(targetDate.localeCompare(best));
      for (const [d] of sections) {
        const diff = Math.abs(targetDate.localeCompare(d));
        if (diff < bestDiff) { best = d; bestDiff = diff; }
      }
      return best;
    },
    [sections],
  );

  // ── Date at a given track ratio (using full months array) ───────────────

  const dateAtRatio = useCallback(
    (ratio: number): string | null => {
      if (months.length === 0) return null;
      // Find the month whose position is closest to this ratio
      const clamped = clamp01(ratio);
      let best = months[0];
      for (const m of months) {
        if (m.position <= clamped) best = m;
        else break;
      }
      return best.firstDate;
    },
    [months],
  );

  // ── Auto-hide timer logic ───────────────────────────────────────────────

  const resetHideTimer = useCallback(() => {
    setIsScrolling(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, AUTO_HIDE_DELAY_MS);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Scroll position → handle ratio (via section visibility → month position) ──

  useEffect(() => {
    if (sections.length === 0 || months.length === 0) return;

    const onScroll = () => {
      if (isDragging) return;
      resetHideTimer();

      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const refs = sectionRefs.current;
        if (!refs || refs.size === 0) return;

        // Find the last section whose top is above 30% of viewport
        let bestDate = sections[0][0];
        const viewMid = window.innerHeight * 0.3;

        for (let i = 0; i < sections.length; i++) {
          const el = refs.get(sections[i][0]);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.top <= viewMid) bestDate = sections[i][0];
          else break;
        }

        // Map the visible section date to a position on the full months track
        const ym = bestDate.slice(0, 7);
        const monthMarker = months.find((m) => m.key === ym);
        const ratio = monthMarker?.position ?? 0;
        setHandleRatio(ratio);
        setTooltipDate(bestDate);
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [isDragging, sections, months, sectionRefs, resetHideTimer]);

  // ── Hover zone detection (activate when mouse is near right edge) ──────

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDragging) return;
      const distFromRight = window.innerWidth - e.clientX;
      if (distFromRight <= HOVER_ZONE_WIDTH) {
        setIsHovering(true);
      } else if (!isDragging) {
        setIsHovering(false);
      }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [isDragging]);

  // ── Drag / click on track ───────────────────────────────────────────────

  const ratioFromEvent = useCallback(
    (clientY: number): number => {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      return clamp01((clientY - rect.top) / rect.height);
    },
    [],
  );

  const scrollToRatio = useCallback(
    (ratio: number) => {
      const date = dateAtRatio(ratio);
      if (!date) return;
      // Find the closest loaded section for actual scrolling
      const scrollTarget = closestSectionDate(date) ?? date;
      if (onScrollToDate) {
        onScrollToDate(scrollTarget);
      } else {
        const el = sectionRefs.current?.get(scrollTarget);
        if (el) {
          el.scrollIntoView({ behavior: 'auto', block: 'start' });
          window.scrollBy(0, -60);
        }
      }
      setHandleRatio(ratio);
      setTooltipDate(date);
    },
    [dateAtRatio, closestSectionDate, sectionRefs, onScrollToDate],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.setPointerCapture) target.setPointerCapture(e.pointerId);
      setIsDragging(true);
      const ratio = ratioFromEvent(e.clientY);
      scrollToRatio(ratio);
    },
    [ratioFromEvent, scrollToRatio],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) {
        // Update tooltip on hover
        const ratio = ratioFromEvent(e.clientY);
        const date = dateAtRatio(ratio);
        if (date) setTooltipDate(date);
        return;
      }
      e.preventDefault();
      const ratio = ratioFromEvent(e.clientY);
      scrollToRatio(ratio);
    },
    [isDragging, ratioFromEvent, scrollToRatio, dateAtRatio],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.releasePointerCapture) target.releasePointerCapture(e.pointerId);
      setIsDragging(false);
      resetHideTimer();
    },
    [resetHideTimer],
  );

  // ── Keyboard navigation ────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 0.05;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const newRatio = clamp01(handleRatio - step);
        scrollToRatio(newRatio);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const newRatio = clamp01(handleRatio + step);
        scrollToRatio(newRatio);
      } else if (e.key === 'Home') {
        e.preventDefault();
        scrollToRatio(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        scrollToRatio(1);
      }
    },
    [handleRatio, scrollToRatio],
  );

  // ── Don't render if insufficient data ───────────────────────────────────

  if (months.length < 2) return null;

  const showTooltip = isDragging || isHovering;
  const maxItemCount = Math.max(1, ...months.map((m) => m.itemCount));

  // ── Tooltip text: "Mon YYYY" from the handle date ──────────────────────
  const handleTooltipText = tooltipDate
    ? `${monthLabel(tooltipDate.length === 7 ? tooltipDate + '-01' : tooltipDate)} ${(tooltipDate.length === 7 ? tooltipDate : tooltipDate).slice(0, 4)}`
    : null;

  return (
    <div
      ref={containerRef}
      className={`fixed right-0 top-0 z-50 flex h-screen items-center justify-end pointer-events-none transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ width: HOVER_ZONE_WIDTH }}
      data-testid="date-scroller"
    >
      {/* Track container */}
      <div
        ref={trackRef}
        className="relative pointer-events-auto flex flex-col items-center cursor-pointer select-none"
        style={{ height: '85vh' }}
        role="slider"
        aria-label="Timeline scrubber"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(handleRatio * 100)}
        aria-valuetext={tooltipDate ? formatTooltip(tooltipDate.length === 7 ? tooltipDate + '-01' : tooltipDate) : undefined}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        {/* Track rail — vertical line */}
        <div className={`absolute inset-y-0 right-5 w-[1px] rounded-full transition-colors duration-200 ${
          isHovering || isDragging || isScrolling ? 'bg-slate-500/50' : 'bg-slate-400/30'
        }`} />

        {/* Year labels & month dots — Google Photos style */}
        {months.map((m) => {
          const density = m.itemCount / maxItemCount;
          const dotSize = isHovering || isDragging || isScrolling
            ? Math.max(3, Math.round(3 + density * 3))
            : Math.max(2, Math.round(2 + density * 2));

          return (
            <div
              key={m.key}
              className="absolute right-1 flex items-center"
              style={{ top: `${m.position * 100}%`, transform: 'translateY(-50%)' }}
            >
              {m.isFirstOfYear ? (
                <span className={`text-[10px] font-semibold whitespace-nowrap pr-1 select-none transition-colors duration-200 ${
                  isHovering || isDragging || isScrolling ? 'text-slate-400' : 'text-slate-500/60'
                }`}>
                  {m.year}
                </span>
              ) : (
                <span
                  className={`block rounded-full transition-all duration-200 ${
                    isHovering || isDragging || isScrolling
                      ? 'bg-slate-400'
                      : 'bg-slate-400/50'
                  }`}
                  style={{ width: `${dotSize}px`, height: `${dotSize}px` }}
                />
              )}
            </div>
          );
        })}

        {/* Handle — Google Photos-style inline label */}
        <div
          className="absolute right-0 flex items-center"
          style={{
            top: `${handleRatio * 100}%`,
            transform: 'translateY(-50%)',
            transition: isDragging ? 'none' : 'top 100ms ease-out',
          }}
        >
          {/* Inline "Mon YYYY" label — Google Photos shows it as text next to the line */}
          {showTooltip && handleTooltipText && (
            <div
              className="mr-1 flex items-center whitespace-nowrap select-none"
              data-testid="scrubber-tooltip"
            >
              <span className="rounded bg-slate-800/90 px-2 py-0.5 text-[11px] font-semibold text-white shadow-lg">
                {handleTooltipText}
              </span>
            </div>
          )}

          {/* Handle bar */}
          <div
            className={`rounded-full transition-all duration-150 ${
              isDragging
                ? 'h-8 w-1 bg-white shadow-md'
                : isHovering || isScrolling
                  ? 'h-6 w-1 bg-white/80 shadow-sm'
                  : 'h-5 w-[3px] bg-slate-400/60'
            }`}
            data-testid="scrubber-handle"
          />
        </div>
      </div>
    </div>
  );
}
