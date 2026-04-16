import { useState, useEffect } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchImmichSettings,
  testImmichSettings,
  saveImmichSettings,
  type ImmichSettingsResponse,
} from '@/lib/api';

type Props = {
  onSaved?: () => void;
  compact?: boolean;
};

type FormState = {
  url: string;
  apiKey: string;
};

export function ImmichStep({ onSaved, compact }: Props) {
  const [existing, setExisting] = useState<ImmichSettingsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>({ url: '', apiKey: '' });
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    serverVersion?: string;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetchImmichSettings().then((cfg) => {
      setExisting(cfg);
      if (cfg.url) {
        setForm((f) => ({ ...f, url: cfg.url! }));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  function set(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setTestResult(null);
    setSaveError(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testImmichSettings({
        url: form.url,
        apiKey: form.apiKey,
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
    try {
      await saveImmichSettings({
        url: form.url,
        apiKey: form.apiKey || undefined,
      });
      const updated = await fetchImmichSettings();
      setExisting(updated);
      setForm((f) => ({ ...f, apiKey: '' }));
      setTestResult(null);
      onSaved?.();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const secretPlaceholder = existing?.configured ? 'already set — leave blank to keep' : '';

  if (!loaded) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  return (
    <div>
      {!compact && (
        <div className="mb-2">
          <h3 className="text-base font-semibold text-slate-900">Immich</h3>
          <p className="text-sm text-slate-500 mt-1">
            Connect to your local Immich instance for library comparison and deduplication.
          </p>
        </div>
      )}

      {existing?.configured && (
        <Alert variant="success" className="mb-3">
          Immich is configured — server: <strong>{existing.url}</strong>
        </Alert>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Server URL</label>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="http://localhost:2283"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            API Key
            <span className="text-slate-500 font-normal"> — from Immich → Account Settings → API Keys</span>
          </label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder={existing?.configured ? 'existing key — leave blank to keep' : 'paste your Immich API key'}
          />
        </div>
      </div>

      {testResult && (
        <Alert variant={testResult.ok ? 'success' : 'error'} className="mt-3">
          {testResult.ok
            ? `Connection successful${testResult.serverVersion ? ` — Immich ${testResult.serverVersion}` : ''}.`
            : `Test failed: ${testResult.error}`}
        </Alert>
      )}
      {saveError && (
        <Alert variant="error" className="mt-3">{saveError}</Alert>
      )}

      <div className="flex gap-2 mt-4 items-start">
        <div>
          <Button
            type="button"
            onClick={handleTest}
            disabled={testing || !form.url || (!form.apiKey && !existing?.configured)}
            className="bg-slate-600 hover:bg-slate-500"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          {!form.url && <p className="text-xs text-amber-600 mt-1">Enter server URL to test</p>}
          {!form.url && !form.apiKey && !existing?.configured && <p className="text-xs text-amber-600 mt-1">Enter API key to test</p>}
        </div>
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
            <p className="text-xs text-amber-600 mt-1">Test connection first to validate server and key</p>
          )}
        </div>
      </div>
    </div>
  );
}
