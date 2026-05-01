import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

type RunLockInfo = {
  pid: number;
  startedAt: string;
  source: 'cli' | 'api';
  command: string;
  instanceId?: string;
  lastSeenAt?: string;
};

const pid = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isFinite(pid) || pid <= 0) {
  process.stderr.write('Usage: npx tsx scripts/heartbeat-takeout-lock.ts <pid> [workDir]\n');
  process.exit(2);
}

const workDir = path.resolve(process.argv[3] ?? 'data/takeout/work');
const lockPath = path.join(workDir, '.takeout-run.lock');

function isProcessAlive(targetPid: number): boolean {
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

async function readLock(): Promise<RunLockInfo | null> {
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8')) as RunLockInfo;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

while (isProcessAlive(pid)) {
  const lock = await readLock();
  if (!lock || lock.pid !== pid) break;
  await writeJsonAtomic(lockPath, {
    ...lock,
    lastSeenAt: new Date().toISOString(),
  });
  await sleep(30_000);
}

const finalLock = await readLock();
if (finalLock?.pid === pid) {
  await fs.rm(lockPath, { force: true });
}