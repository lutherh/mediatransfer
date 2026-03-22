import dotenv from 'dotenv';
dotenv.config();
import fs from 'node:fs/promises';

// Analyze archive-state.json timing and throughput
const stateFile = await fs.readFile('./data/takeout/work/archive-state.json', 'utf8');
const state = JSON.parse(stateFile);

const entries = Object.entries(state.archives as Record<string, any>);

let totalMediaBytes = 0;
let totalEntries = 0;
let totalUploaded = 0;
let firstStart: Date | null = null;
let lastComplete: Date | null = null;
let completedCount = 0;

interface Session { start: Date; end: Date; archives: string[]; mediaBytes: number; uploadedCount: number; }
const sessions: Session[] = [];
let currentSession: Session | null = null;

// Sort archives by startedAt
const sorted = entries
  .filter(([, v]: [string, any]) => v.startedAt)
  .sort((a: any, b: any) => new Date(a[1].startedAt).getTime() - new Date(b[1].startedAt).getTime());

for (const [name, item] of sorted as [string, any][]) {
  totalEntries += item.entryCount ?? 0;
  totalUploaded += item.uploadedCount ?? 0;
  const mediaBytes = item.mediaBytes ?? 0;
  totalMediaBytes += mediaBytes;
  
  if (item.status === 'completed') completedCount++;
  
  const start = item.startedAt ? new Date(item.startedAt) : null;
  const end = item.completedAt ? new Date(item.completedAt) : null;
  
  if (start && (!firstStart || start < firstStart)) firstStart = start;
  if (end && (!lastComplete || end > lastComplete)) lastComplete = end;

  // Detect sessions (gap > 5 minutes = new session)
  if (start) {
    if (!currentSession || (start.getTime() - currentSession.end.getTime()) > 5 * 60 * 1000) {
      if (currentSession) sessions.push(currentSession);
      currentSession = { start, end: end || start, archives: [name], mediaBytes, uploadedCount: item.uploadedCount ?? 0 };
    } else {
      currentSession.archives.push(name);
      currentSession.mediaBytes += mediaBytes;
      currentSession.uploadedCount += item.uploadedCount ?? 0;
      if (end && end > currentSession.end) currentSession.end = end;
    }
  }
}
if (currentSession) sessions.push(currentSession);

console.log('=== Archive State Throughput Analysis ===');
console.log(`Total archives: ${entries.length} (${completedCount} completed)`);
console.log(`Total entries: ${totalEntries}`);
console.log(`Total uploaded: ${totalUploaded}`);
console.log(`Total media bytes: ${(totalMediaBytes / 1e9).toFixed(2)} GB`);
console.log(`First start: ${firstStart?.toISOString()}`);
console.log(`Last complete: ${lastComplete?.toISOString()}`);

if (firstStart && lastComplete) {
  const wallTimeSec = (lastComplete.getTime() - firstStart.getTime()) / 1000;
  console.log(`Wall time: ${(wallTimeSec / 3600).toFixed(2)} hours`);
  console.log(`Average throughput: ${(totalMediaBytes / wallTimeSec / 1e6).toFixed(2)} MB/s`);
}

console.log(`\n=== Sessions (${sessions.length}) ===`);
for (let i = 0; i < sessions.length; i++) {
  const s = sessions[i];
  const durSec = (s.end.getTime() - s.start.getTime()) / 1000;
  const throughputMBps = durSec > 0 ? s.mediaBytes / durSec / 1e6 : 0;
  console.log(`\nSession ${i + 1}:`);
  console.log(`  Start: ${s.start.toISOString()}`);
  console.log(`  End: ${s.end.toISOString()}`);
  console.log(`  Duration: ${(durSec / 60).toFixed(1)} minutes`);
  console.log(`  Archives: ${s.archives.length}`);
  console.log(`  Uploaded: ${s.uploadedCount} items`);
  console.log(`  Media: ${(s.mediaBytes / 1e9).toFixed(2)} GB`);
  console.log(`  Throughput: ${throughputMBps.toFixed(2)} MB/s`);
  
  // Show first and last archive with individual timing
  if (s.archives.length > 0) {
    const firstArch = state.archives[s.archives[0]];
    const lastArch = state.archives[s.archives[s.archives.length - 1]];
    const firstDurSec = firstArch.startedAt && firstArch.completedAt
      ? (new Date(firstArch.completedAt).getTime() - new Date(firstArch.startedAt).getTime()) / 1000
      : 0;
    const firstSpeed = firstDurSec > 0 ? (firstArch.mediaBytes ?? 0) / firstDurSec / 1e6 : 0;
    console.log(`  First archive: ${s.archives[0]} — ${firstDurSec.toFixed(0)}s — ${firstSpeed.toFixed(1)} MB/s`);
    if (s.archives.length > 1) {
      const lastDurSec = lastArch.startedAt && lastArch.completedAt
        ? (new Date(lastArch.completedAt).getTime() - new Date(lastArch.startedAt).getTime()) / 1000
        : 0;
      const lastSpeed = lastDurSec > 0 ? (lastArch.mediaBytes ?? 0) / lastDurSec / 1e6 : 0;
      console.log(`  Last archive: ${s.archives[s.archives.length - 1]} — ${lastDurSec.toFixed(0)}s — ${lastSpeed.toFixed(1)} MB/s`);
    }
  }
}

// Check for the stuck "extracting" archive
console.log('\n=== Stuck/Non-completed Archives ===');
for (const [name, item] of entries as [string, any][]) {
  if (item.status !== 'completed' && item.status !== 'pending') {
    console.log(`${name}: status=${item.status}, startedAt=${item.startedAt}, entries=${item.entryCount}`);
  }
}
