/**
 * Routes.
 *
 * Pages that do not exist yet render a stub rather than being omitted, so the
 * rail is navigable end to end from the first run — a dead link during a
 * rehearsal is worse than an honest "not built yet", and it keeps the shell's
 * layout verifiable before the pages land.
 */

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { useAuth } from '@/context/AuthContext';
import Shell from '@/components/shell/Shell';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import { Spinner, Empty } from '@/components/ui/Bits';

/**
 * The Explorer is loaded on demand.
 *
 * Cytoscape and its layout engine are ~600 kB, and bundling them into the entry
 * chunk means the LOGIN page downloads a graph library before anyone has
 * authenticated. Splitting here keeps first paint light and pays the cost only
 * when an investigator actually opens the network.
 */
const NetworkExplorer = lazy(() => import('@/pages/NetworkExplorer'));

function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={16} />
    </div>
  );
}

/** A page that is planned but not built. Named so the gap is visible. */
function Planned({ title, note }) {
  return (
    <div className="p-3">
      <div className="glass">
        <Empty
          title={title}
          hint={note ?? 'This page is planned and its API endpoints are live. The interface has not been built yet.'}
        />
      </div>
    </div>
  );
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();

  // Wait for the token rehydration in AuthContext before deciding. Redirecting
  // during the check would bounce a signed-in user to /login on every refresh.
  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-void">
        <Spinner size={18} />
      </div>
    );
  }
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route
          path="network"
          element={
            <Suspense fallback={<PageLoading />}>
              <NetworkExplorer />
            </Suspense>
          }
        />
        <Route path="complaints" element={<Planned title="Complaints" />} />
        <Route path="complaints/:id" element={<Planned title="Complaint Intelligence" />} />
        <Route path="money" element={<Planned title="Money Flow Analysis" />} />
        <Route path="geo" element={<Planned title="Geo Intelligence" />} />
        <Route path="alerts" element={<Planned title="Threat Feed" />} />
        <Route path="timeline" element={<Planned title="Investigation Timeline" />} />
        <Route path="clusters" element={<Planned title="Criminal Networks" />} />
        <Route path="clusters/:key" element={<Planned title="Network Detail" />} />
        <Route path="evidence" element={<Planned title="Evidence Locker" />} />
        <Route path="admin" element={<Planned title="Admin" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
