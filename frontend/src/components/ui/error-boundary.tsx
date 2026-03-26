import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional fallback UI. Defaults to a simple retry prompt. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in child components and shows a recovery UI
 * instead of unmounting the entire app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 p-8 text-center">
          <svg className="h-8 w-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="text-sm text-slate-400">Something went wrong</p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
