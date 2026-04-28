import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchImmichSettings,
  testImmichSettings,
  saveImmichSettings,
  checkImmichReachable,
  startImmich,
  SettingsValidationError,
  type ImmichSettingsResponse,
  type ValidationIssue,
} from '@/lib/api';
import { ValidationIssues } from './validation-issues';

type Props = {
  onSaved?: () => void;
  compact?: boolean;
};

type FormState = {
  url: string;
  apiKey: string;
};

/** Total milliseconds to wait after `Start Immich` before re-probing. */
const START_PROBE_DELAY_MS = 4_000;
/** Interval (ms) between progress-bar updates during the post-start wait. */
const START_PROBE_PROGRESS_INTERVAL_MS = 100;

type ReachableState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up' }
  | { state: 'unauthorized' }
  | { state: 'down'; error?: string };

export function ImmichStep({ onSaved, compact }: Props) {
  const [existing, setExisting] = useState<ImmichSettingsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>({ url: '', apiKey: '' });
  const [reachable, setReachable] = useState<ReachableState>({ state: 'idle' });
  const [starting, setStarting] = useState(false);
  /** Progress 0..1 during the post-start probe wait. -1 means inactive. */
  const [startProgress, setStartProgress] = useState<number>(-1);
  const startProgressTimerRef = useRef<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    {
      ok: boolean;
      serverVersion?: string;
      error?: string;
      issues?: ValidationIssue[];
    } | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveIssues, setSaveIssues] = useState<ValidationIssue[]>([]);
  const [savedOk, setSavedOk] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    fetchImmichSettings().then((cfg) => {
      setExisting(cfg);
      if (cfg.url) {
        setForm((f) => ({ ...f, url: cfg.url! }));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  // Clean up any pending progress timer on unmount.
  useEffect(() => {
    return () => {
      if (startProgressTimerRef.current !== null) {
        window.clearInterval(startProgressTimerRef.current);
      }
    };
  }, []);

  function set(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setTestResult(null);
    setSaveError(null);
    setSaveIssues([]);
    setSavedOk(false);
  }

  const probeReachable = useCallback(async (url: string) => {
    if (!url || !/^https?:\/\//.test(url)) {
      setReachable({ state: 'idle' });
      return;
    }
    setReachable({ state: 'checking' });
    try {
      const result = await checkImmichReachable(url);
      if (result.ok) {
        setReachable({ state: 'up' });
      } else if (result.reason === 'unauthorized') {
        setReachable({ state: 'unauthorized' });
      } else {
        setReachable({ state: 'down', error: result.error });
      }
    } catch (e) {
      setReachable({
        state: 'down',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // Probe reachability whenever the URL changes (debounced).
  useEffect(() => {
    if (!form.url) {
      setReachable({ state: 'idle' });
      return;
    }
    const t = setTimeout(() => { void probeReachable(form.url); }, 600);
    return () => clearTimeout(t);
  }, [form.url, probeReachable]);

  async function handleStartImmich() {
    setStarting(true);
    setStartError(null);
    try {
      const result = await startImmich();
      if (!result.ok) {
        setStartError(result.error ?? 'Failed to start Immich');
        return;
      }
      // Give Immich a moment to come up, then re-probe. While we wait, drive
      // a small progress bar so the UI doesn't appear hung.
      setStartProgress(0);
      const startedAt = Date.now();
      if (startProgressTimerRef.current !== null) {
        window.clearInterval(startProgressTimerRef.current);
      }
      startProgressTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const fraction = Math.min(1, elapsed / START_PROBE_DELAY_MS);
        setStartProgress(fraction);
        if (fraction >= 1 && startProgressTimerRef.current !== null) {
          window.clearInterval(startProgressTimerRef.current);
          startProgressTimerRef.current = null;
        }
      }, START_PROBE_PROGRESS_INTERVAL_MS);
      window.setTimeout(() => {
        setStartProgress(-1);
        void probeReachable(form.url);
      }, START_PROBE_DELAY_MS);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
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
    setSaveIssues([]);
    setSavedOk(false);
    try {
      await saveImmichSettings({
        url: form.url,
        apiKey: form.apiKey || undefined,
      });
      const updated = await fetchImmichSettings();
      setExisting(updated);
      setForm((f) => ({ ...f, apiKey: '' }));
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
          {form.url && (
            <div className="mt-1 flex flex-col gap-1 text-xs">
              {reachable.state === 'checking' && (
                <span className="text-slate-500">Checking server…</span>
              )}
              {reachable.state === 'up' && (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Server reachable
                </span>
              )}
              {reachable.state === 'unauthorized' && (
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  Server reachable but rejecting access — check the API key below
                </span>
              )}
              {reachable.state === 'down' && (
                <div className="flex flex-col gap-1 w-full">
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    Not reachable — Immich isn't running at this URL
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      onClick={handleStartImmich}
                      disabled={starting || startProgress >= 0}
                      className="bg-emerald-600 hover:bg-emerald-500 text-xs px-2 py-1"
                    >
                      {starting ? 'Starting…' : startProgress >= 0 ? 'Waiting…' : 'Start Immich'}
                    </Button>
                    <span className="text-slate-500">
                      runs <code className="bg-slate-100 px-1 rounded">docker compose -f docker-compose.immich.yml up -d</code>
                    </span>
                  </div>
                  {startProgress >= 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-slate-500">
                        Waiting for Immich to come up before re-probing…
                      </span>
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(startProgress * 100)}
                        className="h-1 w-full rounded bg-slate-200 overflow-hidden"
                      >
                        <div
                          className="h-full bg-emerald-500 transition-[width] duration-100"
                          style={{ width: `${Math.min(100, startProgress * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {startError && (
                    <span className="text-rose-600">Start failed: {startError}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            API Key
          </label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder={existing?.configured ? 'existing key — leave blank to keep' : 'paste your Immich API key'}
          />
          <button
            type="button"
            className="mt-2 text-xs text-blue-600 underline"
            onClick={() => setShowInstructions((v) => !v)}
          >
            {showInstructions ? 'Hide help' : 'How to get an Immich API key'}
          </button>
        </div>
      </div>

      {showInstructions && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-2">
          <p>
            <strong className="text-slate-700">Immich must be running first.</strong>{' '}
            If you haven't started it yet, run{' '}
            <code className="bg-slate-100 px-1 rounded">
              docker compose -f docker-compose.immich.yml up -d
            </code>{' '}
            from the project root, then open the server URL above and create your
            admin account.
          </p>
          <ol className="list-decimal list-inside space-y-1">
            <li>
              Open the Immich web UI (the server URL above, e.g.{' '}
              <code className="bg-slate-100 px-1 rounded">http://localhost:2283</code>).
            </li>
            <li>
              Click your profile picture (top-right) →{' '}
              <strong>Account Settings</strong> → <strong>API Keys</strong> →{' '}
              <strong>New API Key</strong>.
            </li>
            <li>
              Give it a name (e.g. <em>MediaTransfer</em>), copy the generated key,
              and paste it here. The key is shown only once — save it somewhere safe.
            </li>
          </ol>
          <p className="text-slate-500">
            Note: The mobile app cannot create API keys — it must be done in the web UI.
          </p>
          {form.url && (
            <a
              href={`${form.url.replace(/\/+$/, '')}/user-settings?isOpen=api-keys`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Open API Keys page →
            </a>
          )}
        </div>
      )}

      {testResult && testResult.ok && (
        <Alert variant="success" className="mt-3">
          {`Connection successful${testResult.serverVersion ? ` — Immich ${testResult.serverVersion}` : ''}.`}
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
