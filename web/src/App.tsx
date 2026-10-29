import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Button, PageLoader } from './components/ui';
import { listenForSessionChanges } from './lib/realtime';
import { noWorkspaceReason, useSession } from './lib/session';
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
const InvitationPage = lazy(() => import('./pages/Invitation'));

function NoWorkspace({ reason }: { reason: string }) {
  const session = useSession();
  const userId = session.user?.id;
  // Rights changes reach the user's socket: the operator reactivating the workspace then reloads
  // the session and lets them in without a page reload.
  useEffect(() => {
    if (userId) listenForSessionChanges();
  }, [userId]);
  return (
    <div className="space-y-4 p-10 text-center text-slate-600">
      <p>{reason}</p>
      <Button variant="outline" onClick={() => void session.logout()}>
        Cerrar sesión
      </Button>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.loading) return <PageLoader />;
  if (!session.user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  const blocked = noWorkspaceReason(session);
  if (blocked) return <NoWorkspace reason={blocked} />;
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
        <Route path="/invitacion/:token" element={<InvitationPage />} />
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
