import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPickerSession, pollPickerSession, fetchPickedItems, ApiError, type PickedMediaItem } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

type PickPhotosStepProps = {
  onPhotosSelected: (items: PickedMediaItem[], sessionId: string) => void;
  onBack: () => void;
};

const AUTH_ERROR_CODES = new Set(['GOOGLE_NOT_CONNECTED', 'GOOGLE_TOKEN_EXPIRED']);

export function PickPhotosStep({ onPhotosSelected, onBack }: PickPhotosStepProps) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pickerUri, setPickerUri] = useState<string | null>(null);
  const [pickerWindow, setPickerWindow] = useState<Window | null>(null);
  const [items, setItems] = useState<PickedMediaItem[]>([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [selectionDone, setSelectionDone] = useState(false);

  // Create picker session
  const createSessionMutation = useMutation({
    mutationFn: createPickerSession,
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      setPickerUri(data.pickerUri ?? null);
    },
    onError: (error) => {
      if (error instanceof ApiError && AUTH_ERROR_CODES.has(error.code)) {
        queryClient.invalidateQueries({ queryKey: ['google-auth-status'] });
        onBack();
      }
    },
  });

  // Poll picker session status
  const { data: sessionStatus } = useQuery({
    queryKey: ['picker-session', sessionId],
    queryFn: () => pollPickerSession(sessionId!),
    enabled: Boolean(sessionId) && !selectionDone,
    refetchInterval: 2000,
  });

  // When media items are set, fetch them
  const loadItems = useCallback(async () => {
    if (!sessionId) return;
    setIsLoadingItems(true);
    try {
      const allItems: PickedMediaItem[] = [];
      let pageToken: string | undefined;

      do {
        const page = await fetchPickedItems(sessionId, pageToken);
        allItems.push(...page.mediaItems);
        pageToken = page.nextPageToken;
      } while (pageToken);

      setItems(allItems);
      setSelectionDone(true);
    } catch {
      // Will show error state
    } finally {
      setIsLoadingItems(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionStatus?.mediaItemsSet && !selectionDone && !isLoadingItems) {
      loadItems();
    }
  }, [sessionStatus?.mediaItemsSet, selectionDone, isLoadingItems, loadItems]);

  // Check if picker window was closed
  useEffect(() => {
    if (!pickerWindow) return;
    const interval = setInterval(() => {
      if (pickerWindow.closed) {
        setPickerWindow(null);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [pickerWindow]);

  const handleOpenPicker = () => {
    if (!pickerUri) return;
    const w = window.open(pickerUri, 'google-picker', 'width=800,height=600,popup=yes');
    if (w) setPickerWindow(w);
  };

  const handleStartNewSession = () => {
    setSessionId(null);
    setPickerUri(null);
    setItems([]);
    setSelectionDone(false);
    createSessionMutation.mutate();
  };

  // Initial state — no session yet
  if (!sessionId && !createSessionMutation.isPending) {
    return (
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Select Photos</h2>
        <p className="text-sm text-slate-600">
          Click the button below to open the Google Photos picker. You can select
          individual photos, multiple photos, or entire albums to transfer.
        </p>
        {createSessionMutation.isError && (
          <Alert variant="error">
            Failed to create picker session. {createSessionMutation.error?.message}
          </Alert>
        )}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          <Button onClick={() => createSessionMutation.mutate()}>
            Open Photo Picker
          </Button>
          <Button
            className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
            onClick={onBack}
          >
            Back
          </Button>
        </div>
      </Card>
    );
  }

  // Creating session
  if (createSessionMutation.isPending) {
    return (
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Select Photos</h2>
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          <span className="text-sm text-slate-600">Creating picker session...</span>
        </div>
      </Card>
    );
  }

  // Selection done — show results
  if (selectionDone && items.length > 0) {
    const imageCount = items.filter((item) => item.mimeType?.startsWith('image/')).length;
    const videoCount = items.filter((item) => item.mimeType?.startsWith('video/')).length;
    const otherCount = items.length - imageCount - videoCount;

    return (
      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
            <span className="text-lg">📷</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold">{items.length} Items Selected</h2>
            <p className="text-sm text-slate-500">
              {[
                imageCount > 0 && `${imageCount} photo${imageCount > 1 ? 's' : ''}`,
                videoCount > 0 && `${videoCount} video${videoCount > 1 ? 's' : ''}`,
                otherCount > 0 && `${otherCount} other`,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          </div>
        </div>

        {/* Preview grid */}
        <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {items.slice(0, 30).map((item) => (
              <div
                key={item.id}
                className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-slate-100"
                title={item.filename ?? item.id}
              >
                <div className="text-center text-xs text-slate-400">
                  <p>{item.mimeType?.startsWith('video/') ? '🎬' : '📷'}</p>
                  <p className="truncate px-1">{item.filename ?? 'Unknown'}</p>
                </div>
              </div>
            ))}
            {items.length > 30 && (
              <div className="flex aspect-square items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-500">
                +{items.length - 30} more
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 sm:gap-3">
          <Button onClick={() => onPhotosSelected(items, sessionId!)}>
            Continue with {items.length} Items
          </Button>
          <Button
            className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
            onClick={handleStartNewSession}
          >
            Pick Different Photos
          </Button>
        </div>
      </Card>
    );
  }

  // Selection done but no items
  if (selectionDone && items.length === 0) {
    return (
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">No Photos Selected</h2>
        <p className="text-sm text-slate-600">
          It looks like no photos were selected. Try again.
        </p>
        <div className="flex flex-wrap gap-2 sm:gap-3">
          <Button onClick={handleStartNewSession}>Try Again</Button>
          <Button
            className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
            onClick={onBack}
          >
            Back
          </Button>
        </div>
      </Card>
    );
  }

  // Session created, waiting for user to pick
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold">Select Photos</h2>

      {isLoadingItems ? (
        <div className="space-y-3">
          <Alert variant="info">Photos selected! Loading details...</Alert>
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
            <span className="text-sm text-slate-600">Loading {items.length > 0 ? items.length : ''} items...</span>
          </div>
        </div>
      ) : (
        <>
          {!pickerWindow && (
            <Alert variant="info">
              Click the button below to open the Google Photos picker. Select the photos you want to transfer, then come back here.
            </Alert>
          )}

          {pickerWindow && !pickerWindow.closed && (
            <div className="space-y-3">
              <Alert variant="info">
                The Google Photos picker is open in another window. Select your photos there and close the picker when done.
              </Alert>
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                <span className="text-sm text-slate-600">Waiting for photo selection...</span>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 sm:gap-3">
            <Button onClick={handleOpenPicker}>
              {pickerWindow ? 'Reopen Picker' : 'Open Photo Picker'}
            </Button>
            <Button
              className="bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
              onClick={onBack}
            >
              Back
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
