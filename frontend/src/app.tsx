import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { TransfersListPage } from '@/pages/transfers-list-page';
import { NewTransferPage } from '@/pages/new-transfer-page';
import { TransferDetailPage } from '@/pages/transfer-detail-page';
import { TakeoutProgressPage } from '@/pages/takeout-progress-page';
import { PhotoTransferPage } from '@/pages/photo-transfer-page';
import { OAuthCallbackPage } from '@/pages/oauth-callback-page';
import { CostsPage } from '@/pages/costs-page';
import { CatalogPage } from '@/pages/catalog-page';
import { UploadPage } from '@/pages/upload-page';

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
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
            <Route element={<CostsPage />} path="costs" />
            <Route element={<NewTransferPage />} path="transfers/new" />
            <Route element={<TransferDetailPage />} path="transfers/:id" />
          </Route>
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
