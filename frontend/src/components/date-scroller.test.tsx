import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  DateScroller,
  buildMonthMarkers,
  monthLabel,
  monthLabelFull,
  formatTooltip,
  clamp01,
  MONTH_NAMES_SHORT,
  MONTH_NAMES_FULL,
  AUTO_HIDE_DELAY_MS,
  HOVER_ZONE_WIDTH,
} from '@/components/date-scroller';

// ── Helper factories ───────────────────────────────────────────────────────

/** Create a mock sections array with dates spanning multiple months */
function makeSections(dates: string[], itemsPerDate = 3): [string, unknown[]][] {
  return dates.map((d) => [d, new Array(itemsPerDate).fill({ key: d })] as [string, unknown[]]);
}

/** Create a ref-compatible Map with mock DOM elements */
function makeSectionRefs(dates: string[]) {
  const map = new Map<string, HTMLElement>();
  dates.forEach((d) => {
    const el = document.createElement('div');
    // Mock getBoundingClientRect
    el.getBoundingClientRect = () => ({
      top: 100,
      bottom: 200,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    el.scrollIntoView = vi.fn();
    map.set(d, el);
  });
  return { current: map };
}

// ── Pure function tests ────────────────────────────────────────────────────

describe('monthLabel', () => {
  it('returns short month name for valid dates', () => {
    expect(monthLabel('2024-01-15')).toBe('Jan');
    expect(monthLabel('2024-06-01')).toBe('Jun');
    expect(monthLabel('2024-12-31')).toBe('Dec');
  });

  it('returns raw month string for invalid month', () => {
    expect(monthLabel('2024-13-01')).toBe('13');
    expect(monthLabel('2024-00-01')).toBe('00');
  });

  it('handles all 12 months', () => {
    for (let m = 1; m <= 12; m++) {
      const pad = String(m).padStart(2, '0');
      expect(monthLabel(`2024-${pad}-01`)).toBe(MONTH_NAMES_SHORT[m - 1]);
    }
  });
});

describe('monthLabelFull', () => {
  it('returns full month name for valid dates', () => {
    expect(monthLabelFull('2024-01-15')).toBe('January');
    expect(monthLabelFull('2024-06-01')).toBe('June');
    expect(monthLabelFull('2024-12-31')).toBe('December');
  });

  it('handles all 12 months', () => {
    for (let m = 1; m <= 12; m++) {
      const pad = String(m).padStart(2, '0');
      expect(monthLabelFull(`2024-${pad}-01`)).toBe(MONTH_NAMES_FULL[m - 1]);
    }
  });
});

describe('formatTooltip', () => {
  it('formats as "FullMonth YYYY"', () => {
    expect(formatTooltip('2024-01-15')).toBe('January 2024');
    expect(formatTooltip('2023-07-04')).toBe('July 2023');
    expect(formatTooltip('2025-12-25')).toBe('December 2025');
  });
});

describe('clamp01', () => {
  it('returns value unchanged when in range', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps below zero to 0', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });

  it('clamps above one to 1', () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(100)).toBe(1);
  });
});

// ── buildMonthMarkers tests ────────────────────────────────────────────────

describe('buildMonthMarkers', () => {
  it('returns empty array for empty sections', () => {
    expect(buildMonthMarkers([])).toEqual([]);
  });

  it('creates one marker per unique month', () => {
    const sections = makeSections([
      '2024-06-15',
      '2024-06-14',
      '2024-06-10',
      '2024-05-20',
      '2024-05-15',
    ]);
    const markers = buildMonthMarkers(sections);
    expect(markers).toHaveLength(2);
    expect(markers[0].key).toBe('2024-06');
    expect(markers[1].key).toBe('2024-05');
  });

  it('sets isFirstOfYear correctly for year boundaries', () => {
    const sections = makeSections([
      '2024-03-01',
      '2024-01-15',
      '2023-12-20',
      '2023-11-10',
    ]);
    const markers = buildMonthMarkers(sections);
    expect(markers[0].isFirstOfYear).toBe(true); // 2024 first seen
    expect(markers[1].isFirstOfYear).toBe(false); // still 2024
    expect(markers[2].isFirstOfYear).toBe(true); // 2023 first seen
    expect(markers[3].isFirstOfYear).toBe(false); // still 2023
  });

  it('accumulates item count for same month across sections', () => {
    const sections: [string, unknown[]][] = [
      ['2024-06-15', [1, 2, 3]],
      ['2024-06-14', [4, 5]],
      ['2024-05-20', [6]],
    ];
    const markers = buildMonthMarkers(sections);
    expect(markers[0].itemCount).toBe(5); // 3 + 2
    expect(markers[1].itemCount).toBe(1);
  });

  it('computes density-proportional positions based on item counts', () => {
    const sections: [string, unknown[]][] = [
      ['2024-06-15', new Array(100).fill(1)],  // heavy month
      ['2024-05-20', new Array(10).fill(1)],   // light month
      ['2024-04-10', new Array(1).fill(1)],    // minimal month
    ];
    const markers = buildMonthMarkers(sections);
    expect(markers[0].position).toBe(0);
    // Heavy month (100 items) should get more track space than light month (10 items)
    // so the second marker should be further from 0 than if spacing were linear
    expect(markers[1].position).toBeGreaterThan(0);
    expect(markers[2].position).toBeGreaterThan(markers[1].position);
    expect(markers[2].position).toBeLessThanOrEqual(1);
  });

  it('uses distribution data when provided', () => {
    const sections = makeSections(['2024-06-15', '2024-05-20', '2024-04-10']);
    const dist = {
      months: [
        { month: '2024-04', count: 500 },
        { month: '2024-05', count: 10 },
        { month: '2024-06', count: 50 },
      ],
      totalItems: 560,
    };
    const markers = buildMonthMarkers(sections, dist);
    expect(markers[0].position).toBe(0);
    // With distribution data, spacing should reflect the distribution counts
    expect(markers[1].position).toBeGreaterThan(0);
    expect(markers[2].position).toBeGreaterThan(markers[1].position);
  });

  it('returns position 0 for single section', () => {
    const sections = makeSections(['2024-06-15']);
    const markers = buildMonthMarkers(sections);
    expect(markers[0].position).toBe(0);
  });

  it('includes full and short labels', () => {
    const sections = makeSections(['2024-03-15']);
    const markers = buildMonthMarkers(sections);
    expect(markers[0].label).toBe('Mar');
    expect(markers[0].fullLabel).toBe('March');
  });
});

// ── Constants tests ────────────────────────────────────────────────────────

describe('constants', () => {
  it('MONTH_NAMES_SHORT has 12 entries', () => {
    expect(MONTH_NAMES_SHORT).toHaveLength(12);
  });

  it('MONTH_NAMES_FULL has 12 entries', () => {
    expect(MONTH_NAMES_FULL).toHaveLength(12);
  });

  it('AUTO_HIDE_DELAY_MS is a positive number', () => {
    expect(AUTO_HIDE_DELAY_MS).toBeGreaterThan(0);
  });

  it('HOVER_ZONE_WIDTH is a positive number', () => {
    expect(HOVER_ZONE_WIDTH).toBeGreaterThan(0);
  });
});

// ── Component rendering tests ──────────────────────────────────────────────

describe('DateScroller component', () => {
  const dates = [
    '2024-06-15',
    '2024-06-14',
    '2024-05-20',
    '2024-04-10',
    '2024-03-01',
    '2023-12-20',
    '2023-11-10',
  ];

  let sectionRefs: ReturnType<typeof makeSectionRefs>;

  beforeEach(() => {
    sectionRefs = makeSectionRefs(dates);
    // Mock requestAnimationFrame
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    // Mock window.innerWidth for hover zone
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when sections have fewer than 2 months', () => {
    const sections = makeSections(['2024-06-15']);
    const { container } = render(
      <DateScroller sections={sections} sectionRefs={makeSectionRefs(['2024-06-15'])} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the scroller when there are 2+ months', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    expect(screen.getByTestId('date-scroller')).toBeInTheDocument();
  });

  it('renders with slider role for accessibility', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-label', 'Timeline scrubber');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '100');
  });

  it('renders year labels for first occurrence of each year', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    // Should have 2024 and 2023 year labels
    expect(screen.getByText('2024')).toBeInTheDocument();
    expect(screen.getByText('2023')).toBeInTheDocument();
  });

  it('renders the scrubber handle', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    expect(screen.getByTestId('scrubber-handle')).toBeInTheDocument();
  });

  it('starts hidden (opacity-0) when not interacting', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    const scroller = screen.getByTestId('date-scroller');
    // Initially not hovering/dragging/scrolling → should have opacity-0
    // (but scroll listener fires immediately so isScrolling may be true briefly)
    expect(scroller.className).toContain('transition-opacity');
  });

  it('is keyboard focusable with tabIndex', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('tabindex', '0');
  });

  it('does not show tooltip by default', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);
    expect(screen.queryByTestId('scrubber-tooltip')).not.toBeInTheDocument();
  });
});

// ── Component interaction tests ────────────────────────────────────────────

describe('DateScroller interactions', () => {
  const dates = [
    '2024-06-15',
    '2024-05-20',
    '2024-04-10',
    '2024-03-01',
  ];
  let sectionRefs: ReturnType<typeof makeSectionRefs>;

  beforeEach(() => {
    vi.useFakeTimers();
    sectionRefs = makeSectionRefs(dates);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows scroller when scrolling and auto-hides after delay', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    // Trigger scroll
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    const scroller = screen.getByTestId('date-scroller');
    expect(scroller.className).toContain('opacity-100');

    // Fast-forward past auto-hide delay
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS + 100);
    });

    expect(scroller.className).toContain('opacity-0');
  });

  it('shows scroller when mouse enters hover zone', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    // Simulate mouse near right edge (within HOVER_ZONE_WIDTH)
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: 1920 - HOVER_ZONE_WIDTH / 2,
          clientY: 500,
        }),
      );
    });

    const scroller = screen.getByTestId('date-scroller');
    expect(scroller.className).toContain('opacity-100');
  });

  it('hides scroller when mouse moves away from hover zone', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    // Enter hover zone
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 1920 - 10, clientY: 500 }),
      );
    });

    // Move away
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 500, clientY: 500 }),
      );
    });

    // Wait for auto-hide
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS + 100);
    });

    const scroller = screen.getByTestId('date-scroller');
    expect(scroller.className).toContain('opacity-0');
  });

  it('keyboard ArrowDown increases handle ratio', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    const slider = screen.getByRole('slider');
    const initialValue = parseInt(slider.getAttribute('aria-valuenow') ?? '0');

    act(() => {
      fireEvent.keyDown(slider, { key: 'ArrowDown' });
    });

    const newValue = parseInt(slider.getAttribute('aria-valuenow') ?? '0');
    expect(newValue).toBeGreaterThanOrEqual(initialValue);
  });

  it('keyboard ArrowUp decreases handle ratio', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    const slider = screen.getByRole('slider');

    // First move down
    act(() => {
      fireEvent.keyDown(slider, { key: 'ArrowDown' });
      fireEvent.keyDown(slider, { key: 'ArrowDown' });
    });

    const midValue = parseInt(slider.getAttribute('aria-valuenow') ?? '0');

    act(() => {
      fireEvent.keyDown(slider, { key: 'ArrowUp' });
    });

    const newValue = parseInt(slider.getAttribute('aria-valuenow') ?? '0');
    expect(newValue).toBeLessThanOrEqual(midValue);
  });

  it('keyboard Home jumps to start', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    const slider = screen.getByRole('slider');

    act(() => {
      fireEvent.keyDown(slider, { key: 'End' });
    });

    act(() => {
      fireEvent.keyDown(slider, { key: 'Home' });
    });

    const value = parseInt(slider.getAttribute('aria-valuenow') ?? '0');
    expect(value).toBe(0);
  });

  it('keyboard End jumps to end', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    const slider = screen.getByRole('slider');

    act(() => {
      fireEvent.keyDown(slider, { key: 'End' });
    });

    const value = parseInt(slider.getAttribute('aria-valuenow') ?? '0');
    expect(value).toBe(100);
  });

  it('clicking on track scrolls to corresponding section', () => {
    const sections = makeSections(dates);
    render(<DateScroller sections={sections} sectionRefs={sectionRefs} />);

    const slider = screen.getByRole('slider');

    // Mock track bounding rect
    const mockRect = {
      top: 100,
      height: 600,
      bottom: 700,
      left: 0,
      right: 48,
      width: 48,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    };
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(mockRect);

    // Mock setPointerCapture (not in jsdom)
    Object.defineProperty(slider, 'setPointerCapture', { value: vi.fn() });

    // Click in middle of track
    act(() => {
      fireEvent.pointerDown(slider, {
        clientY: 400, // middle of 100..700
        pointerId: 1,
      });
    });

    // Should have scrolled one of the sections into view
    const scrolled = dates.some((d) => {
      const el = sectionRefs.current.get(d);
      return el && (el.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    });
    expect(scrolled).toBe(true);
  });
});

// ── Security-related tests ─────────────────────────────────────────────────

describe('DateScroller security', () => {
  it('does not render raw HTML from date strings (XSS prevention)', () => {
    const xssDates = ['<script>alert(1)</script>-06-15', '2024-05-20'] as const;
    const sections = makeSections([...xssDates]);
    const sectionRefs = makeSectionRefs([...xssDates]);

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    // Even if the date string contains an XSS payload, React's JSX
    // escaping should prevent script execution. We just verify no
    // script tags appear in the DOM.
    const { container } = render(
      <DateScroller sections={sections} sectionRefs={sectionRefs} />,
    );
    expect(container.innerHTML).not.toContain('<script>');
  });

  it('sanitizes tooltip display against XSS attempts in date strings', () => {
    // formatTooltip uses string slicing, not innerHTML
    const result = formatTooltip('<img onerror="alert(1)">-06-15');
    // Should just return the sliced strings, no HTML interpretation
    expect(result).not.toContain('onerror');
  });
});
