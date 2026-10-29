import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FlaskConical, MessageCircle, PlugZap, Plus, Send, Star, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useChannels, useWorkspace } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { BillingMode, Channel } from '../../lib/types';
import { Alert, Badge, Button, Card, CopyField, EmptyState, Field, Input, Modal, PageLoader, useConfirm, useToast } from '../ui';

const STEPS = [
  {
    title: 'Crea una app de Meta con WhatsApp',
    body: (
      <>
        Entra a <b>developers.facebook.com</b> → <i>Mis apps</i> → <i>Crear app</i> → tipo <b>Empresa (Business)</b>. Agrega el producto{' '}
        <b>WhatsApp</b> y vincúlalo a tu portafolio comercial (Business Manager).
      </>
    ),
  },
  {
    title: 'Registra tu número',
    body: (
      <>
        En <i>WhatsApp → Configuración de la API</i> agrega tu número (no debe estar en la app de WhatsApp, o usa <b>Coexistencia</b> si tu
        proveedor la ofrece). Copia el <b>Identificador del número de teléfono</b> (Phone Number ID) y el{' '}
        <b>Identificador de la cuenta de WhatsApp Business</b> (WABA ID).
      </>
    ),
  },
  {
    title: 'Genera un token permanente',
    body: (
      <>
        En <b>business.facebook.com</b> → <i>Configuración del negocio → Usuarios del sistema</i> crea un usuario <b>Administrador</b>,
        asígnale tu app y tu cuenta de WhatsApp y genera un token con los permisos <code>whatsapp_business_messaging</code> y{' '}
        <code>whatsapp_business_management</code> (caducidad: <b>nunca</b>).
      </>
    ),
  },
  {
    title: 'Copia la clave secreta de la app',
    body: (
      <>
        En tu app: <i>Configuración de la app → Básica → Clave secreta de la app</i>. LeadLibre la usa para verificar que los mensajes
        realmente vienen de Meta.
      </>
    ),
  },
  {
    title: 'Agrega tu método de pago en Meta',
    body: (
      <>
        En <i>WhatsApp Manager → Configuración de pagos</i> agrega tu tarjeta. <b>Ahí pagas tus créditos directamente a Meta</b>: solo las
        plantillas (y conversaciones de servicio fuera del nivel gratuito) que envíes. LeadLibre no cobra mensualidad.
      </>
    ),
  },
];

function ConnectCloudModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Channel, warnings: string[]) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: 'WhatsApp principal', phone_number_id: '', waba_id: '', access_token: '', app_secret: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ channel: Channel; warnings: string[] }>('/api/channels', { provider: 'cloud_api', ...form }),
    onSuccess: (r) => onCreated(r.channel, r.warnings ?? []),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value.trim() }));
  const ready = form.phone_number_id && form.waba_id && form.access_token.length >= 20 && form.app_secret.length >= 16;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Conectar WhatsApp API oficial (WAPI)"
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!ready} icon={<PlugZap className="h-4 w-4" />}>
            Verificar y conectar
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <ol className="space-y-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">{i + 1}</span>
              <div className="text-sm">
                <p className="font-medium text-slate-900">{s.title}</p>
                <p className="mt-0.5 text-slate-600">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="space-y-4">
          <Field label="Nombre interno">
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </Field>
          <Field label="Phone Number ID" hint="Solo dígitos. Ej. 109876543210987">
            <Input value={form.phone_number_id} onChange={set('phone_number_id')} inputMode="numeric" />
          </Field>
          <Field label="WhatsApp Business Account ID (WABA ID)">
            <Input value={form.waba_id} onChange={set('waba_id')} inputMode="numeric" />
          </Field>
          <Field label="Token de acceso permanente" hint="Se guarda cifrado en tu servidor.">
            <Input type="password" value={form.access_token} onChange={set('access_token')} autoComplete="off" />
          </Field>
          <Field label="Clave secreta de la app (App Secret)">
            <Input type="password" value={form.app_secret} onChange={set('app_secret')} autoComplete="off" />
          </Field>
          <Alert tone="info">Al conectar, LeadLibre valida el número con Meta, suscribe tu app a la cuenta de WhatsApp y descarga tus plantillas.</Alert>
        </div>
      </div>
    </Modal>
  );
}

function WebhookBox({ channel }: { channel: Channel }) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-800">Configura el webhook en tu app de Meta (WhatsApp → Configuración)</p>
      <CopyField label="URL de devolución de llamada (Callback URL)" value={channel.webhook_url} />
      <CopyField label="Token de verificación (Verify token)" value={channel.verify_token} />
      <p className="text-xs text-slate-500">
        Después de verificar, suscríbete a los campos <code>messages</code> y <code>message_template_status_update</code>. La URL debe ser
        pública con HTTPS (configura PUBLIC_URL en tu servidor).
      </p>
    </div>
  );
}

function SimulateBox({ channel }: { channel: Channel }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ from: '5215512345678', name: 'Cliente de prueba', text: 'Hola, quiero información de sus productos' });
  const sim = useMutation({
    mutationFn: () => api.post(`/api/channels/${channel.id}/simulate`, form),
    onSuccess: () => {
      toast.success('Mensaje simulado: revisa tu Bandeja');
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/60 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-violet-900">
        <FlaskConical className="h-4 w-4" /> Simular un cliente que escribe
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <Field label="Teléfono (con lada)">
          <Input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </Field>
        <Field label="Nombre en WhatsApp">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
      </div>
      <Field label="Mensaje">
        <Input value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
      </Field>
      <p className="text-xs text-violet-800/80">Los números que terminan en 0000 simulan un destinatario sin WhatsApp (envíos fallidos).</p>
      <Button size="sm" onClick={() => sim.mutate()} loading={sim.isPending} icon={<Send className="h-4 w-4" />}>
        Enviar mensaje simulado
      </Button>
    </div>
  );
}

export interface ChannelEditForm {
  name: string;
  waba_id: string;
  access_token: string;
  app_secret: string;
}

/**
 * Only what the user changed: the server treats any waba_id as a credential change (Meta
 * verification, and refused to tenants in prepaid workspaces), so an unchanged one is not resent.
 */
export function channelPatch(channel: Channel, form: ChannelEditForm): Record<string, string> {
  const out: Record<string, string> = {};
  const name = form.name.trim();
  if (name && name !== channel.name) out.name = name;
  if (channel.provider === 'cloud_api') {
    const waba = form.waba_id.trim();
    if (waba && waba !== (channel.waba_id ?? '')) out.waba_id = waba;
    if (form.access_token.trim()) out.access_token = form.access_token.trim();
    if (form.app_secret.trim()) out.app_secret = form.app_secret.trim();
  }
  return out;
}

/** In prepaid workspaces only the instance operator connects and edits official numbers (the server enforces it). */
export function canManageCloudChannels(billingMode: BillingMode | undefined, isSuperadmin: boolean): boolean {
  return isSuperadmin || billingMode !== 'prepaid';
}

/**
 * A cloud number whose credentials the business may know cannot work in a prepaid workspace (the
 * switch to prepaid disabled it): the operator must re-key it with their own Meta app.
 */
export function needsOperatorVerification(channel: Channel, billingMode: BillingMode | undefined): boolean {
  return channel.provider === 'cloud_api' && billingMode === 'prepaid' && !channel.operator_verified;
}

/**
 * Why an edit would leave such a number unverified, or null. The server verifies it only with both
 * a token and a new App Secret: a secret alone is refused, a token alone is saved but the number
 * stays disabled, so neither is sent.
 */
export function verificationGap(channel: Channel, billingMode: BillingMode | undefined, form: ChannelEditForm): string | null {
  if (!needsOperatorVerification(channel, billingMode)) return null;
  const token = !!form.access_token.trim();
  const secret = !!form.app_secret.trim();
  if (token === secret) return null;
  return token
    ? 'Captura también una clave secreta (App Secret) nueva de tu propia app de Meta: sin ella el número sigue desactivado.'
    : 'Captura también el token de acceso de tu propia app de Meta: sin él no se puede verificar el número.';
}

/** What the operator must do to bring back a number disabled by the switch to prepaid. */
export function PrepaidVerificationNote() {
  return (
    <Alert tone="warning" title="Verificación del operador pendiente">
      Para reactivar este número en modo prepagado, abre <b>Editar</b> y captura los dos datos de <b>tu propia app de Meta</b>: el token de acceso
      y una clave secreta (App Secret) <b>nueva</b>. La App Secret que el negocio ya conoce no sirve. Después configura el webhook de esa app.
    </Alert>
  );
}

export interface ChannelSaveNotice {
  channel: Channel;
  warnings: string[];
  verified: boolean;
}

/**
 * What to show after a PATCH before closing, or null: Meta subscription warnings (like on
 * connect), and for a number the operator just verified, the webhook its new app needs.
 */
export function channelSaveNotice(before: Channel, r: { channel: Channel; warnings?: string[] }): ChannelSaveNotice | null {
  const warnings = r.warnings ?? [];
  const verified = !before.operator_verified && !!r.channel.operator_verified;
  return warnings.length || verified ? { channel: r.channel, warnings, verified } : null;
}

export function ChannelSavedNotice({ notice }: { notice: ChannelSaveNotice }) {
  return (
    <div className="space-y-4">
      {notice.verified && (
        <Alert tone="success">
          {notice.channel.status === 'active' ? 'Número verificado y activado.' : 'Número verificado.'} Para recibir mensajes, configura el webhook de tu
          app de Meta con estos datos.
        </Alert>
      )}
      {notice.warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}
      {notice.verified && <WebhookBox channel={notice.channel} />}
    </div>
  );
}

function EditChannelModal({
  channel,
  credentialsLocked,
  billingMode,
  onClose,
}: {
  channel: Channel;
  credentialsLocked: boolean;
  billingMode: BillingMode | undefined;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<ChannelEditForm>({ name: channel.name, waba_id: channel.waba_id ?? '', access_token: '', app_secret: '' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ChannelSaveNotice | null>(null);
  const changes = channelPatch(channel, form);
  const gap = credentialsLocked ? null : verificationGap(channel, billingMode, form);
  const reverify = !credentialsLocked && needsOperatorVerification(channel, billingMode);
  const save = useMutation({
    mutationFn: () => api.patch<{ channel: Channel; warnings?: string[] }>(`/api/channels/${channel.id}`, changes),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      const notice = channelSaveNotice(channel, r);
      if (notice) {
        setSaved(notice);
        return;
      }
      toast.success('Canal actualizado');
      onClose();
    },
    // APP_SECRET_NOT_NEW, OPERATOR_VERIFICATION_REQUIRED and Meta errors come in Spanish: show them by the fields.
    onError: (e) => setError(errorMessage(e)),
  });
  if (saved) {
    return (
      <Modal open onClose={onClose} title="Canal actualizado" size="lg" footer={<Button onClick={onClose}>Listo</Button>}>
        <ChannelSavedNotice notice={saved} />
      </Modal>
    );
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Editar canal"
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!Object.keys(changes).length || !!gap}>
          Guardar
        </Button>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Nombre">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        {channel.provider === 'cloud_api' &&
          (credentialsLocked ? (
            <Alert tone="info">El administrador de la instancia gestiona la cuenta de WhatsApp, el token y la clave secreta de este número.</Alert>
          ) : (
            <>
              {reverify && (
                <Alert tone="info" title="Verifica este número con tu propia app de Meta">
                  En modo prepagado el número solo funciona con credenciales que el negocio no conozca: captura el token de acceso y una clave secreta
                  (App Secret) nueva, ambos de tu propia app de Meta. Al guardarlos se verifica y se reactiva.
                </Alert>
              )}
              <Field label="WABA ID">
                <Input value={form.waba_id} onChange={(e) => setForm({ ...form, waba_id: e.target.value })} />
              </Field>
              <Field label="Nuevo token de acceso" hint="Déjalo vacío para conservar el actual.">
                <Input type="password" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />
              </Field>
              <Field label="Nueva clave secreta de la app" hint="Déjalo vacío para conservar la actual." error={gap}>
                <Input type="password" value={form.app_secret} onChange={(e) => setForm({ ...form, app_secret: e.target.value })} />
              </Field>
            </>
          ))}
      </div>
    </Modal>
  );
}

export function ChannelsTab() {
  const { isAdmin, user, workspace } = useSession();
  const channels = useChannels();
  const ws = useWorkspace();
  const billingMode = ws.data?.workspace.billing_mode ?? workspace?.billing_mode;
  const manageCloud = canManageCloudChannels(billingMode, !!user?.is_superadmin);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [connecting, setConnecting] = useState(false);
  const [created, setCreated] = useState<{ channel: Channel; warnings: string[] } | null>(null);
  const [editing, setEditing] = useState<Channel | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['channels'] });

  const sandbox = useMutation({
    mutationFn: () => api.post('/api/channels', { provider: 'sandbox', name: 'Sandbox de pruebas' }),
    onSuccess: () => {
      toast.success('Canal de pruebas creado');
      refresh();
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  async function test(c: Channel) {
    try {
      const r = await api.post<{ ok: boolean; error?: string; info?: { display_phone_number?: string; verified_name?: string; quality_rating?: string } }>(
        `/api/channels/${c.id}/test`,
      );
      if (r.ok) toast.success(`Conexión correcta: ${r.info?.verified_name ?? ''} ${r.info?.display_phone_number ?? ''} (calidad ${r.info?.quality_rating ?? '—'})`);
      else toast.error(r.error ?? 'No se pudo conectar');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function subscribe(c: Channel) {
    try {
      await api.post(`/api/channels/${c.id}/subscribe`);
      toast.success('App suscrita a la cuenta de WhatsApp');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(c: Channel) {
    if (!(await confirm(`Se desconectará "${c.name}". Las conversaciones se conservan.`, { danger: true, confirmText: 'Eliminar canal' }))) return;
    try {
      await api.delete(`/api/channels/${c.id}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function makeDefault(c: Channel) {
    await api.patch(`/api/channels/${c.id}`, { is_default: true }).catch((e) => toast.error(errorMessage(e)));
    refresh();
  }

  if (channels.isLoading) return <PageLoader />;
  const list = channels.data ?? [];

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div className="grid gap-4 md:grid-cols-2">
          {manageCloud ? (
            <button onClick={() => setConnecting(true)} className="rounded-xl border-2 border-dashed border-brand-300 bg-brand-50/50 p-5 text-left transition hover:border-brand-500 hover:bg-brand-50">
              <MessageCircle className="h-6 w-6 text-brand-600" />
              <p className="mt-2 font-semibold text-slate-900">Conectar WhatsApp API oficial</p>
              <p className="mt-1 text-sm text-slate-600">Tu propio número con la Cloud API de Meta. Sin mensualidad: pagas a Meta solo lo que envías.</p>
            </button>
          ) : (
            <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-5 text-left">
              <MessageCircle className="h-6 w-6 text-brand-600" />
              <p className="mt-2 font-semibold text-slate-900">Números oficiales de WhatsApp</p>
              <p className="mt-1 text-sm text-slate-600">
                Este espacio usa créditos prepagados: el administrador de la instancia conecta y edita los números oficiales. Pídele que conecte el
                tuyo; aparecerá aquí en cuanto lo haga.
              </p>
            </div>
          )}
          <button
            onClick={() => sandbox.mutate()}
            disabled={sandbox.isPending}
            className="rounded-xl border-2 border-dashed border-violet-300 bg-violet-50/50 p-5 text-left transition hover:border-violet-500 hover:bg-violet-50"
          >
            <FlaskConical className="h-6 w-6 text-violet-600" />
            <p className="mt-2 font-semibold text-slate-900">Crear canal de pruebas (sandbox)</p>
            <p className="mt-1 text-sm text-slate-600">Prueba bandeja, embudos, bot, IA y difusiones sin cuenta de Meta, simulando clientes.</p>
          </button>
        </div>
      )}

      {!list.length && <EmptyState icon={<Plus className="h-6 w-6" />} title="Aún no hay números conectados" description="Conecta tu número de WhatsApp o crea un canal de pruebas para empezar." />}

      {list.map((c) => (
        <Card
          key={c.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {c.name}
              {c.provider === 'sandbox' ? <Badge color="purple">Sandbox</Badge> : <Badge color="green">API oficial</Badge>}
              {c.is_default && (
                <Badge color="blue">
                  <Star className="h-3 w-3" /> Predeterminado
                </Badge>
              )}
              {c.status === 'disabled' && <Badge color="gray">Deshabilitado</Badge>}
            </span>
          }
          description={
            <>
              {c.display_phone ?? 'Número sin verificar'} · Phone Number ID {c.provider === 'sandbox' ? '(simulado)' : c.phone_number_id}
              {c.waba_id ? ` · WABA ${c.waba_id}` : ''}
            </>
          }
          actions={
            isAdmin && (
              <>
                {c.provider === 'cloud_api' && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => test(c)} icon={<CheckCircle2 className="h-4 w-4" />}>
                      Probar conexión
                    </Button>
                    {manageCloud && (
                      <Button size="sm" variant="outline" onClick={() => subscribe(c)}>
                        Re-suscribir webhook
                      </Button>
                    )}
                  </>
                )}
                {!c.is_default && (
                  <Button size="sm" variant="ghost" onClick={() => makeDefault(c)}>
                    Hacer predeterminado
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                  Editar
                </Button>
                {(c.provider !== 'cloud_api' || manageCloud) && (
                  <Button size="sm" variant="ghost" onClick={() => remove(c)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
                )}
              </>
            )
          }
        >
          <div className="space-y-4">
            {c.last_error && <Alert tone="error" title="Último error">{c.last_error}</Alert>}
            {isAdmin && manageCloud && c.status === 'disabled' && needsOperatorVerification(c, billingMode) && <PrepaidVerificationNote />}
            {/* The simulator writes as if a customer did: owners and admins only (the server refuses agents). */}
            {c.provider === 'cloud_api' ? <WebhookBox channel={c} /> : isAdmin && <SimulateBox channel={c} />}
          </div>
        </Card>
      ))}

      <ConnectCloudModal
        open={connecting}
        onClose={() => setConnecting(false)}
        onCreated={(channel, warnings) => {
          setConnecting(false);
          setCreated({ channel, warnings });
          refresh();
          void qc.invalidateQueries({ queryKey: ['templates'] });
        }}
      />
      <Modal open={!!created} onClose={() => setCreated(null)} title="¡Número conectado! Último paso: el webhook" size="lg" footer={<Button onClick={() => setCreated(null)}>Listo</Button>}>
        {created && (
          <div className="space-y-4">
            <Alert tone="success">
              {created.channel.display_phone} quedó conectado. Para recibir mensajes, pega estos datos en tu app de Meta → WhatsApp → Configuración → Webhook.
            </Alert>
            {created.warnings.map((w) => (
              <Alert key={w} tone="warning">
                {w}
              </Alert>
            ))}
            <WebhookBox channel={created.channel} />
          </div>
        )}
      </Modal>
      {editing && <EditChannelModal channel={editing} credentialsLocked={!manageCloud} billingMode={billingMode} onClose={() => setEditing(null)} />}
    </div>
  );
}
