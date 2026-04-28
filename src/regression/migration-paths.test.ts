import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf-8');
}

/**
 * Regression suite for the unified S3 layout (post-migration April 2026).
 *
 * Canonical layout:
 *   s3://${BUCKET}/immich/library/...         ← Immich originals
 *   s3://${BUCKET}/immich/upload/...          ← Immich incoming
 *   s3://${BUCKET}/immich/s3transfers/...     ← MediaTransfer uploads
 *   s3://${BUCKET}/immich/_thumbs/...         ← MediaTransfer catalog thumbs
 *
 * Bug history captured here:
 *  1. `scripts/migrate-s3-to-immich.sh` — `S3_SOURCE` pointed at the
 *     legacy bucket-root `transfers/` namespace. After the namespace move
 *     this would silently no-op (zero year folders found).
 *  2. `scripts/verify-s3-immich-compat.ts` — Check 5 was inverted: it
 *     constructed `${SCW_PREFIX}/transfers/` (wrong path) and asserted
 *     that MediaTransfer must NOT overlap the Immich prefix. The unified
 *     layout *intentionally* co-locates them, so the check now asserts
 *     the opposite (co-location confirmed).
 */
describe('migration scripts — unified S3 layout', () => {
  describe('scripts/migrate-s3-to-immich.sh', () => {
    const content = read('scripts/migrate-s3-to-immich.sh');

    it('S3_SOURCE points at the unified immich/s3transfers/ namespace', () => {
      expect(content).toMatch(/S3_SOURCE=":s3:\$\{BUCKET\}\/immich\/s3transfers"/);
    });

    it('does not point at the legacy bucket-root transfers/ namespace', () => {
      // This pattern would match S3_SOURCE=":s3:${BUCKET}/transfers" or trailing slash.
      expect(content).not.toMatch(/S3_SOURCE=":s3:\$\{BUCKET\}\/transfers"/);
    });
  });

  describe('scripts/verify-s3-immich-compat.ts', () => {
    const content = read('scripts/verify-s3-immich-compat.ts');

    it('builds mtTransfers using the s3transfers/ folder name (not legacy transfers/)', () => {
      // The legacy buggy form was: `${mtPrefix}/transfers/`
      expect(content).toMatch(/`\$\{mtPrefix\}\/s3transfers\/`/);
      expect(content).not.toMatch(/`\$\{mtPrefix\}\/transfers\/`/);
    });

    it('asserts MediaTransfer is co-located under Immich prefix (not isolated)', () => {
      // Inverted from the original buggy check. Co-location is the goal.
      expect(content).toMatch(
        /MediaTransfer "[^"]+" is co-located under Immich prefix/,
      );
      expect(content).not.toMatch(/are isolated\.`\)/);
    });

    it('summary section reflects the unified layout', () => {
      // Summary must list the new s3transfers/ folder under the rclonePrefix —
      // not the legacy bucket-root transfers/ path.
      expect(content).toMatch(/\$\{rclonePrefix\}\/s3transfers\//);
      expect(content).not.toMatch(/`\s+s3:\/\/\$\{rcloneBucket\}\/transfers\//);
    });
  });
});
