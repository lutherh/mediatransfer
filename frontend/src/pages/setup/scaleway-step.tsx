import { useState, useEffect } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchScalewaySettings,
  testScalewaySettings,
  saveScalewaySettings,
  SettingsValidationError,
  type ScalewaySettingsResponse,
  type ValidationIssue,
} from '@/lib/api';
import { ValidationIssues } from './validation-issues';

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
  endpoint: string;
  forcePathStyle: boolean;
};

const MASK = '••••••••';

const KNOWN_STORAGE_CLASSES = [
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'GLACIER',
  'DEEP_ARCHIVE',
  'INTELLIGENT_TIERING',
] as const;
const CUSTOM_STORAGE_CLASS = '__custom__';

export function ScalewayStep({ onSaved, compact }: Props) {
  const [existing, setExisting] = useState<ScalewaySettingsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>({
    accessKey: '',
    secretKey: '',
    region: '',
    bucket: '',
    prefix: '',
    storageClass: 'ONEZONE_IA',
    endpoint: '',
    forcePathStyle: true,
  });
  /** Whether the user picked the Custom escape-hatch option for Storage Class. */
  const [customStorageClass, setCustomStorageClass] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; error?: string; issues?: ValidationIssue[] } | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveIssues, setSaveIssues] = useState<ValidationIssue[]>([]);
  const [savedOk, setSavedOk] = useState(false);

  // Load existing config once on mount
  useEffect(() => {
    fetchScalewaySettings().then((cfg) => {
      setExisting(cfg);
      if (cfg.configured) {
        const sc = cfg.storageClass ?? 'ONEZONE_IA';
        setForm((f) => ({
          ...f,
          region: cfg.region ?? '',
          bucket: cfg.bucket ?? '',
          prefix: cfg.prefix ?? '',
          storageClass: sc,
          endpoint: cfg.endpoint ?? '',
          forcePathStyle: cfg.forcePathStyle ?? true,
        }));
        setCustomStorageClass(!KNOWN_STORAGE_CLASSES.includes(sc as typeof KNOWN_STORAGE_CLASSES[number]));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }));
    setTestResult(null);
    setSaveError(null);
    setSaveIssues([]);
    setSavedOk(false);
  }

  function handleStorageClassSelect(value: string) {
    if (value === CUSTOM_STORAGE_CLASS) {
      setCustomStorageClass(true);
      // Keep current storageClass if it's already non-standard; otherwise clear.
      if (KNOWN_STORAGE_CLASSES.includes(form.storageClass as typeof KNOWN_STORAGE_CLASSES[number])) {
        set('storageClass', '');
      }
    } else {
      setCustomStorageClass(false);
      set('storageClass', value);
    }
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
        endpoint: form.endpoint || undefined,
        forcePathStyle: form.forcePathStyle,
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
      await saveScalewaySettings({
        accessKey: form.accessKey || undefined,
        secretKey: form.secretKey || undefined,
        region: form.region,
        bucket: form.bucket,
        prefix: form.prefix || undefined,
        storageClass: form.storageClass || undefined,
        endpoint: form.endpoint || undefined,
        forcePathStyle: form.forcePathStyle,
      });
      // Reload to reflect new state
      const updated = await fetchScalewaySettings();
      setExisting(updated);
      setForm((f) => ({ ...f, accessKey: '', secretKey: '' }));
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

  const secretPlaceholder = existing?.configured ? 'already set — leave blank to keep' : '';
  const storageClassSelectValue = customStorageClass ? CUSTOM_STORAGE_CLASS : form.storageClass;

  if (!loaded) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  return (
    <div className={compact ? '' : 'space-y-4'}>
      {!compact && (
        <div className="mb-2">
          <h3 className="text-base font-semibold text-slate-900">Object Storage (S3-Compatible)</h3>
          <p className="text-sm text-slate-500 mt-1">
            Configure S3-compatible credentials. Works with Scaleway, AWS S3, Backblaze B2, Cloudflare R2, and others.
          </p>
        </div>
      )}

      {existing?.configured && (
        <Alert variant="success" className="mb-3">
          Object storage configured — bucket: <strong>{existing.bucket}</strong> / region:{' '}
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
            placeholder="e.g. fr-par, us-east-1, eu-west-1"
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
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm bg-white"
            value={storageClassSelectValue}
            onChange={(e) => handleStorageClassSelect(e.target.value)}
          >
            {KNOWN_STORAGE_CLASSES.map((sc) => (
              <option key={sc} value={sc}>{sc}</option>
            ))}
            <option value={CUSTOM_STORAGE_CLASS}>Custom…</option>
          </select>
          {customStorageClass && (
            <input
              type="text"
              className="mt-2 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              value={form.storageClass}
              onChange={(e) => set('storageClass', e.target.value)}
              placeholder="Enter custom storage class (e.g. provider-specific)"
            />
          )}
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-slate-700 mb-1">Endpoint URL <span className="font-normal text-slate-400">(optional — leave blank for Scaleway auto-detect)</span></label>
          <input
            type="url"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={form.endpoint}
            onChange={(e) => set('endpoint', e.target.value)}
            placeholder="e.g. https://s3.amazonaws.com or https://s3.us-west-001.backblazeb2.com"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="force-path-style"
            type="checkbox"
            checked={form.forcePathStyle}
            onChange={(e) => set('forcePathStyle', e.target.checked)}
            className="rounded border-slate-300"
          />
          <label htmlFor="force-path-style" className="text-xs text-slate-700">
            Path-style requests <span className="text-slate-400">(on for Scaleway/B2/R2; off for AWS S3)</span>
          </label>
        </div>
      </div>

      {testResult && testResult.ok && (
        <Alert variant="success" className="mt-3">Connection successful.</Alert>
      )}
      {testResult && !testResult.ok && (
        <ValidationIssues message={`Test failed: ${testResult.error}`} issues={testResult.issues} />
      )}
      {savedOk && (
        <Alert variant="success" className="mt-3">Settings saved successfully.</Alert>
      )}
      <ValidationIssues message={saveError} issues={saveIssues} />

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
