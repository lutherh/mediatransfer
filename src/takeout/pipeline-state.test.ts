import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  actionToPipelineStep,
  buildPipelineSummary,
  createDefaultPipelineState,
  getPipelineStatePath,
  loadPipelineState,
  markStepFinished,
  markStepStarted,
  PIPELINE_STEPS,
  savePipelineState,
  type PipelineState,
} from './pipeline-state.js';

describe('pipeline-state', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-state-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── actionToPipelineStep ──────────────────────────────────────────────────

  describe('actionToPipelineStep', () => {
    it('maps scan to scan step', () => {
      expect(actionToPipelineStep('scan')).toBe('scan');
    });

    it('maps upload and resume to upload step', () => {
      expect(actionToPipelineStep('upload')).toBe('upload');
      expect(actionToPipelineStep('resume')).toBe('upload');
    });

    it('maps verify to verify step', () => {
      expect(actionToPipelineStep('verify')).toBe('verify');
    });

    it('maps all cleanup variants to cleanup step', () => {
      expect(actionToPipelineStep('cleanup-move')).toBe('cleanup');
      expect(actionToPipelineStep('cleanup-delete')).toBe('cleanup');
      expect(actionToPipelineStep('cleanup-force-move')).toBe('cleanup');
      expect(actionToPipelineStep('cleanup-force-delete')).toBe('cleanup');
    });

    it('returns undefined for unknown actions', () => {
      expect(actionToPipelineStep('start-services')).toBeUndefined();
      expect(actionToPipelineStep('bogus')).toBeUndefined();
    });
  });

  // ─── createDefaultPipelineState ────────────────────────────────────────────

  describe('createDefaultPipelineState', () => {
    it('creates state with all steps pending', () => {
      const state = createDefaultPipelineState();
      expect(state.version).toBe(1);
      expect(state.currentStep).toBe('scan');
      for (const step of PIPELINE_STEPS) {
        expect(state.steps[step]).toEqual({ step, status: 'pending' });
      }
    });

    it('has a valid updatedAt timestamp', () => {
      const state = createDefaultPipelineState();
      expect(new Date(state.updatedAt).getTime()).not.toBeNaN();
    });
  });

  // ─── Persistence: save / load ──────────────────────────────────────────────

  describe('persistence', () => {
    it('round-trips state through save and load', async () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, ['done'], { total: 100, done: 100 });

      await savePipelineState(tempDir, state);
      const loaded = await loadPipelineState(tempDir);

      expect(loaded.currentStep).toBe('upload'); // advanced after scan
      expect(loaded.steps.scan.status).toBe('completed');
      expect(loaded.steps.scan.itemsTotal).toBe(100);
      expect(loaded.steps.scan.itemsDone).toBe(100);
    });

    it('returns default state when file does not exist', async () => {
      const loaded = await loadPipelineState(tempDir);
      expect(loaded.currentStep).toBe('scan');
      expect(loaded.steps.scan.status).toBe('pending');
    });

    it('returns default state when file is malformed JSON', async () => {
      const filePath = getPipelineStatePath(tempDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '{ not valid json !!!', 'utf8');

      const loaded = await loadPipelineState(tempDir);
      expect(loaded.version).toBe(1);
      expect(loaded.currentStep).toBe('scan');
    });

    it('returns default state when file has wrong version', async () => {
      const filePath = getPipelineStatePath(tempDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ version: 99, steps: {} }), 'utf8');

      const loaded = await loadPipelineState(tempDir);
      expect(loaded.version).toBe(1);
    });

    it('creates work directory if it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'a', 'b', 'c');
      const state = createDefaultPipelineState();
      await savePipelineState(nestedDir, state);

      const loaded = await loadPipelineState(nestedDir);
      expect(loaded.version).toBe(1);
    });

    it('getPipelineStatePath returns expected filename', () => {
      const result = getPipelineStatePath(tempDir);
      expect(result).toBe(path.join(tempDir, 'pipeline-state.json'));
    });
  });

  // ─── markStepStarted ──────────────────────────────────────────────────────

  describe('markStepStarted', () => {
    it('marks the correct step as in-progress', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');

      expect(state.currentStep).toBe('scan');
      expect(state.steps.scan.status).toBe('in-progress');
      expect(state.steps.scan.startedAt).toBe('2026-03-05T10:00:00.000Z');
    });

    it('clears previous completedAt when re-starting a step', () => {
      const state = createDefaultPipelineState();
      state.steps.scan.completedAt = '2026-03-05T09:00:00.000Z';
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');

      expect(state.steps.scan.completedAt).toBeUndefined();
    });

    it('records last action with the correct start time', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'upload', '2026-03-05T11:00:00.000Z');

      expect(state.lastAction).toEqual({
        action: 'upload',
        startedAt: '2026-03-05T11:00:00.000Z',
      });
    });

    it('maps resume action to the upload step', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'resume', '2026-03-05T12:00:00.000Z');

      expect(state.currentStep).toBe('upload');
      expect(state.steps.upload.status).toBe('in-progress');
    });

    it('is a no-op for actions not mapped to a pipeline step', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'start-services', '2026-03-05T12:00:00.000Z');

      // No step should change
      for (const step of PIPELINE_STEPS) {
        expect(state.steps[step].status).toBe('pending');
      }
      expect(state.currentStep).toBe('scan');
    });
  });

  // ─── markStepFinished ─────────────────────────────────────────────────────

  describe('markStepFinished', () => {
    it('marks step as completed on success', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, ['ok']);

      expect(state.steps.scan.status).toBe('completed');
      expect(state.steps.scan.completedAt).toBe('2026-03-05T10:05:00.000Z');
    });

    it('marks step as failed on failure', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', false, '2026-03-05T10:05:00.000Z', 1, ['error']);

      expect(state.steps.scan.status).toBe('failed');
    });

    it('records counts when provided', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'upload', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'upload', true, '2026-03-05T11:00:00.000Z', 0, [], {
        total: 500,
        done: 490,
        failed: 10,
      });

      expect(state.steps.upload.itemsTotal).toBe(500);
      expect(state.steps.upload.itemsDone).toBe(490);
      expect(state.steps.upload.itemsFailed).toBe(10);
    });

    it('advances currentStep to next pending step after success', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, []);

      expect(state.currentStep).toBe('upload');
    });

    it('does NOT advance currentStep on failure', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', false, '2026-03-05T10:05:00.000Z', 1, []);

      expect(state.currentStep).toBe('scan');
    });

    it('skips already-completed steps when advancing', () => {
      const state = createDefaultPipelineState();

      // Complete scan
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, []);

      // Complete upload
      markStepStarted(state, 'upload', '2026-03-05T10:10:00.000Z');
      markStepFinished(state, 'upload', true, '2026-03-05T11:00:00.000Z', 0, []);

      expect(state.currentStep).toBe('verify');
    });

    it('advances to the failed step if next step has failed status', () => {
      const state = createDefaultPipelineState();
      // Manually set verify to failed
      state.steps.verify.status = 'failed';

      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, []);

      // Should advance to upload (next pending), not verify (which is failed but after upload)
      expect(state.currentStep).toBe('upload');
    });

    it('updates lastAction with finish info and output tail', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');

      const output = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, output);

      expect(state.lastAction?.finishedAt).toBe('2026-03-05T10:05:00.000Z');
      expect(state.lastAction?.exitCode).toBe(0);
      expect(state.lastAction?.success).toBe(true);
      // Output tail is capped at 50 lines
      expect(state.lastAction?.outputTail).toHaveLength(50);
      expect(state.lastAction?.outputTail?.[0]).toBe('line 50');
    });

    it('handles finish without a prior start gracefully', () => {
      const state = createDefaultPipelineState();
      // No markStepStarted call — simulate direct finish
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, []);

      expect(state.steps.scan.status).toBe('completed');
      // lastAction was never set so its finish fields won't update
      expect(state.lastAction).toBeUndefined();
    });
  });

  // ─── Full pipeline workflow ────────────────────────────────────────────────

  describe('full pipeline workflow', () => {
    it('progresses through all four steps', () => {
      const state = createDefaultPipelineState();

      // Scan
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      expect(state.currentStep).toBe('scan');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, [], { total: 1000, done: 1000 });
      expect(state.currentStep).toBe('upload');

      // Upload
      markStepStarted(state, 'upload', '2026-03-05T10:10:00.000Z');
      markStepFinished(state, 'upload', true, '2026-03-05T11:00:00.000Z', 0, [], { total: 1000, done: 980, failed: 20 });
      expect(state.currentStep).toBe('verify');

      // Verify
      markStepStarted(state, 'verify', '2026-03-05T11:05:00.000Z');
      markStepFinished(state, 'verify', true, '2026-03-05T11:10:00.000Z', 0, []);
      expect(state.currentStep).toBe('cleanup');

      // Cleanup
      markStepStarted(state, 'cleanup-move', '2026-03-05T11:15:00.000Z');
      markStepFinished(state, 'cleanup-move', true, '2026-03-05T11:16:00.000Z', 0, []);

      // All steps completed
      for (const step of PIPELINE_STEPS) {
        expect(state.steps[step].status).toBe('completed');
      }
    });

    it('retry scenario: failed upload → re-run → completes', () => {
      const state = createDefaultPipelineState();

      // Scan succeeds
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, []);

      // Upload fails
      markStepStarted(state, 'upload', '2026-03-05T10:10:00.000Z');
      markStepFinished(state, 'upload', false, '2026-03-05T10:30:00.000Z', 1, ['timeout']);
      expect(state.steps.upload.status).toBe('failed');
      expect(state.currentStep).toBe('upload'); // stays at upload

      // Retry upload succeeds
      markStepStarted(state, 'upload', '2026-03-05T10:35:00.000Z');
      expect(state.steps.upload.status).toBe('in-progress');
      markStepFinished(state, 'upload', true, '2026-03-05T11:00:00.000Z', 0, []);
      expect(state.steps.upload.status).toBe('completed');
      expect(state.currentStep).toBe('verify');
    });

    it('resume action maps to the upload step', () => {
      const state = createDefaultPipelineState();
      state.steps.scan.status = 'completed';
      state.currentStep = 'upload';

      markStepStarted(state, 'resume', '2026-03-05T10:10:00.000Z');
      expect(state.steps.upload.status).toBe('in-progress');
      markStepFinished(state, 'resume', true, '2026-03-05T11:00:00.000Z', 0, []);
      expect(state.steps.upload.status).toBe('completed');
    });
  });

  // ─── Crash recovery ────────────────────────────────────────────────────────

  describe('crash recovery', () => {
    it('detects interrupted action on reload and marks it failed', async () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'upload', '2026-03-05T10:10:00.000Z');
      // Simulate crash: save state without markStepFinished
      await savePipelineState(tempDir, state);

      // loadPipelineState itself does not do recovery (the route does).
      // Verify the state reflects in-progress:
      const loaded = await loadPipelineState(tempDir);
      expect(loaded.steps.upload.status).toBe('in-progress');
      expect(loaded.lastAction?.finishedAt).toBeUndefined();

      // Simulate what ensurePipelineState does: detect unfinished action
      if (loaded.lastAction && !loaded.lastAction.finishedAt) {
        markStepFinished(
          loaded,
          loaded.lastAction.action,
          false,
          new Date().toISOString(),
          -1,
          ['Process was interrupted (server restart detected)'],
        );
      }

      expect(loaded.steps.upload.status).toBe('failed');
      expect(loaded.lastAction?.success).toBe(false);
      expect(loaded.lastAction?.exitCode).toBe(-1);
      expect(loaded.lastAction?.outputTail).toEqual(['Process was interrupted (server restart detected)']);
    });

    it('does not falsely detect crash when action completed normally', async () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, ['done']);
      await savePipelineState(tempDir, state);

      const loaded = await loadPipelineState(tempDir);
      expect(loaded.steps.scan.status).toBe('completed');
      expect(loaded.lastAction?.finishedAt).toBe('2026-03-05T10:05:00.000Z');

      // Verify recovery logic would NOT trigger
      const needsRecovery = loaded.lastAction && !loaded.lastAction.finishedAt;
      expect(needsRecovery).toBeFalsy();
    });
  });

  // ─── buildPipelineSummary ──────────────────────────────────────────────────

  describe('buildPipelineSummary', () => {
    it('returns all steps in pipeline order', () => {
      const state = createDefaultPipelineState();
      const summary = buildPipelineSummary(state);

      expect(summary.steps).toHaveLength(4);
      expect(summary.steps.map((s) => s.step)).toEqual(['scan', 'upload', 'verify', 'cleanup']);
    });

    it('reflects the current step and step statuses', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, []);
      markStepStarted(state, 'upload', '2026-03-05T10:10:00.000Z');

      const summary = buildPipelineSummary(state);
      expect(summary.currentStep).toBe('upload');
      expect(summary.steps[0].status).toBe('completed');
      expect(summary.steps[1].status).toBe('in-progress');
      expect(summary.steps[2].status).toBe('pending');
      expect(summary.steps[3].status).toBe('pending');
    });

    it('excludes outputTail from lastAction in summary', () => {
      const state = createDefaultPipelineState();
      markStepStarted(state, 'scan', '2026-03-05T10:00:00.000Z');
      markStepFinished(state, 'scan', true, '2026-03-05T10:05:00.000Z', 0, ['some output']);

      const summary = buildPipelineSummary(state);
      expect(summary.lastAction).toBeDefined();
      expect(summary.lastAction?.outputTail).toBeUndefined();
    });

    it('returns undefined lastAction when no action has been run', () => {
      const state = createDefaultPipelineState();
      const summary = buildPipelineSummary(state);
      expect(summary.lastAction).toBeUndefined();
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('sequential saves produce a valid state file (last-writer-wins)', async () => {
      const state = createDefaultPipelineState();
      await savePipelineState(tempDir, { ...state, currentStep: 'scan' });
      await savePipelineState(tempDir, { ...state, currentStep: 'upload' });

      const loaded = await loadPipelineState(tempDir);
      expect(loaded.version).toBe(1);
      expect(loaded.currentStep).toBe('upload');
    });

    it('preserves step counts when re-finishing with partial counts', () => {
      const state = createDefaultPipelineState();
      state.steps.upload.itemsTotal = 1000;
      state.steps.upload.itemsDone = 500;

      // Finish with only failed count — total and done should be preserved
      markStepFinished(state, 'upload', false, '2026-03-05T11:00:00.000Z', 1, [], {
        failed: 3,
      });

      expect(state.steps.upload.itemsTotal).toBe(1000);
      expect(state.steps.upload.itemsDone).toBe(500);
      expect(state.steps.upload.itemsFailed).toBe(3);
    });

    it('BOM prefix in state file is stripped on load', async () => {
      const filePath = getPipelineStatePath(tempDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const state = createDefaultPipelineState();
      // Write with BOM
      await fs.writeFile(filePath, '\uFEFF' + JSON.stringify(state), 'utf8');

      const loaded = await loadPipelineState(tempDir);
      expect(loaded.version).toBe(1);
    });

    it('loads state with missing steps and fills them in', async () => {
      const filePath = getPipelineStatePath(tempDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // Write a state with only scan step — others missing
      const partialState = {
        version: 1,
        currentStep: 'upload',
        steps: {
          scan: { step: 'scan', status: 'completed' },
        },
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(filePath, JSON.stringify(partialState), 'utf8');

      const loaded = await loadPipelineState(tempDir);
      expect(loaded.steps.scan.status).toBe('completed');
      expect(loaded.steps.upload.status).toBe('pending');
      expect(loaded.steps.verify.status).toBe('pending');
      expect(loaded.steps.cleanup.status).toBe('pending');
    });
  });
});
