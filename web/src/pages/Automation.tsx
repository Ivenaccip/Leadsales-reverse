import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronRight, Clock, Hand, MessageSquareText, Plus, Power, Sparkles, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useFunnels, useMembers, useTags, useWorkspace } from '../lib/queries';
import type { BotMenu, BotMenuOption, WorkspaceSettings } from '../lib/types';
import { MemberSelect, StageSelect, TagMultiSelect } from '../components/pickers';
import { Alert, Badge, Button, Card, Field, Input, Page, PageHeader, PageLoader, Select, Textarea, Toggle, cx, useToast } from '../components/ui';

const DAYS: { key: string; label: string }[] = [
  { key: '1', label: 'Lunes' },
  { key: '2', label: 'Martes' },
  { key: '3', label: 'Miércoles' },
  { key: '4', label: 'Jueves' },
  { key: '5', label: 'Viernes' },
  { key: '6', label: 'Sábado' },
  { key: '0', label: 'Domingo' },
];

const MODES = [
  { id: 'off', icon: Power, title: 'Sin bot', text: 'Solo mensajes de bienvenida y ausencia. Tu equipo responde todo.' },
  { id: 'menu', icon: MessageSquareText, title: 'Bot de menú', text: 'Menú de opciones numeradas (hasta 3 niveles) que califica y mueve leads.' },
  { id: 'ai', icon: Sparkles, title: 'Agente con IA', text: 'Claude responde en lenguaje natural con la información de tu negocio y pasa a un humano.' },
] as const;

function renumber(options: BotMenuOption[]): BotMenuOption[] {
  return options.map((o, i) => ({ ...o, key: String(i + 1) }));
}

function OptionEditor({
  option,
  depth,
  onChange,
  onRemove,
}: {
  option: BotMenuOption;
  depth: number;
  onChange: (o: BotMenuOption) => void;
  onRemove: () => void;
}) {
  const funnels = useFunnels();
  const tags = useTags();
  const members = useMembers();
  const [open, setOpen] = useState(true);
  const hasSub = !!option.submenu;
  return (
    <div className={cx('rounded-lg border bg-white', depth === 1 ? 'border-slate-200' : 'border-slate-200/80')}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-slate-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">{option.key}</span>
        <Input className="h-8" value={option.label} onChange={(e) => onChange({ ...option, label: e.target.value })} placeholder="Texto de la opción" maxLength={72} />
        <Button type="button" size="sm" variant="ghost" onClick={onRemove} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
      </div>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3">
          <Field label="Respuesta al elegirla (opcional)">
            <Textarea rows={2} value={option.reply ?? ''} onChange={(e) => onChange({ ...option, reply: e.target.value })} />
          </Field>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Mover a etapa">
              <StageSelect funnels={funnels.data ?? []} value={option.stage_id ?? null} allowEmpty emptyLabel="No mover" onChange={(v) => onChange({ ...option, stage_id: v })} />
            </Field>
            <Field label="Agregar etiquetas">
              <TagMultiSelect tags={tags.data ?? []} value={option.tag_ids ?? []} onChange={(v) => onChange({ ...option, tag_ids: v })} placeholder="Etiquetas" />
            </Field>
            <Field label="Asignar a">
              <MemberSelect members={members.data ?? []} value={option.assign_user_id ?? null} emptyLabel="No asignar" onChange={(v) => onChange({ ...option, assign_user_id: v })} />
            </Field>
          </div>
          {!hasSub && (
            <Toggle
              checked={!!option.handoff}
              onChange={(v) => onChange({ ...option, handoff: v })}
              label="Pasar a un asesor al elegirla"
              description="Termina el bot y asigna la conversación (round-robin si nadie la tiene)."
            />
          )}
          {hasSub ? (
            <div className="rounded-lg bg-slate-50 p-3">
              <MenuEditor menu={option.submenu!} depth={depth + 1} onChange={(m) => onChange({ ...option, submenu: m })} />
              <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => onChange({ ...option, submenu: null })}>
                Quitar submenú
              </Button>
            </div>
          ) : (
            depth < 3 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onChange({ ...option, handoff: false, submenu: { prompt: '¿Qué opción prefieres?', options: [{ key: '1', label: 'Opción 1', handoff: true }] } })}
                icon={<Plus className="h-4 w-4" />}
              >
                Agregar submenú (nivel {depth + 1})
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function MenuEditor({ menu, depth, onChange }: { menu: BotMenu; depth: number; onChange: (m: BotMenu) => void }) {
  return (
    <div className="space-y-3">
      <Field label={depth === 1 ? 'Mensaje del menú principal' : `Mensaje del submenú (nivel ${depth})`}>
        <Textarea rows={2} value={menu.prompt} onChange={(e) => onChange({ ...menu, prompt: e.target.value })} />
      </Field>
      {menu.options.map((o, i) => (
        <OptionEditor
          key={i}
          option={o}
          depth={depth}
          onChange={(next) => onChange({ ...menu, options: menu.options.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => onChange({ ...menu, options: renumber(menu.options.filter((_, j) => j !== i)) })}
        />
      ))}
      {menu.options.length < 10 && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onChange({ ...menu, options: renumber([...menu.options, { key: '', label: `Opción ${menu.options.length + 1}`, handoff: true }]) })}
          icon={<Plus className="h-4 w-4" />}
        >
          Agregar opción
        </Button>
      )}
    </div>
  );
}

function MenuPreview({ menu, interactive }: { menu: BotMenu; interactive: boolean }) {
  const asButtons = interactive && menu.options.length <= 3;
  return (
    <div className="chat-bg rounded-xl p-4">
      <div className="max-w-xs rounded-lg rounded-tl-none bg-white p-3 text-sm shadow-sm">
        <p className="whitespace-pre-wrap text-slate-800">{menu.prompt}</p>
        {!interactive && (
          <div className="mt-2 space-y-0.5 text-slate-800">
            {menu.options.map((o) => (
              <p key={o.key}>
                <b>{o.key}.</b> {o.label}
              </p>
            ))}
          </div>
        )}
      </div>
      {interactive && (
        <div className="mt-1 flex max-w-xs flex-col gap-1">
          {asButtons ? (
            menu.options.map((o) => (
              <div key={o.key} className="rounded-lg bg-white py-2 text-center text-sm font-medium text-sky-600 shadow-sm">
                {o.label.length > 20 ? `${o.label.slice(0, 19).trimEnd()}…` : o.label}
              </div>
            ))
          ) : (
            <div className="rounded-lg bg-white py-2 text-center text-sm font-medium text-sky-600 shadow-sm">☰ Ver opciones</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AutomationPage() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);

  useEffect(() => {
    if (ws.data && !s) setS(ws.data.workspace.settings);
  }, [ws.data, s]);

  const save = useMutation({
    mutationFn: () => {
      const { has_api_key: _ignored, ...ai } = s!.ai;
      return api.put('/api/workspace/settings', {
        automation_mode: s!.automation_mode,
        welcome: s!.welcome,
        away: s!.away,
        bot: s!.bot,
        ai: { ...ai, ...(apiKey ? { api_key: apiKey } : removeKey ? { api_key: null } : {}) },
      });
    },
    onSuccess: () => {
      toast.success('Automatización guardada');
      setApiKey('');
      setRemoveKey(false);
      void qc.invalidateQueries({ queryKey: ['workspace'] }).then(() => setS(null));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!s || !ws.data) return <PageLoader />;
  const set = <K extends keyof WorkspaceSettings>(k: K, v: WorkspaceSettings[K]) => setS({ ...s, [k]: v });
  const hours = s.away.hours ?? {};

  return (
    <Page>
      <PageHeader
        title="Bot e IA"
        description="Automatiza la primera respuesta, califica leads y deja que tu equipo atienda lo importante."
        actions={
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Guardar cambios
          </Button>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-3 md:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => set('automation_mode', m.id)}
              className={cx(
                'rounded-xl border-2 p-4 text-left transition',
                s.automation_mode === m.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300',
              )}
            >
              <m.icon className={cx('h-6 w-6', s.automation_mode === m.id ? 'text-brand-600' : 'text-slate-400')} />
              <p className="mt-2 font-semibold text-slate-900">{m.title}</p>
              <p className="mt-1 text-sm text-slate-600">{m.text}</p>
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">Solo un modo puede estar activo a la vez. Cuando una persona de tu equipo responde un chat, el bot y la IA se detienen en esa conversación.</p>

        {s.automation_mode === 'off' && (
          <Card title="Mensaje de bienvenida" description="Se envía automáticamente al primer mensaje de cada contacto nuevo.">
            <div className="space-y-3">
              <Toggle checked={s.welcome.enabled} onChange={(v) => set('welcome', { ...s.welcome, enabled: v })} label="Enviar bienvenida" />
              <Textarea rows={3} value={s.welcome.text} onChange={(e) => set('welcome', { ...s.welcome, text: e.target.value })} disabled={!s.welcome.enabled} />
            </div>
          </Card>
        )}

        {s.automation_mode !== 'ai' && (
          <Card title={<span className="flex items-center gap-2"><Clock className="h-4 w-4" /> Horario de atención</span>} description="Fuera de horario se envía un mensaje de ausencia (máximo uno cada 12 horas por contacto).">
            <div className="space-y-4">
              <Toggle checked={s.away.enabled} onChange={(v) => set('away', { ...s.away, enabled: v })} label="Responder fuera de horario" />
              <Textarea rows={2} value={s.away.text} onChange={(e) => set('away', { ...s.away, text: e.target.value })} disabled={!s.away.enabled} />
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {DAYS.map((d) => {
                  const range = hours[d.key]?.[0];
                  return (
                    <div key={d.key} className={cx('rounded-lg border p-3', range ? 'border-brand-200 bg-brand-50/40' : 'border-slate-200')}>
                      <Toggle
                        checked={!!range}
                        onChange={(on) => {
                          const next = { ...hours };
                          if (on) next[d.key] = [['09:00', '18:00']];
                          else delete next[d.key];
                          set('away', { ...s.away, hours: next });
                        }}
                        label={d.label}
                        disabled={!s.away.enabled}
                      />
                      {range && (
                        <div className="mt-2 flex items-center gap-2">
                          <Input type="time" className="h-8 min-w-0 flex-1 px-2" value={range[0]} onChange={(e) => set('away', { ...s.away, hours: { ...hours, [d.key]: [[e.target.value, range[1]]] } })} />
                          <span className="text-slate-400">a</span>
                          <Input type="time" className="h-8 min-w-0 flex-1 px-2" value={range[1]} onChange={(e) => set('away', { ...s.away, hours: { ...hours, [d.key]: [[range[0], e.target.value]] } })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">Zona horaria: {ws.data.workspace.timezone} (cámbiala en Ajustes → General).</p>
            </div>
          </Card>
        )}

        {s.automation_mode === 'menu' && (
          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <Card title={<span className="flex items-center gap-2"><Bot className="h-4 w-4" /> Menú del bot</span>} description="Como Leadbot: cada opción puede responder, mover de etapa, etiquetar, asignar o pasar a un asesor.">
              <MenuEditor menu={s.bot.menu} depth={1} onChange={(menu) => set('bot', { ...s.bot, menu })} />
            </Card>
            <div className="space-y-6">
              <Card title="Vista previa">
                <MenuPreview menu={s.bot.menu} interactive={s.bot.interactive} />
              </Card>
              <Card title="Opciones del bot">
                <div className="space-y-4">
                  <Toggle
                    checked={s.bot.interactive}
                    onChange={(v) => set('bot', { ...s.bot, interactive: v })}
                    label="Usar botones y listas de WhatsApp"
                    description="Hasta 3 opciones como botones; hasta 10 como lista. Si no, menú numerado en texto."
                  />
                  <Toggle
                    checked={s.bot.only_unassigned}
                    onChange={(v) => set('bot', { ...s.bot, only_unassigned: v })}
                    label="Solo en conversaciones sin asignar"
                  />
                  <Field label="Si no entiende la respuesta">
                    <Input value={s.bot.fallback} onChange={(e) => set('bot', { ...s.bot, fallback: e.target.value })} />
                  </Field>
                  <Field label="Mensaje al pasar con un asesor">
                    <Input value={s.bot.handoff_message} onChange={(e) => set('bot', { ...s.bot, handoff_message: e.target.value })} />
                  </Field>
                  <p className="text-xs text-slate-500">El cliente puede escribir “menú” o “0” para volver al inicio.</p>
                </div>
              </Card>
            </div>
          </div>
        )}

        {s.automation_mode === 'ai' && (
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> Agente de ventas con IA</span>} description="Responde con la información de tu negocio, actualiza el CRM (etapa, etiquetas, datos) y pasa a un humano cuando hace falta.">
              <div className="space-y-4">
                <Field label="Instrucciones" hint="Tono, objetivo, qué debe preguntar, cuándo pasar a un humano.">
                  <Textarea rows={5} value={s.ai.instructions} onChange={(e) => set('ai', { ...s.ai, instructions: e.target.value })} />
                </Field>
                <Field label={`Información del negocio (${s.ai.knowledge.length.toLocaleString('es-MX')} caracteres)`} hint="Productos, precios, horarios, ubicación, formas de pago, preguntas frecuentes… La IA no inventa lo que no esté aquí.">
                  <Textarea rows={14} value={s.ai.knowledge} onChange={(e) => set('ai', { ...s.ai, knowledge: e.target.value })} placeholder={'Ej.\nPaquete básico: $1,500 MXN\nHorario: L-V 9 a 18 h\nEnvíos a todo México en 3-5 días'} />
                </Field>
                <Field label="Mensaje al pasar con un humano">
                  <Input value={s.ai.handoff_message} onChange={(e) => set('ai', { ...s.ai, handoff_message: e.target.value })} />
                </Field>
              </div>
            </Card>
            <div className="space-y-6">
              <Card title="Modelo y llave">
                <div className="space-y-4">
                  <Field label="Modelo de Claude">
                    <Select value={s.ai.model} onChange={(e) => set('ai', { ...s.ai, model: e.target.value })}>
                      {ws.data.ai_models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={
                      <span className="flex items-center gap-2">
                        Llave de API de Anthropic {s.ai.has_api_key && !removeKey && <Badge color="green">Configurada</Badge>}
                      </span>
                    }
                    hint="Se guarda cifrada. Pagas el uso directamente a Anthropic (console.anthropic.com): solo tus créditos."
                  >
                    <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.ai.has_api_key ? '•••••••• (déjala vacía para conservarla)' : 'sk-ant-…'} autoComplete="off" />
                  </Field>
                  {s.ai.has_api_key && (
                    <Toggle checked={removeKey} onChange={setRemoveKey} label="Eliminar la llave guardada" />
                  )}
                  <Field label="Máximo de respuestas de IA por contacto" hint="Al llegar al límite pasa la conversación a un humano.">
                    <Input type="number" min={1} max={500} value={s.ai.max_replies} onChange={(e) => set('ai', { ...s.ai, max_replies: Number(e.target.value) || 1 })} />
                  </Field>
                  <Toggle checked={s.ai.only_unassigned} onChange={(v) => set('ai', { ...s.ai, only_unassigned: v })} label="Solo en conversaciones sin asignar" />
                </div>
              </Card>
              <Alert tone="info" title={<span className="flex items-center gap-1"><Hand className="h-4 w-4" /> Control humano</span>}>
                En cada chat puedes pausar o reactivar la IA. Si alguien de tu equipo responde, la IA se pausa sola en esa conversación.
              </Alert>
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
