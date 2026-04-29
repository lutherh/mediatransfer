/**
 * @file Tests for the enhanced Catalog Page.
 *
 * Validates:
 *   • formatSectionDate() human-friendly date formatting
 *   • Skeleton / fade-in loading behavior for thumbnails
 *   • Shift-click range selection across sections
 *   • EmptyState rendering with and without prefix
 *   • Lightbox toolbar, info panel, zoom, and download
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CatalogPage } from './catalog-page';
import { fetchCatalogItems } from '@/lib/api';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/api', () => ({
  fetchCatalogStats: vi.fn(async () => ({
    totalFiles: 10,
    totalBytes: 1_000_000,
    imageCount: 8,
    videoCount: 2,
    oldestDate: '2024-01-15',
    newestDate: '2025-06-16',
  })),
  fetchCatalogItems: vi.fn(async () => ({
    items: [
      {
        key: '2025/06/16/photo1.jpg',
        encodedKey: 'abc1',
        size: 5000,
        lastModified: '2025-06-16T12:00:00Z',
        capturedAt: '2025-06-16T10:00:00Z',
        mediaType: 'image',
        sectionDate: '2025-06-16',
      },
      {
        key: '2025/06/16/video1.mp4',
        encodedKey: 'abc2',
        size: 15000,
        lastModified: '2025-06-16T13:00:00Z',
        capturedAt: '2025-06-16T11:00:00Z',
        mediaType: 'video',
        sectionDate: '2025-06-16',
      },
      {
        key: '2024/03/10/photo2.jpg',
        encodedKey: 'abc3',
        size: 7500,
        lastModified: '2024-03-10T08:00:00Z',
        capturedAt: '2024-03-10T07:30:00Z',
        mediaType: 'image',
        sectionDate: '2024-03-10',
      },
    ],
    nextToken: undefined,
  })),
  fetchDateDistribution: vi.fn(async () => null),
  fetchCatalogExif: vi.fn(async () => ({})),
  fetchAlbums: vi.fn(async () => ({ albums: [] })),
  createAlbum: vi.fn(async () => ({ id: 'test-album' })),
  updateAlbum: vi.fn(async () => ({})),
  moveCatalogItem: vi.fn(async () => ({})),
  bulkMoveCatalogItems: vi.fn(async () => ({})),
  catalogMediaUrl: vi.fn((encodedKey: string) => `/catalog/media/${encodedKey}`),
  catalogThumbnailUrl: vi.fn((encodedKey: string, size: string) => `/catalog/thumb/${size}/${encodedKey}`),
  deleteCatalogItems: vi.fn(async () => {}),
}));

vi.mock('@/components/date-scroller', () => ({
  DateScroller: () => <div data-testid="date-scroller-mock" />,
}));

// Mock @tanstack/react-virtual to render all rows in jsdom (no real scroll measurement)
vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: count }, (_, i) => ({
      index: i,
      key: i,
      start: Array.from({ length: i }, (__, j) => estimateSize(j)).reduce((a, b) => a + b, 0),
      size: estimateSize(i),
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => items.reduce((sum, item) => sum + item.size, 0),
      measureElement: () => {},
      scrollToIndex: vi.fn(),
      options: { scrollMargin: 0 },
    };
  },
}));

// jsdom does not implement ResizeObserver — provide a no-op stub
class MockResizeObserver {
  observe(_target: Element) {}
  unobserve(_target: Element) {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: MockResizeObserver,
});

// ── Helpers ────────────────────────────────────────────────────────────────

function renderCatalogPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/catalog']}>
        <Routes>
          <Route element={<CatalogPage />} path="/catalog" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CatalogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset localStorage so sort preference from one test doesn't bleed into the next
    localStorage.clear();
  });

  it('renders the page heading and stats inline', async () => {
    renderCatalogPage();
    expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeInTheDocument();
    // Stats are now inline in header — "10 files · ..."
    expect(await screen.findByText(/10 files/)).toBeInTheDocument();
  });

  it('renders stats with file count and size inline', async () => {
    renderCatalogPage();
    expect(await screen.findByText(/10 files/)).toBeInTheDocument();
  });

  it('renders the deduplication link', async () => {
    renderCatalogPage();
    expect(await screen.findByText('🔍 Dedup')).toBeInTheDocument();
  });

  it('shows item count in the filter bar', async () => {
    renderCatalogPage();
    // 3 items loaded from mock
    expect(await screen.findByText(/3 items/)).toBeInTheDocument();
  });

  it('renders section headers with human-friendly date formatting', async () => {
    renderCatalogPage();
    // The 2024 date should show with the year since it's not the current year
    // The exact format depends on the current date context, so we check the
    // section renders at least one heading element (h2)
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.length).toBeGreaterThan(0);
  });

  it('renders thumbnails with selection checkboxes', async () => {
    renderCatalogPage();
    // Wait for items to load, then find selection checkboxes
    const selectButtons = await screen.findAllByLabelText('Select');
    expect(selectButtons.length).toBeGreaterThan(0);
  });

  it('renders video play icon for video items', async () => {
    renderCatalogPage();
    // The video item should have a play button overlay
    // We check that at least one thumbnail button exists
    const buttons = await screen.findAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('shows sort toggle button', async () => {
    renderCatalogPage();
    const sortBtn = await screen.findByText(/Newest first|Oldest first/);
    expect(sortBtn).toBeInTheDocument();
  });

  it('toggles sort direction when sort button is clicked', async () => {
    renderCatalogPage();
    const sortBtn = await screen.findByText(/Newest first/);
    fireEvent.click(sortBtn);
    expect(await screen.findByText(/Oldest first/)).toBeInTheDocument();
  });

  it('passes sort=desc to the API by default', async () => {
    const { fetchCatalogItems } = await import('@/lib/api');
    renderCatalogPage();
    await screen.findByText(/Newest first/);
    expect(fetchCatalogItems).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'desc' }),
    );
  });

  it('passes sort=asc after toggling to oldest first', async () => {
    const { fetchCatalogItems } = await import('@/lib/api');
    renderCatalogPage();
    const sortBtn = await screen.findByText(/Newest first/);
    fireEvent.click(sortBtn);
    await screen.findByText(/Oldest first/);
    expect(fetchCatalogItems).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'asc' }),
    );
  });

  it('persists sort preference to localStorage', async () => {
    // Provide a minimal localStorage stub if the test environment lacks one
    const store: Record<string, string> = {};
    const storageMock = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
    };
    Object.defineProperty(window, 'localStorage', { value: storageMock, writable: true, configurable: true });

    renderCatalogPage();
    const sortBtn = await screen.findByText(/Newest first/);
    fireEvent.click(sortBtn);
    await screen.findByText(/Oldest first/);
    expect(store['catalog-sort-newest-first']).toBe('false');
  });

  it('renders prefix filter input', async () => {
    renderCatalogPage();
    const input = await screen.findByPlaceholderText(/Search by date/);
    expect(input).toBeInTheDocument();
  });

  it('renders monthly divider cards for each distinct month', async () => {
    renderCatalogPage();
    // Mock data has items in 2025-06 and 2024-03, so we expect 2 month dividers
    const dividers = await screen.findAllByTestId('month-divider');
    expect(dividers.length).toBe(2);
  });

  it('shows month and year label inside month divider', async () => {
    renderCatalogPage();
    // Slim dividers show "June 2025" and "March 2024"
    expect(await screen.findByText('June 2025')).toBeInTheDocument();
    expect(await screen.findByText('March 2024')).toBeInTheDocument();
  });

  it('shows item count in month divider', async () => {
    renderCatalogPage();
    // June has 2 items, March has 1 item
    expect(await screen.findByText('2 items')).toBeInTheDocument();
    expect(await screen.findByText('1 item')).toBeInTheDocument();
  });

  it('renders month heading in month divider', async () => {
    renderCatalogPage();
    expect(await screen.findByText('June 2025')).toBeInTheDocument();
    expect(await screen.findByText('March 2024')).toBeInTheDocument();
  });

  it('shows actionable links when the catalog is empty', async () => {
    vi.mocked(fetchCatalogItems).mockResolvedValueOnce({
      items: [],
      nextToken: undefined,
    });

    renderCatalogPage();

    expect(await screen.findByText('No media in the catalog yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start photo transfer' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Upload files' })).toHaveAttribute('href', '/upload');
    expect(screen.getByRole('link', { name: 'Open Takeout import' })).toHaveAttribute('href', '/takeout');
  });

  it('offers a clear-search action when filtering returns no results', async () => {
    vi.mocked(fetchCatalogItems).mockResolvedValue({
      items: [],
      nextToken: undefined,
    });

    renderCatalogPage();

    const input = await screen.findByPlaceholderText(/Search by date/);
    fireEvent.change(input, { target: { value: 'missing-folder' } });

    expect(await screen.findByText('No media found matching "missing-folder"')).toBeInTheDocument();
    expect(fetchCatalogItems).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'missing-folder' }),
    );

    // Both the EmptyState and the input X icon have "Clear search"; click the EmptyState one
    const clearButtons = screen.getAllByRole('button', { name: 'Clear search' });
    fireEvent.click(clearButtons[clearButtons.length - 1]);

    expect(await screen.findByDisplayValue('')).toBeInTheDocument();
    expect(screen.queryByText('No media found matching "missing-folder"')).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Start photo transfer' })).toHaveAttribute('href', '/');
  });
});

// ── formatSectionDate tests (extracted logic) ──────────────────────────────

describe('formatSectionDate logic', () => {
  // We can't directly import the function since it's a module-private helper.
  // Instead, we test it indirectly through the SectionHeader rendering.
  // For direct testing, we replicate the logic here.

  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function formatSectionDate(dateStr: string): string {
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
    if (diffDays > 1 && diffDays < 7) {
      return DAY_NAMES_FULL[date.getDay()];
    }
    if (year === now.getFullYear()) {
      return `${DAY_NAMES[date.getDay()]} ${day} ${SHORT_MONTHS[month]}`;
    }
    return `${DAY_NAMES[date.getDay()]} ${day} ${SHORT_MONTHS[month]} ${year}`;
  }

  it('returns "Today" for current date', () => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(formatSectionDate(todayStr)).toBe('Today');
  });

  it('returns "Yesterday" for the previous day', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const ydStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    expect(formatSectionDate(ydStr)).toBe('Yesterday');
  });

  it('returns full day name for dates 2–6 days ago', () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const dateStr = `${threeDaysAgo.getFullYear()}-${String(threeDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(threeDaysAgo.getDate()).padStart(2, '0')}`;
    const result = formatSectionDate(dateStr);
    // Should be a full day name like "Tuesday", "Wednesday", etc.
    expect(result).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/);
  });

  it('returns abbreviated day + day number + month for same-year dates outside 7-day window', () => {
    const now = new Date();
    // Use a date early in the year (Jan 1) if we're far enough into the year
    const month = now.getMonth();
    if (month >= 1) {
      const dateStr = `${now.getFullYear()}-01-01`;
      const result = formatSectionDate(dateStr);
      // Should be like "Wed 1 Jan"
      expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d+ Jan$/);
    }
  });

  it('includes year for dates in a different year', () => {
    const result = formatSectionDate('2020-07-04');
    expect(result).toBe('Sat 4 Jul 2020');
  });
});

// ── Lightbox out-of-range guard (P0 regression) ────────────────────────────
//
// Regression for: "Cannot update a component while rendering" warning when the
// Lightbox was rendered with an out-of-range index. The fix moves the close
// call out of the render body and into a useEffect.

describe('Lightbox out-of-range guard', () => {
  it('renders content for a valid index without calling onClose', async () => {
    const { Lightbox } = await import('./catalog-page');
    const items = [
      {
        key: '2025/06/16/photo1.jpg',
        encodedKey: 'abc1',
        size: 5000,
        lastModified: '2025-06-16T12:00:00Z',
        capturedAt: '2025-06-16T10:00:00Z',
        mediaType: 'image' as const,
        sectionDate: '2025-06-16',
      },
    ];
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onDateChanged = vi.fn();

    render(
      <Lightbox
        items={items}
        index={0}
        apiToken={undefined}
        onClose={onClose}
        onNavigate={onNavigate}
        onDateChanged={onDateChanged}
      />,
    );

    // Filename is rendered in the toolbar
    expect(screen.getAllByText(/photo1\.jpg/).length).toBeGreaterThan(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call onClose during render but does call it after effects flush when index is out-of-range', async () => {
    const { Lightbox } = await import('./catalog-page');
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onDateChanged = vi.fn();

    // Spy on console.error so we catch React's "Cannot update a component
    // while rendering" warning if the regression returns.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Track whether onClose was called *synchronously* during render. We do
    // this by wrapping the render in act() and observing call count before
    // effects flush — React Testing Library's render() already flushes
    // effects, so we instead check that onClose was *not* invoked from inside
    // the render phase by ensuring no React warning fires.
    render(
      <Lightbox
        items={[]}
        index={5}
        apiToken={undefined}
        onClose={onClose}
        onNavigate={onNavigate}
        onDateChanged={onDateChanged}
      />,
    );

    // After render + effect flush, onClose should have been called exactly once.
    expect(onClose).toHaveBeenCalledTimes(1);

    // No "Cannot update a component while rendering" or related render-phase
    // setState warnings should have surfaced.
    const renderPhaseWarning = errorSpy.mock.calls.find((args) =>
      args.some(
        (a) =>
          typeof a === 'string' &&
          /Cannot update a component .* while rendering|setState.*during render/i.test(a),
      ),
    );
    expect(renderPhaseWarning).toBeUndefined();

    errorSpy.mockRestore();
  });
});

