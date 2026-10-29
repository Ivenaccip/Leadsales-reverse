import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useChannels, useTemplates } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { CATEGORY_LABEL, dateTime } from '../lib/format';
import type { Template } from '../lib/types';
import {
  TEMPLATE_STATUS_LABEL,
  TemplatePreview,
  categoryColor,
  emptyTemplateValue,
  statusColor,
} from '../components/TemplateForm';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Page,
  PageHeader,
  PageLoader,
  Select,
  Toggle,
  useConfirm,
  useToast,
} from '../components/ui';

const LANGUAGES = [
  { code: 'es_MX', label: 'Español (México)' },
  { code: 'es', label: 'Español' },
  { code: 'es_ES', label: 'Español (España)' },
  { code: 'es_AR', label: 'Español (Argentina)' },
  { code: 'es_CO', label: 'Español (Colombia)' },
  { code: 'en_US', label: 'Inglés (EE. UU.)' },
  { code: 'pt_BR', label: 'Portugués (Brasil)' },
];

const CATEGORIES = [
  { id: 'MARKETING', label: 'Marketing', hint: 'Promociones, ofertas, reactivación. Es la categoría más cara.' },
  { id: 'UTILITY', label: 'Utilidad', hint: 'Confirmaciones, recordatorios y seguimiento de pedidos o citas. Mucho más barata.' },
  { id: 'AUTHENTICATION', label: 'Autenticación', hint: 'Códigos de verificación de un solo uso.' },
] as const;

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}/g;
function variablesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function normalizeName(v: string) {
  return v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export interface AuthOptions {
  security_recommendation: boolean;
  code_expiration_minutes: string;
  otp_button_text: string;
}

export const AUTH_DEFAULTS: AuthOptions = { security_recommendation: true, code_expiration_minutes: '', otp_button_text: '' };

/**
 * Request fields of an authentication template, or null while they are invalid. Meta writes the
 * text of these templates itself, so header, body, footer and buttons are never sent.
 */
export function authTemplateFields(o: AuthOptions): { security_recommendation: boolean; code_expiration_minutes?: number; otp_button_text?: string } | null {
  const minutes = o.code_expiration_minutes.trim();
  const n = Number(minutes);
  if (minutes && (!/^\d+$/.test(minutes) || n < 1 || n > 90)) return null;
  const label = o.otp_button_text.trim();
  if (label.length > 25) return null;
  return {
    security_recommendation: o.security_recommendation,
    ...(minutes ? { code_expiration_minutes: n } : {}),
    ...(label ? { otp_button_text: label } : {}),
  };
}

/** Preview of an authentication template: the same text the server shows once Meta approves it. */
export function authPreviewComponents(o: AuthOptions): any[] {
  const f = authTemplateFields(o);
  const components: any[] = [
    { type: 'BODY', text: `*123456* es tu código de verificación.${o.security_recommendation ? ' Por tu seguridad, no lo compartas.' : ''}` },
  ];
  if (f?.code_expiration_minutes) components.push({ type: 'FOOTER', text: `Este código caduca en ${f.code_expiration_minutes} minutos.` });
  components.push({ type: 'BUTTONS', buttons: [{ type: 'OTP', text: f?.otp_button_text ?? 'Copiar código' }] });
  return components;
}

export default function TemplatesPage() {
  const { isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const channels = useChannels().data ?? [];
  const [channelId, setChannelId] = useState('');
  const effective = channelId || (channels.find((c) => c.is_default) ?? channels[0])?.id || '';
  const templatesQ = useTemplates(effective || undefined);
  const [viewing, setViewing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  useRealtime('template:update', () => void qc.invalidateQueries({ queryKey: ['templates'] }));

  const sync = useMutation({
    mutationFn: () => api.post<{ synced: number }>('/api/templates/sync', { channel_id: effective }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      toast.success(`${r.synced} plantillas sincronizadas con Meta`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  async function remove(t: Template) {
    const ok = await confirm(
      <>
        Se eliminará la plantilla <b>{t.name}</b> en Meta (todos sus idiomas). Las difusiones que la usen dejarán de funcionar.
      </>,
      { title: 'Eliminar plantilla', confirmText: 'Eliminar', danger: true },
    );
    if (!ok) return;
    try {
      await api.delete(`/api/templates/${t.id}`);
      void qc.invalidateQueries({ queryKey: ['templates'] });
      setViewing(null);
      toast.success('Plantilla eliminada');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const templates = templatesQ.data ?? [];

  return (
    <Page>
      <PageHeader
        title="Plantillas"
        description="Mensajes aprobados por Meta para iniciar conversaciones o escribir fuera de la ventana de 24 horas."
        actions={
          effective && (
            <>
              {channels.length > 1 && (
                <Select value={effective} onChange={(e) => setChannelId(e.target.value)} className="w-56">
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.display_phone ? `(${c.display_phone})` : ''}
                    </option>
                  ))}
                </Select>
              )}
              {isAdmin && (
                <>
                  <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => sync.mutate()} loading={sync.isPending}>
                    Sincronizar con Meta
                  </Button>
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                    Nueva plantilla
                  </Button>
                </>
              )}
            </>
          )
        }
      />

      <div className="mb-4">
        <Alert tone="info">
          Meta revisa cada plantilla nueva (de minutos a 24 h). Las de <b>marketing</b> cuestan más que las de <b>utilidad</b>; usa utilidad para recordatorios y
          seguimientos reales. En canales sandbox se aprueban al instante.
        </Alert>
      </div>

      {!effective ? (
        <Card>
          <EmptyState icon={<FileText className="h-6 w-6" />} title="Conecta un número de WhatsApp" description="Las plantillas pertenecen a tu cuenta de WhatsApp Business. Conecta un canal en Ajustes → Canales." />
        </Card>
      ) : templatesQ.isLoading ? (
        <PageLoader />
      ) : templates.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText className="h-6 w-6" />}
            title="No hay plantillas en este canal"
            description="Sincroniza las que ya tienes en Meta o crea una nueva."
            action={isAdmin && <Button onClick={() => sync.mutate()}>Sincronizar</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => {
            const body = t.components.find((c: any) => c.type === 'BODY')?.text ?? '';
            return (
              <button key={t.id} onClick={() => setViewing(t)} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-mono text-sm font-semibold text-slate-900">{t.name}</p>
                  <Badge color={statusColor(t.status)}>{TEMPLATE_STATUS_LABEL[t.status] ?? t.status}</Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge color={categoryColor(t.category)}>{CATEGORY_LABEL[t.category] ?? t.category}</Badge>
                  <Badge>{t.language}</Badge>
                </div>
                <p className="mt-3 line-clamp-3 text-sm text-slate-600">{body}</p>
                {t.rejected_reason && <p className="mt-2 text-xs text-red-600">Motivo de rechazo: {t.rejected_reason}</p>}
              </button>
            );
          })}
        </div>
      )}

      {viewing && (
        <Modal
          open
          onClose={() => setViewing(null)}
          title={<span className="font-mono">{viewing.name}</span>}
          footer={
            isAdmin && (
              <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(viewing)}>
                Eliminar
              </Button>
            )
          }
        >
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <Badge color={statusColor(viewing.status)}>{TEMPLATE_STATUS_LABEL[viewing.status] ?? viewing.status}</Badge>
              <Badge color={categoryColor(viewing.category)}>{CATEGORY_LABEL[viewing.category] ?? viewing.category}</Badge>
              <Badge>{viewing.language}</Badge>
              {viewing.parameter_format === 'NAMED' && <Badge color="blue">Variables con nombre</Badge>}
            </div>
            {viewing.rejected_reason && <Alert tone="error" title="Rechazada por Meta">{viewing.rejected_reason}</Alert>}
            <TemplatePreview template={viewing} value={emptyTemplateValue(viewing)} />
            <p className="text-xs text-slate-500">Actualizada {dateTime(viewing.updated_at)}</p>
          </div>
        </Modal>
      )}

      {creating && effective && <CreateTemplateModal channelId={effective} onClose={() => setCreating(false)} />}
    </Page>
  );
}

type ButtonDraft = { type: 'QUICK_REPLY'; text: string } | { type: 'URL'; text: string; url: string; example: string } | { type: 'PHONE_NUMBER'; text: string; phone_number: string };

function CreateTemplateModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('es_MX');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['id']>('UTILITY');
  const [header, setHeader] = useState('');
  const [headerExample, setHeaderExample] = useState('');
  const [body, setBody] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<ButtonDraft[]>([]);
  const [auth, setAuth] = useState<AuthOptions>(AUTH_DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const isAuth = category === 'AUTHENTICATION';
  const authFields = authTemplateFields(auth);

  const bodyVars = variablesIn(body);
  const headerVars = variablesIn(header);

  function insertVariable() {
    const next = `{{${bodyVars.filter((v) => /^\d+$/.test(v)).length + 1}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const value = body.slice(0, start) + next + body.slice(end);
    setBody(value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + next.length, start + next.length);
    });
  }

  const preview = useMemo<Template>(() => {
    const components: any[] = [];
    if (isAuth) components.push(...authPreviewComponents(auth));
    else {
      if (header.trim()) components.push({ type: 'HEADER', format: 'TEXT', text: header });
      components.push({ type: 'BODY', text: body || 'Escribe el cuerpo del mensaje…' });
      if (footer.trim()) components.push({ type: 'FOOTER', text: footer });
      if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map((b) => ({ type: b.type, text: b.text || 'Botón' })) });
    }
    return {
      id: 'preview',
      channel_id: channelId,
      meta_id: null,
      name,
      language,
      category: category.toLowerCase(),
      status: 'PENDING',
      components,
      parameter_format: null,
      rejected_reason: null,
      updated_at: new Date().toISOString(),
      inputs: isAuth ? { header: null, body: [], buttons: [] } : { header: header.trim() ? { type: 'text', variables: headerVars } : null, body: bodyVars, buttons: [] },
    };
  }, [header, body, footer, buttons, channelId, name, language, category, headerVars, bodyVars, isAuth, auth]);

  const create = useMutation({
    mutationFn: () =>
      isAuth
        ? api.post('/api/templates', { channel_id: channelId, name, language, category, ...authFields })
        : api.post('/api/templates', {
            channel_id: channelId,
            name,
            language,
            category,
            header: header.trim() ? { text: header.trim(), example: headerVars.length ? headerExample : undefined } : undefined,
            body: { text: body.trim(), examples: bodyVars.length ? bodyVars.map((_, i) => examples[i] ?? '') : undefined },
            footer: footer.trim() || undefined,
            buttons: buttons.length
              ? buttons.map((b) =>
                  b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url, example: variablesIn(b.url).length && b.example ? b.example : undefined } : b,
                )
              : undefined,
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Plantilla enviada a revisión');
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const missingExamples = bodyVars.some((_, i) => !examples[i]?.trim()) || (headerVars.length > 0 && !headerExample.trim());
  const valid = isAuth
    ? name.length > 0 && !!authFields
    : name.length > 0 && body.trim().length > 0 && !missingExamples && buttons.every((b) => b.text.trim() && (b.type !== 'URL' || b.url.startsWith('http')) && (b.type !== 'PHONE_NUMBER' || /^\+?\d{8,15}$/.test(b.phone_number)));

  function updateButton(i: number, patch: Partial<ButtonDraft>) {
    setButtons((all) => all.map((b, j) => (j === i ? ({ ...b, ...patch } as ButtonDraft) : b)));
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Nueva plantilla"
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!valid}>
            Enviar a revisión
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre" hint="Minúsculas, números y guion bajo. Ej. recordatorio_cita">
              <Input value={name} onChange={(e) => setName(normalizeName(e.target.value))} placeholder="recordatorio_cita" autoFocus />
            </Field>
            <Field label="Idioma">
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Categoría</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={`rounded-lg border p-3 text-left text-xs transition-colors ${category === c.id ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <span className="block text-sm font-semibold text-slate-900">{c.label}</span>
                  <span className="text-slate-500">{c.hint}</span>
                </button>
              ))}
            </div>
          </div>
          {isAuth ? (
            <div className="space-y-4 rounded-lg border border-slate-200 p-3">
              <Alert tone="info">
                Meta escribe el texto de las plantillas de autenticación («123456 es tu código de verificación») y agrega el botón para copiar el código.
                Solo eliges estas opciones.
              </Alert>
              <Toggle
                checked={auth.security_recommendation}
                onChange={(v) => setAuth({ ...auth, security_recommendation: v })}
                label="Agregar recomendación de seguridad"
                description="Agrega «Por tu seguridad, no lo compartas.»"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="El código caduca en (minutos)"
                  hint="Opcional, de 1 a 90."
                  error={auth.code_expiration_minutes.trim() && !authFields ? 'Escribe un número entero de 1 a 90' : null}
                >
                  <Input
                    value={auth.code_expiration_minutes}
                    inputMode="numeric"
                    placeholder="10"
                    onChange={(e) => setAuth({ ...auth, code_expiration_minutes: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                  />
                </Field>
                <Field label="Texto del botón (opcional)" hint="Si lo dejas vacío, WhatsApp usa su propio texto.">
                  <Input value={auth.otp_button_text} maxLength={25} placeholder="Copiar código" onChange={(e) => setAuth({ ...auth, otp_button_text: e.target.value })} />
                </Field>
              </div>
            </div>
          ) : (
            <>
              <Field label="Encabezado (opcional)" hint="Máximo 60 caracteres. Puede tener una variable {{1}}.">
                <Input value={header} maxLength={60} onChange={(e) => setHeader(e.target.value)} placeholder="Tu cita está confirmada" />
              </Field>
              {headerVars.length > 0 && (
                <Field label={`Ejemplo para {{${headerVars[0]}}} del encabezado`}>
                  <Input value={headerExample} onChange={(e) => setHeaderExample(e.target.value)} />
                </Field>
              )}
              <Field
                label={
                  <span className="flex items-center justify-between">
                    Cuerpo
                    <button type="button" onClick={insertVariable} className="text-xs font-medium text-brand-700 hover:underline">
                      + Agregar variable
                    </button>
                  </span>
                }
                hint={`${body.length}/1024 · Usa *negritas* y _cursivas_. Las variables se escriben {{1}}, {{2}}…`}
              >
                <textarea
                  ref={bodyRef}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  rows={5}
                  maxLength={1024}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Hola {{1}}, te recordamos tu cita el {{2}}. Responde para confirmar."
                />
              </Field>
              {bodyVars.length > 0 && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <p className="text-xs font-medium text-slate-600">Meta pide un ejemplo para cada variable:</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {bodyVars.map((v, i) => (
                      <Field key={v} label={`{{${v}}}`}>
                        <Input
                          value={examples[i] ?? ''}
                          onChange={(e) => {
                            const next = [...examples];
                            next[i] = e.target.value;
                            setExamples(next);
                          }}
                          placeholder={i === 0 ? 'Ana' : 'lunes 10:00'}
                        />
                      </Field>
                    ))}
                  </div>
                </div>
              )}
              <Field label="Pie de página (opcional)" hint="Ej. “Responde BAJA para no recibir más mensajes”">
                <Input value={footer} maxLength={60} onChange={(e) => setFooter(e.target.value)} />
              </Field>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">Botones (opcional)</p>
                  {buttons.length < 3 && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])}>
                        + Respuesta
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: 'https://', example: '' }])}>
                        + Enlace
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setButtons([...buttons, { type: 'PHONE_NUMBER', text: '', phone_number: '' }])}>
                        + Llamar
                      </Button>
                    </div>
                  )}
                </div>
                {buttons.map((b, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2">
                    <Badge>{b.type === 'QUICK_REPLY' ? 'Respuesta rápida' : b.type === 'URL' ? 'Enlace' : 'Llamada'}</Badge>
                    <Input className="w-40" maxLength={25} value={b.text} onChange={(e) => updateButton(i, { text: e.target.value })} placeholder="Texto del botón" />
                    {b.type === 'URL' && (
                      <>
                        <Input className="min-w-48 flex-1" value={b.url} onChange={(e) => updateButton(i, { url: e.target.value })} placeholder="https://tienda.mx/pedido/{{1}}" />
                        {variablesIn(b.url).length > 0 && (
                          <Input className="min-w-48 flex-1" value={b.example} onChange={(e) => updateButton(i, { example: e.target.value })} placeholder="Ejemplo: https://tienda.mx/pedido/123" />
                        )}
                      </>
                    )}
                    {b.type === 'PHONE_NUMBER' && (
                      <Input className="w-44" value={b.phone_number} onChange={(e) => updateButton(i, { phone_number: e.target.value })} placeholder="+525512345678" />
                    )}
                    <IconButton title="Quitar botón" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>
                      <X className="h-4 w-4" />
                    </IconButton>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <aside className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Vista previa</p>
          <TemplatePreview template={preview} value={{ header: headerExample, body: examples, buttons: {} }} />
          <p className="text-xs text-slate-500">Las variables se muestran con tus ejemplos.</p>
        </aside>
      </div>
    </Modal>
  );
}
