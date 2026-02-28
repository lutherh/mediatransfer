import { useMemo } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export function CatalogPage() {
  const catalogUrl = useMemo(() => `${API_BASE_URL}/catalog`, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold">Catalog</h1>
        <p className="text-sm text-slate-600">Browse media uploaded to Scaleway Object Storage.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-medium text-slate-900">Quick guide</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li>If the catalog is empty, confirm uploads have completed on the <span className="font-semibold">Takeout</span> or <span className="font-semibold">Photo Transfer</span> page.</li>
          <li>If API auth is enabled, open <span className="font-mono">/catalog?apiToken=YOUR_API_AUTH_TOKEN</span>.</li>
          <li>If the frame fails to load, verify backend is running on <span className="font-mono">http://localhost:3000</span>.</li>
        </ul>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-1 sm:p-2 shadow-sm">
        <iframe
          src={catalogUrl}
          title="Scaleway Catalog Browser"
          className="h-[calc(100vh-10rem)] sm:h-[75vh] w-full rounded-lg border border-slate-200"
        />
      </div>
    </div>
  );
}
