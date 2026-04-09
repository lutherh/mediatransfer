import type { PipelineStage } from '@/pages/pipeline-page';

/* ─── Stage metadata ───────────────────────────────────────────── */
const STAGES: {
  id: PipelineStage & string;
  label: string;
  sublabel: string;
  icon: string;
  color: string;
  bgColor: string;
  borderColor: string;
  glowColor: string;
}[] = [
  {
    id: 'google-photos',
    label: 'Google Photos',
    sublabel: 'Your originals',
    icon: '📸',
    color: 'text-blue-400',
    bgColor: 'bg-blue-950/60',
    borderColor: 'border-blue-500/40',
    glowColor: 'shadow-blue-500/20',
  },
  {
    id: 'takeout-download',
    label: 'Takeout',
    sublabel: 'Download & extract',
    icon: '📦',
    color: 'text-amber-400',
    bgColor: 'bg-amber-950/60',
    borderColor: 'border-amber-500/40',
    glowColor: 'shadow-amber-500/20',
  },
  {
    id: 'cloud-storage',
    label: 'Cloud Storage',
    sublabel: 'Scaleway S3',
    icon: '☁️',
    color: 'text-purple-400',
    bgColor: 'bg-purple-950/60',
    borderColor: 'border-purple-500/40',
    glowColor: 'shadow-purple-500/20',
  },
  {
    id: 'immich-library',
    label: 'Immich',
    sublabel: 'Your private library',
    icon: '🏠',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-950/60',
    borderColor: 'border-emerald-500/40',
    glowColor: 'shadow-emerald-500/20',
  },
];

/* ─── Animated connector arrow between stages ──────────────────── */
function ConnectorArrow({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center flex-shrink-0 w-8 sm:w-12 md:w-16">
      <svg
        viewBox="0 0 60 24"
        className="w-full h-6"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Track line */}
        <line
          x1="0" y1="12" x2="48" y2="12"
          stroke="currentColor"
          strokeWidth="2"
          className="text-slate-700"
        />
        {/* Arrowhead */}
        <polygon
          points="46,6 58,12 46,18"
          fill="currentColor"
          className="text-slate-600"
        />
        {/* Animated particle */}
        <circle r="3" className={active ? 'text-sky-400' : 'text-slate-500'} fill="currentColor">
          <animate
            attributeName="cx"
            values="4;50"
            dur="2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.1;0.8;1"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
    </div>
  );
}

/* ─── Mobile: vertical connector ───────────────────────────────── */
function VerticalConnector({ active }: { active: boolean }) {
  return (
    <div className="flex justify-center h-8 sm:hidden">
      <svg
        viewBox="0 0 24 40"
        className="h-full w-6"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <line
          x1="12" y1="0" x2="12" y2="30"
          stroke="currentColor"
          strokeWidth="2"
          className="text-slate-700"
        />
        <polygon
          points="6,28 12,38 18,28"
          fill="currentColor"
          className="text-slate-600"
        />
        <circle r="3" cx="12" className={active ? 'text-sky-400' : 'text-slate-500'} fill="currentColor">
          <animate
            attributeName="cy"
            values="4;32"
            dur="2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.1;0.8;1"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
    </div>
  );
}

/* ─── Single stage card ────────────────────────────────────────── */
function StageNode({
  stage,
  isActive,
  onClick,
}: {
  stage: (typeof STAGES)[number];
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        group relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 sm:p-4
        transition-all duration-300 cursor-pointer select-none
        min-w-[90px] sm:min-w-[110px]
        ${stage.bgColor} ${stage.borderColor}
        ${isActive
          ? `ring-2 ring-offset-2 ring-offset-slate-900 ${stage.borderColor} shadow-lg ${stage.glowColor} scale-105`
          : 'hover:scale-[1.03] hover:shadow-md'
        }
      `}
    >
      {/* Icon with bounce */}
      <span
        className={`
          text-2xl sm:text-3xl transition-transform duration-500
          ${isActive ? 'animate-bounce' : 'group-hover:scale-110'}
        `}
      >
        {stage.icon}
      </span>

      {/* Label */}
      <span className={`text-xs sm:text-sm font-semibold ${stage.color} text-center leading-tight`}>
        {stage.label}
      </span>

      {/* Sublabel */}
      <span className="text-[10px] sm:text-xs text-slate-400 text-center leading-tight">
        {stage.sublabel}
      </span>

      {/* Active indicator dot */}
      {isActive && (
        <span className={`absolute -top-1 -right-1 h-3 w-3 rounded-full ${stage.borderColor.replace('border-', 'bg-').replace('/40', '')}`}>
          <span className={`absolute inset-0 rounded-full ${stage.borderColor.replace('border-', 'bg-').replace('/40', '')} animate-ping`} />
        </span>
      )}
    </button>
  );
}

/* ─── Main flow component ──────────────────────────────────────── */
export function PipelineFlow({
  activeStage,
  onStageClick,
}: {
  activeStage: PipelineStage;
  onStageClick: (stage: PipelineStage) => void;
}) {
  const handleClick = (stageId: PipelineStage & string) => {
    onStageClick(activeStage === stageId ? null : stageId);
  };

  return (
    <div className="relative bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 p-4 sm:p-6 md:p-8">
      {/* Title bar */}
      <div className="mb-4 sm:mb-6 text-center">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-medium">
          Data Pipeline
        </p>
      </div>

      {/* Desktop: horizontal flow */}
      <div className="hidden sm:flex items-center justify-center gap-0">
        {STAGES.map((stage, i) => (
          <div key={stage.id} className="contents">
            <StageNode
              stage={stage}
              isActive={activeStage === stage.id}
              onClick={() => handleClick(stage.id)}
            />
            {i < STAGES.length - 1 && (
              <ConnectorArrow active={activeStage === STAGES[i].id || activeStage === STAGES[i + 1].id} />
            )}
          </div>
        ))}
      </div>

      {/* Mobile: vertical flow */}
      <div className="flex sm:hidden flex-col items-center gap-0">
        {STAGES.map((stage, i) => (
          <div key={stage.id} className="contents">
            <StageNode
              stage={stage}
              isActive={activeStage === stage.id}
              onClick={() => handleClick(stage.id)}
            />
            {i < STAGES.length - 1 && (
              <VerticalConnector active={activeStage === STAGES[i].id || activeStage === STAGES[i + 1].id} />
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-4 sm:mt-6 flex items-center justify-center gap-4 text-[10px] sm:text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
          Data flowing
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-slate-600" />
          Tap a stage for details
        </span>
      </div>
    </div>
  );
}
