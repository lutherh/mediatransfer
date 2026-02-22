import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OAuthCallbackPage } from '@/pages/oauth-callback-page';

const mockSubmitGoogleAuthCode = vi.fn();

vi.mock('@/lib/api', () => ({
  submitGoogleAuthCode: (...args: unknown[]) => mockSubmitGoogleAuthCode(...args),
}));

// Helper to set window.location.search
function setLocationSearch(search: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, search, origin: 'http://localhost:3000' },
    writable: true,
  });
}

describe('OAuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset window.opener 
    Object.defineProperty(window, 'opener', { value: null, writable: true });
  });

  it('shows loading state while exchanging code', () => {
    setLocationSearch('?code=test-auth-code');
    mockSubmitGoogleAuthCode.mockReturnValue(new Promise(() => {}));

    render(<OAuthCallbackPage />);
    expect(screen.getByText('Completing Google authorization...')).toBeInTheDocument();
  });

  it('shows success after code exchange', async () => {
    setLocationSearch('?code=valid-code');
    mockSubmitGoogleAuthCode.mockResolvedValue({ connected: true });

    render(<OAuthCallbackPage />);
    expect(await screen.findByText(/google account connected successfully/i)).toBeInTheDocument();
  });

  it('shows error when code is missing', async () => {
    setLocationSearch('');
    render(<OAuthCallbackPage />);
    expect(await screen.findByText(/no authorization code received/i)).toBeInTheDocument();
  });

  it('shows error when Google returns error', async () => {
    setLocationSearch('?error=access_denied');
    render(<OAuthCallbackPage />);
    expect(await screen.findByText(/google returned an error/i)).toBeInTheDocument();
  });

  it('shows error on exchange failure', async () => {
    setLocationSearch('?code=bad-code');
    mockSubmitGoogleAuthCode.mockRejectedValue(new Error('Invalid code'));

    render(<OAuthCallbackPage />);
    expect(await screen.findByText(/invalid code/i)).toBeInTheDocument();
  });

  it('sends postMessage to opener on success', async () => {
    const mockPostMessage = vi.fn();
    Object.defineProperty(window, 'opener', {
      value: { postMessage: mockPostMessage },
      writable: true,
    });

    setLocationSearch('?code=valid-code');
    mockSubmitGoogleAuthCode.mockResolvedValue({ connected: true });

    render(<OAuthCallbackPage />);
    await screen.findByText(/google account connected successfully/i);

    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: 'google-auth-success' },
      'http://localhost:3000',
    );
  });
});
