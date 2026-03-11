import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SequenceAnalysisPage } from '@/pages/sequence-analysis-page';

const mockFetchSequenceAnalysis = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchSequenceAnalysis: (...args: unknown[]) => mockFetchSequenceAnalysis(...args),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/takeout/sequences']}>
        <SequenceAnalysisPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const COMPLETE_ANALYSIS = {
  groups: [
    {
      prefix: 'takeout-20260308T081854Z',
      declaredTotal: 3,
      extension: '.tgz',
      present: [1, 2, 3],
      missing: [],
      isComplete: true,
      maxSeen: 3,
      totalSizeBytes: 3_221_225_472,
      totalMediaBytes: 3_000_000_000,
      totalEntries: 1500,
      totalUploaded: 1500,
      totalSkipped: 0,
      totalFailed: 0,
      errors: [],
    },
  ],
  totalArchives: 3,
  unrecognised: [],
  archiveDetails: {
    'takeout-20260308T081854Z-3-001.tgz': { status: 'completed', entryCount: 500, uploadedCount: 500, skippedCount: 0, failedCount: 0, archiveSizeBytes: 1_073_741_824 },
    'takeout-20260308T081854Z-3-002.tgz': { status: 'completed', entryCount: 500, uploadedCount: 500, skippedCount: 0, failedCount: 0, archiveSizeBytes: 1_073_741_824 },
    'takeout-20260308T081854Z-3-003.tgz': { status: 'completed', entryCount: 500, uploadedCount: 500, skippedCount: 0, failedCount: 0, archiveSizeBytes: 1_073_741_824 },
  },
};

const INCOMPLETE_ANALYSIS = {
  groups: [
    {
      prefix: 'takeout-20260308T081854Z',
      declaredTotal: 4,
      extension: '.tgz',
      present: [1, 3, 4],
      missing: [2],
      isComplete: false,
      maxSeen: 4,
      totalSizeBytes: 2_147_483_648,
      totalMediaBytes: 2_000_000_000,
      totalEntries: 900,
      totalUploaded: 900,
      totalSkipped: 0,
      totalFailed: 0,
      errors: [],
    },
    {
      prefix: 'takeout-20260310T120000Z',
      declaredTotal: 2,
      extension: '.tgz',
      present: [1, 2],
      missing: [],
      isComplete: true,
      maxSeen: 2,
      totalSizeBytes: 1_073_741_824,
      totalMediaBytes: 1_000_000_000,
      totalEntries: 600,
      totalUploaded: 600,
      totalSkipped: 0,
      totalFailed: 0,
      errors: [],
    },
  ],
  totalArchives: 5,
  unrecognised: [],
  archiveDetails: {
    'takeout-20260308T081854Z-4-001.tgz': { status: 'completed', entryCount: 300, uploadedCount: 300, skippedCount: 0, failedCount: 0, archiveSizeBytes: 715_827_882 },
    'takeout-20260308T081854Z-4-003.tgz': { status: 'completed', entryCount: 300, uploadedCount: 300, skippedCount: 0, failedCount: 0, archiveSizeBytes: 715_827_882 },
    'takeout-20260308T081854Z-4-004.tgz': { status: 'completed', entryCount: 300, uploadedCount: 300, skippedCount: 0, failedCount: 0, archiveSizeBytes: 715_827_884 },
    'takeout-20260310T120000Z-2-001.tgz': { status: 'completed', entryCount: 300, uploadedCount: 300, skippedCount: 0, failedCount: 0, archiveSizeBytes: 536_870_912 },
    'takeout-20260310T120000Z-2-002.tgz': { status: 'completed', entryCount: 300, uploadedCount: 300, skippedCount: 0, failedCount: 0, archiveSizeBytes: 536_870_912 },
  },
};

describe('SequenceAnalysisPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    mockFetchSequenceAnalysis.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText(/loading archive data/i)).toBeInTheDocument();
  });

  it('renders error state on fetch failure', async () => {
    mockFetchSequenceAnalysis.mockRejectedValue(new Error('Network error'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/failed to load sequence analysis/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it('renders page heading and description', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Archive Sequence Analysis' })).toBeInTheDocument();
    expect(screen.getByText(/checks whether any parts are missing/i)).toBeInTheDocument();
  });

  it('renders breadcrumb with Takeout link', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    const link = await screen.findByRole('link', { name: 'Takeout' });
    expect(link).toHaveAttribute('href', '/takeout');
  });

  it('renders summary cards for a complete set', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Total Archives')).toBeInTheDocument();
    });
    // "Complete Sets" text appears both in summary card and section heading
    expect(screen.getAllByText('Complete Sets').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Missing Parts')).toBeInTheDocument();
  });

  it('renders Complete badge for a fully present group', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    expect(await screen.findByText('Complete')).toBeInTheDocument();
  });

  it('renders missing count badge for incomplete group', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(INCOMPLETE_ANALYSIS);
    renderPage();
    expect(await screen.findByText('1 missing')).toBeInTheDocument();
  });

  it('shows missing archive filename in the red callout', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(INCOMPLETE_ANALYSIS);
    renderPage();
    expect(
      await screen.findByText('takeout-20260308T081854Z-4-002.tgz'),
    ).toBeInTheDocument();
  });

  it('renders Incomplete Sets and Complete Sets section headings', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(INCOMPLETE_ANALYSIS);
    renderPage();
    // The section headings are h2 elements; the summary card also has "Incomplete Sets" label
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Incomplete Sets' })).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Complete Sets' })).toBeInTheDocument();
  });

  it('renders the colour legend', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Present')).toBeInTheDocument();
    expect(screen.getByText('Missing / Failed')).toBeInTheDocument();
  });

  it('renders empty state when there are no groups', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue({
      groups: [],
      totalArchives: 0,
      unrecognised: [],
      archiveDetails: {},
    });
    renderPage();
    expect(
      await screen.findByText(/no takeout archives found/i),
    ).toBeInTheDocument();
  });

  it('renders unrecognised archives section', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue({
      ...COMPLETE_ANALYSIS,
      unrecognised: ['random-file.zip', 'other.tar'],
    });
    renderPage();
    expect(await screen.findByText('Unrecognised Archives')).toBeInTheDocument();
    expect(screen.getByText('random-file.zip')).toBeInTheDocument();
    expect(screen.getByText('other.tar')).toBeInTheDocument();
  });

  it('renders sequence grid squares for each part', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();

    // 3-part complete sequence should render squares labeled 1, 2, 3
    await waitFor(() => {
      const group = screen.getByText('takeout-20260308T081854Z');
      expect(group).toBeInTheDocument();
    });

    // The sequence grid should contain the numbers
    const squares = screen.getAllByTitle(/^#\d+ —/);
    expect(squares.length).toBeGreaterThanOrEqual(3);
  });

  it('displays group metadata (extension, declared total, found count)', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(INCOMPLETE_ANALYSIS);
    renderPage();
    // The incomplete group displays ".tgz · Declared: 4 parts · Found: 3/4"
    await waitFor(() => {
      expect(screen.getByText(/Declared: 4 parts/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Found: 3\/4/)).toBeInTheDocument();
  });

  it('shows total archive size in summary cards', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Total Archive Size').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows total entries in summary cards', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Total Entries').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows failed entries count when present', async () => {
    const withFailures = {
      ...COMPLETE_ANALYSIS,
      groups: [
        {
          ...COMPLETE_ANALYSIS.groups[0],
          totalFailed: 12,
          errors: ['Part 2: Upload timeout'],
        },
      ],
    };
    mockFetchSequenceAnalysis.mockResolvedValue(withFailures);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Failed Entries')).toBeInTheDocument();
      // The group stats row should also show the "Failed: 12" text
      expect(screen.getByText(/Failed:/)).toBeInTheDocument();
    });
  });

  it('shows group-level size and entry stats', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    await waitFor(() => {
      // Group stats row
      expect(screen.getByText(/Entries:/)).toBeInTheDocument();
    });
  });

  it('shows processing errors section in group card', async () => {
    const withErrors = {
      ...COMPLETE_ANALYSIS,
      groups: [
        {
          ...COMPLETE_ANALYSIS.groups[0],
          errors: ['Part 1: Extraction failed', 'Part 3: Upload timeout'],
        },
      ],
    };
    mockFetchSequenceAnalysis.mockResolvedValue(withErrors);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Processing errors:')).toBeInTheDocument();
    });
    expect(screen.getByText('Part 1: Extraction failed')).toBeInTheDocument();
    expect(screen.getByText('Part 3: Upload timeout')).toBeInTheDocument();
  });

  it('shows rich tooltip on sequence squares', async () => {
    mockFetchSequenceAnalysis.mockResolvedValue(COMPLETE_ANALYSIS);
    renderPage();
    await waitFor(() => {
      const square = screen.getByTitle(/^#1 — Completed/);
      expect(square).toBeInTheDocument();
      // Tooltip includes size and entry count
      expect(square.getAttribute('title')).toContain('1.0 GB');
      expect(square.getAttribute('title')).toContain('500 entries');
    });
  });

  it('hides stats row when no size/entries data', async () => {
    const noStats = {
      ...COMPLETE_ANALYSIS,
      groups: [
        {
          ...COMPLETE_ANALYSIS.groups[0],
          totalSizeBytes: 0,
          totalMediaBytes: 0,
          totalEntries: 0,
          totalUploaded: 0,
        },
      ],
    };
    mockFetchSequenceAnalysis.mockResolvedValue(noStats);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('takeout-20260308T081854Z')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Entries:/)).not.toBeInTheDocument();
  });
});
