import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, errorMessage, setWorkspaceId } from '../lib/api';
import { dateTime } from '../lib/format';
import { useSession } from '../lib/session';
import type { User, WorkspaceSummary } from '../lib/types';
import { Alert, Button, Field, Input, PageLoader } from '../components/ui';
import { AuthShell, SessionReconnecting } from './Login';

/** Public preview of an invitation. It never says whether the email has an account (#51). */
export interface InvitationInfo {
  workspace_name: string;
  email: string;
  role: 'admin' | 'agent';
  expires_at: string;
}

export type InvitationStep = 'accept' | 'switch_account' | 'login' | 'register';

/**
 * What the person opening the link has to do: the invitation only works for its own email.
 * An anonymous visitor gets the register form plus a link to sign in, since the preview does not
 * reveal whether the account exists; `emailTaken` (the register answered EMAIL_TAKEN) leaves only login.
 */
export function invitationStep(inv: Pick<InvitationInfo, 'email'>, user: Pick<User, 'email'> | null, emailTaken = false): InvitationStep {
  if (user) return user.email.trim().toLowerCase() === inv.email.trim().toLowerCase() ? 'accept' : 'switch_account';
  return emailTaken ? 'login' : 'register';
}

/**
 * How the page reacts to a refused register or accept: an existing account switches to the login
 * step, and a deactivated membership is final (accepting again cannot help), so its button goes.
 */
export function invitationFailure(err: unknown): { message: string; emailTaken: boolean; final: boolean } {
  const code = err instanceof ApiError ? err.code : null;
  return { message: errorMessage(err), emailTaken: code === 'EMAIL_TAKEN', final: code === 'MEMBER_DEACTIVATED' };
}

const ROLE: Record<InvitationInfo['role'], string> = { admin: 'administrador', agent: 'agente' };

export function InvitationSteps({
  token,
  inv,
  step,
  user,
  form,
  onForm,
  busy,
  error,
  blocked,
  onAccept,
  onRegister,
  onLogout,
}: {
  token: string;
  inv: InvitationInfo;
  step: InvitationStep;
  user: Pick<User, 'email'> | null;
  form: { name: string; password: string };
  onForm: (f: { name: string; password: string }) => void;
  busy: boolean;
  error: string | null;
  /** The server refused the invitation for good (e.g. MEMBER_DEACTIVATED): no retry button. */
  blocked: boolean;
  onAccept: () => void;
  onRegister: (e: FormEvent) => void;
  onLogout: () => void;
}) {
  // Signing in comes back here with the invited email filled in.
  const loginState = { from: `/invitacion/${token}`, email: inv.email };
  return (
    <AuthShell>
      <h2 className="text-2xl font-semibold text-slate-900">Te invitaron a {inv.workspace_name}</h2>
      <p className="mt-2 text-sm text-slate-500">
        Entrarás como {ROLE[inv.role]} con el correo <b>{inv.email}</b>. La invitación vence el {dateTime(inv.expires_at)}
      </p>
      <div className="mt-6 space-y-4">
        {error && <Alert tone={blocked || step === 'login' ? 'warning' : 'error'}>{error}</Alert>}
        {step === 'accept' && !blocked && (
          <Button onClick={onAccept} loading={busy} className="w-full">
            Aceptar invitación
          </Button>
        )}
        {step === 'switch_account' && (
          <>
            <Alert tone="warning">
              Esta invitación es para {inv.email} y entraste como {user?.email}. Cierra sesión y entra con la cuenta invitada.
            </Alert>
            <Button variant="outline" onClick={onLogout} className="w-full">
              Cerrar sesión
            </Button>
          </>
        )}
        {step === 'login' && (
          <>
            {!error && <p className="text-sm text-slate-600">Ya existe una cuenta con ese correo: inicia sesión para aceptar la invitación.</p>}
            <Link to="/login" state={loginState} className="block">
              <Button className="w-full">Iniciar sesión</Button>
            </Link>
          </>
        )}
        {step === 'register' && (
          <>
            <form onSubmit={onRegister} className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-800">Crear cuenta</h3>
              <Field label="Correo">
                <Input value={inv.email} disabled />
              </Field>
              <Field label="Tu nombre">
                <Input value={form.name} onChange={(e) => onForm({ ...form, name: e.target.value })} required minLength={2} autoFocus />
              </Field>
              <Field label="Contraseña" hint="Mínimo 8 caracteres">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => onForm({ ...form, password: e.target.value })}
                  minLength={8}
                  required
                />
              </Field>
              <Button type="submit" loading={busy} className="w-full">
                Crear cuenta y entrar
              </Button>
            </form>
            <div className="border-t border-slate-200 pt-4 text-center text-sm text-slate-500">
              ¿Ya tienes una cuenta con este correo?{' '}
              <Link to="/login" state={loginState} className="font-medium text-brand-700 hover:underline">
                Ya tengo cuenta: iniciar sesión
              </Link>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function InvitationPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { loading, reconnecting, user, logout, refresh, switchWorkspace, setSession } = useSession();
  const info = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<InvitationInfo>(`/api/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [blocked, setBlocked] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ workspace_id: string }>(`/api/invitations/${encodeURIComponent(token)}/accept`);
      switchWorkspace(r.workspace_id);
      await refresh();
      navigate('/bandeja', { replace: true });
    } catch (err) {
      const f = invitationFailure(err);
      setError(f.message);
      setBlocked(f.final);
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
      const f = invitationFailure(err);
      setError(f.message);
      if (f.emailTaken) setEmailTaken(true);
    } finally {
      setBusy(false);
    }
  }

  if (loading && reconnecting) return <SessionReconnecting />;
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

  return (
    <InvitationSteps
      token={token}
      inv={info.data}
      step={invitationStep(info.data, user, emailTaken)}
      user={user}
      form={form}
      onForm={setForm}
      busy={busy}
      error={error}
      blocked={blocked}
      onAccept={() => void accept()}
      onRegister={(e) => void register(e)}
      onLogout={() => {
        setError(null);
        setBlocked(false);
        void logout().catch((err) => setError(errorMessage(err)));
      }}
    />
  );
}
