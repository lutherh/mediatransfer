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

export async function createTransfer(payload: {
  sourceProvider: string;
  destProvider: string;
  keys?: string[];
}): Promise<{ job: TransferJob }> {
  const response = await fetch(`${API_BASE_URL}/transfers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('Failed to create transfer');
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
