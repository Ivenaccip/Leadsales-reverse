import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Alert, Badge, Button, Card, CopyField, EmptyState, Field, Input, Modal, PageLoader, Toggle, useConfirm, useToast } from '../ui';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events: string[];
  is_active: boolean;
  last_status: number | null;
  last_error: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  'contact.created': 'Nuevo contacto',
  'contact.updated': 'Contacto actualizado',
  'contact.stage_changed': 'Cambio de etapa',
  'contact.assigned': 'Asignación',
  'message.received': 'Mensaje recibido',
  'message.sent': 'Mensaje enviado',
  'message.status': 'Estado de mensaje',
  'broadcast.completed': 'Difusión terminada',
};

function ApiKeys() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: async () => (await api.get<{ api_keys: ApiKey[] }>('/api/api-keys')).api_keys });
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ key: string }>('/api/api-keys', { name }),
    onSuccess: (r) => {
      setNewKey(r.key);
      setName('');
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  async function remove(k: ApiKey) {
    if (!(await confirm(`Las integraciones que usan "${k.name}" dejarán de funcionar.`, { danger: true, confirmText: 'Revocar' }))) return;
    await api.delete(`/api/api-keys/${k.id}`).catch((e) => toast.error(errorMessage(e)));
    void qc.invalidateQueries({ queryKey: ['api-keys'] });
  }

  return (
    <Card title="Llaves de API" description="Para Make, Zapier, n8n, formularios web o Facebook Lead Ads." padded={false}>
      <div className="flex flex-wrap gap-2 border-b border-slate-100 px-5 py-4">
        <Input className="max-w-xs" placeholder="Nombre (ej. Make)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()} icon={<KeyRound className="h-4 w-4" />}>
          Crear llave
        </Button>
      </div>
      {keys.isLoading ? (
        <PageLoader />
      ) : !keys.data?.length ? (
        <EmptyState title="Sin llaves de API" />
      ) : (
        <div className="divide-y divide-slate-100">
          {keys.data.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="font-medium text-slate-900">{k.name}</span>
              <code className="rounded bg-slate-100 px-1.5 text-xs">{k.prefix}…</code>
              <span className="flex-1 text-xs text-slate-500">{k.last_used_at ? `usada ${timeAgo(k.last_used_at)}` : 'sin uso'}</span>
              <Button size="sm" variant="ghost" onClick={() => remove(k)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
            </div>
          ))}
        </div>
      )}
      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="Tu nueva llave de API" footer={<Button onClick={() => setNewKey(null)}>Ya la guardé</Button>}>
        <div className="space-y-3">
          <Alert tone="warning">Cópiala ahora: por seguridad no la volveremos a mostrar.</Alert>
          {newKey && <CopyField value={newKey} />}
        </div>
      </Modal>
    </Card>
  );
}

function Webhooks() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<{ webhooks: WebhookEndpoint[]; events: string[] }>('/api/webhooks') });
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['contact.created', 'message.received']);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });
  const create = useMutation({
    mutationFn: () => api.post('/api/webhooks', { url, events }),
    onSuccess: () => {
      setCreating(false);
      setUrl('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  async function toggle(w: WebhookEndpoint) {
    await api.patch(`/api/webhooks/${w.id}`, { is_active: !w.is_active }).catch((e) => toast.error(errorMessage(e)));
    refresh();
  }
  async function test(w: WebhookEndpoint) {
    await api.post(`/api/webhooks/${w.id}/test`).catch((e) => toast.error(errorMessage(e)));
    toast.info('Evento de prueba en camino…');
    setTimeout(refresh, 2500);
  }
  async function remove(w: WebhookEndpoint) {
    if (!(await confirm('¿Eliminar este webhook?', { danger: true, confirmText: 'Eliminar' }))) return;
    await api.delete(`/api/webhooks/${w.id}`).catch((e) => toast.error(errorMessage(e)));
    refresh();
  }

  return (
    <Card
      title="Webhooks salientes"
      description="LeadLibre avisa a tu sistema cuando pasa algo. Firmados con HMAC-SHA256 en X-LeadLibre-Signature."
      actions={
        <Button size="sm" onClick={() => setCreating(true)} icon={<Plus className="h-4 w-4" />}>
          Nuevo webhook
        </Button>
      }
      padded={false}
    >
      {hooks.isLoading ? (
        <PageLoader />
      ) : !hooks.data?.webhooks.length ? (
        <EmptyState icon={<Webhook className="h-6 w-6" />} title="Sin webhooks" />
      ) : (
        <div className="divide-y divide-slate-100">
          {hooks.data.webhooks.map((w) => (
            <div key={w.id} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <code className="min-w-0 flex-1 truncate text-sm">{w.url}</code>
                {w.last_status != null && <Badge color={w.last_status < 300 ? 'green' : 'red'}>HTTP {w.last_status}</Badge>}
                <Toggle checked={w.is_active} onChange={() => toggle(w)} label="Activo" />
                <Button size="sm" variant="outline" onClick={() => test(w)} icon={<Send className="h-4 w-4" />}>
                  Probar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(w)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
              </div>
              <div className="flex flex-wrap gap-1">
                {(w.events.length ? w.events : ['*']).map((e) => (
                  <Badge key={e}>{e === '*' ? 'Todos los eventos' : EVENT_LABEL[e] ?? e}</Badge>
                ))}
              </div>
              {w.last_error && <p className="text-xs text-red-600">Último error: {w.last_error}</p>}
              <CopyField label="Secreto de firma" value={w.secret} />
            </div>
          ))}
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Nuevo webhook"
        footer={
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!url.startsWith('http')}>
            Crear
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="URL de destino">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hook.make.com/…" />
          </Field>
          <Field label="Eventos">
            <div className="grid gap-2 sm:grid-cols-2">
              {(hooks.data?.events ?? Object.keys(EVENT_LABEL)).map((e) => (
                <label key={e} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={events.includes(e)} onChange={() => setEvents((all) => (all.includes(e) ? all.filter((x) => x !== e) : [...all, e]))} />
                  {EVENT_LABEL[e] ?? e}
                </label>
              ))}
            </div>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

function ApiDocs() {
  const base = window.location.origin;
  const snippet = `# Crear o actualizar un lead (por teléfono)
curl -X POST ${base}/api/v1/contacts \\
  -H "Authorization: Bearer ll_live_TU_LLAVE" \\
  -H "Content-Type: application/json" \\
  -d '{"phone":"+52 55 1234 5678","name":"Ana","email":"ana@correo.com",
       "tags":["Facebook Ads"],"stage":"Nuevo","source":"facebook_lead_ads",
       "custom_fields":{"campaña":"Octubre"}}'

# Enviar una plantilla aprobada
curl -X POST ${base}/api/v1/messages \\
  -H "Authorization: Bearer ll_live_TU_LLAVE" \\
  -H "Content-Type: application/json" \\
  -d '{"phone":"5512345678","template":{"name":"seguimiento","language":"es_MX","body":["{primer_nombre}"]}}'

# Enviar texto (solo dentro de la ventana de 24 h)
curl -X POST ${base}/api/v1/messages -H "Authorization: Bearer ll_live_TU_LLAVE" \\
  -H "Content-Type: application/json" -d '{"phone":"5512345678","text":"¡Gracias por tu compra!"}'

# Consultar embudos y etapas / buscar contacto
curl ${base}/api/v1/funnels -H "Authorization: Bearer ll_live_TU_LLAVE"
curl "${base}/api/v1/contacts?phone=525512345678" -H "Authorization: Bearer ll_live_TU_LLAVE"`;
  return (
    <Card title="API pública (v1)" description="Ejemplos listos para copiar.">
      <pre className="scroll-thin overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">{snippet}</pre>
      <p className="mt-3 text-xs text-slate-500">
        Verifica webhooks calculando <code>HMAC_SHA256(secreto, cuerpo)</code> y comparándolo con <code>X-LeadLibre-Signature: sha256=…</code>.
        Placeholders como <code>{'{primer_nombre}'}</code> se reemplazan con los datos del contacto.
      </p>
    </Card>
  );
}

export function IntegrationsTab() {
  return (
    <div className="space-y-6">
      <ApiKeys />
      <Webhooks />
      <ApiDocs />
    </div>
  );
}
