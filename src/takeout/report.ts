import path from 'node:path';
import fs from 'node:fs/promises';
import type { ManifestEntry } from './manifest.js';
import type { UploadState, UploadSummary } from './uploader.js';

export type ReconciliationReport = {
  generatedAt: string;
  summary: UploadSummary;
  bytes: {
    uploaded: number;
    skipped: number;
    failed: number;
  };
  failuresByReason: Record<string, number>;
  manifestCount: number;
};

export function buildReconciliationReport(
  entries: ManifestEntry[],
  state: UploadState,
  summary: UploadSummary,
): ReconciliationReport {
  let uploadedBytes = 0;
  let skippedBytes = 0;
  let failedBytes = 0;

  const failuresByReason: Record<string, number> = {};

  for (const entry of entries) {
    const item = state.items[entry.destinationKey];
    if (!item) continue;

    if (item.status === 'uploaded') {
      uploadedBytes += entry.size;
    } else if (item.status === 'skipped') {
      skippedBytes += entry.size;
    } else if (item.status === 'failed') {
      failedBytes += entry.size;
      const reason = item.error ?? 'unknown';
      failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    bytes: {
      uploaded: uploadedBytes,
      skipped: skippedBytes,
      failed: failedBytes,
    },
    failuresByReason,
    manifestCount: entries.length,
  };
}

export async function persistReportJson(
  report: ReconciliationReport,
  reportPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

export async function persistReportCsv(
  state: UploadState,
  reportPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const lines = ['destinationKey,status,attempts,updatedAt,error'];

  for (const [key, item] of Object.entries(state.items).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const row = [
      csvEscape(key),
      csvEscape(item.status),
      String(item.attempts),
      csvEscape(item.updatedAt),
      csvEscape(item.error ?? ''),
    ].join(',');

    lines.push(row);
  }

  await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
