import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchCloudUsage, type CloudUsageAssumptions, type CloudUsageBucketType } from '@/lib/api';
import { Card } from '@/components/ui/card';

const BUCKET_TYPE_SETTING_KEY = 'cloudUsage.bucketType';

function readBucketTypeSetting(): CloudUsageBucketType {
  if (
    typeof window === 'undefined' ||
    !window.localStorage ||
    typeof window.localStorage.getItem !== 'function'
  ) {
    return 'standard';
  }

  const stored = window.localStorage.getItem(BUCKET_TYPE_SETTING_KEY);
  if (stored === 'standard' || stored === 'infrequent' || stored === 'archive') {
    return stored;
  }

  return 'standard';
}

export function CostsPage() {
  const [bucketType, setBucketType] = useState<CloudUsageBucketType>(readBucketTypeSetting);
  const [assumptions, setAssumptions] = useState<CloudUsageAssumptions>({
    putRequests: 0,
    getRequests: 0,
    listRequests: 0,
    lifecycleTransitionGB: 0,
    retrievalGB: 0,
    egressGB: 0,
    vatRate: 0.25,
  });

  const cloudUsageQuery = useQuery({
    queryKey: [
      'cloud-usage',
      bucketType,
      assumptions.putRequests,
      assumptions.getRequests,
      assumptions.listRequests,
      assumptions.lifecycleTransitionGB,
      assumptions.retrievalGB,
      assumptions.egressGB,
      assumptions.vatRate,
    ],
    queryFn: () => fetchCloudUsage(bucketType, assumptions),
    retry: false,
    staleTime: 30_000,
  });

  const handleAssumptionChange = (key: keyof CloudUsageAssumptions, value: number) => {
    setAssumptions((current) => ({
      ...current,
      [key]: Number.isFinite(value) ? Math.max(0, value) : 0,
    }));
  };

  const handleBucketTypeChange = (value: CloudUsageBucketType) => {
    setBucketType(value);
    if (
      typeof window !== 'undefined' &&
      window.localStorage &&
      typeof window.localStorage.setItem === 'function'
    ) {
      window.localStorage.setItem(BUCKET_TYPE_SETTING_KEY, value);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Costs</h1>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-900">Detailed cost estimate</p>
            <p className="text-xs text-slate-600">Includes requests, lifecycle, retrieval, egress, and VAT assumptions.</p>
          </div>
          <label className="text-xs text-slate-700">
            Bucket type
            <select
              className="ml-2 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              value={bucketType}
              onChange={(event) => handleBucketTypeChange(event.target.value as CloudUsageBucketType)}
            >
              <option value="standard">Standard</option>
              <option value="infrequent">Infrequent</option>
              <option value="archive">Archive</option>
            </select>
          </label>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-slate-700">
            PUT requests / month
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              value={assumptions.putRequests}
              onChange={(event) => handleAssumptionChange('putRequests', Number(event.target.value))}
            />
          </label>
          <label className="text-xs text-slate-700">
            GET requests / month
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              value={assumptions.getRequests}
              onChange={(event) => handleAssumptionChange('getRequests', Number(event.target.value))}
            />
          </label>
          <label className="text-xs text-slate-700">
            LIST requests / month
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              value={assumptions.listRequests}
              onChange={(event) => handleAssumptionChange('listRequests', Number(event.target.value))}
            />
          </label>
          <label className="text-xs text-slate-700">
            Egress GB / month
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              step="0.01"
              value={assumptions.egressGB}
              onChange={(event) => handleAssumptionChange('egressGB', Number(event.target.value))}
            />
          </label>
          <label className="text-xs text-slate-700">
            Retrieval GB / month
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              step="0.01"
              value={assumptions.retrievalGB}
              onChange={(event) => handleAssumptionChange('retrievalGB', Number(event.target.value))}
            />
          </label>
          <label className="text-xs text-slate-700">
            Lifecycle transition GB / month
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              step="0.01"
              value={assumptions.lifecycleTransitionGB}
              onChange={(event) => handleAssumptionChange('lifecycleTransitionGB', Number(event.target.value))}
            />
          </label>
          <label className="text-xs text-slate-700">
            VAT rate (Denmark default 0.25)
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
              type="number"
              min={0}
              max={1}
              step="0.01"
              value={assumptions.vatRate}
              onChange={(event) => handleAssumptionChange('vatRate', Number(event.target.value))}
            />
          </label>
        </div>

        {cloudUsageQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-600">Loading cost estimate...</p>
        ) : cloudUsageQuery.isError ? (
          <p className="mt-3 text-sm text-amber-700">
            {cloudUsageQuery.error instanceof Error ? cloudUsageQuery.error.message : 'Cloud usage unavailable.'}
          </p>
        ) : cloudUsageQuery.data ? (
          <div className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-4">
            <p><span className="font-medium">Uploaded:</span> {cloudUsageQuery.data.totalGB.toFixed(2)} GB</p>
            <p><span className="font-medium">Objects:</span> {cloudUsageQuery.data.totalObjects.toLocaleString()}</p>
            <p><span className="font-medium">Monthly (incl. VAT):</span> ${cloudUsageQuery.data.estimatedMonthlyCost.toFixed(2)} / mo</p>
            <p><span className="font-medium">Storage rate:</span> ${cloudUsageQuery.data.pricing.pricePerGBMonthly.toFixed(4)} / GB</p>

            {cloudUsageQuery.data.breakdown ? (
              <>
                <p><span className="font-medium">Storage:</span> ${cloudUsageQuery.data.breakdown.storageCost.toFixed(4)}</p>
                <p><span className="font-medium">Requests:</span> ${cloudUsageQuery.data.breakdown.requestCost.toFixed(4)}</p>
                <p><span className="font-medium">Lifecycle:</span> ${cloudUsageQuery.data.breakdown.lifecycleTransitionCost.toFixed(4)}</p>
                <p><span className="font-medium">Retrieval:</span> ${cloudUsageQuery.data.breakdown.retrievalCost.toFixed(4)}</p>
                <p><span className="font-medium">Egress:</span> ${cloudUsageQuery.data.breakdown.egressCost.toFixed(4)}</p>
                <p><span className="font-medium">VAT:</span> ${cloudUsageQuery.data.breakdown.vatAmount.toFixed(4)}</p>
                <p><span className="font-medium">Subtotal excl. VAT:</span> ${cloudUsageQuery.data.breakdown.subtotalExclVat.toFixed(4)}</p>
              </>
            ) : null}

            {cloudUsageQuery.data.providerRules ? (
              <p><span className="font-medium">Request unit:</span> {cloudUsageQuery.data.providerRules.requestBillingUnit.toLocaleString()} ops</p>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
