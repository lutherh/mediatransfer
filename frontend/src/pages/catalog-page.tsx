import { useMemo } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export function CatalogPage() {
  const catalogUrl = useMemo(() => `${API_BASE_URL}/catalog`, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Catalog</h1>
        <p className="text-sm text-slate-600">Browse media uploaded to Scaleway Object Storage.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <iframe
          src={catalogUrl}
          title="Scaleway Catalog Browser"
          className="h-[75vh] w-full rounded-lg border border-slate-200"
        />
      </div>
    </div>
  );
}
