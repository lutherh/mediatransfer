import { useState, useEffect } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchGoogleSettings,
  saveGoogleSettings,
  testGoogleSettings,
  SettingsValidationError,
  API_BASE_URL,
  type GoogleSettingsResponse,
  type ValidationIssue,
} from '@/lib/api';
import { ValidationIssues } from './validation-issues';

type Props = {
  onSaved?: () => void;
  compact?: boolean;
};

type FormState = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/**
 * Compute the redirect URI we'd recommend based on the page's origin. This is
 * the URI that should be registered in Google Cloud Console for the OAuth
 * client. Note: the OAuth callback is served by the *backend* (port 3000) for
 * the dev workflow, but the OAuth flow can also be terminated at the SPA's
 * own callback (e.g. http://localhost:5173/auth/google/callback). We default
 * to the SPA origin so that whatever port the user is currently using is
 * registered, and let them edit if they need otherwise.
 */
function detectRedirectUri(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/auth/google/callback`;
}

const STANDARD_PORTS = new Set(['', '80', '443', '5173', '3000']);

export function GoogleStep({ onSaved, compact }: Props) {
  const [existing, setExisting] = useState<GoogleSettingsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const detectedRedirectUri = detectRedirectUri();
  const [form, setForm] = useState<FormState>({
    clientId: '',
    clientSecret: '',
    redirectUri: detectedRedirectUri,
  });
  const [testResult, setTestResult] = useState<
    { ok: boolean; error?: string; issues?: ValidationIssue[] } | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveIssues, setSaveIssues] = useState<ValidationIssue[]>([]);
  const [savedOk, setSavedOk] = useState(false);
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
    setTestResult(null);
    setSaveError(null);
    setSaveIssues([]);
    setSavedOk(false);
  }

  /** Detect a non-standard port in the current redirect URI for an inline warning. */
  const redirectPortWarning = (() => {
    try {
      const u = new URL(form.redirectUri);
      if (!STANDARD_PORTS.has(u.port)) {
        return `The redirect URI uses port :${u.port}, which isn't a typical dev/prod port. Make sure you registered this exact URI in Google Cloud Console.`;
      }
    } catch {
      // Ignore — Zod on the server will validate the URL on save/test.
    }
    return null;
  })();

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testGoogleSettings({
        clientId: form.clientId,
        clientSecret: form.clientSecret,
        redirectUri: form.redirectUri,
      });
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaveIssues([]);
    setSavedOk(false);
    try {
      await saveGoogleSettings({
        clientId: form.clientId,
        clientSecret: form.clientSecret,
        redirectUri: form.redirectUri,
      });
      const updated = await fetchGoogleSettings();
      setExisting(updated);
      setForm((f) => ({ ...f, clientId: '', clientSecret: '' }));
      setTestResult(null);
      setSavedOk(true);
      onSaved?.();
    } catch (e) {
      if (e instanceof SettingsValidationError) {
        setSaveError(e.message);
        setSaveIssues(e.issues);
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }

  function handleConnectGoogle() {
    window.location.href = `${API_BASE_URL}/auth/google/url`;
  }

  function handleResetRedirectUri() {
    set('redirectUri', detectedRedirectUri);
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
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-slate-700">
              Redirect URI
              <span className="text-slate-500 font-normal"> — where Google sends you after login</span>
            </label>
            {form.redirectUri !== detectedRedirectUri && (
              <button
                type="button"
                className="text-xs text-blue-600 underline"
                onClick={handleResetRedirectUri}
                title={`Reset to ${detectedRedirectUri}`}
              >
                Reset to detected
              </button>
            )}
          </div>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.redirectUri}
            onChange={(e) => set('redirectUri', e.target.value)}
          />
          <p className="text-xs text-slate-500 mt-1">Copy this exact URI into Google Cloud Console under &ldquo;Authorized redirect URIs&rdquo;</p>
          {redirectPortWarning && (
            <p className="text-xs text-amber-600 mt-1">{redirectPortWarning}</p>
          )}
        </div>
      </div>

      {testResult && testResult.ok && (
        <Alert variant="success" className="mt-3">
          Credentials look valid — Google accepted the OAuth client.
        </Alert>
      )}
      {testResult && !testResult.ok && (
        <ValidationIssues
          message={`Test failed: ${testResult.error}`}
          issues={testResult.issues}
        />
      )}
      {savedOk && (
        <Alert variant="success" className="mt-3">Settings saved successfully.</Alert>
      )}
      <ValidationIssues message={saveError} issues={saveIssues} />

      <div className="flex gap-2 mt-4 items-start">
        <Button
          type="button"
          onClick={handleTest}
          disabled={testing || !form.clientId || !form.clientSecret || !form.redirectUri}
          className="bg-slate-600 hover:bg-slate-500"
        >
          {testing ? 'Testing…' : 'Test credentials'}
        </Button>
        <div>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !testResult?.ok}
            title={!testResult?.ok ? 'Run a successful test first' : undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {!testResult?.ok && (
            <p className="text-xs text-amber-600 mt-1">Test credentials first to validate them</p>
          )}
        </div>
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
