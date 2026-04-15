import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { TransfersListPage } from '@/pages/transfers-list-page';
import { NewTransferPage } from '@/pages/new-transfer-page';
import { TransferDetailPage } from '@/pages/transfer-detail-page';
import { TakeoutProgressPage } from '@/pages/takeout-progress-page';
import { PhotoTransferPage } from '@/pages/photo-transfer-page';
import { OAuthCallbackPage } from '@/pages/oauth-callback-page';
import { CostsPage } from '@/pages/costs-page';
import { CatalogPage } from '@/pages/catalog-page';
import { CatalogDedupPage } from '@/pages/catalog-dedup-page';
import { CatalogAlbumsPage } from '@/pages/catalog-albums-page';
import { CatalogAlbumDetailPage } from '@/pages/catalog-album-detail-page';
import { CatalogUndatedPage } from '@/pages/catalog-undated-page';
import { UploadPage } from '@/pages/upload-page';
import { SequenceAnalysisPage } from '@/pages/sequence-analysis-page';
import { PipelinePage } from '@/pages/pipeline-page';
import { ImmichComparePage } from '@/pages/immich-compare-page';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          {/* OAuth callback renders outside the main layout */}
          <Route element={<OAuthCallbackPage />} path="auth/google/callback" />
          <Route element={<Layout />} path="/">
            <Route element={<PhotoTransferPage />} index />
            <Route element={<UploadPage />} path="upload" />
            <Route element={<TakeoutProgressPage />} path="takeout" />
            <Route element={<TransfersListPage />} path="transfers" />
            <Route element={<CatalogPage />} path="catalog" />
            <Route element={<CatalogDedupPage />} path="catalog/dedup" />
            <Route element={<ImmichComparePage />} path="catalog/immich-compare" />
            <Route element={<CatalogAlbumsPage />} path="catalog/albums" />
            <Route element={<CatalogAlbumDetailPage />} path="catalog/albums/:albumId" />
            <Route element={<CatalogUndatedPage />} path="catalog/undated" />
            <Route element={<CostsPage />} path="costs" />
            <Route element={<PipelinePage />} path="pipeline" />
            <Route element={<SequenceAnalysisPage />} path="takeout/sequences" />
            <Route element={<NewTransferPage />} path="transfers/new" />
            <Route element={<TransferDetailPage />} path="transfers/:id" />
          </Route>
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </BrowserRouter>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
