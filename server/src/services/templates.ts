import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import type { ChannelRow } from '../types.js';
import { providerFor } from '../whatsapp/provider.js';
import type { CreateTemplateInput, TemplateParams } from '../whatsapp/types.js';

export interface TemplateRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  meta_id: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  components: any[];
  parameter_format: string | null;
  rejected_reason: string | null;
  updated_at: Date;
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}/g;

export function variablesIn(text: string | undefined | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Describes the inputs a template needs (used by the UI and to validate sends). */
export function templateSchema(components: any[]) {
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  return {
    header: header
      ? header.format === 'TEXT' || !header.format
        ? { type: 'text' as const, variables: variablesIn(header.text) }
        : { type: String(header.format).toLowerCase() as 'image' | 'video' | 'document' | 'location', variables: [] }
      : null,
    body: variablesIn(body?.text),
    buttons: buttons
      .map((b: any, index: number) => ({ index, type: b.type, text: b.text, variables: b.type === 'URL' ? variablesIn(b.url) : [] }))
      .filter((b: any) => b.variables.length > 0),
  };
}

/** Converts our TemplateParams into Meta "components" for the send API. */
export function buildTemplateComponents(params: TemplateParams | undefined, named: boolean, components: any[] = []): any[] {
  if (!params) return [];
  const out: any[] = [];
  const schema = templateSchema(components);
  const textParam = (text: string, name?: string) => (named && name ? { type: 'text', parameter_name: name, text } : { type: 'text', text });

  if (params.header) {
    if (params.header.type === 'text') {
      out.push({ type: 'header', parameters: [textParam(params.header.text, schema.header?.variables[0])] });
    } else {
      const media: Record<string, string> = params.header.mediaId ? { id: params.header.mediaId } : { link: params.header.link ?? '' };
      if (params.header.type === 'document' && params.header.filename) media.filename = params.header.filename;
      out.push({ type: 'header', parameters: [{ type: params.header.type, [params.header.type]: media }] });
    }
  }
  if (params.bodyNamed && Object.keys(params.bodyNamed).length) {
    out.push({
      type: 'body',
      parameters: Object.entries(params.bodyNamed).map(([k, v]) => ({ type: 'text', parameter_name: k, text: v })),
    });
  } else if (params.body?.length) {
    out.push({ type: 'body', parameters: params.body.map((t, i) => textParam(t, schema.body[i])) });
  }
  for (const b of params.buttons ?? []) {
    out.push({ type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: b.text }] });
  }
  return out;
}

function fill(text: string, values: string[] | Record<string, string> | undefined): string {
  let i = 0;
  return text.replace(VAR_RE, (whole, key) => {
    if (!values) return whole;
    if (Array.isArray(values)) {
      const idx = /^\d+$/.test(key) ? Number(key) - 1 : i;
      i++;
      return values[idx] ?? whole;
    }
    return values[key] ?? whole;
  });
}

/** Text shown in the chat for a sent template (header, body, footer and buttons). */
export function renderTemplateText(components: any[], params: TemplateParams | undefined): string {
  const parts: string[] = [];
  const header = components.find((c) => c.type === 'HEADER');
  if (header?.text) {
    const hv = params?.header?.type === 'text' ? [params.header.text] : undefined;
    parts.push(`*${fill(header.text, hv)}*`);
  }
  const body = components.find((c) => c.type === 'BODY');
  if (body?.text) parts.push(fill(body.text, params?.bodyNamed && Object.keys(params.bodyNamed).length ? params.bodyNamed : params?.body));
  const footer = components.find((c) => c.type === 'FOOTER');
  if (footer?.text) parts.push(`_${footer.text}_`);
  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  if (buttons.length) parts.push(buttons.map((b: any) => `[${b.text}]`).join(' '));
  return parts.join('\n\n');
}

export async function findTemplate(q: Queryable, channelId: string, name: string, language: string): Promise<TemplateRow | null> {
  const { rows } = await q.query<TemplateRow>(`SELECT * FROM templates WHERE channel_id = $1 AND name = $2 AND language = $3`, [
    channelId,
    name,
    language,
  ]);
  return rows[0] ?? null;
}

export async function upsertTemplate(
  q: Queryable,
  channel: ChannelRow,
  t: { meta_id: string | null; name: string; language: string; category: string; status: string; components: any[]; parameter_format?: string | null; rejected_reason?: string | null },
) {
  const { rows } = await q.query<TemplateRow>(
    `INSERT INTO templates (workspace_id, channel_id, meta_id, name, language, category, status, components, parameter_format, rejected_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (channel_id, name, language) DO UPDATE SET meta_id = EXCLUDED.meta_id, category = EXCLUDED.category,
       status = EXCLUDED.status, components = EXCLUDED.components, parameter_format = EXCLUDED.parameter_format,
       rejected_reason = EXCLUDED.rejected_reason, updated_at = now()
     RETURNING *`,
    [
      channel.workspace_id,
      channel.id,
      t.meta_id,
      t.name,
      t.language,
      t.category.toLowerCase(),
      t.status.toUpperCase(),
      JSON.stringify(t.components ?? []),
      t.parameter_format ?? null,
      t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    ],
  );
  return rows[0];
}

export async function syncTemplates(ctx: AppContext, channel: ChannelRow): Promise<number> {
  const remote = await providerFor(ctx, channel).listTemplates();
  await ctx.db.tx(async (q) => {
    for (const t of remote) {
      await upsertTemplate(q, channel, { ...t, meta_id: t.id });
    }
    if (channel.provider === 'cloud_api') {
      const keep = remote.map((t) => `${t.name}|${t.language}`);
      await q.query(`DELETE FROM templates WHERE channel_id = $1 AND NOT ((name || '|' || language) = ANY($2::text[]))`, [channel.id, keep]);
    }
  });
  return remote.length;
}

export async function createTemplate(ctx: AppContext, channel: ChannelRow, input: CreateTemplateInput): Promise<TemplateRow> {
  const r = await providerFor(ctx, channel).createTemplate(input);
  return upsertTemplate(ctx.db, channel, {
    meta_id: r.id,
    name: input.name,
    language: input.language,
    category: r.category ?? input.category,
    status: r.status ?? 'PENDING',
    components: input.components,
    parameter_format: input.parameter_format ?? null,
  });
}
