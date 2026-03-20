import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PickPhotosStep } from '@/components/steps/pick-photos-step';

const mockCreatePickerSession = vi.fn();
const mockPollPickerSession = vi.fn();
const mockFetchPickedItems = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    createPickerSession: (...args: unknown[]) => mockCreatePickerSession(...args),
    pollPickerSession: (...args: unknown[]) => mockPollPickerSession(...args),
    fetchPickedItems: (...args: unknown[]) => mockFetchPickedItems(...args),
    deletePickerSession: vi.fn(),
  };
});

function renderStep(onPhotosSelected = vi.fn(), onBack = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onPhotosSelected,
    onBack,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PickPhotosStep onPhotosSelected={onPhotosSelected} onBack={onBack} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('PickPhotosStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows initial state with Open Photo Picker button', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Select Photos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Photo Picker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('calls onBack when Back button is clicked', () => {
    const onBack = vi.fn();
    renderStep(vi.fn(), onBack);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows loading state when creating session', async () => {
    mockCreatePickerSession.mockReturnValue(new Promise(() => {}));

    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo Picker' }));

    expect(await screen.findByText('Creating picker session...')).toBeInTheDocument();
  });

  it('shows error when session creation fails', async () => {
    mockCreatePickerSession.mockRejectedValue(new Error('Session failed'));

    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo Picker' }));

    expect(await screen.findByText(/failed to create picker session/i)).toBeInTheDocument();
  });

  it('shows selected items after picking', async () => {
    const mockItems = [
      { id: 'item-1', mimeType: 'image/jpeg', filename: 'photo1.jpg' },
      { id: 'item-2', mimeType: 'image/png', filename: 'photo2.png' },
      { id: 'item-3', mimeType: 'video/mp4', filename: 'video1.mp4' },
    ];

    mockCreatePickerSession.mockResolvedValue({
      sessionId: 'session-123',
      pickerUri: 'https://photospicker.google.com/sesion-123',
    });
    mockPollPickerSession.mockResolvedValue({
      sessionId: 'session-123',
      mediaItemsSet: true,
    });
    mockFetchPickedItems.mockResolvedValue({
      mediaItems: mockItems,
      nextPageToken: undefined,
    });

    const onPhotosSelected = vi.fn();
    renderStep(onPhotosSelected);

    fireEvent.click(screen.getByRole('button', { name: 'Open Photo Picker' }));

    // Wait for items to load after polling detects mediaItemsSet
    expect(await screen.findByText('3 Items Selected')).toBeInTheDocument();
    expect(screen.getByText(/2 photos, 1 video/)).toBeInTheDocument();

    // Continue button with count
    const continueBtn = screen.getByRole('button', { name: /continue with 3 items/i });
    expect(continueBtn).toBeInTheDocument();

    fireEvent.click(continueBtn);
    expect(onPhotosSelected).toHaveBeenCalledWith(mockItems, 'session-123');
  });

  it('shows no items state when selection is empty', async () => {
    mockCreatePickerSession.mockResolvedValue({
      sessionId: 'session-456',
      pickerUri: 'https://photospicker.google.com/session-456',
    });
    mockPollPickerSession.mockResolvedValue({
      sessionId: 'session-456',
      mediaItemsSet: true,
    });
    mockFetchPickedItems.mockResolvedValue({
      mediaItems: [],
      nextPageToken: undefined,
    });

    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo Picker' }));

    expect(await screen.findByText('No Photos Selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('allows picking different photos after selection', async () => {
    mockCreatePickerSession.mockResolvedValue({
      sessionId: 'session-789',
      pickerUri: 'https://photospicker.google.com/session-789',
    });
    mockPollPickerSession.mockResolvedValue({
      sessionId: 'session-789',
      mediaItemsSet: true,
    });
    mockFetchPickedItems.mockResolvedValue({
      mediaItems: [{ id: 'item-1', mimeType: 'image/jpeg', filename: 'photo1.jpg' }],
      nextPageToken: undefined,
    });

    renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo Picker' }));

    expect(await screen.findByText('1 Items Selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pick different photos/i })).toBeInTheDocument();
  });
});
