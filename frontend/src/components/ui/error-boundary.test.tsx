import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ui/error-boundary';

function Boom({ message = 'kaboom' }: { message?: string }) {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence React's own dev-mode error logging plus the boundary's
    // componentDidCatch console.error call.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>safe child</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('safe child')).toBeInTheDocument();
  });

  it('shows the default fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('renders the custom fallback prop instead of the default', () => {
    render(
      <ErrorBoundary fallback={<p>custom oops</p>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom oops')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('calls console.error via componentDidCatch when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(errorSpy).toHaveBeenCalled();
    const calledWithBoundaryTag = errorSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('[ErrorBoundary]'),
    );
    expect(calledWithBoundaryTag).toBe(true);
  });

  it('clears the error and re-renders children when "Try again" is clicked', () => {
    function Maybe({ shouldThrow }: { shouldThrow: boolean }) {
      const [n] = useState(0);
      if (shouldThrow) throw new Error('controlled boom');
      return <p>recovered {n}</p>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Maybe shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Swap in a non-throwing child *before* clicking retry, so that the
    // boundary's next render finds healthy children.
    rerender(
      <ErrorBoundary>
        <Maybe shouldThrow={false} />
      </ErrorBoundary>,
    );

    // Boundary still shows the fallback (its internal `error` state is sticky).
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText(/recovered/)).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
