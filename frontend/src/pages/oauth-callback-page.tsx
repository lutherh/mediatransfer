import { useEffect, useState } from 'react';
import { submitGoogleAuthCode } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';

/**
 * OAuth callback page. Rendered after Google redirects back.
 * Extracts the `code` query parameter, exchanges it for tokens via the backend,
 * and then sends a postMessage to the parent/opener window to continue the wizard flow.
 */
export function OAuthCallbackPage() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authError = params.get('error');

    if (authError) {
      setStatus('error');
      setErrorMessage(`Google returned an error: ${authError}`);
      return;
    }

    if (!code) {
      setStatus('error');
      setErrorMessage('No authorization code received from Google.');
      return;
    }

    submitGoogleAuthCode(code)
      .then(() => {
        setStatus('success');
        // Notify the opener (wizard page) that auth is complete — do NOT
        // send the code; it has already been exchanged and codes are single-use.
        if (window.opener) {
          window.opener.postMessage({ type: 'google-auth-success' }, window.location.origin);
        }
      })
      .catch((err: Error) => {
        setStatus('error');
        setErrorMessage(err.message || 'Failed to exchange authorization code.');
      });
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="max-w-md space-y-4">
        {status === 'loading' && (
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
            <p className="text-sm text-slate-600">Completing Google authorization...</p>
          </div>
        )}

        {status === 'success' && (
          <>
            <Alert variant="success">
              Google account connected successfully!
            </Alert>
            <p className="text-sm text-slate-600">
              Authorization is complete. Return to the transfer wizard and close this window.
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <Alert variant="error">{errorMessage}</Alert>
            <p className="text-sm text-slate-600">
              Close this window and try again from the transfer wizard.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
