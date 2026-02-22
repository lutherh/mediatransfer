import { cn } from '@/lib/utils';

export type StepStatus = 'completed' | 'current' | 'upcoming';

export type StepDef = {
  label: string;
  description?: string;
};

type StepperProps = {
  steps: StepDef[];
  currentStep: number;
};

export function Stepper({ steps, currentStep }: StepperProps) {
  return (
    <nav aria-label="Transfer progress" className="mb-8">
      <ol className="flex items-center">
        {steps.map((step, index) => {
          const status: StepStatus =
            index < currentStep ? 'completed' : index === currentStep ? 'current' : 'upcoming';

          return (
            <li
              key={step.label}
              className={cn('flex items-center', index < steps.length - 1 && 'flex-1')}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold',
                    status === 'completed' && 'bg-green-600 text-white',
                    status === 'current' && 'bg-slate-900 text-white',
                    status === 'upcoming' && 'bg-slate-200 text-slate-500',
                  )}
                  aria-current={status === 'current' ? 'step' : undefined}
                >
                  {status === 'completed' ? '✓' : index + 1}
                </span>
                <div className="hidden sm:block">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      status === 'current' ? 'text-slate-900' : 'text-slate-500',
                    )}
                  >
                    {step.label}
                  </p>
                  {step.description && (
                    <p className="text-xs text-slate-400">{step.description}</p>
                  )}
                </div>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    'mx-3 h-0.5 flex-1',
                    index < currentStep ? 'bg-green-600' : 'bg-slate-200',
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
