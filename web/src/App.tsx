import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { PageLoader } from './components/ui';
import { useSession } from './lib/session';
import { LoginPage, RegisterPage } from './pages/Login';

const InboxPage = lazy(() => import('./pages/Inbox'));
const FunnelsPage = lazy(() => import('./pages/Funnels'));
const ContactsPage = lazy(() => import('./pages/Contacts'));
const BroadcastsPage = lazy(() => import('./pages/Broadcasts'));
const TemplatesPage = lazy(() => import('./pages/Templates'));
const AutomationPage = lazy(() => import('./pages/Automation'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const CreditsPage = lazy(() => import('./pages/Credits'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const AdminPage = lazy(() => import('./pages/Admin'));

function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, user, workspace } = useSession();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!workspace && !user.is_superadmin) {
    return (
      <div className="p-10 text-center text-slate-600">
        Tu usuario no pertenece a ningún espacio de trabajo activo. Pide a tu administrador que te agregue.
      </div>
    );
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useSession();
  return isAdmin ? <>{children}</> : <Navigate to="/bandeja" replace />;
}

export function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/registro" element={<RegisterPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/bandeja" replace />} />
          <Route path="/bandeja" element={<InboxPage />} />
          <Route path="/bandeja/:contactId" element={<InboxPage />} />
          <Route path="/embudos" element={<FunnelsPage />} />
          <Route path="/embudos/:funnelId" element={<FunnelsPage />} />
          <Route path="/contactos" element={<ContactsPage />} />
          <Route
            path="/difusiones/*"
            element={
              <RequireAdmin>
                <BroadcastsPage />
              </RequireAdmin>
            }
          />
          <Route path="/plantillas" element={<TemplatesPage />} />
          <Route
            path="/automatizacion"
            element={
              <RequireAdmin>
                <AutomationPage />
              </RequireAdmin>
            }
          />
          <Route path="/reportes" element={<ReportsPage />} />
          <Route path="/creditos" element={<CreditsPage />} />
          <Route path="/ajustes" element={<SettingsPage />} />
          <Route path="/ajustes/:tab" element={<SettingsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/bandeja" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
