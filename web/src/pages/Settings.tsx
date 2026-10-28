import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { useWorkspace } from '../lib/queries';
import { useSession } from '../lib/session';
import type { User } from '../lib/types';
import { ChannelsTab } from '../components/settings/ChannelsTab';
import { IntegrationsTab } from '../components/settings/IntegrationsTab';
import { QuickRepliesTab, TagsTab } from '../components/settings/LibraryTabs';
import { TeamTab } from '../components/settings/TeamTab';
import { Alert, Button, Card, Field, Input, Page, PageHeader, PageLoader, Select, Tabs, useToast } from '../components/ui';

type TabId = 'general' | 'canales' | 'equipo' | 'etiquetas' | 'respuestas-rapidas' | 'integraciones' | 'perfil';

const TIMEZONES = [
  'America/Mexico_City',
  'America/Monterrey',
  'America/Cancun',
  'America/Tijuana',
  'America/Bogota',
  'America/Lima',
  'America/Guayaquil',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Caracas',
  'America/Guatemala',
  'America/Costa_Rica',
  'America/Panama',
  'America/Santo_Domingo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Madrid',
];

function GeneralTab() {
  const ws = useWorkspace();
  const { isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', timezone: '', default_country_code: '' });
  useEffect(() => {
    if (ws.data) {
      const w = ws.data.workspace;
      setForm({ name: w.name, timezone: w.timezone, default_country_code: w.default_country_code });
    }
  }, [ws.data]);
  const save = useMutation({
    mutationFn: () => api.patch('/api/workspace', form),
    onSuccess: () => {
      toast.success('Guardado');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!ws.data) return <PageLoader />;
  const w = ws.data.workspace;
  return (
    <div className="space-y-6">
      <Card title="Espacio de trabajo">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Nombre del negocio">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!isAdmin} />
          </Field>
          <Field label="Zona horaria" hint="Para horarios de atención y reportes.">
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} disabled={!isAdmin}>
              {[...new Set([form.timezone, ...TIMEZONES])].filter(Boolean).map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace('America/', '').replace('Europe/', '').replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lada por defecto" hint="Se agrega a números de 10 dígitos.">
            <Input value={form.default_country_code} onChange={(e) => setForm({ ...form, default_country_code: e.target.value.replace(/\D/g, '') })} disabled={!isAdmin} />
          </Field>
        </div>
        {isAdmin && (
          <div className="mt-4">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Guardar cambios
            </Button>
          </div>
        )}
      </Card>
      <Card title="Modelo de cobro">
        {w.billing_mode === 'prepaid' ? (
          <Alert tone="info" title="Créditos prepagados">
            El administrador de la comunidad te recarga créditos y cada plantilla enviada se descuenta de tu saldo. Consulta tu saldo en Créditos.
          </Alert>
        ) : (
          <Alert tone="success" title="Pago directo a Meta (sin mensualidad)">
            Meta cobra a tu tarjeta solo los mensajes que envías desde tu número. LeadLibre te muestra el gasto estimado y lo concilia con lo que reporta Meta.
          </Alert>
        )}
      </Card>
    </div>
  );
}

function ProfileTab() {
  const { user, setSession, workspaces } = useSession();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [pw, setPw] = useState({ currentPassword: '', password: '' });
  const save = useMutation({
    mutationFn: (body: object) => api.patch<{ user: User }>('/api/auth/me', body),
    onSuccess: (r) => {
      setSession({ user: r.user, workspaces });
      setPw({ currentPassword: '', password: '' });
      toast.success('Perfil actualizado');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card title="Mi perfil">
        <div className="space-y-4">
          <Field label="Nombre">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Correo">
            <Input value={user?.email ?? ''} disabled />
          </Field>
          <Button onClick={() => save.mutate({ name })} loading={save.isPending}>
            Guardar
          </Button>
        </div>
      </Card>
      <Card title="Cambiar contraseña">
        <div className="space-y-4">
          <Field label="Contraseña actual">
            <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} autoComplete="current-password" />
          </Field>
          <Field label="Nueva contraseña" hint="Mínimo 8 caracteres">
            <Input type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <Button onClick={() => save.mutate(pw)} disabled={pw.password.length < 8 || !pw.currentPassword}>
            Cambiar contraseña
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useSession();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'canales', label: 'Canales de WhatsApp' },
    { id: 'equipo', label: 'Equipo' },
    { id: 'etiquetas', label: 'Etiquetas' },
    { id: 'respuestas-rapidas', label: 'Respuestas rápidas' },
    ...(isAdmin ? [{ id: 'integraciones' as TabId, label: 'Integraciones y API' }] : []),
    { id: 'perfil', label: 'Mi perfil' },
  ];
  const current = (tabs.find((t) => t.id === tab)?.id ?? 'general') as TabId;
  return (
    <Page>
      <PageHeader title="Ajustes" description="Conecta tus números, organiza tu equipo y personaliza LeadLibre." />
      <Tabs tabs={tabs} value={current} onChange={(id) => navigate(`/ajustes/${id}`)} />
      <div className="mt-6">
        {current === 'general' && <GeneralTab />}
        {current === 'canales' && <ChannelsTab />}
        {current === 'equipo' && <TeamTab />}
        {current === 'etiquetas' && <TagsTab />}
        {current === 'respuestas-rapidas' && <QuickRepliesTab />}
        {current === 'integraciones' && <IntegrationsTab />}
        {current === 'perfil' && <ProfileTab />}
      </div>
    </Page>
  );
}
