import type { BroadcastParams, Template, TemplateParams } from '../lib/types';
import { Badge, Field, Input } from './ui';

export interface TemplateFormValue {
  header: string;
  body: string[];
  buttons: Record<number, string>;
}

export const PLACEHOLDERS = [
  { key: '{nombre}', label: 'Nombre completo' },
  { key: '{primer_nombre}', label: 'Primer nombre' },
  { key: '{telefono}', label: 'Teléfono' },
  { key: '{correo}', label: 'Correo' },
  { key: '{empresa}', label: 'Empresa' },
  { key: '{campo.ciudad}', label: 'Campo personalizado' },
];

export function emptyTemplateValue(t: Template | null | undefined): TemplateFormValue {
  return { header: '', body: (t?.inputs.body ?? []).map(() => ''), buttons: {} };
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}/g;

function fill(text: string, vars: string[], values: string[]) {
  return text.replace(VAR_RE, (whole, key) => {
    const i = vars.indexOf(key);
    const v = i >= 0 ? values[i] : '';
    return v ? v : whole;
  });
}

export function templateText(t: Template, v: TemplateFormValue): string {
  const parts: string[] = [];
  const header = t.components.find((c: any) => c.type === 'HEADER');
  const body = t.components.find((c: any) => c.type === 'BODY');
  const footer = t.components.find((c: any) => c.type === 'FOOTER');
  if (header?.text) parts.push(`*${fill(header.text, t.inputs.header?.variables ?? [], [v.header])}*`);
  if (header && header.format && header.format !== 'TEXT') parts.push(`[${String(header.format).toLowerCase()}]`);
  if (body?.text) parts.push(fill(body.text, t.inputs.body, v.body));
  if (footer?.text) parts.push(`_${footer.text}_`);
  return parts.join('\n\n');
}

export function templateButtons(t: Template): string[] {
  return (t.components.find((c: any) => c.type === 'BUTTONS')?.buttons ?? []).map((b: any) => b.text);
}

export function isTemplateValueComplete(t: Template, v: TemplateFormValue): boolean {
  if (t.inputs.header?.variables.length && !v.header.trim()) return false;
  if (t.inputs.header && t.inputs.header.type !== 'text' && t.inputs.header.type !== 'location' && !v.header.trim()) return false;
  if (t.inputs.body.some((_, i) => !v.body[i]?.trim())) return false;
  if (t.inputs.buttons.some((b) => !v.buttons[b.index]?.trim())) return false;
  return true;
}

function headerParam(t: Template, v: TemplateFormValue) {
  const h = t.inputs.header;
  if (!h) return undefined;
  if (h.type === 'text') return h.variables.length ? { type: 'text' as const, text: v.header } : undefined;
  if (h.type === 'location') return undefined;
  return { type: h.type, link: v.header };
}

/** Params for a one-off send from the inbox (placeholders are rendered by the server). */
export function toTemplateParams(t: Template, v: TemplateFormValue): TemplateParams {
  const out: TemplateParams = {};
  const header = headerParam(t, v);
  if (header) out.header = header;
  if (t.inputs.body.length) {
    if (t.parameter_format === 'NAMED') out.bodyNamed = Object.fromEntries(t.inputs.body.map((k, i) => [k, v.body[i] ?? '']));
    else out.body = v.body.slice(0, t.inputs.body.length);
  }
  if (t.inputs.buttons.length) out.buttons = t.inputs.buttons.map((b) => ({ index: b.index, text: v.buttons[b.index] ?? '' }));
  return out;
}

/** Params for broadcasts (same values, different key names). */
export function toBroadcastParams(t: Template, v: TemplateFormValue): BroadcastParams {
  const p = toTemplateParams(t, v);
  return {
    header: p.header ? (p.header.type === 'text' ? { type: 'text', value: p.header.text } : p.header) : undefined,
    body: p.body,
    bodyNamed: p.bodyNamed,
    buttons: p.buttons?.map((b) => ({ index: b.index, value: b.text })),
  };
}

export function fromBroadcastParams(t: Template, p: BroadcastParams): TemplateFormValue {
  return {
    header: p.header ? (p.header.type === 'text' ? p.header.value : p.header.link) : '',
    body: t.parameter_format === 'NAMED' ? t.inputs.body.map((k) => p.bodyNamed?.[k] ?? '') : t.inputs.body.map((_, i) => p.body?.[i] ?? ''),
    buttons: Object.fromEntries((p.buttons ?? []).map((b) => [b.index, b.value])),
  };
}

export function TemplatePreview({ template, value }: { template: Template; value: TemplateFormValue }) {
  const buttons = templateButtons(template);
  return (
    <div className="chat-bg rounded-xl p-4">
      <div className="max-w-sm rounded-lg rounded-tl-none bg-white p-3 text-sm shadow-sm">
        <p className="whitespace-pre-wrap break-words text-slate-800">{templateText(template, value)}</p>
      </div>
      {buttons.length > 0 && (
        <div className="mt-1 flex max-w-sm flex-col gap-1">
          {buttons.map((b, i) => (
            <div key={i} className="rounded-lg bg-white py-2 text-center text-sm font-medium text-sky-600 shadow-sm">
              {b}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inputs for the variables of a template. Values may use placeholders like {primer_nombre}. */
export function TemplateForm({ template, value, onChange, showPlaceholders = true }: { template: Template; value: TemplateFormValue; onChange: (v: TemplateFormValue) => void; showPlaceholders?: boolean }) {
  const t = template;
  const h = t.inputs.header;
  const hasInputs = (h && (h.type !== 'text' || h.variables.length > 0) && h.type !== 'location') || t.inputs.body.length > 0 || t.inputs.buttons.length > 0;
  return (
    <div className="space-y-4">
      {!hasInputs && <p className="text-sm text-slate-500">Esta plantilla no tiene variables.</p>}
      {h && h.type === 'text' && h.variables.length > 0 && (
        <Field label="Encabezado: variable">
          <Input value={value.header} onChange={(e) => onChange({ ...value, header: e.target.value })} placeholder="Ej. {primer_nombre}" />
        </Field>
      )}
      {h && h.type !== 'text' && h.type !== 'location' && (
        <Field label={`Encabezado: URL pública del ${h.type === 'image' ? 'imagen' : h.type === 'video' ? 'video' : 'documento'}`} hint="Debe ser un enlace https accesible por Meta.">
          <Input value={value.header} onChange={(e) => onChange({ ...value, header: e.target.value })} placeholder="https://…" />
        </Field>
      )}
      {t.inputs.body.map((name, i) => (
        <Field key={name} label={`Variable {{${name}}}`}>
          <Input
            value={value.body[i] ?? ''}
            onChange={(e) => {
              const body = [...value.body];
              body[i] = e.target.value;
              onChange({ ...value, body });
            }}
            placeholder={i === 0 ? 'Ej. {primer_nombre}' : 'Texto o {campo}'}
          />
        </Field>
      ))}
      {t.inputs.buttons.map((b) => (
        <Field key={b.index} label={`Botón “${b.text}”: final de la URL`}>
          <Input value={value.buttons[b.index] ?? ''} onChange={(e) => onChange({ ...value, buttons: { ...value.buttons, [b.index]: e.target.value } })} />
        </Field>
      ))}
      {showPlaceholders && hasInputs && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          Datos del contacto:
          {PLACEHOLDERS.map((p) => (
            <Badge key={p.key} color="gray" className="font-mono">
              {p.key}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function categoryColor(category: string): 'purple' | 'blue' | 'yellow' | 'gray' {
  return category === 'marketing' ? 'purple' : category === 'utility' ? 'blue' : category === 'authentication' ? 'yellow' : 'gray';
}

export function statusColor(status: string): 'green' | 'yellow' | 'red' | 'gray' {
  return status === 'APPROVED' ? 'green' : status === 'PENDING' || status === 'IN_APPEAL' ? 'yellow' : status === 'REJECTED' || status === 'DISABLED' || status === 'PAUSED' ? 'red' : 'gray';
}

export const TEMPLATE_STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Aprobada',
  PENDING: 'En revisión',
  REJECTED: 'Rechazada',
  PAUSED: 'Pausada',
  DISABLED: 'Deshabilitada',
  IN_APPEAL: 'En apelación',
};
