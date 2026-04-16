import { useState, useEffect } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchScalewaySettings,
  testScalewaySettings,
  saveScalewaySettings,
  type ScalewaySettingsResponse,
} from '@/lib/api';

type Props = {
  onSaved?: () => void;
  /** When true, renders a compact card for the Settings page (no wizard nav). */
  compact?: boolean;
};

type FormState = {
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  prefix: string;
  storageClass: string;
};

const MASK = '••••••••';

export function ScalewayStep({ onSaved, compact }: Props) {
  const [existing, setExisting] = useState<ScalewaySettingsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>({
    accessKey: '',
    secretKey: '',
    region: 'fr-par',
    bucket: '',
    prefix: '',
    storageClass: 'ONEZONE_IA',
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load existing config once on mount
  useEffect(() => {
    fetchScalewaySettings().then((cfg) => {
      setExisting(cfg);
      if (cfg.configured) {
        setForm((f) => ({
          ...f,
          region: cfg.region ?? 'fr-par',
          bucket: cfg.bucket ?? '',
          prefix: cfg.prefix ?? '',
          storageClass: cfg.storageClass ?? 'ONEZONE_IA',
        }));
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
      const result = await testScalewaySettings({
        accessKey: form.accessKey || undefined,
        secretKey: form.secretKey || undefined,
        region: form.region,
        bucket: form.bucket,
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
      await saveScalewaySettings({
        accessKey: form.accessKey || undefined,
        secretKey: form.secretKey || undefined,
        region: form.region,
        bucket: form.bucket,
        prefix: form.prefix || undefined,
        storageClass: form.storageClass || undefined,
      });
      // Reload to reflect new state
      const updated = await fetchScalewaySettings();
      setExisting(updated);
      setForm((f) => ({ ...f, accessKey: '', secretKey: '' }));
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
    <div className={compact ? '' : 'space-y-4'}>
      {!compact && (
        <div className="mb-2">
          <h3 className="text-base font-semibold text-slate-900">Scaleway Object Storage</h3>
          <p className="text-sm text-slate-500 mt-1">
            Configure S3-compatible credentials for your Scaleway bucket.
          </p>
        </div>
      )}

      {existing?.configured && (
        <Alert variant="success" className="mb-3">
          Scaleway is configured — bucket: <strong>{existing.bucket}</strong> / region:{' '}
          <strong>{existing.region}</strong>
        </Alert>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Access Key</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.accessKey}
            onChange={(e) => set('accessKey', e.target.value)}
            placeholder={secretPlaceholder}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Secret Key</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.secretKey}
            onChange={(e) => set('secretKey', e.target.value)}
            placeholder={secretPlaceholder}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Region</label>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.region}
            onChange={(e) => set('region', e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Bucket</label>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.bucket}
            onChange={(e) => set('bucket', e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Prefix (optional)</label>
          <input
            type="text"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.prefix}
            onChange={(e) => set('prefix', e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Storage Class</label>
          <select
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.storageClass}
            onChange={(e) => set('storageClass', e.target.value)}
          >
            <option value="STANDARD">Standard — daily access, full speed</option>
            <option value="ONEZONE_IA">Infrequent Access — cheaper, slower retrieval</option>
            <option value="GLACIER">Glacier Archive — cheapest, very slow retrieval</option>
          </select>
        </div>
      </div>

      {testResult && (
        <Alert variant={testResult.ok ? 'success' : 'error'} className="mt-3">
          {testResult.ok ? 'Connection successful.' : `Test failed: ${testResult.error}`}
        </Alert>
      )}
      {saveError && (
        <Alert variant="error" className="mt-3">{saveError}</Alert>
      )}

      <div className="flex gap-2 mt-4 items-start">
        <Button
          type="button"
          onClick={handleTest}
          disabled={testing || !form.bucket || !form.region}
          className="bg-slate-600 hover:bg-slate-500"
        >
          {testing ? 'Testing…' : 'Test connection'}
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
            <p className="text-xs text-amber-600 mt-1">Test connection first to validate credentials</p>
          )}
        </div>
      </div>

      {existing?.configured && (
        <p className="text-xs text-slate-500 mt-2">
          Secret fields are masked. Leave blank to keep existing credentials.
        </p>
      )}
    </div>
  );
}
