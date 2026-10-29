import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, ChevronLeft, ChevronRight, Megaphone, Pause, Play, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api';
import { useChannels, useFunnels, useMembers, useTags, useTemplates } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { CATEGORY_LABEL, MARKET_LABEL, credits, dateTime, formatPhone, number } from '../lib/format';
import type { Audience, Broadcast, Estimate, Template } from '../lib/types';
import { useDebounced } from '../components/crm/hooks';
import { MemberSelect, StagePills, TagMultiSelect } from '../components/pickers';
import {
  TemplateForm,
  TemplatePreview,
  emptyTemplateValue,
  fromBroadcastParams,
  isTemplateValueComplete,
  templateUnsupportedReason,
  toBroadcastParams,
  type TemplateFormValue,
} from '../components/TemplateForm';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Page,
  PageHeader,
  PageLoader,
  Select,
  Spinner,
  Stat,
  cx,
  useConfirm,
  useToast,
} from '../components/ui';

const STATUS: Record<Broadcast['status'], { label: string; color: 'gray' | 'blue' | 'yellow' | 'green' | 'red' | 'purple' }> = {
  draft: { label: 'Borrador', color: 'gray' },
  scheduled: { label: 'Programada', color: 'purple' },
  running: { label: 'Enviando', color: 'blue' },
  paused: { label: 'Pausada', color: 'yellow' },
  completed: { label: 'Completada', color: 'green' },
  cancelled: { label: 'Cancelada', color: 'red' },
};

const RECIPIENT_STATUS: Record<string, { label: string; color: 'gray' | 'blue' | 'green' | 'red' | 'yellow' }> = {
  queued: { label: 'En cola', color: 'gray' },
  sent: { label: 'Enviado', color: 'blue' },
  delivered: { label: 'Entregado', color: 'green' },
  read: { label: 'Leído', color: 'green' },
  failed: { label: 'Fallido', color: 'red' },
  skipped: { label: 'Omitido', color: 'yellow' },
  pending: { label: 'Enviando', color: 'gray' },
  sending: { label: 'Enviando', color: 'gray' },
  unknown: { label: 'Sin confirmar', color: 'yellow' },
};

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function processed(b: Broadcast) {
  return b.stats.sent + b.stats.failed + b.stats.skipped;
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${p}%` }} />
    </div>
  );
}

export default function BroadcastsPage() {
  return (
    <Routes>
      <Route index element={<BroadcastList />} />
      <Route path="nueva" element={<BroadcastWizard />} />
      <Route path=":id/editar" element={<BroadcastWizard />} />
      <Route path=":id" element={<BroadcastDetail />} />
    </Routes>
  );
}

// ---------------------------------------------------------------- List

function BroadcastList() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const listQ = useQuery({
    queryKey: ['broadcasts'],
    queryFn: async () => (await api.get<{ broadcasts: Broadcast[] }>('/api/broadcasts')).broadcasts,
    refetchInterval: (q) => ((q.state.data ?? []).some((b) => b.status === 'running') ? 4000 : false),
  });
  useRealtime('broadcast:update', () => void qc.invalidateQueries({ queryKey: ['broadcasts'] }));
  const list = listQ.data ?? [];

  return (
    <Page>
      <PageHeader
        title="Difusiones"
        description="Envía plantillas aprobadas a segmentos de tus contactos. Cada mensaje entregado consume créditos de Meta según su categoría y país."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/difusiones/nueva')}>
            Nueva difusión
          </Button>
        }
      />
      {listQ.isLoading ? (
        <PageLoader />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Megaphone className="h-6 w-6" />}
            title="Aún no has enviado difusiones"
            description="Elige una plantilla, filtra a tu audiencia por etapa o etiqueta y envía en segundos. Verás el costo estimado antes de enviar."
            action={<Button onClick={() => navigate('/difusiones/nueva')}>Crear la primera</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((b) => {
            const total = b.stats.total || b.total_recipients;
            const sent = b.stats.sent;
            return (
              <Link key={b.id} to={`/difusiones/${b.id}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold text-slate-900">{b.name}</h3>
                      <Badge color={STATUS[b.status].color}>{STATUS[b.status].label}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Plantilla <span className="font-mono">{b.template_name}</span> · {CATEGORY_LABEL[b.template_category] ?? b.template_category} ·{' '}
                      {b.status === 'scheduled' && b.scheduled_at
                        ? `programada para ${dateTime(b.scheduled_at)}`
                        : b.started_at
                          ? `iniciada ${dateTime(b.started_at)}`
                          : `creada ${dateTime(b.created_at)}`}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-semibold text-slate-900">{credits(b.status === 'draft' ? b.estimated_cost : b.stats.cost)}</p>
                    <p className="text-xs text-slate-500">{b.status === 'draft' ? 'estimado' : 'costo'}</p>
                  </div>
                </div>
                {total > 0 && (
                  <div className="mt-3 space-y-2">
                    <ProgressBar value={processed(b)} max={total} />
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                      <span>
                        <b className="text-slate-700">{number(total)}</b> destinatarios
                      </span>
                      <span>
                        <b className="text-slate-700">{number(sent)}</b> enviados
                      </span>
                      <span>
                        <b className="text-slate-700">{pct(b.stats.delivered, sent)}%</b> entregados
                      </span>
                      <span>
                        <b className="text-slate-700">{pct(b.stats.read, sent)}%</b> leídos
                      </span>
                      <span>
                        <b className="text-slate-700">{pct(b.stats.replied, sent)}%</b> respondieron
                      </span>
                      {b.stats.failed > 0 && <span className="text-red-600">{number(b.stats.failed)} fallidos</span>}
                    </div>
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- Wizard

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function cleanAudience(a: Audience): Audience {
  const out: Audience = {};
  if (a.funnel_id) out.funnel_id = a.funnel_id;
  if (a.stage_ids?.length) out.stage_ids = a.stage_ids;
  if (a.tag_ids?.length) out.tag_ids = a.tag_ids;
  if (a.exclude_tag_ids?.length) out.exclude_tag_ids = a.exclude_tag_ids;
  if (a.assigned_user_id) out.assigned_user_id = a.assigned_user_id;
  if (a.created_from) out.created_from = a.created_from;
  if (a.created_to) out.created_to = a.created_to;
  return out;
}

function StepTitle({ n, title, active, done, onClick }: { n: number; title: string; active: boolean; done: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 text-sm">
      <span
        className={cx(
          'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold',
          active ? 'bg-brand-600 text-white' : done ? 'bg-brand-100 text-brand-700' : 'bg-slate-200 text-slate-500',
        )}
      >
        {n}
      </span>
      <span className={cx('font-medium', active ? 'text-slate-900' : 'text-slate-500')}>{title}</span>
    </button>
  );
}

function BroadcastWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useChannels().data ?? [];
  const funnels = useFunnels().data ?? [];
  const tags = useTags().data ?? [];
  const members = useMembers().data ?? [];

  const existingQ = useQuery({
    queryKey: ['broadcast', id],
    queryFn: async () => (await api.get<{ broadcast: Broadcast }>(`/api/broadcasts/${id}`)).broadcast,
    enabled: !!id,
  });

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [value, setValue] = useState<TemplateFormValue>(emptyTemplateValue(null));
  const [audience, setAudience] = useState<Audience>({});
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [loaded, setLoaded] = useState(!id);

  const defaultChannel = channels.find((c) => c.is_default) ?? channels[0];
  const effectiveChannel = channelId || defaultChannel?.id || '';
  const templatesQ = useTemplates(effectiveChannel || undefined);
  const approved = (templatesQ.data ?? []).filter((t) => t.status === 'APPROVED');
  const template: Template | undefined = approved.find((t) => `${t.name}|${t.language}` === templateKey);

  // Load a draft being edited.
  useEffect(() => {
    const b = existingQ.data;
    if (!b || loaded || !templatesQ.data) return;
    setName(b.name);
    if (b.channel_id) setChannelId(b.channel_id);
    setTemplateKey(`${b.template_name}|${b.template_language}`);
    const t = templatesQ.data.find((x) => x.name === b.template_name && x.language === b.template_language);
    if (t) setValue(fromBroadcastParams(t, b.params ?? {}));
    setAudience(b.audience ?? {});
    if (b.scheduled_at) {
      setWhen('later');
      setScheduledAt(toLocalInput(b.scheduled_at));
    }
    setLoaded(true);
  }, [existingQ.data, templatesQ.data, loaded]);

  const audienceClean = cleanAudience(audience);
  // Debounce a string (not an object) so identical inputs don't retrigger the timer on every render.
  const estimateInput = useDebounced(
    template
      ? JSON.stringify({ channel_id: effectiveChannel, template_name: template.name, template_language: template.language, audience: audienceClean })
      : '',
    500,
  );
  const estimateQ = useQuery({
    queryKey: ['broadcast-estimate', estimateInput],
    queryFn: async () => (await api.post<{ estimate: Estimate }>('/api/broadcasts/estimate', JSON.parse(estimateInput))).estimate,
    enabled: !!estimateInput,
  });
  const estimate = estimateQ.data;

  const step1Valid = !!name.trim() && !!template && isTemplateValueComplete(template, value);
  const scheduleValid = when === 'now' || (scheduledAt && new Date(scheduledAt).getTime() > Date.now());
  const canSend = step1Valid && !!estimate?.recipients && estimate.sufficient && scheduleValid;

  const save = useMutation({
    mutationFn: async (launch: boolean) => {
      if (!template) throw new Error('Elige una plantilla');
      const body = {
        name: name.trim(),
        channel_id: effectiveChannel || undefined,
        template_name: template.name,
        template_language: template.language,
        params: toBroadcastParams(template, value),
        audience: audienceClean,
        scheduled_at: when === 'later' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      };
      const saved = id
        ? (await api.patch<{ broadcast: Broadcast }>(`/api/broadcasts/${id}`, body)).broadcast
        : (await api.post<{ broadcast: Broadcast }>('/api/broadcasts', body)).broadcast;
      if (launch) await api.post(`/api/broadcasts/${saved.id}/launch`);
      return { saved, launch };
    },
    onSuccess: ({ saved, launch }) => {
      void qc.invalidateQueries({ queryKey: ['broadcasts'] });
      void qc.invalidateQueries({ queryKey: ['broadcast', saved.id] });
      void qc.invalidateQueries({ queryKey: ['credits'] });
      toast.success(launch ? (when === 'later' ? 'Difusión programada' : 'Difusión en camino 🚀') : 'Borrador guardado');
      navigate(`/difusiones/${saved.id}`);
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });

  if (id && (existingQ.isLoading || !loaded)) return <PageLoader />;
  if (existingQ.data && existingQ.data.status !== 'draft') {
    return (
      <Page>
        <Alert tone="warning" title="Solo puedes editar borradores">
          <Link to={`/difusiones/${id}`} className="underline">
            Volver a la difusión
          </Link>
        </Alert>
      </Page>
    );
  }

  const selectedFunnel = funnels.find((f) => f.id === audience.funnel_id);

  return (
    <Page>
      <Link to="/difusiones" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Difusiones
      </Link>
      <PageHeader title={id ? 'Editar difusión' : 'Nueva difusión'} />

      {channels.length === 0 && (
        <div className="mb-4">
          <Alert tone="warning" title="Conecta un número primero">
            Necesitas un canal de WhatsApp para enviar difusiones.{' '}
            <Link to="/ajustes/canales" className="underline">
              Ir a canales
            </Link>
          </Alert>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <StepTitle n={1} title="Mensaje" active={step === 1} done={step1Valid} onClick={() => setStep(1)} />
        <span className="h-px w-8 bg-slate-300" />
        <StepTitle n={2} title="Audiencia" active={step === 2} done={!!estimate?.recipients} onClick={() => step1Valid && setStep(2)} />
        <span className="h-px w-8 bg-slate-300" />
        <StepTitle n={3} title="Envío" active={step === 3} done={false} onClick={() => step1Valid && setStep(3)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {step === 1 && (
            <Card title="1. Mensaje" description="Solo se pueden usar plantillas aprobadas por Meta.">
              <div className="space-y-4">
                <Field label="Nombre interno de la difusión">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Promo Buen Fin clientes VIP" autoFocus />
                </Field>
                {channels.length > 1 && (
                  <Field label="Número que envía">
                    <Select
                      value={effectiveChannel}
                      onChange={(e) => {
                        setChannelId(e.target.value);
                        setTemplateKey('');
                      }}
                    >
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.display_phone ? `(${c.display_phone})` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field
                  label="Plantilla"
                  hint={
                    approved.length === 0 && !templatesQ.isLoading ? (
                      <>
                        No hay plantillas aprobadas en este canal.{' '}
                        <Link to="/plantillas" className="text-brand-700 underline">
                          Crear o sincronizar plantillas
                        </Link>
                      </>
                    ) : undefined
                  }
                >
                  <Select
                    value={templateKey}
                    onChange={(e) => {
                      setTemplateKey(e.target.value);
                      const t = approved.find((x) => `${x.name}|${x.language}` === e.target.value);
                      setValue(emptyTemplateValue(t));
                    }}
                  >
                    <option value="">Elige una plantilla…</option>
                    {approved.map((t) => (
                      <option key={t.id} value={`${t.name}|${t.language}`}>
                        {t.name} ({t.language}) · {CATEGORY_LABEL[t.category] ?? t.category}
                        {templateUnsupportedReason(t) ? ' · no compatible' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                {template && (
                  <div className="rounded-lg border border-slate-200 p-4">
                    <TemplateForm template={template} value={value} onChange={setValue} />
                  </div>
                )}
                <div className="flex justify-end">
                  <Button onClick={() => setStep(2)} disabled={!step1Valid}>
                    Continuar
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {step === 2 && (
            <Card title="2. Audiencia" description="Combina filtros; si no eliges ninguno se enviará a todos tus contactos (excepto los dados de baja).">
              <div className="space-y-5">
                <Field label="Embudo">
                  <Select value={audience.funnel_id ?? ''} onChange={(e) => setAudience({ ...audience, funnel_id: e.target.value || null, stage_ids: [] })}>
                    <option value="">Todos los embudos</option>
                    {funnels.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {selectedFunnel && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-slate-700">Etapas (opcional)</p>
                    <StagePills funnel={selectedFunnel} value={audience.stage_ids ?? []} onChange={(ids) => setAudience({ ...audience, stage_ids: ids })} />
                  </div>
                )}
                <Field label="Con alguna de estas etiquetas">
                  <TagMultiSelect tags={tags} value={audience.tag_ids ?? []} onChange={(ids) => setAudience({ ...audience, tag_ids: ids })} placeholder="Cualquier etiqueta" />
                </Field>
                <Field label="Excluir contactos con estas etiquetas">
                  <TagMultiSelect tags={tags} value={audience.exclude_tag_ids ?? []} onChange={(ids) => setAudience({ ...audience, exclude_tag_ids: ids })} placeholder="Ninguna" />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Asignados a">
                    <MemberSelect members={members} value={audience.assigned_user_id} onChange={(v) => setAudience({ ...audience, assigned_user_id: v })} emptyLabel="Cualquier asesor" />
                  </Field>
                  <Field label="Creados desde">
                    <Input type="date" value={audience.created_from ?? ''} onChange={(e) => setAudience({ ...audience, created_from: e.target.value || null })} />
                  </Field>
                  <Field label="Creados hasta">
                    <Input type="date" value={audience.created_to ?? ''} onChange={(e) => setAudience({ ...audience, created_to: e.target.value || null })} />
                  </Field>
                </div>
                <Alert tone="info">
                  Los contactos que respondieron “BAJA” o fueron dados de baja se excluyen automáticamente. Meta limita cuántos mensajes de marketing recibe cada
                  persona, así que algunos pueden no entregarse aunque se cobren solo los entregados.
                </Alert>
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep(1)}>
                    Atrás
                  </Button>
                  <Button onClick={() => setStep(3)} disabled={!estimate?.recipients}>
                    Continuar
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {step === 3 && (
            <Card title="3. Envío">
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['now', 'Enviar ahora', 'Se envía en cuanto confirmes, respetando el límite de velocidad.', <Send key="s" className="h-5 w-5" />],
                      ['later', 'Programar', 'Elige fecha y hora; puedes cancelar antes.', <CalendarClock key="c" className="h-5 w-5" />],
                    ] as const
                  ).map(([k, title, desc, icon]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setWhen(k)}
                      className={cx(
                        'flex gap-3 rounded-xl border p-4 text-left transition-colors',
                        when === k ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20' : 'border-slate-200 hover:bg-slate-50',
                      )}
                    >
                      <span className="text-brand-600">{icon}</span>
                      <span>
                        <span className="block text-sm font-semibold text-slate-900">{title}</span>
                        <span className="block text-xs text-slate-500">{desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {when === 'later' && (
                  <Field label="Fecha y hora" error={scheduledAt && !scheduleValid ? 'Debe ser una fecha futura' : null}>
                    <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
                  </Field>
                )}
                {estimate && !estimate.sufficient && (
                  <Alert tone="error" title="Créditos insuficientes">
                    Necesitas {credits(estimate.cost)} y tu saldo es {credits(estimate.balance)}. Pide una recarga al administrador.
                  </Alert>
                )}
                <div className="flex flex-wrap justify-between gap-2">
                  <Button variant="outline" onClick={() => setStep(2)}>
                    Atrás
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => save.mutate(false)} loading={save.isPending && save.variables === false} disabled={!step1Valid}>
                      Guardar borrador
                    </Button>
                    <Button
                      icon={when === 'later' ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                      onClick={() => save.mutate(true)}
                      loading={save.isPending && save.variables === true}
                      disabled={!canSend}
                    >
                      {when === 'later' ? 'Programar' : `Enviar a ${number(estimate?.recipients ?? 0)}`}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          {template ? (
            <Card title="Vista previa" description="Los datos entre llaves se reemplazan con los de cada contacto.">
              <TemplatePreview template={template} value={value} />
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-slate-500">Elige una plantilla para ver la vista previa y el costo estimado.</p>
            </Card>
          )}
          {template && <EstimateCard estimate={estimate} loading={estimateQ.isFetching} />}
        </aside>
      </div>
    </Page>
  );
}

function EstimateCard({ estimate, loading }: { estimate: Estimate | undefined; loading: boolean }) {
  return (
    <Card title="Costo estimado" actions={loading ? <Spinner className="h-4 w-4" /> : undefined}>
      {!estimate ? (
        <p className="text-sm text-slate-500">Calculando…</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-slate-500">Destinatarios</span>
            <span className="text-lg font-semibold text-slate-900">{number(estimate.recipients)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-slate-500">Categoría</span>
            <span className="font-medium">{CATEGORY_LABEL[estimate.category] ?? estimate.category}</span>
          </div>
          <div className="flex items-baseline justify-between border-t border-slate-100 pt-3">
            <span className="text-slate-500">Total estimado</span>
            <span className="text-lg font-semibold text-brand-700">{credits(estimate.cost)}</span>
          </div>
          {estimate.by_market.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="py-1 text-left font-medium">País</th>
                  <th className="py-1 text-right font-medium">Contactos</th>
                  <th className="py-1 text-right font-medium">c/u</th>
                  <th className="py-1 text-right font-medium">Costo</th>
                </tr>
              </thead>
              <tbody className="text-slate-600">
                {estimate.by_market.map((m) => (
                  <tr key={m.market} className="border-t border-slate-100">
                    <td className="py-1">{MARKET_LABEL[m.market] ?? m.market}</td>
                    <td className="py-1 text-right">{number(m.count)}</td>
                    <td className="py-1 text-right">${m.unit_price.toFixed(4)}</td>
                    <td className="py-1 text-right">${m.cost.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {estimate.billing_mode === 'meta_direct' ? (
            <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-500">Meta te cobrará directamente a tu tarjeta solo los mensajes entregados. LeadLibre no cobra comisión.</p>
          ) : (
            <p className={cx('rounded-lg p-2 text-xs', estimate.sufficient ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800')}>
              Saldo disponible: {credits(estimate.balance)}. {estimate.sufficient ? 'Alcanza para esta difusión.' : 'No alcanza para esta difusión.'}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Detail

interface Recipient {
  id: string;
  contact_id: string;
  status: string;
  error: string | null;
  processed_at: string | null;
  name: string | null;
  phone: string;
  message_status: string | null;
  message_error: { message?: string } | null;
  cost: number | null;
}

const SETTLED = new Set(['sent', 'delivered', 'read']);

/**
 * The "Detalle" column. A recipient back in the queue after a Meta rate limit keeps the reason
 * (it is retried, not failed), and an unconfirmed send may still arrive: both are warnings.
 */
export function recipientDetail(r: Pick<Recipient, 'status' | 'error' | 'message_status' | 'message_error'>): { text: string; tone: 'error' | 'warning' } | null {
  // The recipient row keeps the "unconfirmed" reason after Meta confirms the message: it no longer applies.
  if (r.message_status && SETTLED.has(r.message_status) && !r.message_error?.message) return null;
  const text = r.message_error?.message ?? r.error ?? '';
  if (!text) return null;
  if (r.status === 'queued') return { text: `En espera: ${text}`, tone: 'warning' };
  if (r.message_status === 'unknown') return { text, tone: 'warning' };
  return { text, tone: 'error' };
}

function BroadcastDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const bQ = useQuery({
    queryKey: ['broadcast', id],
    queryFn: async () => (await api.get<{ broadcast: Broadcast }>(`/api/broadcasts/${id}`)).broadcast,
    refetchInterval: (q) => (q.state.data && ['running', 'scheduled'].includes(q.state.data.status) ? 3000 : false),
  });
  const b = bQ.data;
  const rQ = useQuery({
    queryKey: ['broadcast-recipients', id, statusFilter, page],
    queryFn: async () => (await api.get<{ recipients: Recipient[] }>(`/api/broadcasts/${id}/recipients${qs({ status: statusFilter, page })}`)).recipients,
    enabled: !!b && b.status !== 'draft',
    refetchInterval: b?.status === 'running' ? 3000 : false,
  });

  useRealtime<Broadcast>('broadcast:update', (data) => {
    if (data?.id === id) {
      void qc.invalidateQueries({ queryKey: ['broadcast', id] });
      void qc.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
    }
  });

  const action = useMutation({
    mutationFn: (kind: 'launch' | 'pause' | 'cancel' | 'delete') =>
      kind === 'delete' ? api.delete(`/api/broadcasts/${id}`) : api.post(`/api/broadcasts/${id}/${kind}`),
    onSuccess: (_r, kind) => {
      void qc.invalidateQueries({ queryKey: ['broadcasts'] });
      void qc.invalidateQueries({ queryKey: ['credits'] });
      if (kind === 'delete') {
        toast.success('Difusión eliminada');
        navigate('/difusiones');
        return;
      }
      void qc.invalidateQueries({ queryKey: ['broadcast', id] });
      void qc.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
      const done: Record<string, string> = { launch: 'Difusión en marcha', pause: 'Difusión pausada', cancel: 'Difusión cancelada' };
      toast.success(done[kind]);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const stats = b?.stats;
  const total = useMemo(() => (b ? b.stats.total || b.total_recipients : 0), [b]);

  if (bQ.isLoading) return <PageLoader />;
  if (!b || !stats) return <EmptyState title="Difusión no encontrada" action={<Link to="/difusiones">Volver</Link>} />;

  async function run(kind: 'launch' | 'pause' | 'cancel' | 'delete') {
    if (kind === 'cancel') {
      const ok = await confirm('Los mensajes que aún no se envían ya no saldrán. Esta acción no se puede deshacer.', {
        title: 'Cancelar difusión',
        confirmText: 'Cancelar difusión',
        danger: true,
      });
      if (!ok) return;
    }
    if (kind === 'delete') {
      const ok = await confirm('Se eliminará la difusión y sus estadísticas. Los mensajes enviados seguirán en cada conversación.', {
        title: 'Eliminar difusión',
        confirmText: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
    }
    if (kind === 'launch' && b!.status === 'draft') {
      const ok = await confirm(
        <>
          Se enviará la plantilla <b>{b!.template_name}</b> a la audiencia configurada. El costo se descuenta conforme Meta entregue cada mensaje.
        </>,
        { title: 'Enviar difusión', confirmText: 'Enviar' },
      );
      if (!ok) return;
    }
    action.mutate(kind);
  }

  const actions: ReactNode[] = [];
  if (b.status === 'draft') {
    actions.push(
      <Button key="edit" variant="outline" onClick={() => navigate(`/difusiones/${b.id}/editar`)}>
        Editar
      </Button>,
      <Button key="launch" icon={<Send className="h-4 w-4" />} onClick={() => run('launch')} loading={action.isPending && action.variables === 'launch'}>
        {b.scheduled_at && new Date(b.scheduled_at) > new Date() ? 'Programar' : 'Enviar'}
      </Button>,
    );
  }
  if (b.status === 'paused') {
    actions.push(
      <Button key="resume" icon={<Play className="h-4 w-4" />} onClick={() => run('launch')} loading={action.isPending && action.variables === 'launch'}>
        Reanudar
      </Button>,
    );
  }
  if (b.status === 'running' || b.status === 'scheduled') {
    actions.push(
      <Button key="pause" variant="outline" icon={<Pause className="h-4 w-4" />} onClick={() => run('pause')} loading={action.isPending && action.variables === 'pause'}>
        Pausar
      </Button>,
    );
  }
  if (['draft', 'running', 'scheduled', 'paused'].includes(b.status)) {
    actions.push(
      <Button key="cancel" variant="outline" icon={<XCircle className="h-4 w-4" />} onClick={() => run('cancel')}>
        Cancelar
      </Button>,
    );
  }
  if (!['running', 'scheduled'].includes(b.status)) {
    actions.push(
      <Button key="delete" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => run('delete')} className="text-red-600 hover:bg-red-50">
        Eliminar
      </Button>,
    );
  }

  const recipients = rQ.data ?? [];

  return (
    <Page>
      <Link to="/difusiones" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Difusiones
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {b.name} <Badge color={STATUS[b.status].color}>{STATUS[b.status].label}</Badge>
          </span>
        }
        description={
          <>
            Plantilla <span className="font-mono">{b.template_name}</span> ({b.template_language}) · {CATEGORY_LABEL[b.template_category] ?? b.template_category}
            {b.scheduled_at && ` · programada para ${dateTime(b.scheduled_at)}`}
            {b.started_at && ` · iniciada ${dateTime(b.started_at)}`}
            {b.finished_at && ` · terminó ${dateTime(b.finished_at)}`}
          </>
        }
        actions={actions}
      />

      {b.last_error && (
        <div className="mb-4">
          <Alert tone="error" title="La difusión se detuvo">
            {b.last_error}
          </Alert>
        </div>
      )}

      {b.status === 'draft' ? (
        <Card>
          <p className="text-sm text-slate-600">
            Este es un borrador. Costo estimado al guardarlo: <b>{credits(b.estimated_cost)}</b>. Edítalo para revisar la audiencia y la estimación actualizada.
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Destinatarios" value={number(total)} />
            <Stat label="Enviados" value={number(stats.sent)} />
            <Stat label="Entregados" value={`${pct(stats.delivered, stats.sent)}%`} hint={number(stats.delivered)} />
            <Stat label="Leídos" value={`${pct(stats.read, stats.sent)}%`} hint={number(stats.read)} />
            <Stat label="Respondieron" value={`${pct(stats.replied, stats.sent)}%`} hint={number(stats.replied)} />
            <Stat label="Fallidos" value={number(stats.failed)} hint={stats.skipped ? `${number(stats.skipped)} omitidos` : undefined} />
            <Stat label="Costo" value={<span className="text-lg">{credits(stats.cost)}</span>} />
          </div>
          <Card className="mb-4">
            <div className="flex items-center justify-between text-sm text-slate-600">
              <span>Progreso</span>
              <span>
                {number(processed(b))} de {number(total)}
              </span>
            </div>
            <div className="mt-2">
              <ProgressBar value={processed(b)} max={total} />
            </div>
          </Card>
          <Card
            title="Destinatarios"
            padded={false}
            actions={
              <Select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                className="h-8 w-40"
              >
                <option value="">Todos</option>
                <option value="queued">En cola</option>
                <option value="sent">Enviados</option>
                <option value="delivered">Entregados</option>
                <option value="read">Leídos</option>
                <option value="failed">Fallidos</option>
                <option value="unknown">Sin confirmar</option>
                <option value="skipped">Omitidos</option>
              </Select>
            }
          >
            {rQ.isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : recipients.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">Sin destinatarios con ese estado.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Contacto</th>
                      <th className="px-4 py-2">Estado</th>
                      <th className="px-4 py-2">Detalle</th>
                      <th className="px-4 py-2 text-right">Costo</th>
                      <th className="px-4 py-2">Procesado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {recipients.map((r) => {
                      const st = r.status === 'sent' && r.message_status ? r.message_status : r.status;
                      const meta = RECIPIENT_STATUS[st] ?? { label: st, color: 'gray' as const };
                      const detail = recipientDetail(r);
                      return (
                        <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/bandeja/${r.contact_id}`)}>
                          <td className="px-4 py-2">
                            <p className="font-medium text-slate-800">{r.name || formatPhone(r.phone)}</p>
                            {r.name && <p className="text-xs text-slate-500">{formatPhone(r.phone)}</p>}
                          </td>
                          <td className="px-4 py-2">
                            <Badge color={meta.color}>{meta.label}</Badge>
                          </td>
                          <td className={cx('max-w-72 px-4 py-2 text-xs', detail?.tone === 'warning' ? 'text-amber-700' : 'text-red-600')}>{detail?.text ?? ''}</td>
                          <td className="px-4 py-2 text-right text-xs text-slate-600">{r.cost ? `$${Number(r.cost).toFixed(4)}` : '—'}</td>
                          <td className="px-4 py-2 text-xs text-slate-500">{r.processed_at ? dateTime(r.processed_at) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2 text-sm text-slate-500">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} icon={<ChevronLeft className="h-4 w-4" />}>
                Anterior
              </Button>
              <span>Página {page}</span>
              <Button size="sm" variant="ghost" disabled={recipients.length < 100} onClick={() => setPage((p) => p + 1)}>
                Siguiente <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}
