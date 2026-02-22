import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ConnectGoogleStep } from '@/components/steps/connect-google-step';

const mockFetchGoogleAuthStatus = vi.fn();
const mockFetchGoogleAuthUrl = vi.fn();
const mockSubmitGoogleAuthCode = vi.fn();
const mockDisconnectGoogle = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchGoogleAuthStatus: (...args: unknown[]) => mockFetchGoogleAuthStatus(...args),
  fetchGoogleAuthUrl: (...args: unknown[]) => mockFetchGoogleAuthUrl(...args),
  submitGoogleAuthCode: (...args: unknown[]) => mockSubmitGoogleAuthCode(...args),
  disconnectGoogle: (...args: unknown[]) => mockDisconnectGoogle(...args),
}));

function renderStep(onConnected = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onConnected,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ConnectGoogleStep onConnected={onConnected} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('ConnectGoogleStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockFetchGoogleAuthStatus.mockReturnValue(new Promise(() => {}));
    renderStep();
    expect(screen.getByText('Checking Google connection...')).toBeInTheDocument();
  });

  it('shows not-configured warning when Google OAuth is missing', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: false,
      connected: false,
      message: 'Google OAuth2 credentials not configured',
    });

    renderStep();
    expect(await screen.findByText(/Google OAuth2 is not configured/i)).toBeInTheDocument();
  });

  it('shows connect button when configured but not connected', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: true,
      connected: false,
    });
    mockFetchGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/auth' });

    renderStep();
    expect(await screen.findByRole('button', { name: 'Connect Google Account' })).toBeInTheDocument();
    expect(screen.getByText(/connect your Google account/i)).toBeInTheDocument();
  });

  it('shows connected state with continue button', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: true,
      connected: true,
      expired: false,
      hasRefreshToken: true,
    });

    const onConnected = vi.fn();
    renderStep(onConnected);

    expect(await screen.findByText('Google Account Connected')).toBeInTheDocument();
    expect(screen.getByText('Ready to pick photos')).toBeInTheDocument();

    const continueBtn = screen.getByRole('button', { name: /continue to photo selection/i });
    expect(continueBtn).toBeInTheDocument();

    fireEvent.click(continueBtn);
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('shows disconnect button when connected', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: true,
      connected: true,
    });
    mockDisconnectGoogle.mockResolvedValue(undefined);

    renderStep();
    expect(await screen.findByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockFetchGoogleAuthStatus.mockRejectedValue(new Error('Network error'));

    renderStep();
    expect(await screen.findByText(/unable to check google connection/i)).toBeInTheDocument();
  });

  it('opens auth window when Connect button is clicked', async () => {
    mockFetchGoogleAuthStatus.mockResolvedValue({
      configured: true,
      connected: false,
    });
    mockFetchGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/auth' });

    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);

    renderStep();
    const btn = await screen.findByRole('button', { name: 'Connect Google Account' });
    fireEvent.click(btn);

    expect(openSpy).toHaveBeenCalledWith(
      'https://accounts.google.com/auth',
      'google-auth',
      expect.any(String),
    );

    await waitFor(() => {
      expect(screen.getByText(/waiting for authorization/i)).toBeInTheDocument();
    });

    openSpy.mockRestore();
  });
});
