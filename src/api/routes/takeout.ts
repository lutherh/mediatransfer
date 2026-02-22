import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

type UploadStateItem = {
  status: 'uploaded' | 'skipped' | 'failed';
  attempts: number;
  updatedAt: string;
  error?: string;
};

type UploadState = {
  version: 1;
  updatedAt: string;
  items: Record<string, UploadStateItem>;
};

export async function registerTakeoutRoutes(app: FastifyInstance): Promise<void> {
  app.get('/takeout/status', async () => {
    const workDir = path.resolve(process.env.TAKEOUT_WORK_DIR ?? './data/takeout/work');
    const statePath = path.resolve(process.env.TRANSFER_STATE_PATH ?? './data/takeout/state.json');
    const manifestPath = path.join(workDir, 'manifest.jsonl');

    const [manifestCount, state] = await Promise.all([
      readManifestCount(manifestPath),
      readUploadState(statePath),
    ]);

    const summary = summarizeState(state.items);
    const total = manifestCount;
    const processed = summary.uploaded + summary.skipped + summary.failed;
    const pending = Math.max(total - processed, 0);
    const progress = total > 0 ? Math.min(processed / total, 1) : 0;

    return {
      paths: {
        manifestPath,
        statePath,
      },
      counts: {
        total,
        processed,
        pending,
        uploaded: summary.uploaded,
        skipped: summary.skipped,
        failed: summary.failed,
      },
      progress,
      stateUpdatedAt: state.updatedAt,
      recentFailures: summary.recentFailures,
      isComplete: total > 0 && pending === 0 && summary.failed === 0,
    };
  });
}

async function readManifestCount(manifestPath: string): Promise<number> {
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function readUploadState(statePath: string): Promise<UploadState> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as UploadState;
    if (!parsed || parsed.version !== 1 || typeof parsed.items !== 'object' || !parsed.items) {
      return createEmptyState();
    }

    return parsed;
  } catch {
    return createEmptyState();
  }
}

function createEmptyState(): UploadState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: {},
  };
}

function summarizeState(items: Record<string, UploadStateItem>): {
  uploaded: number;
  skipped: number;
  failed: number;
  recentFailures: Array<{ key: string; error?: string; updatedAt: string; attempts: number }>;
} {
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const recentFailures: Array<{ key: string; error?: string; updatedAt: string; attempts: number }> = [];

  for (const [key, item] of Object.entries(items)) {
    if (item.status === 'uploaded') {
      uploaded += 1;
      continue;
    }

    if (item.status === 'skipped') {
      skipped += 1;
      continue;
    }

    failed += 1;
    recentFailures.push({
      key,
      error: item.error,
      updatedAt: item.updatedAt,
      attempts: item.attempts,
    });
  }

  recentFailures.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    uploaded,
    skipped,
    failed,
    recentFailures: recentFailures.slice(0, 10),
  };
}
