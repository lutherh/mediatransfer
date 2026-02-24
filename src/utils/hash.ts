import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Compute the SHA-256 hash of a Readable stream.
 * Returns the hex-encoded digest.
 *
 * The stream is fully consumed by this function.
 */
export async function sha256Stream(stream: Readable): Promise<string> {
  const hash = createHash('sha256');

  return new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Compute the SHA-256 hash of a Buffer.
 * Returns the hex-encoded digest.
 */
export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
