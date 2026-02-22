const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export type TransferJob = {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  sourceProvider: string;
  destProvider: string;
  progress: number;
  createdAt: string;
};

export type TransferLog = {
  id: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  createdAt: string;
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

