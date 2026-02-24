const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

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
};

export type TakeoutAction = 'scan' | 'upload' | 'verify' | 'resume' | 'start-services';

export type TakeoutActionStatus = {
  running: boolean;
  action?: TakeoutAction;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  success?: boolean;
  output: string[];
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

export async function fetchTakeoutStatus(): Promise<TakeoutStatus> {
  const response = await fetch(`${API_BASE_URL}/takeout/status`);
  if (!response.ok) {
    throw new Error('Failed to fetch takeout status');
  }

  return response.json();
}

export async function fetchTakeoutActionStatus(): Promise<TakeoutActionStatus> {
  const response = await fetch(`${API_BASE_URL}/takeout/action-status`);
  if (!response.ok) {
    throw new Error('Failed to fetch takeout action status');
  }

  return response.json();
}

export async function runTakeoutAction(action: TakeoutAction): Promise<{ message: string; status: TakeoutActionStatus }> {
  const response = await fetch(`${API_BASE_URL}/takeout/actions/${action}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiErrorMessage(raw) ?? `Failed to start action ${action}`;
    throw new Error(message);
  }

  return response.json();
}

function parseApiErrorMessage(raw: string): string | undefined {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // plain text response
  }

  return raw;
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
    throw new Error(parseApiErrorMessage(raw) ?? 'Failed to create picker session');
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

    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText) as UploadResponse;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error((data as unknown as { error?: string })?.error ?? `Upload failed (${xhr.status})`));
        }
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
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

