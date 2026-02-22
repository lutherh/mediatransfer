import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { TransfersListPage } from '@/pages/transfers-list-page';
import { NewTransferPage } from '@/pages/new-transfer-page';
import { TransferDetailPage } from '@/pages/transfer-detail-page';
import { TakeoutProgressPage } from '@/pages/takeout-progress-page';

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
}));

function renderRoute(path: string) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />} path="/">
            <Route element={<TransfersListPage />} index />
            <Route element={<TakeoutProgressPage />} path="takeout" />
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

  it('renders transfers list page', async () => {
    renderRoute('/');
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
    expect(await screen.findByText(/transfer job started/i)).toBeInTheDocument();
  });
});
