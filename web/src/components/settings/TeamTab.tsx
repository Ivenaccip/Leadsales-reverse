import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { dateTime, timeAgo } from '../../lib/format';
import { useMembers, useWorkspace } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { Member, Role } from '../../lib/types';
import { Alert, Avatar, Badge, Button, Card, CopyField, Field, Input, Modal, PageLoader, Select, Toggle, useConfirm, useToast } from '../ui';

const ROLE_LABEL: Record<Role, string> = { owner: 'Propietario', admin: 'Administrador', agent: 'Agente' };

export interface InviteResult {
  invitation: { id: string; email: string; role: 'admin' | 'agent'; expires_at: string };
  invite_url: string;
}

/** POST /api/workspace/members answers with an invitation link, or (operator with a password) the new account. */
export type AddMemberResponse = InviteResult | { id: string; existing_user: boolean };

export function isInviteResult(r: AddMemberResponse): r is InviteResult {
  return 'invite_url' in r && typeof r.invite_url === 'string';
}

export interface PendingInvitation {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'agent';
  created_at: string;
  expires_at: string;
  invited_by_name: string | null;
}

/** Body for POST /api/workspace/members: only the instance operator may set a password. */
export function memberRequestBody(form: { name: string; email: string; password: string; role: 'agent' | 'admin' }, isSuperadmin: boolean) {
  return {
    email: form.email.trim(),
    role: form.role,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(isSuperadmin && form.password ? { password: form.password } : {}),
  };
}

function InviteLink({ result }: { result: InviteResult }) {
  return (
    <div className="space-y-4">
      <Alert tone="success" title="Invitación creada">
        Comparte este enlace con <b>{result.invitation.email}</b>. Solo sirve para ese correo: al abrirlo entra con su cuenta o la crea. Vence el{' '}
        {dateTime(result.invitation.expires_at)}
      </Alert>
      <CopyField label="Enlace de invitación" value={result.invite_url} />
      <p className="text-xs text-slate-500">Por seguridad no podrás volver a ver este enlace; si se pierde, genera uno nuevo desde las invitaciones pendientes.</p>
    </div>
  );
}

function InviteMemberModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useSession();
  const superadmin = !!user?.is_superadmin;
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' as 'agent' | 'admin' });
  const [result, setResult] = useState<InviteResult | null>(null);
  const add = useMutation({
    mutationFn: () => api.post<AddMemberResponse>('/api/workspace/members', memberRequestBody(form, superadmin)),
    onSuccess: (r) => {
      if (isInviteResult(r)) {
        setResult(r);
        void qc.invalidateQueries({ queryKey: ['invitations'] });
        return;
      }
      toast.success('Cuenta creada. Compártele su correo y contraseña.');
      void qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (result) {
    return (
      <Modal open onClose={onClose} title="Invitar miembro" footer={<Button onClick={onClose}>Listo</Button>}>
        {superadmin && form.password && (
          <div className="mb-4">
            <Alert tone="info">Ese correo ya tiene una cuenta: en lugar de cambiar su contraseña se generó una invitación.</Alert>
          </div>
        )}
        <InviteLink result={result} />
      </Modal>
    );
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Invitar miembro"
      footer={
        <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!form.email.trim()}>
          {superadmin && form.password ? 'Crear cuenta' : 'Crear invitación'}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Correo">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus />
        </Field>
        <Field label="Nombre (opcional)">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Rol">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'agent' | 'admin' })}>
            <option value="agent">Agente — atiende conversaciones y mueve leads</option>
            <option value="admin">Administrador — además configura canales, bot, difusiones y equipo</option>
          </Select>
        </Field>
        {superadmin && (
          <Field
            label="Contraseña inicial (opcional)"
            hint="Solo para el administrador de la instancia: si el correo no tiene cuenta, se crea con esta contraseña. Si lo dejas vacío o la cuenta ya existe, se genera un enlace de invitación."
          >
            <Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </Field>
        )}
        {!superadmin && (
          <p className="text-xs text-slate-500">Se genera un enlace de invitación para ese correo. La persona entra con su cuenta o crea una con su propia contraseña.</p>
        )}
      </div>
    </Modal>
  );
}

function PendingInvitations() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [link, setLink] = useState<InviteResult | null>(null);
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => (await api.get<{ invitations: PendingInvitation[] }>('/api/workspace/invitations')).invitations,
  });

  async function renew(inv: PendingInvitation) {
    try {
      // Creating it again replaces the pending one (and its lost link).
      const r = await api.post<AddMemberResponse>('/api/workspace/members', memberRequestBody({ name: inv.name ?? '', email: inv.email, password: '', role: inv.role }, false));
      if (isInviteResult(r)) setLink(r);
      void qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function revoke(inv: PendingInvitation) {
    if (!(await confirm(`El enlace enviado a ${inv.email} dejará de funcionar.`, { title: 'Cancelar invitación', confirmText: 'Cancelar invitación', danger: true }))) return;
    try {
      await api.delete(`/api/workspace/invitations/${inv.id}`);
      void qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const list = invitations.data ?? [];
  if (!list.length) return null;
  return (
    <Card title="Invitaciones pendientes" description="Enlaces que aún no se han usado." padded={false}>
      <div className="divide-y divide-slate-100">
        {list.map((inv) => (
          <div key={inv.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-slate-900">
                {inv.email} {inv.name && <span className="text-sm font-normal text-slate-500">· {inv.name}</span>}
              </p>
              <p className="truncate text-xs text-slate-500">
                Vence el {dateTime(inv.expires_at)}
                {inv.invited_by_name ? ` · invitó ${inv.invited_by_name}` : ''}
              </p>
            </div>
            <Badge color={inv.role === 'admin' ? 'blue' : 'gray'}>{ROLE_LABEL[inv.role]}</Badge>
            <Button size="sm" variant="outline" icon={<Link2 className="h-4 w-4" />} onClick={() => void renew(inv)}>
              Nuevo enlace
            </Button>
            <Button size="sm" variant="ghost" title="Cancelar invitación" onClick={() => void revoke(inv)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
          </div>
        ))}
      </div>
      <Modal open={!!link} onClose={() => setLink(null)} title="Nuevo enlace de invitación" footer={<Button onClick={() => setLink(null)}>Listo</Button>}>
        {link && <InviteLink result={link} />}
      </Modal>
    </Card>
  );
}

export function TeamTab() {
  const { isAdmin, role, user } = useSession();
  const members = useMembers();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);

  async function patch(m: Member, body: Partial<Pick<Member, 'role' | 'is_active' | 'receives_leads'>>) {
    try {
      await api.patch(`/api/workspace/members/${m.id}`, body);
      void qc.invalidateQueries({ queryKey: ['members'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(m: Member) {
    if (!(await confirm(`${m.name} ya no podrá entrar a este espacio. Sus conversaciones quedarán sin asignar.`, { danger: true, confirmText: 'Quitar' }))) return;
    try {
      await api.delete(`/api/workspace/members/${m.id}`);
      void qc.invalidateQueries({ queryKey: ['members'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function setVisibility(v: 'all' | 'assigned') {
    try {
      await api.put('/api/workspace/settings', { agent_visibility: v });
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      toast.success('Guardado');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (members.isLoading) return <PageLoader />;

  return (
    <div className="space-y-6">
      <Card
        title="Equipo"
        description="Sin límite de usuarios: agrega a todo tu equipo de ventas."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setAdding(true)} icon={<UserPlus className="h-4 w-4" />}>
              Invitar miembro
            </Button>
          )
        }
        padded={false}
      >
        <div className="divide-y divide-slate-100">
          {(members.data ?? []).map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
              <Avatar name={m.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-900">
                  {m.name} {m.id === user?.id && <span className="text-xs text-slate-400">(tú)</span>}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {m.email} · último lead asignado {m.last_assigned_at ? timeAgo(m.last_assigned_at) : 'nunca'}
                </p>
              </div>
              {isAdmin ? (
                <>
                  <Select className="w-40" value={m.role} onChange={(e) => patch(m, { role: e.target.value as Role })} disabled={m.role === 'owner' && role !== 'owner'}>
                    {(['owner', 'admin', 'agent'] as Role[]).map((r) => (
                      <option key={r} value={r} disabled={r === 'owner' && role !== 'owner'}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                  <Toggle checked={m.receives_leads} onChange={(v) => patch(m, { receives_leads: v })} label="Recibe leads" />
                  <Toggle checked={m.is_active} onChange={(v) => patch(m, { is_active: v })} label="Activo" />
                  <Button size="sm" variant="ghost" onClick={() => remove(m)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
                </>
              ) : (
                <span className="text-sm text-slate-500">{ROLE_LABEL[m.role]}</span>
              )}
            </div>
          ))}
        </div>
      </Card>

      {isAdmin && <PendingInvitations />}

      {isAdmin && ws.data && (
        <Card title="Visibilidad de los agentes">
          <div className="space-y-3">
            <Select className="max-w-md" value={ws.data.workspace.settings.agent_visibility} onChange={(e) => setVisibility(e.target.value as 'all' | 'assigned')}>
              <option value="all">Los agentes ven todas las conversaciones</option>
              <option value="assigned">Los agentes solo ven las suyas y las no asignadas</option>
            </Select>
            <Alert tone="info">
              La asignación automática (round-robin) se activa por embudo en <b>Embudos → Configuración</b>. Solo participan los miembros
              activos con “Recibe leads”.
            </Alert>
          </div>
        </Card>
      )}
      {adding && <InviteMemberModal onClose={() => setAdding(false)} />}
    </div>
  );
}
