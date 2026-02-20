import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { TransfersListPage } from '@/pages/transfers-list-page';
import { NewTransferPage } from '@/pages/new-transfer-page';
import { TransferDetailPage } from '@/pages/transfer-detail-page';

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

  it('renders transfer detail page', async () => {
    renderRoute('/transfers/job-1');
    expect(await screen.findByText('Transfer Detail')).toBeInTheDocument();
    expect(await screen.findByText(/transfer job started/i)).toBeInTheDocument();
  });
});
