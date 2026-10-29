import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage, setWorkspaceId } from '../lib/api';
import { dateTime } from '../lib/format';
import { useSession } from '../lib/session';
import type { User, WorkspaceSummary } from '../lib/types';
import { Alert, Button, Field, Input, PageLoader } from '../components/ui';
import { AuthShell } from './Login';

export interface InvitationInfo {
  workspace_name: string;
  email: string;
  role: 'admin' | 'agent';
  expires_at: string;
  account_exists: boolean;
}

/** What the person opening the link has to do: the invitation only works for its own email. */
export function invitationStep(inv: Pick<InvitationInfo, 'email' | 'account_exists'>, user: Pick<User, 'email'> | null): 'accept' | 'switch_account' | 'login' | 'register' {
  if (user) return user.email.trim().toLowerCase() === inv.email.trim().toLowerCase() ? 'accept' : 'switch_account';
  return inv.account_exists ? 'login' : 'register';
}

const ROLE: Record<InvitationInfo['role'], string> = { admin: 'administrador', agent: 'agente' };

export default function InvitationPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { loading, user, logout, refresh, switchWorkspace, setSession } = useSession();
  const info = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<InvitationInfo>(`/api/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ workspace_id: string }>(`/api/invitations/${encodeURIComponent(token)}/accept`);
      switchWorkspace(r.workspace_id);
      await refresh();
      navigate('/bandeja', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function register(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User; workspaces: WorkspaceSummary[]; workspace_id: string }>(
        `/api/invitations/${encodeURIComponent(token)}/register`,
        form,
      );
      setWorkspaceId(r.workspace_id);
      setSession(r);
      navigate('/bandeja', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading || info.isLoading) return <PageLoader />;

  if (!info.data) {
    return (
      <AuthShell>
        <Alert tone="error" title="Invitación no válida">
          {errorMessage(info.error)}
        </Alert>
        <Link to="/login" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline">
          Ir a iniciar sesión
        </Link>
      </AuthShell>
    );
  }

  const inv = info.data;
  const step = invitationStep(inv, user);
  return (
    <AuthShell>
      <h2 className="text-2xl font-semibold text-slate-900">Te invitaron a {inv.workspace_name}</h2>
      <p className="mt-2 text-sm text-slate-500">
        Entrarás como {ROLE[inv.role]} con el correo <b>{inv.email}</b>. La invitación vence el {dateTime(inv.expires_at)}
      </p>
      <div className="mt-6 space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {step === 'accept' && (
          <Button onClick={() => void accept()} loading={busy} className="w-full">
            Aceptar invitación
          </Button>
        )}
        {step === 'switch_account' && (
          <>
            <Alert tone="warning">
              Esta invitación es para {inv.email} y entraste como {user?.email}. Cierra sesión y entra con la cuenta invitada.
            </Alert>
            <Button variant="outline" onClick={() => void logout()} className="w-full">
              Cerrar sesión
            </Button>
          </>
        )}
        {step === 'login' && (
          <>
            <p className="text-sm text-slate-600">Ya existe una cuenta con ese correo: inicia sesión para aceptar la invitación.</p>
            <Link to="/login" state={{ from: `/invitacion/${token}`, email: inv.email }} className="block">
              <Button className="w-full">Iniciar sesión</Button>
            </Link>
          </>
        )}
        {step === 'register' && (
          <form onSubmit={register} className="space-y-4">
            <Field label="Correo">
              <Input value={inv.email} disabled />
            </Field>
            <Field label="Tu nombre">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} autoFocus />
            </Field>
            <Field label="Contraseña" hint="Mínimo 8 caracteres">
              <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} required />
            </Field>
            <Button type="submit" loading={busy} className="w-full">
              Crear cuenta y entrar
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
