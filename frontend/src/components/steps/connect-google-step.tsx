import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchGoogleAuthStatus, fetchGoogleAuthUrl, disconnectGoogle } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { useState, useEffect, useCallback } from 'react';

type ConnectGoogleStepProps = {
  onConnected: () => void;
};

export function ConnectGoogleStep({ onConnected }: ConnectGoogleStepProps) {
  const queryClient = useQueryClient();
  const [authWindow, setAuthWindow] = useState<Window | null>(null);
  const [waitingForAuth, setWaitingForAuth] = useState(false);

  const { data: status, isLoading, error } = useQuery({
    queryKey: ['google-auth-status'],
    queryFn: fetchGoogleAuthStatus,
    refetchInterval: waitingForAuth ? 2000 : false,
  });

  const authUrlQuery = useQuery({
    queryKey: ['google-auth-url'],
    queryFn: fetchGoogleAuthUrl,
    enabled: status?.configured === true && !status?.connected,
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectGoogle,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['google-auth-status'] });
    },
  });

  // Listen for the OAuth callback success message from the popup
  const handleAuthMessage = useCallback(
    (event: MessageEvent) => {
      // Security: only accept messages from our own origin to prevent
      // cross-origin forgery of the auth-success message.
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'google-auth-success') {
        // The popup already exchanged the code; just refresh status.
        queryClient.invalidateQueries({ queryKey: ['google-auth-status'] });
        setWaitingForAuth(false);
        setAuthWindow(null);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    window.addEventListener('message', handleAuthMessage);
    return () => window.removeEventListener('message', handleAuthMessage);
  }, [handleAuthMessage]);

  useEffect(() => {
    if (status?.connected) {
      setWaitingForAuth(false);
      setAuthWindow(null);
    }
  }, [status?.connected]);

  const handleConnect = () => {
    const url = authUrlQuery.data?.url;
    if (!url) return;

    const w = window.open(url, 'google-auth', 'width=600,height=700,popup=yes');
    if (w) {
      setAuthWindow(w);
      setWaitingForAuth(true);
    }
  };

  if (isLoading) {
    return <Card><p className="text-slate-600">Checking Google connection...</p></Card>;
  }

  if (error) {
    return (
      <Alert variant="error">
        Unable to check Google connection status. Make sure the backend is running.
      </Alert>
    );
  }

  if (!status?.configured) {
    return (
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Connect Google Account</h2>
        <Alert variant="warning">
          Google OAuth2 is not configured. Set <code>GOOGLE_CLIENT_ID</code> and{' '}
          <code>GOOGLE_CLIENT_SECRET</code> in your environment variables.
        </Alert>
      </Card>
    );
  }

  if (status.connected) {
    return (
      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
            <span className="text-lg">✓</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold">Google Account Connected</h2>
            <p className="text-sm text-slate-500">
              {status.expired ? 'Token expired — will auto-refresh' : 'Ready to pick photos'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:gap-3">
          <Button onClick={onConnected}>
            Continue to Photo Selection
          </Button>
          <Button
            className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            Disconnect
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold">Connect Google Account</h2>
      <p className="text-sm text-slate-600">
        To transfer your photos, you need to connect your Google account first.
        This will open a Google consent screen where you can grant read access to your photo library.
      </p>

      {waitingForAuth ? (
        <div className="space-y-3">
          <Alert variant="info">
            A Google sign-in window has been opened. Complete the authorization there, then return here.
          </Alert>
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
            <span className="text-sm text-slate-600">Waiting for authorization...</span>
          </div>
          <Button
            className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
            onClick={() => {
              authWindow?.close();
              setAuthWindow(null);
              setWaitingForAuth(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          onClick={handleConnect}
          disabled={!authUrlQuery.data?.url || authUrlQuery.isLoading}
        >
          {authUrlQuery.isLoading ? 'Loading...' : 'Connect Google Account'}
        </Button>
      )}
    </Card>
  );
}
