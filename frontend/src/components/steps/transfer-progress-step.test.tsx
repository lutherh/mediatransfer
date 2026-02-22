import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TransferProgressStep } from '@/components/steps/transfer-progress-step';

const mockFetchTransferDetail = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchTransferDetail: (...args: unknown[]) => mockFetchTransferDetail(...args),
}));

function renderStep(jobId = 'job-1', totalItems = 5, onStartNew = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onStartNew,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TransferProgressStep jobId={jobId} totalItems={totalItems} onStartNew={onStartNew} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('TransferProgressStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    mockFetchTransferDetail.mockReturnValue(new Promise(() => {}));
    renderStep();
    expect(screen.getByText('Loading transfer status...')).toBeInTheDocument();
  });

  it('shows in-progress transfer', async () => {
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-1',
        status: 'IN_PROGRESS',
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        progress: 0.6,
        createdAt: new Date().toISOString(),
      },
      logs: [
        { id: 'l1', level: 'INFO', message: 'Starting transfer', createdAt: new Date().toISOString() },
      ],
    });

    renderStep('job-1', 10);

    expect(await screen.findByText('Transfer Status')).toBeInTheDocument();
    expect(screen.getAllByText('In Progress')).toHaveLength(2);
    expect(screen.getAllByText('60%')).toHaveLength(2);
    expect(screen.getByText('10')).toBeInTheDocument(); // total items
    expect(screen.getByText('Starting transfer')).toBeInTheDocument();
  });

  it('shows completed transfer with success message', async () => {
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-2',
        status: 'COMPLETED',
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        progress: 1,
        createdAt: new Date().toISOString(),
      },
      logs: [],
    });

    renderStep('job-2', 5);

    expect(await screen.findAllByText('Completed')).toHaveLength(2);
    expect(screen.getByText(/transfer completed successfully/i)).toBeInTheDocument();
    expect(screen.getAllByText('100%')).toHaveLength(2);
  });

  it('shows failed transfer with error message', async () => {
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-3',
        status: 'FAILED',
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        progress: 0.3,
        createdAt: new Date().toISOString(),
      },
      logs: [
        { id: 'l1', level: 'ERROR', message: 'Connection timeout', createdAt: new Date().toISOString() },
      ],
    });

    renderStep('job-3', 5);

    expect(await screen.findAllByText('Failed')).toHaveLength(2);
    expect(screen.getByText(/transfer failed/i)).toBeInTheDocument();
    expect(screen.getByText('Connection timeout')).toBeInTheDocument();
  });

  it('shows Start New Transfer button when finished', async () => {
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-4',
        status: 'COMPLETED',
        progress: 1,
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        createdAt: new Date().toISOString(),
      },
      logs: [],
    });

    renderStep('job-4', 5);

    expect(await screen.findByRole('button', { name: /start new transfer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view full details/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /all transfers/i })).toBeInTheDocument();
  });

  it('shows error when API call fails', async () => {
    mockFetchTransferDetail.mockRejectedValue(new Error('API error'));

    renderStep();
    expect(await screen.findByText(/failed to load transfer status/i)).toBeInTheDocument();
  });

  it('shows progress bar with correct value', async () => {
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-5',
        status: 'IN_PROGRESS',
        progress: 0.75,
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        createdAt: new Date().toISOString(),
      },
      logs: [],
    });

    renderStep('job-5', 8);

    const progressBar = await screen.findByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '75');
  });

  it('shows log levels with appropriate styling', async () => {
    mockFetchTransferDetail.mockResolvedValue({
      job: {
        id: 'job-6',
        status: 'IN_PROGRESS',
        progress: 0.5,
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        createdAt: new Date().toISOString(),
      },
      logs: [
        { id: 'l1', level: 'INFO', message: 'Started upload', createdAt: new Date().toISOString() },
        { id: 'l2', level: 'WARN', message: 'Slow connection', createdAt: new Date().toISOString() },
        { id: 'l3', level: 'ERROR', message: 'Item failed', createdAt: new Date().toISOString() },
      ],
    });

    renderStep('job-6', 10);

    expect(await screen.findByText('Started upload')).toBeInTheDocument();
    expect(screen.getByText('Slow connection')).toBeInTheDocument();
    expect(screen.getByText('Item failed')).toBeInTheDocument();
  });
});
