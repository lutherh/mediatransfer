const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const TAKEOUT_FETCH_TIMEOUT_MS = 10_000;

export type TransferJob = {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  sourceProvider: string;
  destProvider: string;
  progress: number;
  keys?: string[];
  createdAt: string;
};

export type TransferLog = {
  id: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  createdAt: string;
  meta?: Record<string, unknown>;
};

export type CloudUsageBucketType = 'standard' | 'infrequent' | 'archive';

export type CloudUsageAssumptions = {
  putRequests: number;
  getRequests: number;
  listRequests: number;
  lifecycleTransitionGB: number;
  retrievalGB: number;
  egressGB: number;
  vatRate: number;
};

export type CloudUsageSummary = {
  provider: 'scaleway';
  bucket: string;
  region: string;
  prefix?: string;
  totalObjects: number;
  totalBytes: number;
  totalGB: number;
  bucketType: CloudUsageBucketType;
  assumptions: CloudUsageAssumptions;
  pricing: {
    currency: 'USD';
    pricePerGBMonthly: number;
    requestPer1000: {
      put: number;
      get: number;
      list: number;
    };
    lifecycleTransitionPerGB: number;
    retrievalPerGB: number;
    egressPerGB: number;
  };
  providerRules: {
    requestBillingUnit: number;
    lineItemRoundingDecimals: number;
    invoiceRoundingDecimals: number;
    minimumMonthlyChargeUSD: number;
  };
  breakdown: {
    storageCost: number;
    putRequestCost: number;
    getRequestCost: number;
    listRequestCost: number;
    requestCost: number;
    lifecycleTransitionCost: number;
    retrievalCost: number;
    egressCost: number;
    subtotalBeforeMinimum: number;
    minimumChargeAdjustment: number;
    subtotalExclVat: number;
    vatAmount: number;
    totalInclVat: number;
  };
  estimatedMonthlyCost: number;
  measuredAt: string;
  note: string;
};

export type TakeoutStatus = {
  paths: {
    inputDir: string;
    workDir: string;
    archiveDir?: string;
    manifestPath: string;
    statePath: string;
  };
  counts: {
    total: number;
    processed: number;
    pending: number;
    uploaded: number;
    skipped: number;
    failed: number;
  };
  progress: number;
  stateUpdatedAt: string;
  recentFailures: Array<{
    key: string;
    error?: string;
    updatedAt: string;
    attempts: number;
  }>;
  isComplete: boolean;
  /** Number of .zip / .tgz / .tar archive files currently sitting in the input folder */
  archivesInInput: number;
  /** Archive-level processing history from archive-state.json */
  archiveHistory?: TakeoutArchiveHistoryEntry[];
  /** Pipeline state: ordered step progression with per-step status */
  pipeline?: PipelineSummary;
  /** Whether auto-upload mode is enabled */
  autoUpload?: boolean;
};

export type TakeoutArchiveHistoryEntry = {
  archiveName: string;
  status: 'pending' | 'extracting' | 'uploading' | 'completed' | 'failed';
  archiveSizeBytes?: number;
  mediaBytes?: number;
  entryCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  handledPercent: number;
  isFullyUploaded: boolean;
  notUploadedReasons?: Array<{
    code:
      | 'already_exists_in_destination'
      | 'already_uploaded_in_state'
      | 'already_skipped_in_state'
      | 'upload_failed';
    label: string;
    count: number;
  }>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type PipelineStepName = 'scan' | 'upload' | 'verify' | 'cleanup';
export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';

export type StepRecord = {
  step: PipelineStepName;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  itemsTotal?: number;
  itemsDone?: number;
  itemsFailed?: number;
  detail?: string;
};

export type PipelineSummary = {
  currentStep: PipelineStepName;
  steps: StepRecord[];
  updatedAt: string;
};

export type TakeoutAction =
  | 'scan'
  | 'upload'
  | 'verify'
  | 'resume'
  | 'repair-dates'
  | 'repair-dates-s3'
  | 'pause'
  | 'start-services'
  | 'cleanup-move'
  | 'cleanup-delete'
  | 'cleanup-force-move'
  | 'cleanup-force-delete';

export type ScanProgress = {
  phase: string;
  current: number;
  total: number;
  percent: number;
  detail?: string;
};

export type UploadProgressInfo = {
  speed?: string;
  eta?: string;
  inFlight?: number;
  bytesTransferred?: string;
  bytesTotal?: string;
  bytePercent?: number;
  currentArchive?: string;
  currentArchiveIndex?: number;
  totalArchives?: number;
};

export type TakeoutActionStatus = {
  running: boolean;
  paused?: boolean;
  action?: TakeoutAction;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  success?: boolean;
  output: string[];
  scanProgress?: ScanProgress;
  uploadProgress?: UploadProgressInfo;
  lastOutputAt?: string;
  /** When auto-upload has scheduled a next action, indicates what it is. */
  autoUploadPending?: 'scan' | 'upload' | null;
};

// ── Sequence analysis types ────────────────────────────────────────────────

export type ArchiveDetail = {
  status: string;
  entryCount?: number;
  uploadedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  archiveSizeBytes?: number;
  mediaBytes?: number;
  completedAt?: string;
  error?: string;
};

export type SequenceGroup = {
  prefix: string;
  exportNumber: number;
  extension: string;
  present: number[];
  missing: number[];
  isComplete: boolean;
  maxSeen: number;
  totalSizeBytes: number;
  totalMediaBytes: number;
  totalEntries: number;
  totalUploaded: number;
  totalSkipped: number;
  totalFailed: number;
  errors: string[];
};

export type SequenceAnalysis = {
  groups: SequenceGroup[];
  totalArchives: number;
  unrecognised: string[];
  archiveDetails: Record<string, ArchiveDetail>;
};

export async function fetchTransfers(): Promise<TransferJob[]> {
  const response = await fetch(`${API_BASE_URL}/transfers`);
  if (!response.ok) {
    throw new Error('Failed to fetch transfers');
  }
  return response.json();
}

export async function fetchTransferDetail(id: string): Promise<{ job: TransferJob; logs: TransferLog[] }> {
  const response = await fetch(`${API_BASE_URL}/transfers/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch transfer detail');
  }
  return response.json();
}

export async function fetchCloudUsage(
  bucketType: CloudUsageBucketType,
  assumptions?: Partial<CloudUsageAssumptions>,
): Promise<CloudUsageSummary> {
  const params = new URLSearchParams({ bucketType });

  if (assumptions) {
    if (assumptions.putRequests !== undefined) params.set('putRequests', String(assumptions.putRequests));
    if (assumptions.getRequests !== undefined) params.set('getRequests', String(assumptions.getRequests));
    if (assumptions.listRequests !== undefined) params.set('listRequests', String(assumptions.listRequests));
    if (assumptions.lifecycleTransitionGB !== undefined) params.set('lifecycleTransitionGB', String(assumptions.lifecycleTransitionGB));
    if (assumptions.retrievalGB !== undefined) params.set('retrievalGB', String(assumptions.retrievalGB));
    if (assumptions.egressGB !== undefined) params.set('egressGB', String(assumptions.egressGB));
    if (assumptions.vatRate !== undefined) params.set('vatRate', String(assumptions.vatRate));
  }

  const response = await fetch(`${API_BASE_URL}/usage/cloud?${params.toString()}`);
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch cloud usage');
  }
  return response.json();
}

export async function pauseTransfer(id: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/transfers/${id}/pause`, {
    method: 'POST',
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to pause transfer');
  }

  return response.json();
}

export async function resumeTransfer(id: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/transfers/${id}/resume`, {
    method: 'POST',
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to resume transfer');
  }

  return response.json();
}

export async function retryTransferItem(id: string, mediaItemId: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/transfers/${id}/retry-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaItemId }),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to retry transfer item');
  }

  return response.json();
}

export async function queueAllTransferItems(id: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/transfers/${id}/retry-all-items`, {
    method: 'POST',
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to queue all transfer items');
  }

  return response.json();
}

export async function createTransfer(payload: {
  sourceProvider: string;
  destProvider: string;
  keys?: string[];
  sourceConfig?: Record<string, unknown>;
  destConfig?: Record<string, unknown>;
}): Promise<{ job: TransferJob }> {
  const response = await fetch(`${API_BASE_URL}/transfers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to create transfer');
  }

  return response.json();
}

export type DuplicateCheckItem = {
  id: string;
  exists: boolean;
  destinationKey: string;
};

export type DuplicateCheckResult = {
  items: DuplicateCheckItem[];
  duplicateCount: number;
  totalChecked: number;
};

export async function checkTransferDuplicates(
  items: { id: string; filename?: string; createTime?: string }[],
): Promise<DuplicateCheckResult> {
  const response = await fetch(`${API_BASE_URL}/transfers/check-duplicates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to check duplicates');
  }

  return response.json();
}

export async function fetchTakeoutStatus(): Promise<TakeoutStatus> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/status`,
    undefined,
    TAKEOUT_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error('Failed to fetch takeout status');
  }

  return response.json();
}

export async function fetchTakeoutActionStatus(): Promise<TakeoutActionStatus> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/action-status`,
    undefined,
    TAKEOUT_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error('Failed to fetch takeout action status');
  }

  return response.json();
}

export async function fetchSequenceAnalysis(): Promise<SequenceAnalysis> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/sequence-analysis`,
    undefined,
    TAKEOUT_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error('Failed to fetch sequence analysis');
  }

  return response.json();
}

export async function runTakeoutAction(action: TakeoutAction): Promise<{ message: string; status: TakeoutActionStatus }> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/actions/${action}`,
    {
      method: 'POST',
    },
    TAKEOUT_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiErrorMessage(raw) ?? `Failed to start action ${action}`;
    throw new Error(message);
  }

  return response.json();
}

export async function setAutoUpload(enabled: boolean): Promise<{ enabled: boolean }> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/auto-upload`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
    TAKEOUT_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error('Failed to update auto-upload setting');
  }
  return response.json();
}

/**
 * Generic helpers to update / reset any overridable takeout path.
 * `name` must match a key in the backend's OVERRIDABLE_PATHS map
 * (e.g. 'inputDir', 'workDir').
 */
export async function updateTakeoutPath(
  name: string,
  value: string,
): Promise<{ value: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/paths/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    TAKEOUT_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiErrorMessage(raw) ?? `Failed to update ${name}`;
    throw new Error(message);
  }

  return response.json();
}

export async function resetTakeoutPath(
  name: string,
): Promise<{ value: string; reset: boolean }> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/paths/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
    TAKEOUT_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiErrorMessage(raw) ?? `Failed to reset ${name}`;
    throw new Error(message);
  }

  return response.json();
}

export async function resetUploadState(): Promise<{ message: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/takeout/reset-upload-state`,
    { method: 'POST' },
    TAKEOUT_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiErrorMessage(raw) ?? 'Failed to reset upload state';
    throw new Error(message);
  }

  return response.json();
}

/* ── Legacy wrappers (kept for backward compatibility) ──────── */

export const updateTakeoutInputDir = (dir: string) =>
  updateTakeoutPath('inputDir', dir).then((r) => ({ inputDir: r.value }));

export const resetTakeoutInputDir = () =>
  resetTakeoutPath('inputDir').then((r) => ({ inputDir: r.value, reset: r.reset }));

export const updateTakeoutWorkDir = (dir: string) =>
  updateTakeoutPath('workDir', dir).then((r) => ({ workDir: r.value }));

export const resetTakeoutWorkDir = () =>
  resetTakeoutPath('workDir').then((r) => ({ workDir: r.value, reset: r.reset }));

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function parseApiError(raw: string): { code?: string; message?: string } {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as { error?: string | { code?: string; message?: string } };
    if (parsed?.error && typeof parsed.error === 'string') {
      return { message: parsed.error };
    }
    if (parsed?.error && typeof parsed.error === 'object') {
      return { code: parsed.error.code, message: parsed.error.message };
    }
  } catch {
    // plain text response
  }

  return { message: raw };
}

function parseApiErrorMessage(raw: string): string | undefined {
  return parseApiError(raw).message;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = TAKEOUT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Request timed out. Ensure backend is running and reachable.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Google Auth ────────────────────────────────────────────────

export type GoogleAuthStatus = {
  configured: boolean;
  connected: boolean;
  expired?: boolean;
  hasRefreshToken?: boolean;
  message?: string;
};

export async function fetchGoogleAuthStatus(): Promise<GoogleAuthStatus> {
  const response = await fetch(`${API_BASE_URL}/auth/google/status`);
  if (!response.ok) {
    throw new Error('Failed to fetch Google auth status');
  }
  return response.json();
}

export async function fetchGoogleAuthUrl(): Promise<{ url: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/google/url`);
  if (!response.ok) {
    throw new Error('Failed to get Google auth URL');
  }
  return response.json();
}

export async function submitGoogleAuthCode(code: string): Promise<{ connected: boolean }> {
  const response = await fetch(`${API_BASE_URL}/auth/google/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to exchange auth code');
  }
  return response.json();
}

export async function disconnectGoogle(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/google/disconnect`, { method: 'POST' });
  if (!response.ok) {
    throw new Error('Failed to disconnect Google account');
  }
}

// ── Picker ─────────────────────────────────────────────────────

export type PickerSession = {
  sessionId: string;
  pickerUri?: string;
  mediaItemsSet?: boolean;
};

export type PickedMediaItem = {
  id: string;
  mimeType?: string;
  filename?: string;
  createTime?: string;
  baseUrl?: string;
};

export async function createPickerSession(): Promise<PickerSession> {
  const response = await fetch(`${API_BASE_URL}/picker/session`, { method: 'POST' });
  if (!response.ok) {
    const raw = await response.text();
    const { code, message } = parseApiError(raw);
    if (code) {
      throw new ApiError(code, message ?? 'Failed to create picker session');
    }
    throw new Error(message ?? 'Failed to create picker session');
  }
  return response.json();
}

export async function pollPickerSession(sessionId: string): Promise<PickerSession> {
  const response = await fetch(`${API_BASE_URL}/picker/session/${sessionId}`);
  if (!response.ok) {
    throw new Error('Failed to poll picker session');
  }
  return response.json();
}

export async function fetchPickedItems(
  sessionId: string,
  pageToken?: string,
): Promise<{ mediaItems: PickedMediaItem[]; nextPageToken?: string }> {
  const params = new URLSearchParams();
  if (pageToken) params.set('pageToken', pageToken);
  const response = await fetch(`${API_BASE_URL}/picker/session/${sessionId}/items?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch picked items');
  }
  return response.json();
}

export async function deletePickerSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/picker/session/${sessionId}`, { method: 'DELETE' });
}

// ── Uploads ────────────────────────────────────────────────────

export type UploadResult = {
  filename: string;
  status: 'uploaded' | 'duplicate' | 'error';
  mediaItemId?: string;
  s3Key?: string;
  size?: number;
  capturedAt?: string;
  message?: string;
};

export type UploadResponse = {
  summary: {
    total: number;
    uploaded: number;
    duplicates: number;
    errors: number;
  };
  results: UploadResult[];
};

export type MediaItem = {
  id: string;
  filename: string;
  s3Key: string;
  sha256: string;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  capturedAt?: string;
  source: string;
  uploadedAt: string;
};

export type UploadListResponse = {
  items: MediaItem[];
  total: number;
  limit: number;
  offset: number;
};

export type UploadStats = {
  totalItems: number;
};

/**
 * Upload one or more files to the library.
 * Uses XMLHttpRequest for progress tracking.
 */
export function uploadFiles(
  files: File[],
  onProgress?: (loaded: number, total: number) => void,
): { promise: Promise<UploadResponse>; abort: () => void } {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadResponse>((resolve, reject) => {
    xhr.open('POST', `${API_BASE_URL}/uploads`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded, e.total);
      }
    });

    const PAYLOAD_TOO_LARGE_MSG = 'Files are too large. Maximum size is 500 MB per file. Try uploading fewer or smaller files.';

    xhr.addEventListener('load', () => {
      try {
        if (xhr.status === 413) {
          reject(new Error(PAYLOAD_TOO_LARGE_MSG));
          return;
        }
        const data = JSON.parse(xhr.responseText) as UploadResponse;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error((data as unknown as { error?: string })?.error ?? `Upload failed (${xhr.status})`));
        }
      } catch {
        if (xhr.status === 413) {
          reject(new Error(PAYLOAD_TOO_LARGE_MSG));
        } else {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.send(formData);
  });

  return { promise, abort: () => xhr.abort() };
}

export async function fetchUploadList(limit = 50, offset = 0): Promise<UploadListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await fetch(`${API_BASE_URL}/uploads?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch uploads');
  }
  return response.json();
}

export async function fetchUploadStats(): Promise<UploadStats> {
  const response = await fetch(`${API_BASE_URL}/uploads/stats`);
  if (!response.ok) {
    throw new Error('Failed to fetch upload stats');
  }
  return response.json();
}

// ── Catalog ────────────────────────────────────────────────────────────────

export type CatalogItem = {
  key: string;
  encodedKey: string;
  size: number;
  lastModified: string;
  capturedAt: string;
  mediaType: 'image' | 'video' | 'other';
  sectionDate: string;
};

export type CatalogPage = {
  items: CatalogItem[];
  nextToken?: string;
};

export type CatalogStats = {
  totalFiles: number;
  totalBytes: number;
  imageCount: number;
  videoCount: number;
  oldestDate: string | null;
  newestDate: string | null;
  undatedCount: number;
};

/** Returns the URL for streaming a catalog media object (full resolution). */
export function catalogMediaUrl(encodedKey: string, apiToken?: string): string {
  const url = new URL(`/catalog/media/${encodedKey}`, API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  return url.toString();
}

/**
 * Returns the URL for a resized catalog thumbnail.
 *   • `small` – 256px grid tile (~15-30 KB)
 *   • `large` – 1920px lightbox preview (~200-400 KB)
 */
export function catalogThumbnailUrl(
  encodedKey: string,
  size: 'small' | 'large',
  apiToken?: string,
): string {
  const url = new URL(`/catalog/thumb/${size}/${encodedKey}`, API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  return url.toString();
}

export async function fetchCatalogStats(apiToken?: string): Promise<CatalogStats> {
  const url = new URL('/catalog/api/stats', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch catalog stats');
  }
  return response.json();
}

export type DateDistributionMonth = {
  month: string;
  count: number;
};

export type DateDistribution = {
  months: DateDistributionMonth[];
  totalItems: number;
};

export async function fetchDateDistribution(apiToken?: string): Promise<DateDistribution> {
  const url = new URL('/catalog/api/date-distribution', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch date distribution');
  }
  return response.json();
}

export async function fetchCatalogItems(opts: {
  token?: string;
  prefix?: string;
  max?: number;
  sort?: 'asc' | 'desc';
  apiToken?: string;
}): Promise<CatalogPage> {
  const url = new URL('/catalog/api/items', API_BASE_URL);
  if (opts.token) url.searchParams.set('token', opts.token);
  if (opts.prefix) url.searchParams.set('prefix', opts.prefix);
  if (opts.max !== undefined) url.searchParams.set('max', String(opts.max));
  if (opts.sort) url.searchParams.set('sort', opts.sort);
  if (opts.apiToken) url.searchParams.set('apiToken', opts.apiToken);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TAKEOUT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch catalog items');
    }
    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function deleteCatalogItems(encodedKeys: string[], apiToken?: string): Promise<void> {
  const url = new URL('/catalog/api/items', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encodedKeys }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to delete items');
  }
}

export async function moveCatalogItem(
  encodedKey: string,
  newDatePrefix: string,
  apiToken?: string,
): Promise<{ from: string; to: string }> {
  const url = new URL('/catalog/api/items/move', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encodedKey, newDatePrefix }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to move item');
  }
  return response.json();
}

export async function bulkMoveCatalogItems(
  moves: { encodedKey: string; newDatePrefix: string }[],
  apiToken?: string,
): Promise<{ moved: { from: string; to: string }[]; failed: { key: string; error: string }[] }> {
  const url = new URL('/catalog/api/items/bulk-move', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to move items');
  }
  return response.json();
}

export async function fetchUndatedItems(apiToken?: string): Promise<{ items: CatalogItem[] }> {
  const url = new URL('/catalog/api/undated', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch undated items');
  }
  return response.json();
}

export type ExifData = {
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  make: string | null;
  model: string | null;
  latitude: number | null;
  longitude: number | null;
  raw: Record<string, unknown> | null;
};

export async function fetchCatalogExif(encodedKey: string, apiToken?: string): Promise<ExifData> {
  const url = new URL(`/catalog/api/exif/${encodedKey}`, API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch EXIF');
  }
  return response.json();
}

export type Album = {
  id: string;
  name: string;
  keys: string[];
  coverKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type AlbumsManifest = { albums: Album[] };

export async function fetchAlbums(apiToken?: string): Promise<AlbumsManifest> {
  const url = new URL('/catalog/api/albums', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch albums');
  }
  return response.json();
}

export async function createAlbum(
  name: string,
  apiToken?: string,
): Promise<{ id: string; name: string }> {
  const url = new URL('/catalog/api/albums', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to create album');
  }
  return response.json();
}

export async function updateAlbum(
  albumId: string,
  updates: { name?: string; addKeys?: string[]; removeKeys?: string[]; coverKey?: string },
  apiToken?: string,
): Promise<Album> {
  const url = new URL(`/catalog/api/albums/${albumId}`, API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to update album');
  }
  return response.json();
}

export async function deleteAlbum(albumId: string, apiToken?: string): Promise<void> {
  const url = new URL(`/catalog/api/albums/${albumId}`, API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString(), { method: 'DELETE' });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to delete album');
  }
}

// ── Deduplication ──────────────────────────────────────────────────────────

export type DuplicateGroup = {
  fingerprint: string;
  size: number;
  /** Raw S3 key of the copy to keep. */
  keepKey: string;
  /** Raw S3 keys that are safe to delete. */
  duplicateKeys: string[];
};

export type DuplicatesResult = {
  groups: DuplicateGroup[];
  totalDuplicates: number;
  bytesFreed: number;
};

/**
 * Encode a raw S3 key to the base64url format the backend uses for :encodedKey params.
 * Uses TextEncoder so non-ASCII filenames (accented chars, emoji, CJK, etc.) are
 * encoded identically to the Node.js backend's `Buffer.from(key, 'utf8').toString('base64url')`.
 */
export function encodeS3Key(key: string): string {
  const bytes = new TextEncoder().encode(key);
  // Convert Uint8Array → binary string → standard base64 → base64url
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function fetchDuplicates(apiToken?: string): Promise<DuplicatesResult> {
  const url = new URL('/catalog/api/duplicates', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch duplicates');
  }
  return response.json();
}

// ── Dedup scan status polling ──────────────────────────────────────────────

export type DedupScanStatus =
  | { status: 'idle' }
  | { status: 'scanning'; listed: number; totalFiles: number | null; startedAt: number }
  | { status: 'done'; groups: DuplicateGroup[]; totalDuplicates: number; bytesFreed: number; completedAt: number }
  | { status: 'error'; message: string; completedAt: number };

/** Poll the server for the current dedup scan state (cached results or progress). */
export async function fetchDedupScanStatus(apiToken?: string): Promise<DedupScanStatus> {
  const url = new URL('/catalog/api/duplicates/scan/status', API_BASE_URL);
  if (apiToken) url.searchParams.set('apiToken', apiToken);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to fetch scan status');
  }
  return response.json();
}

/** Progress event emitted by the SSE duplicate scan endpoint. */
export type DupScanProgress =
  | { phase: 'started'; totalFiles: number | null }
  | { phase: 'listing'; listed: number; totalFiles: number | null }
  | { phase: 'done'; groups: DuplicateGroup[]; totalDuplicates: number; bytesFreed: number }
  | { phase: 'error'; message: string };

/**
 * Stream the duplicate scan via SSE, calling `onProgress` for each event.
 * Returns the final DuplicatesResult when complete.
 * The caller can abort by using an AbortController.
 *
 * If the stream ends without a 'done' or 'error' event (connection drop),
 * rejects with a recognisable error so the caller can fall back to polling.
 */
export function scanDuplicatesStream(
  onProgress: (event: DupScanProgress) => void,
  apiToken?: string,
  signal?: AbortSignal,
): Promise<DuplicatesResult> {
  return new Promise((resolve, reject) => {
    const url = new URL('/catalog/api/duplicates/scan', API_BASE_URL);
    if (apiToken) url.searchParams.set('apiToken', apiToken);

    let settled = false;

    fetch(url.toString(), { signal })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          const raw = await response.text();
          // 409 = scan already running — caller should poll instead
          const msg = response.status === 409
            ? 'SCAN_ALREADY_RUNNING'
            : (parseApiErrorMessage(raw) ?? 'Scan request failed');
          reject(new Error(msg));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE frames: "data: {...}\n\n"
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const chunk of lines) {
            // Skip SSE comments (keepalive pings)
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const event = JSON.parse(dataLine.slice(6)) as DupScanProgress;
              onProgress(event);
              if (event.phase === 'done') {
                settled = true;
                resolve({ groups: event.groups, totalDuplicates: event.totalDuplicates, bytesFreed: event.bytesFreed });
              } else if (event.phase === 'error') {
                settled = true;
                reject(new Error(event.message));
              }
            } catch { /* skip malformed */ }
          }
        }

        // Stream ended without a terminal event — connection was likely dropped
        if (!settled) {
          reject(new Error('STREAM_ENDED_UNEXPECTEDLY'));
        }
      })
      .catch((err) => {
        if (!settled) reject(err);
      });
  });
}

