import type { BroadcastParams, LocationHeaderParam, Template, TemplateParams } from '../lib/types';
import { Alert, Badge, Field, Input } from './ui';

export interface LocationValue {
  latitude: string;
  longitude: string;
  name: string;
  address: string;
}

export interface TemplateFormValue {
  header: string;
  /** For LOCATION headers: Meta takes the place at send time, not from the approved template. */
  location?: LocationValue;
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

const EMPTY_LOCATION: LocationValue = { latitude: '', longitude: '', name: '', address: '' };

/** Meta's limit for the coupon of a copy-code button. */
export const COUPON_MAX = 15;

export function emptyTemplateValue(t: Template | null | undefined): TemplateFormValue {
  return {
    header: '',
    ...(t?.inputs.header?.type === 'location' ? { location: { ...EMPTY_LOCATION } } : {}),
    body: (t?.inputs.body ?? []).map(() => ''),
    buttons: {},
  };
}

/** Why a template cannot be sent from here (null when it can). */
export function templateUnsupportedReason(t: Template): string | null {
  if (t.inputs.unsupported) return t.inputs.unsupported;
  if (t.components.some((c: any) => String(c?.type).toUpperCase() === 'CAROUSEL')) {
    return 'Las plantillas de carrusel todavía no se pueden enviar desde LeadLibre. Usa una plantilla sin carrusel.';
  }
  return null;
}

export interface ButtonInput {
  index: number;
  text: string;
  kind: 'url' | 'copy_code';
}

/** Buttons that need a value at send time: URL suffixes and coupon codes of copy-code buttons. */
export function templateButtonInputs(t: Template): ButtonInput[] {
  const out = new Map<number, ButtonInput>();
  for (const b of t.inputs.buttons) {
    out.set(b.index, { index: b.index, text: b.text, kind: String(b.type).toUpperCase() === 'COPY_CODE' ? 'copy_code' : 'url' });
  }
  // The coupon is not part of the approved template, so every copy-code button needs one, whether
  // or not the server lists it among the inputs.
  const buttons: any[] = t.components.find((c: any) => c.type === 'BUTTONS')?.buttons ?? [];
  buttons.forEach((b, index) => {
    if (String(b?.type).toUpperCase() === 'COPY_CODE' && !out.has(index)) out.set(index, { index, text: b.text || 'Copiar código', kind: 'copy_code' });
  });
  return [...out.values()].sort((a, b) => a.index - b.index);
}

function coordinate(v: string | undefined, max: number): number | null {
  const s = (v ?? '').trim().replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) <= max ? n : null;
}

/** The location header parameter, or null while latitude/longitude are missing or out of range. */
export function locationParam(v: LocationValue | undefined): LocationHeaderParam | null {
  const latitude = coordinate(v?.latitude, 90);
  const longitude = coordinate(v?.longitude, 180);
  if (latitude === null || longitude === null) return null;
  const name = v?.name.trim();
  const address = v?.address.trim();
  return { type: 'location', latitude, longitude, ...(name ? { name } : {}), ...(address ? { address } : {}) };
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
  if (header?.format === 'LOCATION') {
    const place = [v.location?.name.trim(), v.location?.address.trim()].filter(Boolean).join(' · ');
    parts.push(`📍 ${place || 'Ubicación'}`);
  } else if (header && header.format && header.format !== 'TEXT') parts.push(`[${String(header.format).toLowerCase()}]`);
  if (body?.text) parts.push(fill(body.text, t.inputs.body, v.body));
  if (footer?.text) parts.push(`_${footer.text}_`);
  return parts.join('\n\n');
}

export function templateButtons(t: Template): string[] {
  return (t.components.find((c: any) => c.type === 'BUTTONS')?.buttons ?? []).map((b: any) => b.text);
}

export function isTemplateValueComplete(t: Template, v: TemplateFormValue): boolean {
  if (templateUnsupportedReason(t)) return false;
  const h = t.inputs.header;
  if (h?.type === 'location') {
    if (!locationParam(v.location)) return false;
  } else {
    if (h?.variables.length && !v.header.trim()) return false;
    if (h && h.type !== 'text' && !v.header.trim()) return false;
  }
  if (t.inputs.body.some((_, i) => !v.body[i]?.trim())) return false;
  for (const b of templateButtonInputs(t)) {
    const value = v.buttons[b.index]?.trim() ?? '';
    if (!value || (b.kind === 'copy_code' && value.length > COUPON_MAX)) return false;
  }
  return true;
}

function headerParam(t: Template, v: TemplateFormValue): TemplateParams['header'] {
  const h = t.inputs.header;
  if (!h) return undefined;
  if (h.type === 'text') return h.variables.length ? { type: 'text' as const, text: v.header } : undefined;
  if (h.type === 'location') return locationParam(v.location) ?? undefined;
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
  const buttons = templateButtonInputs(t);
  if (buttons.length) {
    out.buttons = buttons.map((b) => ({
      index: b.index,
      text: (v.buttons[b.index] ?? '').trim(),
      ...(b.kind === 'copy_code' ? { sub_type: 'copy_code' as const } : {}),
    }));
  }
  return out;
}

/** Params for broadcasts (same values, different key names). */
export function toBroadcastParams(t: Template, v: TemplateFormValue): BroadcastParams {
  const p = toTemplateParams(t, v);
  return {
    header: p.header ? (p.header.type === 'text' ? { type: 'text', value: p.header.text } : p.header) : undefined,
    body: p.body,
    bodyNamed: p.bodyNamed,
    buttons: p.buttons?.map((b) => ({ index: b.index, value: b.text, ...(b.sub_type ? { sub_type: b.sub_type } : {}) })),
  };
}

export function fromBroadcastParams(t: Template, p: BroadcastParams): TemplateFormValue {
  const h = p.header;
  return {
    header: h ? (h.type === 'text' ? h.value : h.type === 'location' ? '' : h.link) : '',
    ...(t.inputs.header?.type === 'location'
      ? {
          location:
            h?.type === 'location'
              ? { latitude: String(h.latitude), longitude: String(h.longitude), name: h.name ?? '', address: h.address ?? '' }
              : { ...EMPTY_LOCATION },
        }
      : {}),
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

// "19.4326, -99.1332" as copied from a map (decimal points, so "19,4326" stays one number).
const PAIR_RE = /^\s*([-+]?\d+\.\d+)\s*,\s*([-+]?\d+\.\d+)\s*$/;

/** Inputs for the variables of a template. Values may use placeholders like {primer_nombre}. */
export function TemplateForm({ template, value, onChange, showPlaceholders = true }: { template: Template; value: TemplateFormValue; onChange: (v: TemplateFormValue) => void; showPlaceholders?: boolean }) {
  const t = template;
  const h = t.inputs.header;
  const unsupported = templateUnsupportedReason(t);
  if (unsupported) return <Alert tone="warning" title="Plantilla no compatible">{unsupported}</Alert>;
  const buttons = templateButtonInputs(t);
  const location = value.location ?? EMPTY_LOCATION;
  const setLocation = (patch: Partial<LocationValue>) => onChange({ ...value, location: { ...location, ...patch } });
  const hasInputs = (h && (h.type !== 'text' || h.variables.length > 0)) || t.inputs.body.length > 0 || buttons.length > 0;
  const hasTextInputs = (h?.type === 'text' && h.variables.length > 0) || t.inputs.body.length > 0 || buttons.some((b) => b.kind === 'url');
  return (
    <div className="space-y-4">
      {!hasInputs && <p className="text-sm text-slate-500">Esta plantilla no tiene variables.</p>}
      {h && h.type === 'text' && h.variables.length > 0 && (
        <Field label="Encabezado: variable">
          <Input value={value.header} onChange={(e) => onChange({ ...value, header: e.target.value })} placeholder="Ej. {primer_nombre}" />
        </Field>
      )}
      {h && h.type === 'location' && (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-700">Encabezado: ubicación que se enviará</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitud" hint="Puedes pegar «lat, long» de Google Maps.">
              <Input
                value={location.latitude}
                inputMode="decimal"
                placeholder="19.4326"
                onChange={(e) => {
                  const pair = PAIR_RE.exec(e.target.value);
                  setLocation(pair ? { latitude: pair[1], longitude: pair[2] } : { latitude: e.target.value });
                }}
              />
            </Field>
            <Field label="Longitud">
              <Input value={location.longitude} inputMode="decimal" placeholder="-99.1332" onChange={(e) => setLocation({ longitude: e.target.value })} />
            </Field>
          </div>
          <Field label="Nombre del lugar (opcional)">
            <Input value={location.name} onChange={(e) => setLocation({ name: e.target.value })} placeholder="Sucursal Centro" />
          </Field>
          <Field label="Dirección (opcional)">
            <Input value={location.address} onChange={(e) => setLocation({ address: e.target.value })} placeholder="Av. Juárez 10, CDMX" />
          </Field>
        </div>
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
      {buttons.map((b) =>
        b.kind === 'copy_code' ? (
          <Field key={b.index} label={`Botón “${b.text}”: código del cupón`} hint={`Máximo ${COUPON_MAX} caracteres.`}>
            <Input
              value={value.buttons[b.index] ?? ''}
              maxLength={COUPON_MAX}
              placeholder="Ej. BUENFIN25"
              onChange={(e) => onChange({ ...value, buttons: { ...value.buttons, [b.index]: e.target.value } })}
            />
          </Field>
        ) : (
          <Field key={b.index} label={`Botón “${b.text}”: final de la URL`}>
            <Input value={value.buttons[b.index] ?? ''} onChange={(e) => onChange({ ...value, buttons: { ...value.buttons, [b.index]: e.target.value } })} />
          </Field>
        ),
      )}
      {showPlaceholders && hasTextInputs && (
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
