import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ReviewTransferStep } from '@/components/steps/review-transfer-step';
import type { PickedMediaItem } from '@/lib/api';

const mockCreateTransfer = vi.fn();

vi.mock('@/lib/api', () => ({
  createTransfer: (...args: unknown[]) => mockCreateTransfer(...args),
}));

const mockItems: PickedMediaItem[] = [
  { id: 'item-1', mimeType: 'image/jpeg', filename: 'vacation-photo.jpg', createTime: '2025-06-15T10:30:00Z' },
  { id: 'item-2', mimeType: 'image/png', filename: 'screenshot.png', createTime: '2025-06-16T14:20:00Z' },
  { id: 'item-3', mimeType: 'video/mp4', filename: 'birthday-video.mp4', createTime: '2025-07-01T18:00:00Z' },
];

function renderStep(onTransferCreated = vi.fn(), onBack = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onTransferCreated,
    onBack,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ReviewTransferStep
            items={mockItems}
            sessionId="session-abc123"
            onTransferCreated={onTransferCreated}
            onBack={onBack}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('ReviewTransferStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows transfer summary', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Review Transfer' })).toBeInTheDocument();
    expect(screen.getByText('Google Photos')).toBeInTheDocument();
    expect(screen.getByText('scaleway')).toBeInTheDocument();
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/2 photos, 1 video/i)).toBeInTheDocument();
  });

  it('shows truncated session ID', () => {
    renderStep();
    expect(screen.getByText(/session-abc123/i)).toBeInTheDocument();
  });

  it('has an expandable items list', () => {
    renderStep();
    const details = screen.getByText(/view selected items/i);
    expect(details).toBeInTheDocument();

    // Click to expand
    fireEvent.click(details);
    expect(screen.getByText('vacation-photo.jpg')).toBeInTheDocument();
    expect(screen.getByText('screenshot.png')).toBeInTheDocument();
    expect(screen.getByText('birthday-video.mp4')).toBeInTheDocument();
  });

  it('shows file types in the item list', () => {
    renderStep();
    fireEvent.click(screen.getByText(/view selected items/i));
    expect(screen.getByText('image/jpeg')).toBeInTheDocument();
    expect(screen.getByText('video/mp4')).toBeInTheDocument();
  });

  it('starts transfer on button click', async () => {
    mockCreateTransfer.mockResolvedValue({
      job: { id: 'job-new-1', status: 'PENDING', progress: 0 },
    });

    const onTransferCreated = vi.fn();
    renderStep(onTransferCreated);

    const startBtn = screen.getByRole('button', { name: /start transfer/i });
    expect(startBtn).toBeInTheDocument();

    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(onTransferCreated).toHaveBeenCalledWith('job-new-1');
    });

    expect(mockCreateTransfer.mock.calls[0][0]).toEqual({
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      keys: ['item-1', 'item-2', 'item-3'],
      sourceConfig: {
        sessionId: 'session-abc123',
      },
    });
  });

  it('shows error on transfer creation failure', async () => {
    mockCreateTransfer.mockRejectedValue(new Error('Queue full'));

    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /start transfer/i }));

    expect(await screen.findByText(/queue full/i)).toBeInTheDocument();
  });

  it('calls onBack when Back button is clicked', () => {
    const onBack = vi.fn();
    renderStep(vi.fn(), onBack);

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('disables buttons while transfer is being created', async () => {
    mockCreateTransfer.mockReturnValue(new Promise(() => {})); // never resolves

    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /start transfer/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /starting transfer/i })).toBeDisabled();
    });
  });
});
