import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { TransfersListPage } from '@/pages/transfers-list-page';
import { NewTransferPage } from '@/pages/new-transfer-page';
import { TransferDetailPage } from '@/pages/transfer-detail-page';
import { TakeoutProgressPage } from '@/pages/takeout-progress-page';
import { PhotoTransferPage } from '@/pages/photo-transfer-page';
import { OAuthCallbackPage } from '@/pages/oauth-callback-page';
import { CostsPage } from '@/pages/costs-page';
import { CatalogPage } from '@/pages/catalog-page';
import type { TakeoutActionStatus, TakeoutArchiveHistoryEntry, TakeoutStatus } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  fetchTransfers: vi.fn(async () => [
    {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      status: 'IN_PROGRESS',
      progress: 0.5,
      createdAt: new Date().toISOString(),
    },
  ]),
  fetchTransferDetail: vi.fn(async () => ({
    job: {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      status: 'IN_PROGRESS',
      progress: 0.5,
      createdAt: new Date().toISOString(),
    },
    logs: [
      {
        id: 'log-1',
        level: 'INFO',
        message: 'Transfer job started',
        createdAt: new Date().toISOString(),
      },
    ],
  })),
  fetchCloudUsage: vi.fn(async () => ({
    provider: 'scaleway',
    bucket: 'photos-bucket',
    region: 'nl-ams',
    prefix: 'photos',
    totalObjects: 50,
    totalBytes: 50 * 1024 * 1024 * 1024,
    totalGB: 50,
    bucketType: 'standard',
    pricing: {
      currency: 'USD',
      pricePerGBMonthly: 0.023,
    },
    estimatedMonthlyCost: 1.15,
    measuredAt: new Date().toISOString(),
    note: 'Estimate includes storage only.',
  })),
  pauseTransfer: vi.fn(async () => ({ message: 'Paused' })),
  resumeTransfer: vi.fn(async () => ({ message: 'Resumed' })),
  retryTransferItem: vi.fn(async () => ({ message: 'Retry queued' })),
  queueAllTransferItems: vi.fn(async () => ({ message: 'Queued all' })),
  fetchTakeoutStatus: vi.fn(async () => ({
    paths: {
      inputDir: 'data/takeout/input',
      workDir: 'data/takeout/work',
      manifestPath: 'data/takeout/work/manifest.jsonl',
      statePath: 'data/takeout/state.json',
    },
    counts: {
      total: 18,
      processed: 18,
      pending: 0,
      uploaded: 10,
      skipped: 8,
      failed: 0,
    },
    progress: 1,
    stateUpdatedAt: new Date().toISOString(),
    recentFailures: [],
    isComplete: true,
  })),
  fetchTakeoutActionStatus: vi.fn(async () => ({
    running: false,
    action: 'verify',
    success: true,
    exitCode: 0,
    output: [],
  })),
  resetUploadState: vi.fn(async () => ({ message: 'Upload state reset' })),
  setAutoUpload: vi.fn(async () => ({ enabled: true })),
  runTakeoutAction: vi.fn(),
  createTransfer: vi.fn(),
  fetchGoogleAuthStatus: vi.fn(async () => ({
    configured: true,
    connected: false,
  })),
  fetchGoogleAuthUrl: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/auth' })),
  submitGoogleAuthCode: vi.fn(async () => ({ connected: true })),
  disconnectGoogle: vi.fn(),
  createPickerSession: vi.fn(),
  pollPickerSession: vi.fn(),
  fetchPickedItems: vi.fn(),
  deletePickerSession: vi.fn(),
  fetchCatalogStats: vi.fn(async () => ({
    totalFiles: 42,
    totalBytes: 1_073_741_824,
    imageCount: 40,
    videoCount: 2,
    oldestDate: '2022-01-01',
    newestDate: '2026-02-31',
  })),
  fetchCatalogItems: vi.fn(async () => ({ items: [], nextToken: undefined })),
  fetchDateDistribution: vi.fn(async () => null),
  fetchCatalogExif: vi.fn(async () => ({})),
  fetchAlbums: vi.fn(async () => ({ albums: [] })),
  createAlbum: vi.fn(async () => ({ id: 'test-album' })),
  updateAlbum: vi.fn(async () => ({})),
  moveCatalogItem: vi.fn(async () => ({})),
  bulkMoveCatalogItems: vi.fn(async () => ({})),
  catalogMediaUrl: vi.fn((encodedKey: string) => `/catalog/media/${encodedKey}`),
  catalogThumbnailUrl: vi.fn((encodedKey: string, size: string) => `/catalog/thumb/${size}/${encodedKey}`),
  deleteCatalogItems: vi.fn(async () => {}),
  fetchBootstrapStatus: vi.fn(async () => ({
    needsSetup: false,
    authTokenSet: true,
    dbConnected: true,
    configured: { scaleway: true, google: true, immich: true },
  })),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderRoute(path: string, queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<OAuthCallbackPage />} path="auth/google/callback" />
          <Route element={<Layout />} path="/">
            <Route element={<PhotoTransferPage />} index />
            <Route element={<TakeoutProgressPage />} path="takeout" />
            <Route element={<TransfersListPage />} path="transfers" />
            <Route element={<CatalogPage />} path="catalog" />
            <Route element={<CostsPage />} path="costs" />
            <Route element={<NewTransferPage />} path="transfers/new" />
            <Route element={<TransferDetailPage />} path="transfers/:id" />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function takeoutStatus(overrides: Partial<TakeoutStatus> & {
  counts?: Partial<TakeoutStatus['counts']>;
  paths?: Partial<TakeoutStatus['paths']>;
} = {}): TakeoutStatus {
  const base: TakeoutStatus = {
    paths: {
      inputDir: 'data/takeout/input',
      workDir: 'data/takeout/work',
      manifestPath: 'data/takeout/work/manifest.jsonl',
      statePath: 'data/takeout/state.json',
    },
    counts: {
      total: 18,
      processed: 18,
      pending: 0,
      uploaded: 10,
      skipped: 8,
      failed: 0,
    },
    progress: 1,
    stateUpdatedAt: new Date().toISOString(),
    recentFailures: [],
    isComplete: true,
    archivesInInput: 0,
    archiveHistory: [],
    autoUpload: false,
    externalRun: null,
  };

  return {
    ...base,
    ...overrides,
    paths: { ...base.paths, ...overrides.paths },
    counts: { ...base.counts, ...overrides.counts },
  };
}

function takeoutActionStatus(overrides: Partial<TakeoutActionStatus> = {}): TakeoutActionStatus {
  return {
    running: false,
    action: 'verify',
    success: true,
    exitCode: 0,
    output: [],
    ...overrides,
  };
}

function interruptedArchive(overrides: Partial<TakeoutArchiveHistoryEntry> = {}): TakeoutArchiveHistoryEntry {
  return {
    archiveName: 'takeout-20260430-001.tgz',
    status: 'failed',
    entryCount: 0,
    uploadedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    handledPercent: 0,
    isFullyUploaded: false,
    ...overrides,
  };
}

async function mockTakeoutResponses(
  status: TakeoutStatus,
  actionStatus: TakeoutActionStatus = takeoutActionStatus(),
) {
  const api = await import('@/lib/api');
  vi.mocked(api.fetchTakeoutStatus).mockResolvedValueOnce(status);
  vi.mocked(api.fetchTakeoutActionStatus).mockResolvedValueOnce(actionStatus);
  return api;
}

describe('frontend pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders photo transfer page (home) with connect step', async () => {
    renderRoute('/');
    expect(await screen.findByRole('heading', { name: 'Photo Transfer' })).toBeInTheDocument();
    expect(await screen.findByText('Connect Google Account')).toBeInTheDocument();
  });

  it('renders transfers list page', async () => {
    renderRoute('/transfers');
    expect(await screen.findByText('Transfers')).toBeInTheDocument();
    const googlePhotosElements = await screen.findAllByText(/google-photos/i);
    expect(googlePhotosElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders new transfer page', async () => {
    renderRoute('/transfers/new');
    expect(await screen.findByRole('heading', { name: 'New Transfer' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /create transfer/i })).toBeInTheDocument();
  });

  it('renders takeout progress page', async () => {
    renderRoute('/takeout');
    expect(await screen.findByRole('heading', { name: 'Google Takeout' })).toBeInTheDocument();
    expect(await screen.findByText(/migrate your google photos library/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /repair wrong dates/i })).toBeInTheDocument();
  });

  it('disables takeout controls while an external run is in progress', async () => {
    await mockTakeoutResponses(takeoutStatus({
      counts: {
        total: 18,
        processed: 12,
        pending: 5,
        uploaded: 12,
        skipped: 0,
        failed: 1,
      },
      progress: 12 / 18,
      archivesInInput: 1,
      autoUpload: true,
      externalRun: {
        pid: 4242,
        startedAt: '2026-05-01T10:06:34.000Z',
        source: 'cli',
        command: 'npx tsx scripts/takeout-auto-upload.ts',
      },
    }));

    renderRoute('/takeout');

    expect(await screen.findByText(/external takeout run in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/npx tsx scripts\/takeout-auto-upload\.ts/i)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('button', { name: /start upload/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /resume \(skip failed\)/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reset upload state/i })).toBeDisabled();
  });

  it('marks interrupted archives as retrying during an external run', async () => {
    await mockTakeoutResponses(
      takeoutStatus({
        archiveHistory: [interruptedArchive()],
        externalRun: {
          pid: 4242,
          startedAt: '2026-05-01T10:06:34.000Z',
          source: 'cli',
          command: 'npx tsx scripts/takeout-auto-upload.ts',
        },
      }),
      takeoutActionStatus({
        action: 'upload',
        uploadProgress: { currentArchive: 'takeout-20260430-001.tgz' },
      }),
    );

    renderRoute('/takeout');

    expect(await screen.findByText('Interrupted (will retry)')).toBeInTheDocument();
    expect(screen.queryByText('Interrupted (needs re-run)')).not.toBeInTheDocument();
  });

  it('marks interrupted archives as retrying while a takeout action is running', async () => {
    await mockTakeoutResponses(
      takeoutStatus({ archiveHistory: [interruptedArchive()] }),
      takeoutActionStatus({
        running: true,
        action: 'upload',
        success: undefined,
        exitCode: undefined,
      }),
    );

    renderRoute('/takeout');

    expect(await screen.findByText('Interrupted (will retry)')).toBeInTheDocument();
    expect(screen.queryByText('Interrupted (needs re-run)')).not.toBeInTheDocument();
  });

  it('marks interrupted archives as needing re-run when no takeout action is active', async () => {
    await mockTakeoutResponses(takeoutStatus({ archiveHistory: [interruptedArchive()] }));

    renderRoute('/takeout');

    expect(await screen.findByText('Interrupted (needs re-run)')).toBeInTheDocument();
    expect(screen.queryByText('Interrupted (will retry)')).not.toBeInTheDocument();
  });

  it('renders transient upload-failure reasons in the archive history', async () => {
    await mockTakeoutResponses(
      takeoutStatus({
        archiveHistory: [
          interruptedArchive({
            notUploadedReasons: [
              {
                code: 'upload_failed_transient',
                label: 'Upload failed (will retry next pass)',
                count: 7,
              },
            ],
          }),
        ],
      }),
    );

    renderRoute('/takeout');

    expect(
      await screen.findByText(/7 upload failed \(will retry next pass\)/i),
    ).toBeInTheDocument();
  });

  it('renders permanent upload-failure reasons in the archive history', async () => {
    await mockTakeoutResponses(
      takeoutStatus({
        archiveHistory: [
          interruptedArchive({
            notUploadedReasons: [
              {
                code: 'upload_failed_permanent',
                label: 'Upload failed (needs re-run)',
                count: 2,
              },
            ],
          }),
        ],
      }),
    );

    renderRoute('/takeout');

    expect(
      await screen.findByText(/2 upload failed \(needs re-run\)/i),
    ).toBeInTheDocument();
  });

  it('does not render a red "Failed (X%)" pill for a partly-handled archive while an external run is active', async () => {
    // Regression: with entryCount>0 the pill used to fall through to red
    // "Failed (0%)" even when the external CLI was actively retrying it.
    await mockTakeoutResponses(
      takeoutStatus({
        archiveHistory: [
          interruptedArchive({
            archiveName: 'takeout-20260315T163220Z-3-059.tgz',
            entryCount: 139,
            uploadedCount: 0,
            handledPercent: 0,
          }),
        ],
        externalRun: {
          pid: 89284,
          startedAt: '2026-05-01T10:06:34.000Z',
          source: 'cli',
          command: 'scripts/takeout-process.ts (backfilled)',
        },
      }),
    );

    renderRoute('/takeout');

    expect(await screen.findByText('Interrupted (will retry)')).toBeInTheDocument();
    expect(screen.queryByText(/^Failed \(/)).not.toBeInTheDocument();
  });

  it('shows a stale data warning when cached takeout data is old after failed refreshes', async () => {
    const queryClient = createTestQueryClient();
    const staleUpdatedAt = Date.now() - 20_000;

    queryClient.setQueryData<TakeoutStatus>(['takeout-status'], takeoutStatus(), { updatedAt: staleUpdatedAt });
    queryClient.setQueryData<TakeoutActionStatus>(['takeout-action-status'], takeoutActionStatus(), { updatedAt: Date.now() });
    queryClient.getQueryCache().find({ queryKey: ['takeout-status'], exact: true })?.setState({
      fetchFailureCount: 2,
      fetchFailureReason: new Error('Backend temporarily unreachable'),
    });

    renderRoute('/takeout', queryClient);

    expect(await screen.findByText('Live updates paused')).toBeInTheDocument();
    expect(screen.getByText(/numbers below may be stale/i)).toBeInTheDocument();
  });

  it('renders transfer detail page', async () => {
    renderRoute('/transfers/job-1');
    expect(await screen.findByText('Transfer Detail')).toBeInTheDocument();
    expect(await screen.findByText('Transfer in progress')).toBeInTheDocument();
    expect(await screen.findByText(/transfer job started/i)).toBeInTheDocument();
  });

  it('renders costs page', async () => {
    renderRoute('/costs');
    expect(await screen.findByRole('heading', { name: 'Costs' })).toBeInTheDocument();
    expect(await screen.findByText('Detailed cost estimate')).toBeInTheDocument();
  });

  it('renders catalog page', async () => {
    renderRoute('/catalog');
    expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeInTheDocument();
    // Inline stats: "42 files · 1 GB"
    expect(await screen.findByText(/42 files/)).toBeInTheDocument();
  });

  it('shows navigation links', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: 'Photo Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Takeout' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Transfers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Costs' })).toBeInTheDocument();
  });

  it('shows error state when last scan failed', async () => {
    const api = await import('@/lib/api');
    vi.mocked(api.fetchTakeoutActionStatus).mockResolvedValueOnce({
      running: false,
      action: 'scan',
      success: false,
      exitCode: 1,
      output: ['❌ Takeout scan failed:', '   No media files found'],
    });

    renderRoute('/takeout');
    expect(await screen.findByRole('button', { name: /retry scan/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /continue with upload anyway/i })).toBeInTheDocument();
  });
});
