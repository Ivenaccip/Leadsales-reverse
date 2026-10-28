import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, Coins, MessageCircle, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { CATEGORY_LABEL, credits, dateTime, MARKET_LABEL, number } from '../lib/format';
import { useSession } from '../lib/session';
import { Alert, Badge, Button, Card, Field, Input, Modal, Page, PageHeader, PageLoader, Select, Stat, Tabs, Toggle, useToast } from '../components/ui';

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

interface AdminUser {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
  created_at: string;
  workspaces: number;
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
  const { user } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'workspaces' | 'rates' | 'users'>('workspaces');
  const [topup, setTopup] = useState<AdminWorkspace | null>(null);
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
      await api.patch(`/api/admin/workspaces/${ws.id}`, body);
      void qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function toggleSuper(u: AdminUser) {
    try {
      await api.patch(`/api/admin/users/${u.id}`, { is_superadmin: !u.is_superadmin });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
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
                          <Button size="sm" variant="outline" onClick={() => setTopup(w)}>
                            Créditos
                          </Button>
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
                  <div key={u.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900">{u.name}</p>
                      <p className="text-xs text-slate-500">
                        {u.email} · {u.workspaces} espacio(s) · desde {dateTime(u.created_at).split(',')[0]}
                      </p>
                    </div>
                    <Toggle checked={u.is_superadmin} onChange={() => toggleSuper(u)} label="Administrador de la instancia" disabled={u.id === user.id} />
                  </div>
                ))}
              </div>
            </Card>
          ))}
      </div>
      {topup && <TopupModal ws={topup} onClose={() => setTopup(null)} />}
    </Page>
  );
}
