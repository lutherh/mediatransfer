import { useState, useCallback, useEffect } from 'react';
import { Stepper, type StepDef } from '@/components/ui/stepper';
import { ConnectGoogleStep } from '@/components/steps/connect-google-step';
import { PickPhotosStep } from '@/components/steps/pick-photos-step';
import { ReviewTransferStep } from '@/components/steps/review-transfer-step';
import { TransferProgressStep } from '@/components/steps/transfer-progress-step';
import type { PickedMediaItem } from '@/lib/api';

const STEPS: StepDef[] = [
  { label: 'Connect', description: 'Google account' },
  { label: 'Select', description: 'Pick photos' },
  { label: 'Review', description: 'Confirm transfer' },
  { label: 'Transfer', description: 'Upload to cloud' },
];

const WIZARD_STATE_STORAGE_KEY = 'photo-transfer-wizard-state-v1';

type WizardState = {
  currentStep: number;
  selectedItems: PickedMediaItem[];
  sessionId: string;
  jobId: string;
};

function clampStep(step: number): number {
  if (!Number.isFinite(step)) {
    return 0;
  }

  return Math.max(0, Math.min(step, STEPS.length - 1));
}

function sanitizeWizardState(partial: Partial<WizardState>): WizardState {
  const selectedItems = Array.isArray(partial.selectedItems)
    ? partial.selectedItems.filter((item): item is PickedMediaItem => Boolean(item?.id))
    : [];
  const sessionId = typeof partial.sessionId === 'string' ? partial.sessionId : '';
  const jobId = typeof partial.jobId === 'string' ? partial.jobId : '';

  let currentStep = clampStep(typeof partial.currentStep === 'number' ? partial.currentStep : 0);

  if (currentStep >= 2 && (selectedItems.length === 0 || sessionId.length === 0)) {
    currentStep = 1;
  }

  if (currentStep >= 3 && jobId.length === 0) {
    currentStep = 2;
  }

  return {
    currentStep,
    selectedItems,
    sessionId,
    jobId,
  };
}

function readPersistedWizardState(): WizardState {
  try {
    const raw = window.sessionStorage.getItem(WIZARD_STATE_STORAGE_KEY);
    if (!raw) {
      return sanitizeWizardState({});
    }

    const parsed = JSON.parse(raw) as Partial<WizardState>;
    return sanitizeWizardState(parsed);
  } catch {
    return sanitizeWizardState({});
  }
}

export function PhotoTransferPage() {
  const [initialState] = useState<WizardState>(() => readPersistedWizardState());
  const [currentStep, setCurrentStep] = useState(initialState.currentStep);
  const [selectedItems, setSelectedItems] = useState<PickedMediaItem[]>(initialState.selectedItems);
  const [sessionId, setSessionId] = useState<string>(initialState.sessionId);
  const [jobId, setJobId] = useState<string>(initialState.jobId);

  useEffect(() => {
    const persisted = sanitizeWizardState({
      currentStep,
      selectedItems,
      sessionId,
      jobId,
    });

    window.sessionStorage.setItem(WIZARD_STATE_STORAGE_KEY, JSON.stringify(persisted));
  }, [currentStep, selectedItems, sessionId, jobId]);

  const handleConnected = useCallback(() => {
    setCurrentStep(1);
  }, []);

  const handlePhotosSelected = useCallback((items: PickedMediaItem[], sid: string) => {
    setSelectedItems(items);
    setSessionId(sid);
    setCurrentStep(2);
  }, []);

  const handleTransferCreated = useCallback((id: string) => {
    setJobId(id);
    setCurrentStep(3);
  }, []);

  const handleStartNew = useCallback(() => {
    setCurrentStep(0);
    setSelectedItems([]);
    setSessionId('');
    setJobId('');
    window.sessionStorage.removeItem(WIZARD_STATE_STORAGE_KEY);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Photo Transfer</h1>
        <p className="mt-1 text-sm text-slate-500">
          Transfer photos from Google Photos to your cloud storage
        </p>
      </div>

      <Stepper steps={STEPS} currentStep={currentStep} />

      {currentStep === 0 && (
        <ConnectGoogleStep onConnected={handleConnected} />
      )}

      {currentStep === 1 && (
        <PickPhotosStep
          onPhotosSelected={handlePhotosSelected}
          onBack={() => setCurrentStep(0)}
        />
      )}

      {currentStep === 2 && (
        <ReviewTransferStep
          items={selectedItems}
          sessionId={sessionId}
          onTransferCreated={handleTransferCreated}
          onBack={() => setCurrentStep(1)}
        />
      )}

      {currentStep === 3 && (
        <TransferProgressStep
          jobId={jobId}
          totalItems={selectedItems.length}
          onStartNew={handleStartNew}
        />
      )}
    </div>
  );
}
