import { useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { PipelineFlow } from '@/components/pipeline/pipeline-flow';
import { PipelineStageDetail } from '@/components/pipeline/pipeline-stage-detail';
import { ScheduleConfig } from '@/components/pipeline/schedule-config';

export type PipelineStage =
  | 'google-photos'
  | 'takeout-download'
  | 'cloud-storage'
  | 'immich-library'
  | null;

export function PipelinePage() {
  const [activeStage, setActiveStage] = useState<PipelineStage>(null);
  const clearStage = useCallback(() => setActiveStage(null), []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold">How It Works</h1>
        <p className="mt-1 text-sm text-slate-400">
          Your photos travel through a secure pipeline from Google Photos to your
          private Immich library. Tap any stage to learn more.
        </p>
      </div>

      {/* ── Animated flow diagram ─────────────────────── */}
      <Card className="!p-0 overflow-hidden">
        <PipelineFlow activeStage={activeStage} onStageClick={setActiveStage} />
      </Card>

      {/* ── Stage detail (expands below the flow) ────── */}
      {activeStage && (
        <PipelineStageDetail stage={activeStage} onClose={clearStage} />
      )}

      {/* ── Schedule configuration ────────────────────── */}
      <ScheduleConfig />
    </div>
  );
}
