import { useState, useCallback } from 'react';
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

export function PhotoTransferPage() {
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedItems, setSelectedItems] = useState<PickedMediaItem[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [jobId, setJobId] = useState<string>('');

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
