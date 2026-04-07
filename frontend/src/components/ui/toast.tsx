import { type JSX, useCallback, useEffect, useRef, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  type: ToastType;
  text: string;
}

let nextToastId = 1;

/**
 * Hook to manage toast notifications. Returns the current stack and
 * a `push` function to add new toasts.
 *
 * Toasts auto-dismiss after `durationMs` (default 4 s). The most recent
 * toast slides in at the bottom-center of the viewport.
 */
export function useToast(durationMs = 4000) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (type: ToastType, text: string) => {
      const id = nextToastId++;
      setToasts((prev) => [...prev, { id, type, text }]);
      const timer = setTimeout(() => dismiss(id), durationMs);
      timers.current.set(id, timer);
      return id;
    },
    [durationMs, dismiss],
  );

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    };
  }, []);

  return { toasts, push, dismiss };
}

// ── Presentation ───────────────────────────────────────────────────────

const typeStyles: Record<ToastType, string> = {
  success: 'bg-emerald-900/90 text-emerald-100 border-emerald-700/50',
  error: 'bg-red-900/90 text-red-100 border-red-700/50',
  info: 'bg-slate-800/90 text-slate-100 border-slate-600/50',
};

const typeIcons: Record<ToastType, JSX.Element> = {
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4 text-emerald-400">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 text-red-400">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 text-blue-400">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
};

/**
 * Fixed-position toast stack rendered at the bottom-center of the viewport.
 * Each toast slides up on mount and fades out before removal.
 */
export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
      role="status"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-4 fade-in duration-300 ${typeStyles[toast.type]}`}
        >
          {typeIcons[toast.type]}
          <span className="text-sm font-medium">{toast.text}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="ml-2 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
