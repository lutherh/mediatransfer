import { Link, NavLink, Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-semibold text-slate-900">
            MediaTransfer
          </Link>
          <nav className="flex gap-4 text-sm">
            <NavLink to="/" className={({ isActive }) => (isActive ? 'font-semibold text-slate-900' : 'text-slate-600')}>
              Transfers
            </NavLink>
            <NavLink to="/takeout" className={({ isActive }) => (isActive ? 'font-semibold text-slate-900' : 'text-slate-600')}>
              Takeout Progress
            </NavLink>
            <NavLink to="/transfers/new" className={({ isActive }) => (isActive ? 'font-semibold text-slate-900' : 'text-slate-600')}>
              New Transfer
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
