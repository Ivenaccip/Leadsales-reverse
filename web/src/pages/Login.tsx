import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import type { User, WorkspaceSummary } from '../lib/types';
import { Alert, Button, Field, Input, Select, Spinner } from '../components/ui';

interface Instance {
  allowSignup: boolean;
  hasUsers: boolean;
  defaultBillingMode: string;
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <div className="flex flex-col justify-between bg-brand-800 px-8 py-10 text-white lg:w-[44%] lg:px-14">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-9 w-9 rounded-lg ring-2 ring-white/20" />
          <span className="text-xl font-bold">LeadLibre</span>
        </div>
        <div className="my-10 space-y-6">
          <h1 className="text-3xl font-semibold leading-tight lg:text-4xl">Vende por WhatsApp con todo tu equipo. Sin mensualidad.</h1>
          <ul className="space-y-3 text-brand-50">
            {[
              'Bandeja compartida con la API oficial de WhatsApp',
              'Embudos de venta, etiquetas y asignación automática',
              'Difusiones, bot de menú y agente con IA',
              'Solo pagas los créditos que consumes en Meta',
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-300" />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-brand-100/70">Software libre hecho por y para la comunidad.</p>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

/** The session could not be loaded (the server is restarting, its database is down, no network): it is retried. */
export function SessionReconnecting() {
  const { refresh } = useSession();
  return (
    <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-4 p-10 text-center text-slate-600">
      <Spinner className="h-7 w-7" />
      <p>No se pudo conectar con el servidor. Reintentando…</p>
      <Button variant="outline" onClick={() => void refresh()}>
        Reintentar ahora
      </Button>
    </div>
  );
}

export function LoginPage() {
  const { setSession, user } = useSession();
  const location = useLocation();
  const instance = useQuery({ queryKey: ['instance'], queryFn: () => api.get<Instance>('/api/instance') });
  // An invitation link sends here with the invited email filled in.
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<{ user: User; workspaces: WorkspaceSummary[] }>('/api/auth/login', { email, password });
      setSession(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/bandeja'} replace />;

  if (instance.data && !instance.data.hasUsers) {
    return (
      <AuthShell>
        <h2 className="text-2xl font-semibold text-slate-900">¡Bienvenido!</h2>
        <p className="mt-2 text-sm text-slate-500">Esta instancia es nueva. Crea la primera cuenta: será la administradora de la instancia.</p>
        <Link to="/registro" className="mt-6 inline-block">
          <Button>Crear la primera cuenta</Button>
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h2 className="text-2xl font-semibold text-slate-900">Inicia sesión</h2>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Correo">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Contraseña">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" loading={loading} className="w-full">
          Entrar
        </Button>
      </form>
      {instance.data?.allowSignup && (
        <p className="mt-6 text-center text-sm text-slate-500">
          ¿No tienes cuenta?{' '}
          <Link to="/registro" className="font-medium text-brand-700 hover:underline">
            Regístrate gratis
          </Link>
        </p>
      )}
    </AuthShell>
  );
}

const COUNTRIES = [
  { code: '52', tz: 'America/Mexico_City', label: 'México (+52)' },
  { code: '57', tz: 'America/Bogota', label: 'Colombia (+57)' },
  { code: '51', tz: 'America/Lima', label: 'Perú (+51)' },
  { code: '56', tz: 'America/Santiago', label: 'Chile (+56)' },
  { code: '54', tz: 'America/Argentina/Buenos_Aires', label: 'Argentina (+54)' },
  { code: '593', tz: 'America/Guayaquil', label: 'Ecuador (+593)' },
  { code: '502', tz: 'America/Guatemala', label: 'Guatemala (+502)' },
  { code: '506', tz: 'America/Costa_Rica', label: 'Costa Rica (+506)' },
  { code: '507', tz: 'America/Panama', label: 'Panamá (+507)' },
  { code: '1', tz: 'America/New_York', label: 'Estados Unidos (+1)' },
  { code: '34', tz: 'Europe/Madrid', label: 'España (+34)' },
];

export function RegisterPage() {
  const { setSession, user } = useSession();
  const [registered, setRegistered] = useState(false);
  const instance = useQuery({ queryKey: ['instance'], queryFn: () => api.get<Instance>('/api/instance') });
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '', country: '52' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const c = COUNTRIES.find((x) => x.code === form.country)!;
    try {
      const r = await api.post<{ user: User; workspaces: WorkspaceSummary[] }>('/api/auth/register', {
        name: form.name,
        email: form.email,
        password: form.password,
        workspaceName: form.workspaceName,
        countryCode: c.code,
        timezone: c.tz,
      });
      setRegistered(true);
      setSession(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // New accounts go straight to connecting a WhatsApp number.
  if (user) return <Navigate to={registered ? '/ajustes/canales' : '/bandeja'} replace />;

  if (instance.data && !instance.data.allowSignup) {
    return (
      <AuthShell>
        <Alert tone="warning" title="Registro cerrado">
          El administrador de esta instancia debe invitarte. <Link to="/login" className="underline">Volver</Link>
        </Alert>
      </AuthShell>
    );
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <AuthShell>
      <h2 className="text-2xl font-semibold text-slate-900">Crea tu cuenta</h2>
      <p className="mt-1 text-sm text-slate-500">Gratis. Conectas tu número y solo pagas a Meta lo que envíes.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Tu nombre">
          <Input value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        <Field label="Correo">
          <Input type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
        </Field>
        <Field label="Contraseña" hint="Mínimo 8 caracteres">
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} minLength={8} required />
        </Field>
        <Field label="Nombre de tu negocio">
          <Input value={form.workspaceName} onChange={set('workspaceName')} required />
        </Field>
        <Field label="País principal de tus clientes" hint="Se usa para completar la lada de números de 10 dígitos y la zona horaria.">
          <Select value={form.country} onChange={set('country')}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" loading={loading} className="w-full">
          Crear cuenta
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        ¿Ya tienes cuenta?{' '}
        <Link to="/login" className="font-medium text-brand-700 hover:underline">
          Inicia sesión
        </Link>
      </p>
    </AuthShell>
  );
}
