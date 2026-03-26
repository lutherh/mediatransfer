/**
 * Concurrency-limited thumbnail loading queue.
 *
 * Instead of letting the browser fire hundreds of thumbnail requests at once
 * (one per visible grid cell), this module gates concurrent loads to a fixed
 * limit (~30). Components call `useThumbnailQueue(url)` which returns a
 * ready-to-render `src` only when the queue grants a slot.
 *
 * @pattern p-limit / p-queue style concurrency limiter adapted for React
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_CONCURRENT = 30;
let active = 0;
let nextRequestId = 1;

type PendingRequest = {
  id: number;
  resolve: (lease: ThumbnailLease) => void;
};

type ThumbnailLease = {
  release: () => void;
};

const pending: PendingRequest[] = [];

function drainQueue(): void {
  while (active < MAX_CONCURRENT && pending.length > 0) {
    // LIFO: most recently requested thumbnails (closest to viewport) load first.
    // When scrolling back and forth, this prioritizes visible cells over
    // stale requests from rows the user has already scrolled past.
    const request = pending.pop();
    if (!request) return;
    active++;
    request.resolve(createLease());
  }
}

function createLease(): ThumbnailLease {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drainQueue();
    },
  };
}

function requestSlot(): {
  promise: Promise<ThumbnailLease>;
  cancel: () => void;
} {
  if (active < MAX_CONCURRENT) {
    active++;
    return {
      promise: Promise.resolve(createLease()),
      cancel: () => {},
    };
  }

  const id = nextRequestId++;
  return {
    promise: new Promise<ThumbnailLease>((resolve) => {
      pending.push({ id, resolve });
    }),
    cancel: () => {
      const index = pending.findIndex((request) => request.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

/**
 * Set of thumbnail URLs that returned errors (e.g. 415 for videos without
 * ffmpeg). Prevents remounted virtualizer cells from re-fetching URLs that
 * are known to fail — avoids wasted queue slots and network requests on
 * every scroll.
 */
const failedThumbnails = new Set<string>();

/** Mark a URL as permanently failed so future mounts skip it. */
export function markThumbnailFailed(url: string): void {
  failedThumbnails.add(url);
}

/** Check whether a thumbnail URL is known to fail. */
export function isThumbnailFailed(url: string): boolean {
  return failedThumbnails.has(url);
}

/**
 * Clear all cached thumbnail failures. Called on network recovery so
 * thumbnails that failed during an outage get retried.
 */
export function clearThumbnailFailures(): void {
  failedThumbnails.clear();
}

/**
 * Hook that returns `src` only once the queue grants a loading slot.
 * Pass `null` to skip queueing (e.g. for videos).
 */
export function useThumbnailQueue(url: string | null): {
  src: string | null;
  markComplete: () => void;
} {
  const [src, setSrc] = useState<string | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  const markComplete = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  useEffect(() => {
    markComplete();
    setSrc(null);

    if (!url || failedThumbnails.has(url)) return;

    let disposed = false;
    const request = requestSlot();

    void request.promise.then((lease) => {
      if (disposed) {
        lease.release();
        return;
      }
      releaseRef.current = lease.release;
      setSrc(url);
    });

    return () => {
      disposed = true;
      request.cancel();
      markComplete();
    };
  }, [markComplete, url]);

  return { src, markComplete };
}
