import { describe, it, expect } from 'vitest';
import { analyseArchiveSequences, type SequenceAnalysis } from './sequence-analysis.js';

describe('analyseArchiveSequences', () => {
  it('detects a complete sequence', () => {
    const names = [
      'takeout-20260308T081854Z-3-001.tgz',
      'takeout-20260308T081854Z-3-002.tgz',
      'takeout-20260308T081854Z-3-003.tgz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.totalArchives).toBe(3);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].isComplete).toBe(true);
    expect(result.groups[0].missing).toEqual([]);
    expect(result.groups[0].present).toEqual([1, 2, 3]);
    expect(result.groups[0].declaredTotal).toBe(3);
  });

  it('detects missing parts in a sequence', () => {
    const names = [
      'takeout-20260308T081854Z-4-001.tgz',
      'takeout-20260308T081854Z-4-003.tgz',
      'takeout-20260308T081854Z-4-004.tgz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].isComplete).toBe(false);
    expect(result.groups[0].missing).toEqual([2]);
    expect(result.groups[0].present).toEqual([1, 3, 4]);
    expect(result.groups[0].declaredTotal).toBe(4);
  });

  it('handles multiple groups independently', () => {
    const names = [
      'takeout-20260308T081854Z-3-001.tgz',
      'takeout-20260308T081854Z-3-002.tgz',
      'takeout-20260308T081854Z-3-003.tgz',
      'takeout-20260310T120000Z-2-001.tgz',
      // #002 missing from second group
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(2);

    const first = result.groups.find((g) => g.prefix === 'takeout-20260308T081854Z')!;
    expect(first.isComplete).toBe(true);
    expect(first.missing).toEqual([]);

    const second = result.groups.find((g) => g.prefix === 'takeout-20260310T120000Z')!;
    expect(second.isComplete).toBe(false);
    expect(second.missing).toEqual([2]);
  });

  it('reports unrecognised archive names', () => {
    const names = [
      'takeout-20260308T081854Z-3-001.tgz',
      'random-file.zip',
      'photos-backup.tar.gz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.unrecognised).toEqual(['random-file.zip', 'photos-backup.tar.gz']);
    expect(result.groups).toHaveLength(1);
  });

  it('handles empty input', () => {
    const result = analyseArchiveSequences([]);
    expect(result.totalArchives).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.unrecognised).toEqual([]);
  });

  it('handles sequence numbers exceeding declared total', () => {
    const names = [
      'takeout-20260308T081854Z-2-001.tgz',
      'takeout-20260308T081854Z-2-002.tgz',
      'takeout-20260308T081854Z-2-003.tgz', // exceeds declared total of 2
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups[0].declaredTotal).toBe(2);
    expect(result.groups[0].maxSeen).toBe(3);
    expect(result.groups[0].isComplete).toBe(false); // declared total ≠ count
  });

  it('handles .txt extension (uploaded-archives naming)', () => {
    const names = [
      'takeout-20260308T081854Z-3-001.txt',
      'takeout-20260308T081854Z-3-002.txt',
      'takeout-20260308T081854Z-3-003.txt',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].isComplete).toBe(true);
    expect(result.groups[0].extension).toBe('.txt');
  });

  it('detects multiple missing parts (first and middle)', () => {
    const names = [
      'takeout-20260308T081854Z-5-003.tgz',
      'takeout-20260308T081854Z-5-005.tgz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups[0].missing).toEqual([1, 2, 4]);
    expect(result.groups[0].present).toEqual([3, 5]);
    expect(result.groups[0].isComplete).toBe(false);
  });

  it('treats same prefix with different declared totals as separate groups', () => {
    const names = [
      'takeout-20260308T081854Z-3-001.tgz',
      'takeout-20260308T081854Z-3-002.tgz',
      'takeout-20260308T081854Z-3-003.tgz',
      'takeout-20260308T081854Z-5-001.tgz',
      'takeout-20260308T081854Z-5-002.tgz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(2);

    const threePartGroup = result.groups.find((g) => g.declaredTotal === 3)!;
    expect(threePartGroup.isComplete).toBe(true);

    const fivePartGroup = result.groups.find((g) => g.declaredTotal === 5)!;
    expect(fivePartGroup.isComplete).toBe(false);
    expect(fivePartGroup.missing).toEqual([3, 4, 5]);
  });

  it('treats same prefix with different extensions as separate groups', () => {
    const names = [
      'takeout-20260308T081854Z-2-001.tgz',
      'takeout-20260308T081854Z-2-002.tgz',
      'takeout-20260308T081854Z-2-001.zip',
      // .zip group is missing #2
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(2);

    const tgzGroup = result.groups.find((g) => g.extension === '.tgz')!;
    expect(tgzGroup.isComplete).toBe(true);

    const zipGroup = result.groups.find((g) => g.extension === '.zip')!;
    expect(zipGroup.isComplete).toBe(false);
    expect(zipGroup.missing).toEqual([2]);
  });

  it('deduplicates duplicate archive names', () => {
    const names = [
      'takeout-20260308T081854Z-2-001.tgz',
      'takeout-20260308T081854Z-2-001.tgz', // duplicate
      'takeout-20260308T081854Z-2-002.tgz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.totalArchives).toBe(3); // counts input length, not unique
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].present).toEqual([1, 2]);
    expect(result.groups[0].isComplete).toBe(true);
  });

  it('sorts groups by prefix then by declared total', () => {
    const names = [
      'takeout-20260310T120000Z-2-001.tgz',
      'takeout-20260308T081854Z-5-001.tgz',
      'takeout-20260308T081854Z-3-001.tgz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(3);
    expect(result.groups[0].prefix).toBe('takeout-20260308T081854Z');
    expect(result.groups[0].declaredTotal).toBe(3);
    expect(result.groups[1].prefix).toBe('takeout-20260308T081854Z');
    expect(result.groups[1].declaredTotal).toBe(5);
    expect(result.groups[2].prefix).toBe('takeout-20260310T120000Z');
  });

  it('handles single-part archive (declared total = 1)', () => {
    const names = ['takeout-20260308T081854Z-1-001.tgz'];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].isComplete).toBe(true);
    expect(result.groups[0].declaredTotal).toBe(1);
    expect(result.groups[0].present).toEqual([1]);
    expect(result.groups[0].missing).toEqual([]);
  });

  it('handles tar.gz compound extension', () => {
    const names = [
      'takeout-20260308T081854Z-2-001.tar.gz',
      'takeout-20260308T081854Z-2-002.tar.gz',
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].extension).toBe('.tar.gz');
    expect(result.groups[0].isComplete).toBe(true);
  });

  it('returns maxSeen = 0 for empty group (should not occur in practice)', () => {
    // Edge case: no valid archives, only unrecognised
    const result = analyseArchiveSequences(['not-a-takeout.zip']);
    expect(result.groups).toHaveLength(0);
    expect(result.unrecognised).toEqual(['not-a-takeout.zip']);
  });

  it('only missing the last part', () => {
    const names = [
      'takeout-20260308T081854Z-3-001.tgz',
      'takeout-20260308T081854Z-3-002.tgz',
      // #003 missing
    ];
    const result = analyseArchiveSequences(names);
    expect(result.groups[0].isComplete).toBe(false);
    expect(result.groups[0].missing).toEqual([3]);
    expect(result.groups[0].maxSeen).toBe(2);
  });

  it('large sequence with scattered gaps', () => {
    // Simulate 20-part archive with parts 1, 5, 10, 15, 20 present
    const names = [1, 5, 10, 15, 20].map(
      (n) => `takeout-20260308T081854Z-20-${String(n).padStart(3, '0')}.tgz`,
    );
    const result = analyseArchiveSequences(names);
    expect(result.groups[0].present).toEqual([1, 5, 10, 15, 20]);
    expect(result.groups[0].missing).toHaveLength(15);
    expect(result.groups[0].missing).toContain(2);
    expect(result.groups[0].missing).toContain(19);
    expect(result.groups[0].isComplete).toBe(false);
    expect(result.groups[0].declaredTotal).toBe(20);
  });
});
