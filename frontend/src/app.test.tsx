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
    expect(await screen.findByText(/google-photos/i)).toBeInTheDocument();
  });

  it('renders new transfer page', async () => {
    renderRoute('/transfers/new');
    expect(await screen.findByRole('heading', { name: 'New Transfer' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /create transfer/i })).toBeInTheDocument();
  });

  it('renders takeout progress page', async () => {
    renderRoute('/takeout');
    expect(await screen.findByRole('heading', { name: 'Takeout Transfer Progress' })).toBeInTheDocument();
    expect(await screen.findByText('Overall progress')).toBeInTheDocument();
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
    expect(await screen.findByTitle('Scaleway Catalog Browser')).toBeInTheDocument();
  });

  it('shows navigation links', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: 'Photo Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Takeout Progress' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Transfers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Costs' })).toBeInTheDocument();
  });
});
