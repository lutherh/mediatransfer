import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PhotoTransferPage } from '@/pages/photo-transfer-page';

const mockFetchGoogleAuthStatus = vi.fn();
const mockFetchGoogleAuthUrl = vi.fn();
const mockCreatePickerSession = vi.fn();
const mockPollPickerSession = vi.fn();
const mockFetchPickedItems = vi.fn();
const mockCreateTransfer = vi.fn();
const mockFetchTransferDetail = vi.fn();
const mockPauseTransfer = vi.fn();
const mockResumeTransfer = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchGoogleAuthStatus: (...args: unknown[]) => mockFetchGoogleAuthStatus(...args),
  fetchGoogleAuthUrl: (...args: unknown[]) => mockFetchGoogleAuthUrl(...args),
  submitGoogleAuthCode: vi.fn(async () => ({ connected: true })),
  disconnectGoogle: vi.fn(),
  createPickerSession: (...args: unknown[]) => mockCreatePickerSession(...args),
  pollPickerSession: (...args: unknown[]) => mockPollPickerSession(...args),
  fetchPickedItems: (...args: unknown[]) => mockFetchPickedItems(...args),
  deletePickerSession: vi.fn(),
  createTransfer: (...args: unknown[]) => mockCreateTransfer(...args),
  fetchTransferDetail: (...args: unknown[]) => mockFetchTransferDetail(...args),
  pauseTransfer: (...args: unknown[]) => mockPauseTransfer(...args),
  resumeTransfer: (...args: unknown[]) => mockResumeTransfer(...args),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PhotoTransferPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PhotoTransferPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('renders page title and stepper', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({ configured: true, connected: false });
    mockFetchGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/auth' });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Photo Transfer' })).toBeInTheDocument();
    expect(screen.getByText('Transfer photos from Google Photos to your cloud storage')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Transfer progress' })).toBeInTheDocument();
  });

  it('starts at Connect step', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({ configured: true, connected: false });
    mockFetchGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/auth' });

    renderPage();

    expect(await screen.findByText('Connect Google Account')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Connect Google Account' })).toBeInTheDocument();
  });

  it('advances to Pick step when connected', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: true,
      connected: true,
      expired: false,
    });

    renderPage();

    const continueBtn = await screen.findByRole('button', { name: /continue to photo selection/i });
    fireEvent.click(continueBtn);

    expect(await screen.findByText('Select Photos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Photo Picker' })).toBeInTheDocument();
  });

  it('shows all 4 step labels in stepper', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({ configured: true, connected: false });
    mockFetchGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/auth' });

    renderPage();

    await screen.findByText('Connect');
    expect(screen.getByText('Select')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('full flow: connect → pick → review → transfer', async () => {
    // Step 1: User is already connected
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: true,
      connected: true,
    });

    renderPage();
    const continueBtn = await screen.findByRole('button', { name: /continue to photo selection/i });
    fireEvent.click(continueBtn);

    // Step 2: Create picker session and select photos
    mockCreatePickerSession.mockResolvedValue({
      sessionId: 'session-full-flow',
      pickerUri: 'https://photospicker.google.com/session-full-flow',
    });
    mockPollPickerSession.mockResolvedValue({
      sessionId: 'session-full-flow',
      mediaItemsSet: true,
    });
    mockFetchPickedItems.mockResolvedValue({
      mediaItems: [
        { id: 'f1', mimeType: 'image/jpeg', filename: 'beach.jpg' },
        { id: 'f2', mimeType: 'image/jpeg', filename: 'sunset.jpg' },
      ],
      nextPageToken: undefined,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Photo Picker' }));

    // Wait for selection to complete
    const continueBtn2 = await screen.findByRole('button', { name: /continue with 2 items/i });
    fireEvent.click(continueBtn2);

    // Step 3: Review
    expect(await screen.findByRole('heading', { name: 'Review Transfer' })).toBeInTheDocument();
    expect(screen.getByText('Google Photos')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);

    // Start transfer
    mockCreateTransfer.mockResolvedValue({
      job: { id: 'job-full-flow', status: 'PENDING', progress: 0 },
    });

    fireEvent.click(screen.getByRole('button', { name: /start transfer/i }));

    // Step 4: Transfer progress
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-full-flow',
        status: 'IN_PROGRESS',
        progress: 0.5,
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        createdAt: new Date().toISOString(),
      },
      logs: [],
    });

    expect(await screen.findByText('Transfer Status')).toBeInTheDocument();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
  });

  it('restores Review step when returning to page', async () => {
    window.sessionStorage.setItem(
      'photo-transfer-wizard-state-v1',
      JSON.stringify({
        currentStep: 2,
        selectedItems: [
          { id: 'restore-1', mimeType: 'image/jpeg', filename: 'restored.jpg' },
        ],
        sessionId: 'restore-session',
        jobId: '',
      }),
    );

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Review Transfer' })).toBeInTheDocument();
    expect(screen.getByText('Google Photos')).toBeInTheDocument();
  });
});
