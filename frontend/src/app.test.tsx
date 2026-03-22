import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { TransfersListPage } from '@/pages/transfers-list-page';
import { NewTransferPage } from '@/pages/new-transfer-page';
import { TransferDetailPage } from '@/pages/transfer-detail-page';
import { TakeoutProgressPage } from '@/pages/takeout-progress-page';
import { PhotoTransferPage } from '@/pages/photo-transfer-page';
import { OAuthCallbackPage } from '@/pages/oauth-callback-page';
import { CostsPage } from '@/pages/costs-page';
import { CatalogPage } from '@/pages/catalog-page';

vi.mock('@/lib/api', () => ({
  fetchTransfers: vi.fn(async () => [
    {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      status: 'IN_PROGRESS',
      progress: 0.5,
      createdAt: new Date().toISOString(),
    },
  ]),
  fetchTransferDetail: vi.fn(async () => ({
    job: {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      status: 'IN_PROGRESS',
      progress: 0.5,
      createdAt: new Date().toISOString(),
    },
    logs: [
      {
        id: 'log-1',
        level: 'INFO',
        message: 'Transfer job started',
        createdAt: new Date().toISOString(),
      },
    ],
  })),
  fetchCloudUsage: vi.fn(async () => ({
    provider: 'scaleway',
    bucket: 'photos-bucket',
    region: 'nl-ams',
    prefix: 'photos',
    totalObjects: 50,
    totalBytes: 50 * 1024 * 1024 * 1024,
    totalGB: 50,
    bucketType: 'standard',
    pricing: {
      currency: 'USD',
      pricePerGBMonthly: 0.023,
    },
    estimatedMonthlyCost: 1.15,
    measuredAt: new Date().toISOString(),
    note: 'Estimate includes storage only.',
  })),
  pauseTransfer: vi.fn(async () => ({ message: 'Paused' })),
  resumeTransfer: vi.fn(async () => ({ message: 'Resumed' })),
  retryTransferItem: vi.fn(async () => ({ message: 'Retry queued' })),
  queueAllTransferItems: vi.fn(async () => ({ message: 'Queued all' })),
  fetchTakeoutStatus: vi.fn(async () => ({
    paths: {
      inputDir: 'data/takeout/input',
      workDir: 'data/takeout/work',
      manifestPath: 'data/takeout/work/manifest.jsonl',
      statePath: 'data/takeout/state.json',
    },
    counts: {
      total: 18,
      processed: 18,
      pending: 0,
      uploaded: 10,
      skipped: 8,
      failed: 0,
    },
    progress: 1,
    stateUpdatedAt: new Date().toISOString(),
    recentFailures: [],
    isComplete: true,
  })),
  fetchTakeoutActionStatus: vi.fn(async () => ({
    running: false,
    action: 'verify',
    success: true,
    exitCode: 0,
    output: [],
  })),
  setAutoUpload: vi.fn(async () => ({ enabled: true })),
  runTakeoutAction: vi.fn(),
  createTransfer: vi.fn(),
  fetchGoogleAuthStatus: vi.fn(async () => ({
    configured: true,
    connected: false,
  })),
  fetchGoogleAuthUrl: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/auth' })),
  submitGoogleAuthCode: vi.fn(async () => ({ connected: true })),
  disconnectGoogle: vi.fn(),
  createPickerSession: vi.fn(),
  pollPickerSession: vi.fn(),
  fetchPickedItems: vi.fn(),
  deletePickerSession: vi.fn(),
  fetchCatalogStats: vi.fn(async () => ({
    totalFiles: 42,
    totalBytes: 1_073_741_824,
    imageCount: 40,
    videoCount: 2,
    oldestDate: '2022-01-01',
    newestDate: '2026-02-31',
  })),
  fetchCatalogItems: vi.fn(async () => ({ items: [], nextToken: undefined })),
  catalogMediaUrl: vi.fn((encodedKey: string) => `/catalog/media/${encodedKey}`),
}));

function renderRoute(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<OAuthCallbackPage />} path="auth/google/callback" />
          <Route element={<Layout />} path="/">
            <Route element={<PhotoTransferPage />} index />
            <Route element={<TakeoutProgressPage />} path="takeout" />
            <Route element={<TransfersListPage />} path="transfers" />
            <Route element={<CatalogPage />} path="catalog" />
            <Route element={<CostsPage />} path="costs" />
            <Route element={<NewTransferPage />} path="transfers/new" />
            <Route element={<TransferDetailPage />} path="transfers/:id" />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('frontend pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders photo transfer page (home) with connect step', async () => {
    renderRoute('/');
    expect(await screen.findByRole('heading', { name: 'Photo Transfer' })).toBeInTheDocument();
    expect(await screen.findByText('Connect Google Account')).toBeInTheDocument();
  });

  it('renders transfers list page', async () => {
    renderRoute('/transfers');
    expect(await screen.findByText('Transfers')).toBeInTheDocument();
    const googlePhotosElements = await screen.findAllByText(/google-photos/i);
    expect(googlePhotosElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders new transfer page', async () => {
    renderRoute('/transfers/new');
    expect(await screen.findByRole('heading', { name: 'New Transfer' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /create transfer/i })).toBeInTheDocument();
  });

  it('renders takeout progress page', async () => {
    renderRoute('/takeout');
    expect(await screen.findByRole('heading', { name: 'Google Takeout' })).toBeInTheDocument();
    expect(await screen.findByText(/migrate your google photos library/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /repair wrong dates/i })).toBeInTheDocument();
  });

  it('renders transfer detail page', async () => {
    renderRoute('/transfers/job-1');
    expect(await screen.findByText('Transfer Detail')).toBeInTheDocument();
    expect(await screen.findByText('Transfer in progress')).toBeInTheDocument();
    expect(await screen.findByText(/transfer job started/i)).toBeInTheDocument();
  });

  it('renders costs page', async () => {
    renderRoute('/costs');
    expect(await screen.findByRole('heading', { name: 'Costs' })).toBeInTheDocument();
    expect(await screen.findByText('Detailed cost estimate')).toBeInTheDocument();
  });

  it('renders catalog page', async () => {
    renderRoute('/catalog');
    expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeInTheDocument();
    expect(await screen.findByText(/your photos and videos/i)).toBeInTheDocument();
  });

  it('shows navigation links', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: 'Photo Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Takeout' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Transfers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Costs' })).toBeInTheDocument();
  });

  it('shows error state when last scan failed', async () => {
    const api = await import('@/lib/api');
    vi.mocked(api.fetchTakeoutActionStatus).mockResolvedValueOnce({
      running: false,
      action: 'scan',
      success: false,
      exitCode: 1,
      output: ['❌ Takeout scan failed:', '   No media files found'],
    });

    renderRoute('/takeout');
    expect(await screen.findByRole('button', { name: /retry scan/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /continue with upload anyway/i })).toBeInTheDocument();
  });
});
