import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stepper, type StepDef } from '@/components/ui/stepper';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchBootstrapStatus } from '@/lib/api';
import { ScalewayStep } from './setup/scaleway-step';
import { GoogleStep } from './setup/google-step';
import { ImmichStep } from './setup/immich-step';

const STEPS: StepDef[] = [
  { label: 'Auth Token', description: 'Protect this server' },
  { label: 'Storage', description: 'S3 credentials' },
  { label: 'Google Photos', description: 'Link your account' },
  { label: 'Immich', description: 'Connection details' },
];

export function SetupPage() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authTokenSet, setAuthTokenSet] = useState(false);

  useEffect(() => {
    fetchBootstrapStatus()
      .then((status) => {
        if (!status.needsSetup) {
          navigate('/');
          return;
        }
        setAuthTokenSet(status.authTokenSet);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-slate-500 text-sm">Checking setup status…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Alert variant="error">Could not connect to the server: {error}</Alert>
      </div>
    );
  }

  function skip() {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      navigate('/');
    }
  }

  function advance() {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      navigate('/');
    }
  }

  const isLast = currentStep === STEPS.length - 1;

  return (
    <div className="flex min-h-screen flex-col items-center justify-start bg-slate-50 px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900">MediaTransfer Setup</h1>
          <p className="text-sm text-slate-500 mt-1">
            Configure your integrations to get started. You can update these at any time in Settings.
          </p>
        </div>

        <Stepper steps={STEPS} currentStep={currentStep} />

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {/* Step 0: Auth token advisory */}
          {currentStep === 0 && (
            <div>
              <h3 className="text-base font-semibold text-slate-900">API Auth Token</h3>
              <p className="text-sm text-slate-500 mt-1">
                The API auth token protects this server from unauthorized access.
              </p>
              {authTokenSet ? (
                <Alert variant="success" className="mt-4">
                  API_AUTH_TOKEN is set. Your server is protected.
                </Alert>
              ) : (
                <Alert variant="warning" className="mt-4">
                  <strong>API_AUTH_TOKEN is not set.</strong> Anyone with network access to this
                  server can use it without authentication. Set it in your <code>.env</code> file
                  and restart the server:
                  <pre className="mt-2 rounded bg-amber-100 px-3 py-2 font-mono text-xs">
                    API_AUTH_TOKEN=your-long-random-secret
                  </pre>
                </Alert>
              )}
            </div>
          )}

          {/* Step 1: Scaleway */}
          {currentStep === 1 && (
            <ScalewayStep onSaved={advance} />
          )}

          {/* Step 2: Google */}
          {currentStep === 2 && (
            <GoogleStep onSaved={advance} />
          )}

          {/* Step 3: Immich */}
          {currentStep === 3 && (
            <ImmichStep onSaved={advance} />
          )}

          {/* Navigation */}
          <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
            <button
              type="button"
              className="text-sm text-slate-500 underline"
              onClick={skip}
              title={isLast ? 'Go home without finishing all steps — configure later in Settings' : 'Skip this step — you can configure it later in Settings'}
            >
              {isLast ? 'Skip & go home' : 'Skip for now →'}
            </button>
            {currentStep === 0 && (
              <Button type="button" onClick={advance}>
                Next →
              </Button>
            )}
            {isLast && (
              <Button type="button" onClick={() => navigate('/')}>
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
