import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, Coins, KeyRound, LogIn, MessageCircle, Trash2, Users } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { CATEGORY_LABEL, credits, dateTime, MARKET_LABEL, number } from '../lib/format';
import { useSession } from '../lib/session';
import { Alert, Badge, Button, Card, Field, Input, Modal, Page, PageHeader, PageLoader, Select, Stat, Tabs, Toggle, useConfirm, useToast } from '../components/ui';

interface AdminWorkspace {
  id: string;
  name: string;
  billing_mode: 'meta_direct' | 'prepaid';
  credit_balance: number;
  is_active: boolean;
  created_at: string;
  members: number;
  contacts: number;
  channels: number;
  spend_this_month: number;
  owner_email: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
  created_at: string;
  workspaces: number;
  /** Names of its workspaces, comma-separated (null when it has none). */
  workspace_names: string | null;
}

/**
 * Account recovery the operator can offer (emails are not verified, so an account may have been
 * created by whoever held an invitation link). Same limits as the server: never on the operator's
 * own account or another operator's, and only accounts outside every workspace can be deleted.
 */
export function userRecoveryActions(u: Pick<AdminUser, 'id' | 'is_superadmin' | 'workspaces'>, meId: string): { password: boolean; remove: boolean } {
  const other = u.id !== meId && !u.is_superadmin;
  return { password: other, remove: other && u.workspaces === 0 };
}

const PASSWORD_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random temporary password (no look-alike characters, so it can be dictated). */
export function temporaryPassword(length = 12): string {
  // 32-bit values keep the modulo bias negligible.
  const values = crypto.getRandomValues(new Uint32Array(length));
  return [...values].map((v) => PASSWORD_CHARS[v % PASSWORD_CHARS.length]).join('');
}

export function AdminUserRow({
  u,
  meId,
  onToggleSuper,
  onPassword,
  onDelete,
}: {
  u: AdminUser;
  meId: string;
  onToggleSuper: () => void;
  onPassword: () => void;
  onDelete: () => void;
}) {
  const can = userRecoveryActions(u, meId);
  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-900">{u.name}</p>
        <p className="text-xs text-slate-500">
          {u.email} · desde {dateTime(u.created_at).split(',')[0]}
        </p>
        <p className="text-xs text-slate-500">{u.workspaces > 0 ? `Espacios (${u.workspaces}): ${u.workspace_names ?? ''}` : 'Sin espacios de trabajo'}</p>
      </div>
      <Toggle checked={u.is_superadmin} onChange={onToggleSuper} label="Administrador de la instancia" disabled={u.id === meId} />
      {(can.password || can.remove) && (
        <div className="flex gap-2">
          {can.password && (
            <Button size="sm" variant="outline" icon={<KeyRound className="h-4 w-4" />} onClick={onPassword}>
              Poner contraseña temporal
            </Button>
          )}
          {can.remove && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete} className="text-red-600 hover:bg-red-50">
              Borrar cuenta
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Operator rights and other accounts' passwords are step-up actions: the server checks the
// operator's current password (a stolen operator session cannot make them on its own).
export function setOperatorRights(userId: string, isSuperadmin: boolean, currentPassword: string) {
  return api.patch(`/api/admin/users/${userId}`, { is_superadmin: isSuperadmin, currentPassword });
}

export function setTemporaryPassword(userId: string, password: string, currentPassword: string) {
  return api.post(`/api/admin/users/${userId}/password`, { password, currentPassword });
}

/** A refusal of the password check (WRONG_PASSWORD, TOO_MANY_REQUESTS) goes next to the field; other errors are toasts. */
export function currentPasswordProblem(err: unknown): string | null {
  return err instanceof ApiError && (err.code === 'WRONG_PASSWORD' || err.code === 'TOO_MANY_REQUESTS') ? errorMessage(err) : null;
}

export function CurrentPasswordField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error: string | null }) {
  return (
    <Field label="Tu contraseña actual" hint="La de tu cuenta: confirma que eres tú quien hace este cambio." error={error}>
      <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="current-password" />
    </Field>
  );
}

/** Promotes or demotes an instance operator, after asking for the current operator's password. */
export function OperatorRoleModal({ u, onClose }: { u: AdminUser; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const promote = !u.is_superadmin;
  const [currentPassword, setCurrentPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => setOperatorRights(u.id, promote, currentPassword),
    onSuccess: () => {
      toast.success(promote ? `${u.email} ahora administra la instancia` : `${u.email} ya no administra la instancia`);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose();
    },
    onError: (e) => {
      const p = currentPasswordProblem(e);
      if (p) setProblem(p);
      else toast.error(errorMessage(e));
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={promote ? 'Hacer administrador de la instancia' : 'Quitar rol de administrador'}
      size="sm"
      footer={
        <Button variant={promote ? 'primary' : 'danger'} onClick={() => save.mutate()} loading={save.isPending} disabled={!currentPassword}>
          {promote ? 'Hacer administrador' : 'Quitar rol'}
        </Button>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p>
          {promote ? (
            <>
              <b>{u.email}</b> podrá entrar a cualquier espacio de trabajo y administrar créditos, tarifas y usuarios de toda la instancia.
            </>
          ) : (
            <>
              <b>{u.email}</b> dejará de administrar la instancia. Conserva el acceso a sus propios espacios de trabajo.
            </>
          )}
        </p>
        <CurrentPasswordField
          value={currentPassword}
          onChange={(v) => {
            setCurrentPassword(v);
            setProblem(null);
          }}
          error={problem}
        />
      </div>
    </Modal>
  );
}

export function TempPasswordModal({ u, onClose }: { u: AdminUser; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState(() => temporaryPassword());
  const [currentPassword, setCurrentPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => setTemporaryPassword(u.id, password, currentPassword),
    onSuccess: () => {
      toast.success(`Contraseña temporal guardada para ${u.email}. Sus sesiones abiertas se cerraron.`);
      onClose();
    },
    onError: (e) => {
      const p = currentPasswordProblem(e);
      if (p) setProblem(p);
      else toast.error(errorMessage(e));
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Poner contraseña temporal"
      size="sm"
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={password.length < 8 || !currentPassword}>
          Guardar contraseña
        </Button>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p>
          Para <b>{u.email}</b>
          {u.workspace_names ? ` (espacios: ${u.workspace_names})` : ''}. Comprueba antes que quien lo pide es el dueño de ese correo.
        </p>
        <Field label="Contraseña temporal" hint="Mínimo 8 caracteres. Compártela por un medio seguro y pide que la cambie al entrar.">
          <div className="flex gap-2">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" autoComplete="off" />
            <Button variant="outline" onClick={() => setPassword(temporaryPassword())}>
              Generar
            </Button>
          </div>
        </Field>
        <Alert tone="info">Se cerrarán todas las sesiones abiertas de esa cuenta.</Alert>
        <CurrentPasswordField
          value={currentPassword}
          onChange={(v) => {
            setCurrentPassword(v);
            setProblem(null);
          }}
          error={problem}
        />
      </div>
    </Modal>
  );
}

/**
 * PATCH of a workspace. The switch to prepaid re-reads the templates of its numbers from Meta
 * (their categories set the price); the ones that failed come back as warnings.
 */
export async function patchWorkspace(id: string, body: Partial<Pick<AdminWorkspace, 'billing_mode' | 'is_active'>>): Promise<string[]> {
  const r = await api.patch<{ warnings?: string[] }>(`/api/admin/workspaces/${id}`, body);
  return r?.warnings ?? [];
}

export function WorkspaceWarnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">El cambio se guardó, pero:</p>
      {warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}
      <p className="text-sm text-slate-600">
        Cuando se resuelva, abre el espacio y sincroniza sus plantillas (Plantillas → Sincronizar con Meta) para que los cobros usen las categorías
        actuales de Meta.
      </p>
    </div>
  );
}

const CATS = ['marketing', 'utility', 'authentication', 'service'];

function TopupModal({ ws, onClose }: { ws: AdminWorkspace; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('10');
  const [description, setDescription] = useState('');
  const save = useMutation({
    mutationFn: () => api.post<{ balance: number }>(`/api/admin/workspaces/${ws.id}/credits`, { amount: Number(amount), description: description || undefined }),
    onSuccess: (r) => {
      toast.success(`Nuevo saldo: ${credits(r.balance)}`);
      void qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Créditos de ${ws.name}`}
      size="sm"
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!Number(amount)}>
          Aplicar
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">Saldo actual: {credits(ws.credit_balance)}</p>
        <Field label="Monto en USD" hint="Usa un número negativo para descontar.">
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Concepto (opcional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Pago por transferencia 28/10" />
        </Field>
        {ws.billing_mode !== 'prepaid' && <Alert tone="warning">Este espacio está en “pago directo a Meta”: el saldo no se usa hasta que lo cambies a prepagado.</Alert>}
      </div>
    </Modal>
  );
}

function RatesEditor() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'rates'], queryFn: () => api.get<{ rates: { market: string; category: string; price: number }[]; markets: string[] }>('/api/admin/rates') });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.rates.map((r) => [`${r.market}|${r.category}`, String(r.price)])));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/api/admin/rates', {
        rates: Object.entries(draft)
          .filter(([, v]) => v !== '' && !Number.isNaN(Number(v)))
          .map(([k, v]) => {
            const [market, category] = k.split('|');
            return { market, category, price: Number(v) };
          }),
      }),
    onSuccess: () => {
      toast.success('Tarifas actualizadas');
      void qc.invalidateQueries({ queryKey: ['rates'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'rates'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!q.data) return <PageLoader />;
  return (
    <Card
      title="Tarifas de Meta (USD por mensaje)"
      description="Se usan para estimar y cobrar créditos. Meta las actualiza cada trimestre: consulta la tabla oficial de precios de WhatsApp Business Platform."
      actions={
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Guardar tarifas
        </Button>
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Mercado</th>
              {CATS.map((c) => (
                <th key={c} className="px-4 py-2">
                  {CATEGORY_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data.markets.map((m) => (
              <tr key={m}>
                <td className="px-4 py-2 text-slate-700">{MARKET_LABEL[m] ?? m}</td>
                {CATS.map((c) => (
                  <td key={c} className="px-4 py-1.5">
                    <Input
                      className="h-8 w-28 font-mono text-xs"
                      type="number"
                      step="0.0001"
                      min={0}
                      value={draft[`${m}|${c}`] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [`${m}|${c}`]: e.target.value })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function AdminPage() {
  const { user, switchWorkspace } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'workspaces' | 'rates' | 'users'>('workspaces');
  const [topup, setTopup] = useState<AdminWorkspace | null>(null);
  const [passwordFor, setPasswordFor] = useState<AdminUser | null>(null);
  const [roleFor, setRoleFor] = useState<AdminUser | null>(null);
  const [wsWarnings, setWsWarnings] = useState<{ name: string; warnings: string[] } | null>(null);
  const confirm = useConfirm();
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () =>
      api.get<{ workspaces: number; users: number; channels: number; messages_this_month: number; spend_this_month: number; failed_jobs_24h: number; delayed_jobs: number }>(
        '/api/admin/overview',
      ),
    enabled: !!user?.is_superadmin,
  });
  const workspaces = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: async () => (await api.get<{ workspaces: AdminWorkspace[] }>('/api/admin/workspaces')).workspaces,
    enabled: !!user?.is_superadmin,
  });
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => (await api.get<{ users: AdminUser[] }>('/api/admin/users')).users,
    enabled: !!user?.is_superadmin && tab === 'users',
  });

  if (!user?.is_superadmin) return <Navigate to="/bandeja" replace />;

  async function patchWs(ws: AdminWorkspace, body: Partial<Pick<AdminWorkspace, 'billing_mode' | 'is_active'>>) {
    try {
      const warnings = await patchWorkspace(ws.id, body);
      void qc.invalidateQueries({ queryKey: ['admin'] });
      if (warnings.length) setWsWarnings({ name: ws.name, warnings });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  // The operator works inside any workspace as owner (e.g. to connect its numbers in prepaid mode).
  function openWorkspace(w: AdminWorkspace) {
    switchWorkspace(w.id, { id: w.id, name: w.name, role: 'owner', billing_mode: w.billing_mode, is_active: w.is_active });
    navigate('/ajustes/canales');
  }

  async function deleteUser(u: AdminUser) {
    const ok = await confirm(`Se borrará la cuenta ${u.email}. No pertenece a ningún espacio de trabajo. Esta acción no se puede deshacer.`, {
      title: 'Borrar cuenta',
      confirmText: 'Borrar cuenta',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/admin/users/${u.id}`);
      toast.success('Cuenta borrada');
    } catch (e) {
      // USER_HAS_WORKSPACES: it joined a workspace since the list loaded.
      toast.error(errorMessage(e));
    }
    void qc.invalidateQueries({ queryKey: ['admin'] });
  }

  const o = overview.data;
  return (
    <Page wide>
      <PageHeader title="Administración de la instancia" description="Panel del operador de la comunidad: espacios de trabajo, créditos y tarifas." />
      {o && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Espacios de trabajo" value={number(o.workspaces)} icon={<Building2 className="h-4 w-4" />} hint={`${number(o.users)} usuarios`} />
          <Stat label="Números conectados" value={number(o.channels)} icon={<MessageCircle className="h-4 w-4" />} />
          <Stat label="Mensajes este mes" value={number(o.messages_this_month)} icon={<Users className="h-4 w-4" />} />
          <Stat label="Gasto en Meta este mes" value={credits(o.spend_this_month)} icon={<Coins className="h-4 w-4" />} />
        </div>
      )}
      {o && (o.failed_jobs_24h > 0 || o.delayed_jobs > 0) && (
        <div className="mb-6">
          <Alert tone="warning" title={<span className="flex items-center gap-1"><AlertTriangle className="h-4 w-4" /> Revisa los trabajos en segundo plano</span>}>
            {o.failed_jobs_24h} trabajos fallidos en 24 h · {o.delayed_jobs} retrasados. Revisa los registros del servidor.
          </Alert>
        </div>
      )}
      <Tabs
        tabs={[
          { id: 'workspaces', label: 'Espacios y créditos' },
          { id: 'rates', label: 'Tarifas de Meta' },
          { id: 'users', label: 'Usuarios' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-6">
        {tab === 'workspaces' &&
          (workspaces.isLoading ? (
            <PageLoader />
          ) : (
            <Card padded={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Negocio</th>
                      <th className="px-4 py-2 text-right">Equipo / Contactos / Números</th>
                      <th className="px-4 py-2">Cobro</th>
                      <th className="px-4 py-2 text-right">Saldo</th>
                      <th className="px-4 py-2 text-right">Gasto del mes</th>
                      <th className="px-4 py-2">Activo</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(workspaces.data ?? []).map((w) => (
                      <tr key={w.id}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">{w.name}</p>
                          <p className="text-xs text-slate-500">
                            {w.owner_email} · desde {dateTime(w.created_at).split(',')[0]}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600">
                          {w.members} / {number(w.contacts)} / {w.channels}
                        </td>
                        <td className="px-4 py-3">
                          <Select className="h-8 w-44" value={w.billing_mode} onChange={(e) => patchWs(w, { billing_mode: e.target.value as AdminWorkspace['billing_mode'] })}>
                            <option value="meta_direct">Pago directo a Meta</option>
                            <option value="prepaid">Créditos prepagados</option>
                          </Select>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {w.billing_mode === 'prepaid' ? credits(w.credit_balance) : <Badge>no aplica</Badge>}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{credits(w.spend_this_month)}</td>
                        <td className="px-4 py-3">
                          <Toggle checked={w.is_active} onChange={(v) => patchWs(w, { is_active: v })} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => openWorkspace(w)} icon={<LogIn className="h-4 w-4" />}>
                              Abrir
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setTopup(w)}>
                              Créditos
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        {tab === 'rates' && <RatesEditor />}
        {tab === 'users' &&
          (users.isLoading ? (
            <PageLoader />
          ) : (
            <Card padded={false}>
              <div className="divide-y divide-slate-100">
                {(users.data ?? []).map((u) => (
                  <AdminUserRow
                    key={u.id}
                    u={u}
                    meId={user.id}
                    onToggleSuper={() => setRoleFor(u)}
                    onPassword={() => setPasswordFor(u)}
                    onDelete={() => void deleteUser(u)}
                  />
                ))}
              </div>
            </Card>
          ))}
      </div>
      {topup && <TopupModal ws={topup} onClose={() => setTopup(null)} />}
      {passwordFor && <TempPasswordModal u={passwordFor} onClose={() => setPasswordFor(null)} />}
      {roleFor && <OperatorRoleModal u={roleFor} onClose={() => setRoleFor(null)} />}
      <Modal
        open={!!wsWarnings}
        onClose={() => setWsWarnings(null)}
        title={`Revisa las plantillas de ${wsWarnings?.name ?? ''}`}
        footer={<Button onClick={() => setWsWarnings(null)}>Entendido</Button>}
      >
        {wsWarnings && <WorkspaceWarnings warnings={wsWarnings.warnings} />}
      </Modal>
    </Page>
  );
}
