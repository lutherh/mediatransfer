import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';
import { ToastContainer, useToast, type ToastMessage } from '@/components/ui/toast';

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('push adds a toast and returns an incrementing id', () => {
    const { result } = renderHook(() => useToast());

    let firstId = 0;
    let secondId = 0;
    act(() => {
      firstId = result.current.push('success', 'hello');
    });
    act(() => {
      secondId = result.current.push('error', 'bye');
    });

    expect(result.current.toasts).toHaveLength(2);
    expect(result.current.toasts[0]).toMatchObject({ id: firstId, type: 'success', text: 'hello' });
    expect(result.current.toasts[1]).toMatchObject({ id: secondId, type: 'error', text: 'bye' });
    expect(secondId).toBeGreaterThan(firstId);
  });

  it('auto-dismisses a toast after durationMs', () => {
    const { result } = renderHook(() => useToast(1000));

    act(() => {
      result.current.push('info', 'temporary');
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('dismiss removes a toast and clears its timer (no double-dismiss)', () => {
    const { result } = renderHook(() => useToast(500));

    let id = 0;
    act(() => {
      id = result.current.push('success', 'hi');
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      result.current.dismiss(id);
    });
    expect(result.current.toasts).toHaveLength(0);

    // Advancing past the original duration must not throw or re-trigger.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(2000);
      });
    }).not.toThrow();
    expect(result.current.toasts).toHaveLength(0);
  });

  it('cleans up pending timers on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { result, unmount } = renderHook(() => useToast(1000));

    act(() => {
      result.current.push('success', 'a');
      result.current.push('error', 'b');
    });

    const callsBefore = clearSpy.mock.calls.length;
    unmount();
    const callsAfter = clearSpy.mock.calls.length;

    // The unmount cleanup should clear the two outstanding timers.
    expect(callsAfter - callsBefore).toBeGreaterThanOrEqual(2);

    // Advancing timers post-unmount must not produce any state-update warnings.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe('<ToastContainer />', () => {
  it('renders nothing when toasts is empty', () => {
    const { container } = render(<ToastContainer toasts={[]} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders one item per toast inside an aria-live container', () => {
    const toasts: ToastMessage[] = [
      { id: 1, type: 'success', text: 'first' },
      { id: 2, type: 'info', text: 'second' },
    ];
    render(<ToastContainer toasts={toasts} onDismiss={() => {}} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /dismiss/i })).toHaveLength(2);
  });

  it('calls onDismiss(id) when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [
      { id: 11, type: 'success', text: 'A' },
      { id: 22, type: 'error', text: 'B' },
    ];
    render(<ToastContainer toasts={toasts} onDismiss={onDismiss} />);

    const buttons = screen.getAllByRole('button', { name: /dismiss/i });
    fireEvent.click(buttons[1]);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(22);
  });

  it.each(['success', 'error', 'info'] as const)('renders the %s style', (type) => {
    render(
      <ToastContainer toasts={[{ id: 1, type, text: `${type} message` }]} onDismiss={() => {}} />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(`${type} message`)).toBeInTheDocument();
  });
});
