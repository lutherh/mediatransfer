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
  /** Optional date distribution from the API for density-proportional spacing */
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

/** Build month markers from sections array with density-proportional spacing.
 *  When distribution data is provided, months with more items get more track space
 *  (Google Photos-style). Without distribution data, falls back to linear spacing.
 */
export function buildMonthMarkers(
  sections: [string, unknown[]][],
  distribution?: { months: { month: string; count: number }[]; totalItems: number } | null,
): MonthMarker[] {
  if (sections.length === 0) return [];
  const groups: MonthMarker[] = [];
  const seen = new Map<string, number>(); // key → index in groups
  let lastYear = '';

  for (let i = 0; i < sections.length; i++) {
    const date = sections[i][0];
    const ym = date.slice(0, 7);
    const itemCount = sections[i][1].length;

    const existing = seen.get(ym);
    if (existing !== undefined) {
      // Accumulate item count for same month
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
      position: 0, // computed below
      isFirstOfYear,
      itemCount,
    });
  }

  // Compute density-proportional positions
  if (groups.length <= 1) {
    if (groups.length === 1) groups[0].position = 0;
    return groups;
  }

  // Build a count map from distribution data if available, else use section item counts
  const distMap = new Map<string, number>();
  if (distribution?.months) {
    for (const m of distribution.months) {
      distMap.set(m.month, m.count);
    }
  }

  // Each month gets weight = sqrt(count) to compress extreme outliers while
  // still giving denser months noticeably more space. Minimum weight ensures
  // empty months still show and can be clicked.
  const MIN_WEIGHT = 0.3;
  const weights: number[] = groups.map((g) => {
    const count = distMap.get(g.key) ?? g.itemCount;
    return Math.max(MIN_WEIGHT, Math.sqrt(count));
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cumulative = 0;
  for (let i = 0; i < groups.length; i++) {
    groups[i].position = cumulative / totalWeight;
    cumulative += weights[i];
  }

  return groups;
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

  // ── Month markers ───────────────────────────────────────────────────────

  const months = useMemo<MonthMarker[]>(
    () => buildMonthMarkers(sections, dateDistribution),
    [sections, dateDistribution],
  );

  // ── Date at a given ratio ───────────────────────────────────────────────

  const dateAtRatio = useCallback(
    (ratio: number): string | null => {
      if (sections.length === 0) return null;
      const idx = Math.round(clamp01(ratio) * (sections.length - 1));
      return sections[Math.min(idx, sections.length - 1)]?.[0] ?? null;
    },
    [sections],
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

  // ── Scroll position → handle ratio (with rAF for smooth tracking) ──────

  useEffect(() => {
    if (sections.length === 0) return;

    const onScroll = () => {
      if (isDragging) return;
      resetHideTimer();

      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const refs = sectionRefs.current;
        if (!refs || refs.size === 0) return;

        // Find the last section whose top is above 30% of viewport
        let bestIdx = 0;
        const viewMid = window.innerHeight * 0.3;

        for (let i = 0; i < sections.length; i++) {
          const el = refs.get(sections[i][0]);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.top <= viewMid) bestIdx = i;
          else break;
        }

        const ratio = sections.length === 1 ? 0 : bestIdx / (sections.length - 1);
        setHandleRatio(ratio);
        setTooltipDate(sections[bestIdx]?.[0] ?? null);
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [isDragging, sections, sectionRefs, resetHideTimer]);

  // ── Hover zone detection (Immich-style: activate when mouse is near right edge) ──

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
      if (onScrollToDate) {
        // Prefer the virtualizer-aware callback so off-screen sections are reachable
        onScrollToDate(date);
      } else {
        const el = sectionRefs.current?.get(date);
        if (el) {
          el.scrollIntoView({ behavior: 'auto', block: 'start' });
          window.scrollBy(0, -60);
        }
      }
      setHandleRatio(ratio);
      setTooltipDate(date);
    },
    [dateAtRatio, sectionRefs, onScrollToDate],
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

  // ── Keyboard navigation (Ente-style) ───────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 0.05; // 5% per key press
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
        style={{ height: '80vh' }}
        role="slider"
        aria-label="Timeline scrubber"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(handleRatio * 100)}
        aria-valuetext={tooltipDate ? formatTooltip(tooltipDate) : undefined}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        {/* Track rail — Google Photos style thin vertical line */}
        <div className={`absolute inset-y-0 right-5 w-[2px] rounded-full transition-colors duration-200 ${
          isHovering || isDragging || isScrolling ? 'bg-slate-400/80' : 'bg-slate-300/40'
        }`} />

        {/* Density bars — Google Photos-style: horizontal bars proportional to month item count */}
        {(isHovering || isDragging) && months.map((m) => {
          const density = m.itemCount / maxItemCount;
          const barWidth = Math.max(2, Math.round(density * 18));
          return (
            <div
              key={`bar-${m.key}`}
              className="absolute right-[21px] h-[2px] rounded-full bg-slate-300/60"
              style={{
                top: `${m.position * 100}%`,
                width: `${barWidth}px`,
                transform: 'translateY(-50%) translateX(-100%)',
              }}
            />
          );
        })}

        {/* Year labels & month dots (Google Photos-style) */}
        {months.map((m) => {
          // Scale dot size based on density (more photos = bigger dot)
          const density = m.itemCount / maxItemCount;
          const dotSize = isHovering || isDragging || isScrolling
            ? Math.max(3, Math.round(3 + density * 4))
            : Math.max(2, Math.round(2 + density * 2));

          return (
            <div
              key={m.key}
              className="absolute right-1 flex items-center gap-1"
              style={{ top: `${m.position * 100}%`, transform: 'translateY(-50%)' }}
            >
              {m.isFirstOfYear ? (
                <span className={`text-[10px] font-bold whitespace-nowrap pr-1 select-none transition-colors duration-200 ${
                  isHovering || isDragging || isScrolling ? 'text-slate-600' : 'text-slate-400'
                }`}>
                  {m.year}
                </span>
              ) : (
                <span
                  className={`block rounded-full transition-all duration-200 ${
                    isHovering || isDragging || isScrolling
                      ? 'bg-slate-400'
                      : 'bg-slate-300'
                  }`}
                  style={{ width: `${dotSize}px`, height: `${dotSize}px` }}
                />
              )}
            </div>
          );
        })}

        {/* Handle / thumb — Google Photos-style with tooltip */}
        <div
          className="absolute right-1 flex items-center"
          style={{
            top: `${handleRatio * 100}%`,
            transform: 'translateY(-50%)',
            transition: isDragging ? 'none' : 'top 100ms ease-out',
          }}
        >
          {/* Tooltip bubble (Google Photos-style: rounded pill with month + year + arrow) */}
          {showTooltip && tooltipDate && (
            <div className="mr-2 flex items-center whitespace-nowrap rounded-lg bg-slate-800 px-3 py-1.5 text-white shadow-xl select-none animate-in fade-in slide-in-from-right-2 duration-150"
              data-testid="scrubber-tooltip"
            >
              <span className="text-xs font-semibold">{formatTooltip(tooltipDate)}</span>
              {/* Triangle arrow pointing right */}
              <svg className="absolute -right-1.5 h-3 w-3 text-slate-800" viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path d="M0 0 L12 6 L0 12 Z" fill="currentColor" />
              </svg>
            </div>
          )}

          {/* Handle capsule — wider when active */}
          <div
            className={`rounded-full shadow-md transition-all duration-150 ${
              isDragging
                ? 'h-10 w-1.5 bg-blue-600'
                : isHovering || isScrolling
                  ? 'h-8 w-1.5 bg-blue-500'
                  : 'h-6 w-1 bg-slate-400'
            }`}
            data-testid="scrubber-handle"
          />
        </div>
      </div>
    </div>
  );
}
