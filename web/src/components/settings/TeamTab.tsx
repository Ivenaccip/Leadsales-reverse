import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useMembers, useWorkspace } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { Member, Role } from '../../lib/types';
import { Alert, Avatar, Button, Card, Field, Input, Modal, PageLoader, Select, Toggle, useConfirm, useToast } from '../ui';

const ROLE_LABEL: Record<Role, string> = { owner: 'Propietario', admin: 'Administrador', agent: 'Agente' };

function AddMemberModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' as 'agent' | 'admin' });
  const add = useMutation({
    mutationFn: () => api.post<{ existing_user: boolean }>('/api/workspace/members', { ...form, password: form.password || undefined }),
    onSuccess: (r) => {
      toast.success(r.existing_user ? 'Usuario existente agregado al equipo' : 'Usuario creado. Compártele su correo y contraseña.');
      void qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Agregar miembro"
      footer={
        <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!form.email || !form.name}>
          Agregar
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Nombre">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Correo">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Contraseña inicial" hint="Mínimo 8 caracteres. Si el correo ya tiene cuenta en esta instancia, se ignora.">
          <Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Rol">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'agent' | 'admin' })}>
            <option value="agent">Agente — atiende conversaciones y mueve leads</option>
            <option value="admin">Administrador — además configura canales, bot, difusiones y equipo</option>
          </Select>
        </Field>
      </div>
    </Modal>
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
              Agregar miembro
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
      {adding && <AddMemberModal onClose={() => setAdding(false)} />}
    </div>
  );
}
