import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import type { ManifestEntry } from './manifest.js';
import type { UploadState, UploadSummary } from './uploader.js';
import {
  buildReconciliationReport,
  persistReportCsv,
  persistReportJson,
} from './report.js';

function entry(key: string, size: number): ManifestEntry {
  return {
    sourcePath: `/tmp/${key}`,
    relativePath: key,
    size,
    mtimeMs: Date.now(),
    capturedAt: new Date().toISOString(),
    datePath: '2025/12/13',
    destinationKey: key,
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-report-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('takeout/report', () => {
  it('builds bytes and failure reason aggregates', () => {
    const entries = [
      entry('a.jpg', 100),
      entry('b.jpg', 200),
      entry('c.jpg', 300),
    ];

    const state: UploadState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: {
        'a.jpg': { status: 'uploaded', attempts: 1, updatedAt: new Date().toISOString() },
        'b.jpg': { status: 'skipped', attempts: 0, updatedAt: new Date().toISOString() },
        'c.jpg': { status: 'failed', attempts: 3, updatedAt: new Date().toISOString(), error: 'network' },
      },
    };

    const summary: UploadSummary = {
      total: 3,
      processed: 3,
      uploaded: 1,
      skipped: 1,
      failed: 1,
      dryRun: false,
      stoppedEarly: false,
      failureLimitReached: false,
    };

    const report = buildReconciliationReport(entries, state, summary);
    expect(report.bytes.uploaded).toBe(100);
    expect(report.bytes.skipped).toBe(200);
    expect(report.bytes.failed).toBe(300);
    expect(report.failuresByReason.network).toBe(1);
  });

  it('persists JSON and CSV reports', async () => {
    await withTempDir(async (dir) => {
      const reportPath = path.join(dir, 'reports', 'report.json');
      const csvPath = path.join(dir, 'reports', 'report.csv');

      await persistReportJson(
        {
          generatedAt: new Date().toISOString(),
          summary: {
            total: 1,
            processed: 1,
            uploaded: 1,
            skipped: 0,
            failed: 0,
            dryRun: false,
            stoppedEarly: false,
            failureLimitReached: false,
          },
          bytes: { uploaded: 100, skipped: 0, failed: 0 },
          failuresByReason: {},
          manifestCount: 1,
        },
        reportPath,
      );

      const state: UploadState = {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: {
          'a.jpg': { status: 'uploaded', attempts: 1, updatedAt: new Date().toISOString() },
        },
      };
      await persistReportCsv(state, csvPath);

      const json = await fs.readFile(reportPath, 'utf8');
      const csv = await fs.readFile(csvPath, 'utf8');
      expect(json).toContain('"manifestCount": 1');
      expect(csv).toContain('destinationKey,status,attempts,updatedAt,error');
      expect(csv).toContain('a.jpg,uploaded,1');
    });
  });
});
