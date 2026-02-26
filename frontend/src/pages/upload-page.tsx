import { useState, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  uploadFiles,
  fetchUploadList,
  fetchUploadStats,
  type UploadResult,
  type MediaItem,
} from '@/lib/api';

type UploadState = 'idle' | 'uploading' | 'done';

export function UploadPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const statsQuery = useQuery({
    queryKey: ['upload-stats'],
    queryFn: fetchUploadStats,
    refetchInterval: 30_000,
  });

  const recentQuery = useQuery({
    queryKey: ['upload-list'],
    queryFn: () => fetchUploadList(20, 0),
    refetchInterval: 30_000,
  });

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setUploadState('uploading');
    setProgress(0);
    setResults(null);
    setError(null);

    const fileArray = Array.from(files);
    const { promise, abort } = uploadFiles(fileArray, (loaded, total) => {
      setProgress(total > 0 ? Math.round((loaded / total) * 100) : 0);
    });
    abortRef.current = abort;

    try {
      const response = await promise;
      setResults(response.results);
      setUploadState('done');
      // Refresh queries
      queryClient.invalidateQueries({ queryKey: ['upload-stats'] });
      queryClient.invalidateQueries({ queryKey: ['upload-list'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      if (message !== 'Upload cancelled') {
        setError(message);
      }
      setUploadState('idle');
    } finally {
      abortRef.current = null;
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [queryClient]);

  const handleCancel = useCallback(() => {
    abortRef.current?.();
    setUploadState('idle');
    setProgress(0);
  }, []);

  const handleReset = useCallback(() => {
    setUploadState('idle');
    setResults(null);
    setError(null);
    setProgress(0);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">Upload Photos</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload photos and videos from your device to your library.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm font-medium text-slate-900">Quick guide</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li>Use this page for direct file uploads from your local computer.</li>
          <li>Duplicate files are skipped automatically during upload.</li>
          <li>For Google Photos migration, use <span className="font-semibold">Photo Transfer</span> or <span className="font-semibold">Takeout</span>.</li>
        </ul>
      </div>

      {/* Stats card */}
      {statsQuery.data && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Library items</p>
          <p className="text-2xl font-semibold text-slate-900">
            {statsQuery.data.totalItems.toLocaleString()}
          </p>
        </div>
      )}

      {/* Upload area */}
      <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-6 text-center sm:p-8">
        {uploadState === 'idle' && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
              <svg className="h-6 w-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="mb-2 text-sm font-medium text-slate-700">
              Tap to select photos & videos
            </p>
            <p className="mb-4 text-xs text-slate-400">
              JPEG, PNG, HEIC, MP4, MOV — up to 100 MB each
            </p>
            <input
              ref={fileInputRef}
              accept="image/*,video/*,.heic,.heif"
              className="hidden"
              multiple
              onChange={(e) => handleUpload(e.target.files)}
              type="file"
            />
            <button
              className="inline-flex items-center rounded-lg bg-blue-600 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              Choose Files
            </button>
          </>
        )}

        {uploadState === 'uploading' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-slate-700">Uploading...</p>
            <div className="mx-auto max-w-xs">
              <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">{progress}%</p>
            </div>
            <button
              className="text-sm text-red-600 hover:text-red-700"
              onClick={handleCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        )}

        {uploadState === 'done' && results && (
          <div className="space-y-3">
            <UploadSummary results={results} />
            <button
              className="inline-flex items-center rounded-lg bg-blue-600 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
              onClick={handleReset}
              type="button"
            >
              Upload More
            </button>
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Recently uploaded */}
      {recentQuery.data && recentQuery.data.items.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Recently Uploaded</h2>
          <div className="space-y-2">
            {recentQuery.data.items.map((item: MediaItem) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{item.filename}</p>
                  <p className="text-xs text-slate-500">
                    {formatFileSize(item.size)}
                    {item.capturedAt && ` · ${formatDate(item.capturedAt)}`}
                    {' · '}{item.source}
                  </p>
                </div>
                <span className="ml-2 shrink-0 rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                  {item.contentType.split('/')[0]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadSummary({ results }: { results: UploadResult[] }) {
  const uploaded = results.filter((r) => r.status === 'uploaded');
  const duplicates = results.filter((r) => r.status === 'duplicate');
  const errors = results.filter((r) => r.status === 'error');

  return (
    <div className="space-y-2 text-sm">
      {uploaded.length > 0 && (
        <p className="text-green-700">
          {uploaded.length} file{uploaded.length !== 1 ? 's' : ''} uploaded successfully
        </p>
      )}
      {duplicates.length > 0 && (
        <p className="text-amber-600">
          {duplicates.length} duplicate{duplicates.length !== 1 ? 's' : ''} skipped
        </p>
      )}
      {errors.length > 0 && (
        <div className="text-red-600">
          <p>{errors.length} error{errors.length !== 1 ? 's' : ''}:</p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {errors.map((e, i) => (
              <li key={i}>{e.filename}: {e.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}
