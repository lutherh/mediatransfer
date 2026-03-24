import { execFile } from 'child_process';
import { createRequire } from 'node:module';

execFile('ffmpeg', ['-version'], (err) => {
  if (!err) {
    console.log('System ffmpeg: FOUND');
    return;
  }
  console.log('System ffmpeg: NOT FOUND');
  try {
    const esmRequire = createRequire(import.meta.url);
    const p = esmRequire('ffmpeg-static') as string;
    console.log('ffmpeg-static path:', p);
    execFile(p, ['-version'], (e2, stdout) => {
      if (e2) console.log('ffmpeg-static BROKEN:', e2.message);
      else console.log('ffmpeg-static WORKS:', stdout.split('\n')[0]);
    });
  } catch (e: unknown) {
    console.log('createRequire FAILED:', (e as Error).message);
  }
});
