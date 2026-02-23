import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CostsPage } from '@/pages/costs-page';

const mockFetchCloudUsage = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchCloudUsage: (...args: unknown[]) => mockFetchCloudUsage(...args),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CostsPage />
    </QueryClientProvider>,
  );
}

describe('CostsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchCloudUsage.mockResolvedValue({
      provider: 'scaleway',
      bucket: 'photos-bucket',
      region: 'nl-ams',
      prefix: 'photos',
      totalObjects: 1675,
      totalBytes: 9.16 * 1024 * 1024 * 1024,
      totalGB: 9.16,
      bucketType: 'standard',
      assumptions: {
        putRequests: 0,
        getRequests: 0,
        listRequests: 0,
        lifecycleTransitionGB: 0,
        retrievalGB: 0,
        egressGB: 0,
        vatRate: 0.25,
      },
      pricing: {
        currency: 'USD',
        pricePerGBMonthly: 0.023,
        requestPer1000: { put: 0.005, get: 0.0004, list: 0.005 },
        lifecycleTransitionPerGB: 0.01,
        retrievalPerGB: 0,
        egressPerGB: 0.09,
      },
      providerRules: {
        requestBillingUnit: 1000,
        lineItemRoundingDecimals: 4,
        invoiceRoundingDecimals: 2,
        minimumMonthlyChargeUSD: 0,
      },
      breakdown: {
        storageCost: 0.21,
        putRequestCost: 0,
        getRequestCost: 0,
        listRequestCost: 0,
        requestCost: 0,
        lifecycleTransitionCost: 0,
        retrievalCost: 0,
        egressCost: 0,
        subtotalBeforeMinimum: 0.21,
        minimumChargeAdjustment: 0,
        subtotalExclVat: 0.21,
        vatAmount: 0.0525,
        totalInclVat: 0.26,
      },
      estimatedMonthlyCost: 0.26,
      measuredAt: new Date().toISOString(),
      note: 'Estimate includes storage, requests, transition, retrieval, egress, and VAT based on supplied assumptions (not invoice data).',
    });
  });

  it('renders detailed costs page and calls estimator with defaults', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Costs' })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockFetchCloudUsage).toHaveBeenCalledWith('standard', {
        putRequests: 0,
        getRequests: 0,
        listRequests: 0,
        lifecycleTransitionGB: 0,
        retrievalGB: 0,
        egressGB: 0,
        vatRate: 0.25,
      });
    });
  });

  it('updates estimator inputs and triggers recalculation', async () => {
    renderPage();

    const egressInput = await screen.findByLabelText('Egress GB / month');
    fireEvent.change(egressInput, { target: { value: '12' } });

    await waitFor(() => {
      expect(mockFetchCloudUsage).toHaveBeenLastCalledWith('standard', expect.objectContaining({
        egressGB: 12,
      }));
    });

    const bucketTypeSelect = screen.getByLabelText('Bucket type');
    fireEvent.change(bucketTypeSelect, { target: { value: 'archive' } });

    await waitFor(() => {
      expect(mockFetchCloudUsage).toHaveBeenLastCalledWith('archive', expect.any(Object));
    });
  });
});
