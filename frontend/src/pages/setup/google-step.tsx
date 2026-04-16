import { useState, useEffect } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchGoogleSettings,
  saveGoogleSettings,
  API_BASE_URL,
  type GoogleSettingsResponse,
} from '@/lib/api';

type Props = {
  onSaved?: () => void;
  compact?: boolean;
};

type FormState = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function GoogleStep({ onSaved, compact }: Props) {
  const [existing, setExisting] = useState<GoogleSettingsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>({
    clientId: '',
    clientSecret: '',
    redirectUri: `${window.location.protocol}//${window.location.hostname}:5173/auth/google/callback`,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    fetchGoogleSettings().then((cfg) => {
      setExisting(cfg);
      if (cfg.redirectUri) {
        setForm((f) => ({ ...f, redirectUri: cfg.redirectUri! }));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  function set(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setSaveError(null);
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await saveGoogleSettings({
        clientId: form.clientId,
        clientSecret: form.clientSecret,
        redirectUri: form.redirectUri,
      });
      const updated = await fetchGoogleSettings();
      setExisting(updated);
      setForm((f) => ({ ...f, clientId: '', clientSecret: '' }));
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleConnectGoogle() {
    window.location.href = `${API_BASE_URL}/auth/google/url`;
  }

  const secretPlaceholder = existing?.configured ? 'already set — leave blank to keep' : '';

  if (!loaded) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  return (
    <div>
      {!compact && (
        <div className="mb-2">
          <h3 className="text-base font-semibold text-slate-900">Google Photos OAuth</h3>
          <p className="text-sm text-slate-500 mt-1">
            Required to transfer photos directly from Google Photos.
          </p>
        </div>
      )}

      {existing?.configured && (
        <Alert variant="success" className="mb-3">
          Google OAuth client is configured.
          {' '}
          <button
            type="button"
            className="underline text-blue-700 ml-1"
            onClick={handleConnectGoogle}
          >
            Connect / reconnect Google account →
          </button>
        </Alert>
      )}

      <button
        type="button"
        className="text-xs text-blue-600 underline mb-3"
        onClick={() => setShowInstructions((v) => !v)}
      >
        {showInstructions ? 'Hide' : 'How to get credentials'}
      </button>

      {showInstructions && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
          <p className="font-medium">Steps to create Google OAuth credentials:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="underline text-blue-600">Google Cloud Console → Credentials</a></li>
            <li>Click <strong>Create Credentials → OAuth client ID</strong></li>
            <li>Choose <strong>Web application</strong></li>
            <li>Add the Redirect URI shown below to "Authorized redirect URIs"</li>
            <li>Copy the Client ID and Client Secret here</li>
          </ol>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Client ID</label>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.clientId}
            onChange={(e) => set('clientId', e.target.value)}
            placeholder={secretPlaceholder}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Client Secret</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.clientSecret}
            onChange={(e) => set('clientSecret', e.target.value)}
            placeholder={secretPlaceholder}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Redirect URI
            <span className="text-slate-500 font-normal"> — where Google sends you after login</span>
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.redirectUri}
            onChange={(e) => set('redirectUri', e.target.value)}
          />
          <p className="text-xs text-slate-500 mt-1">Copy this exact URI into Google Cloud Console under &ldquo;Authorized redirect URIs&rdquo;</p>
        </div>
      </div>

      {saved && (
        <Alert variant="success" className="mt-3">Saved successfully.</Alert>
      )}
      {saveError && (
        <Alert variant="error" className="mt-3">{saveError}</Alert>
      )}

      <div className="flex gap-2 mt-4">
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || (!form.clientId && !existing?.configured)}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {existing?.configured && (
          <Button
            type="button"
            onClick={handleConnectGoogle}
            className="bg-blue-600 hover:bg-blue-500"
            title="Link your Google Photos account to authorize photo imports"
          >
            Connect to Google Photos →
          </Button>
        )}
      </div>
    </div>
  );
}
