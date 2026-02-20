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
