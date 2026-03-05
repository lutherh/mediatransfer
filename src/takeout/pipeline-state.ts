import fs from 'node:fs/promises';
import path from 'node:path';

// ─── Pipeline step definitions ────────────────────────────────────────────────

/**
 * The high-level pipeline: the ordered workflow a user goes through.
 * Each step maps to one or more TakeoutActions.
 */
export const PIPELINE_STEPS = ['scan', 'upload', 'verify', 'cleanup'] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';

export type StepRecord = {
  step: PipelineStepName;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  /** Total files/items relevant to this step (e.g. manifest entry count) */
  itemsTotal?: number;
  /** Items successfully processed in this step */
  itemsDone?: number;
  /** Items that failed in this step */
  itemsFailed?: number;
  /** Human-readable detail about what happened */
  detail?: string;
};

export type LastActionRecord = {
  action: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  success?: boolean;
  /** Last N output lines (persisted for crash recovery context) */
  outputTail?: string[];
};

export type PipelineState = {
  version: 1;
  /** Current high-level step the pipeline is at */
  currentStep: PipelineStepName;
  /** Per-step status records */
  steps: Record<PipelineStepName, StepRecord>;
  /** The last action that was run (persisted for restart recovery) */
  lastAction?: LastActionRecord;
  updatedAt: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a takeout action name to its pipeline step. */
export function actionToPipelineStep(action: string): PipelineStepName | undefined {
  switch (action) {
    case 'scan':
      return 'scan';
    case 'upload':
    case 'resume':
      return 'upload';
    case 'verify':
      return 'verify';
    case 'cleanup-move':
    case 'cleanup-delete':
    case 'cleanup-force-move':
    case 'cleanup-force-delete':
      return 'cleanup';
    default:
      return undefined;
  }
}

export function createDefaultPipelineState(): PipelineState {
  return {
    version: 1,
    currentStep: 'scan',
    steps: {
      scan:    { step: 'scan',    status: 'pending' },
      upload:  { step: 'upload',  status: 'pending' },
      verify:  { step: 'verify',  status: 'pending' },
      cleanup: { step: 'cleanup', status: 'pending' },
    },
    updatedAt: new Date().toISOString(),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const PIPELINE_STATE_FILE = 'pipeline-state.json';
const MAX_PERSISTED_OUTPUT_LINES = 50;

export function getPipelineStatePath(workDir: string): string {
  return path.join(workDir, PIPELINE_STATE_FILE);
}

export async function loadPipelineState(workDir: string): Promise<PipelineState> {
  const filePath = getPipelineStatePath(workDir);
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as PipelineState;
    if (parsed.version === 1 && parsed.steps && parsed.currentStep) {
      // Ensure all steps exist (in case we add new steps later)
      for (const step of PIPELINE_STEPS) {
        if (!parsed.steps[step]) {
          parsed.steps[step] = { step, status: 'pending' };
        }
      }
      return parsed;
    }
  } catch {
    // File missing or malformed — create fresh
  }
  return createDefaultPipelineState();
}

export async function savePipelineState(workDir: string, state: PipelineState): Promise<void> {
  const filePath = getPipelineStatePath(workDir);
  state.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

// ─── State transitions ───────────────────────────────────────────────────────

/** Mark a step as in-progress and record the action being run. */
export function markStepStarted(
  state: PipelineState,
  action: string,
  startedAt: string,
): void {
  const stepName = actionToPipelineStep(action);
  if (!stepName) return;

  state.currentStep = stepName;
  state.steps[stepName] = {
    ...state.steps[stepName],
    step: stepName,
    status: 'in-progress',
    startedAt,
    completedAt: undefined,
  };
  state.lastAction = {
    action,
    startedAt,
  };
}

/** Mark a step as completed or failed, recording final counts. */
export function markStepFinished(
  state: PipelineState,
  action: string,
  success: boolean,
  finishedAt: string,
  exitCode?: number,
  outputTail?: string[],
  counts?: { total?: number; done?: number; failed?: number },
): void {
  const stepName = actionToPipelineStep(action);
  if (stepName) {
    state.steps[stepName] = {
      ...state.steps[stepName],
      step: stepName,
      status: success ? 'completed' : 'failed',
      completedAt: finishedAt,
      itemsTotal: counts?.total ?? state.steps[stepName].itemsTotal,
      itemsDone: counts?.done ?? state.steps[stepName].itemsDone,
      itemsFailed: counts?.failed ?? state.steps[stepName].itemsFailed,
    };

    // Advance currentStep to next pending step after completion
    if (success) {
      const idx = PIPELINE_STEPS.indexOf(stepName);
      for (let i = idx + 1; i < PIPELINE_STEPS.length; i++) {
        if (state.steps[PIPELINE_STEPS[i]].status === 'pending' ||
            state.steps[PIPELINE_STEPS[i]].status === 'failed') {
          state.currentStep = PIPELINE_STEPS[i];
          break;
        }
      }
    }
  }

  if (state.lastAction) {
    state.lastAction.finishedAt = finishedAt;
    state.lastAction.exitCode = exitCode;
    state.lastAction.success = success;
    state.lastAction.outputTail = outputTail?.slice(-MAX_PERSISTED_OUTPUT_LINES);
  }
}

/** Build a summary of the pipeline suitable for the API response. */
export function buildPipelineSummary(state: PipelineState): {
  currentStep: PipelineStepName;
  steps: StepRecord[];
  lastAction?: LastActionRecord;
  updatedAt: string;
} {
  return {
    currentStep: state.currentStep,
    steps: PIPELINE_STEPS.map((name) => state.steps[name]),
    lastAction: state.lastAction
      ? { ...state.lastAction, outputTail: undefined }
      : undefined,
    updatedAt: state.updatedAt,
  };
}
