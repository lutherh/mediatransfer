/**
 * @file Tests for the Catalog Undated Page.
 *
 * Validates:
 *   • Empty state when no undated items exist
 *   • Stats card rendering with file counts and sizes
 *   • Thumbnail grid rendering
 *   • Selection: toggle, select all, clear
 *   • Selection toolbar with assign date and delete buttons
 *   • Assign date modal interaction
 *   • Delete confirmation flow
 *   • Error state when fetch fails
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CatalogUndatedPage } from './catalog-undated-page';

// ── Mocks ──────────────────────────────────────────────────────────────────

const MOCK_UNDATED_ITEMS = [
  {
    key: 'unknown-date/photo1.jpg',
    encodedKey: 'enc1',
    size: 5000,
    lastModified: '2025-06-16T12:00:00Z',
    capturedAt: '',
    mediaType: 'image' as const,
    sectionDate: 'unknown-date',
  },
  {
    key: 'unknown-date/video1.mp4',
    encodedKey: 'enc2',
    size: 15000,
    lastModified: '2025-06-16T13:00:00Z',
    capturedAt: '',
    mediaType: 'video' as const,
    sectionDate: 'unknown-date',
  },
  {
    key: 'unknown-date/photo2.jpg',
    encodedKey: 'enc3',
    size: 7500,
    lastModified: '2024-03-10T08:00:00Z',
    capturedAt: '',
    mediaType: 'image' as const,
    sectionDate: 'unknown-date',
  },
];

const mockFetchUndatedItems = vi.fn(async () => ({ items: MOCK_UNDATED_ITEMS }));
const mockBulkMoveCatalogItems = vi.fn(async () => ({ moved: [{ from: 'a', to: 'b' }], failed: [] }));
const mockDeleteCatalogItems = vi.fn(async () => {});
const mockFetchTakeoutActionStatus = vi.fn(async () => ({
  running: false,
  action: undefined,
  output: [],
}));
const mockRunTakeoutAction = vi.fn(async () => ({
  message: 'started',
  status: { running: true, action: 'repair-dates-s3', output: [] },
}));

vi.mock('@/lib/api', () => ({
  fetchUndatedItems: (...args: unknown[]) => mockFetchUndatedItems(...args),
  bulkMoveCatalogItems: (...args: unknown[]) => mockBulkMoveCatalogItems(...args),
  deleteCatalogItems: (...args: unknown[]) => mockDeleteCatalogItems(...args),
  fetchTakeoutActionStatus: (...args: unknown[]) => mockFetchTakeoutActionStatus(...args),
  runTakeoutAction: (...args: unknown[]) => mockRunTakeoutAction(...args),
  catalogThumbnailUrl: (encodedKey: string, size: string) => `/catalog/thumb/${size}/${encodedKey}`,
}));

vi.mock('@/lib/use-api-token', () => ({
  useApiToken: () => undefined,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/catalog/undated']}>
        <Routes>
          <Route element={<CatalogUndatedPage />} path="/catalog/undated" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CatalogUndatedPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUndatedItems.mockResolvedValue({ items: MOCK_UNDATED_ITEMS });
  });

  it('renders the page heading', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Undated Media' })).toBeInTheDocument();
  });

  it('renders stats card with file count and breakdown', async () => {
    renderPage();
    expect(await screen.findByText(/Files:/)).toBeInTheDocument();
    expect(screen.getByText(/Photos:/)).toBeInTheDocument();
    expect(screen.getByText(/Videos:/)).toBeInTheDocument();
  });

  it('renders thumbnail grid with all items', async () => {
    renderPage();
    // Each item gets a button (the thumbnail tile)
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    expect(buttons.length).toBe(3);
  });

  it('shows video badge on video items', async () => {
    renderPage();
    expect(await screen.findByText('▶ Video')).toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────────────

  it('shows empty state when no undated items exist', async () => {
    mockFetchUndatedItems.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText('No undated media')).toBeInTheDocument();
    expect(screen.getByText(/All your media files have a detected capture date/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Catalog' })).toHaveAttribute('href', '/catalog');
  });

  // ── Error state ────────────────────────────────────────────────────────

  it('shows error message when fetch fails', async () => {
    mockFetchUndatedItems.mockRejectedValue(new Error('Network error'));
    renderPage();
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  // ── Selection ──────────────────────────────────────────────────────────

  it('shows selection toolbar when an item is clicked', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
  });

  it('toggles selection on second click', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    // Click again to deselect
    fireEvent.click(buttons[0]);
    await waitFor(() => {
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });

  it('select all button selects all items', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    // Select one first
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    // Click "Select all"
    fireEvent.click(screen.getByText(/Select all 3/));
    expect(await screen.findByText('3 selected')).toBeInTheDocument();
  });

  it('clear selection button clears selection', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    // The clear button is the X icon button
    fireEvent.click(screen.getByTitle('Clear selection'));
    await waitFor(() => {
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });

  // ── Assign date flow ─────────────────────────────────────────────────

  it('shows Assign Date button in selection toolbar', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByRole('button', { name: /Assign Date/ })).toBeInTheDocument();
  });

  it('opens the assign date modal and submits', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);

    // Open modal
    fireEvent.click(await screen.findByRole('button', { name: /Assign Date/ }));
    const modal = await screen.findByRole('heading', { name: 'Assign Date' });
    expect(modal).toBeInTheDocument();
    expect(screen.getByText(/Move 1 file to a dated folder/)).toBeInTheDocument();

    // The date input and submit button
    const dateInput = screen.getByLabelText('Capture date');
    fireEvent.change(dateInput, { target: { value: '2024-06-15' } });

    // Submit via form submission
    const form = dateInput.closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockBulkMoveCatalogItems).toHaveBeenCalled();
    });
  });

  // ── Delete flow ──────────────────────────────────────────────────────

  it('shows delete confirmation before actually deleting', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);

    // Click the Delete button in the toolbar
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));

    // Confirmation prompt appears
    expect(await screen.findByText(/Permanently delete 1 file\?/)).toBeInTheDocument();
  });

  it('executes delete after confirmation', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);

    // Click Delete → confirm
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText(/Permanently delete/)).toBeInTheDocument();

    // Click the confirmation Delete button
    const confirmBtn = screen.getAllByRole('button', { name: /Delete/ })
      .find(btn => btn.textContent === 'Delete');
    expect(confirmBtn).toBeDefined();
    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      expect(mockDeleteCatalogItems).toHaveBeenCalledWith(['enc1']);
    });
  });

  it('cancel button in delete confirmation hides the prompt', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /photo|video/i });
    fireEvent.click(buttons[0]);

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText(/Permanently delete/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText(/Permanently delete/)).not.toBeInTheDocument();
    });
  });

  // ── Auto-detect dates ────────────────────────────────────────────────

  it('renders auto-detect dates panel with detect button', async () => {
    renderPage();
    expect(await screen.findByText('Auto-detect dates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Detect dates/ })).toBeInTheDocument();
  });

  // ── Back link ────────────────────────────────────────────────────────

  it('has a back link to the catalog', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: '← Catalog' });
    expect(link).toHaveAttribute('href', '/catalog');
  });
});
