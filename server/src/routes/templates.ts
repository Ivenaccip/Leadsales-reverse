import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createTemplate, orderedVariables, syncTemplates, templateSchema, variablesIn, type TemplateRow } from '../services/templates.js';
import { getChannel, providerFor } from '../whatsapp/provider.js';
import { explainMetaError, MetaApiError } from '../whatsapp/types.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid } from './helpers.js';

function withSchema(t: TemplateRow) {
  return { ...t, inputs: templateSchema(t.components) };
}

/**
 * Meta answers most template mistakes with code 100 ("Invalid parameter") and the real reason in
 * error_user_msg (the error's message) or error_data.details: both are kept so the admin can fix it.
 */
function metaError(err: MetaApiError, prefix = '') {
  const d = err.details as { details?: unknown; error_subcode?: unknown } | undefined;
  const extra = typeof d?.details === 'string' ? d.details.trim() : '';
  const reason = extra && !err.message.includes(extra) ? `${err.message} ${extra}` : err.message;
  return badRequest(`${prefix}${explainMetaError(err.code, reason)}`, 'META_ERROR', {
    code: err.code,
    subcode: typeof d?.error_subcode === 'number' ? d.error_subcode : null,
    message: reason,
  });
}

const createSchema = z.object({
  channel_id: uuid,
  name: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, 'El nombre solo admite minúsculas, números y guion bajo (ej. promo_julio)'),
  language: z.string().trim().min(2).default('es_MX'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  header: z.object({ text: z.string().trim().min(1).max(60), example: z.string().max(60).optional() }).optional(),
  // Required except for AUTHENTICATION, whose text Meta writes itself.
  body: z.object({ text: z.string().trim().min(1).max(1024), examples: z.array(z.string().min(1)).optional() }).optional(),
  footer: z.string().trim().max(60).optional(),
  /** AUTHENTICATION only: add "Por tu seguridad, no compartas este código" (default true). */
  security_recommendation: z.boolean().optional(),
  /** AUTHENTICATION only: "Este código caduca en N minutos" in the footer. */
  code_expiration_minutes: z.number().int().min(1).max(90).optional(),
  /** AUTHENTICATION only: label of the copy-code button (WhatsApp's own label when omitted). */
  otp_button_text: z.string().trim().min(1).max(25).optional(),
  buttons: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1).max(25) }),
        // Meta's limit for a button URL; it also bounds the work done on it here.
        z.object({
          type: z.literal('URL'),
          text: z.string().trim().min(1).max(25),
          url: z.string().url().max(2000),
          example: z.string().url().max(2000).optional(),
        }),
        z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().trim().min(1).max(25), phone_number: z.string().regex(/^\+?\d{8,15}$/) }),
      ]),
    )
    .max(10)
    .optional(),
});

/**
 * Authentication templates have no free text: Meta writes the body ("<code> es tu código de
 * verificación") in the template's language, the footer only takes the expiration and exactly
 * one one-time-password button is required. Header, body text, footer text and other buttons
 * are not allowed, so the simple form's are ignored.
 */
function buildAuthComponents(b: z.infer<typeof createSchema>) {
  const components: any[] = [{ type: 'BODY', add_security_recommendation: b.security_recommendation ?? true }];
  if (b.code_expiration_minutes) components.push({ type: 'FOOTER', code_expiration_minutes: b.code_expiration_minutes });
  const button: any = { type: 'OTP', otp_type: 'COPY_CODE' };
  if (b.otp_button_text) button.text = b.otp_button_text;
  components.push({ type: 'BUTTONS', buttons: [button] });
  return { components, parameter_format: undefined };
}

/** Turns the simple form into Meta's template components (with the examples Meta requires). */
export function buildCreateComponents(b: z.infer<typeof createSchema>) {
  if (b.category === 'AUTHENTICATION') return buildAuthComponents(b);
  if (!b.body) throw badRequest('Escribe el texto del mensaje');
  const components: any[] = [];
  const named = [b.header?.text, b.body.text].some((t) => variablesIn(t).some((v) => !/^\d+$/.test(v)));
  if (b.header) {
    const vars = variablesIn(b.header.text);
    const h: any = { type: 'HEADER', format: 'TEXT', text: b.header.text };
    if (vars.length) {
      if (!b.header.example) throw badRequest('Agrega un ejemplo para la variable del encabezado');
      h.example = named
        ? { header_text_named_params: [{ param_name: vars[0], example: b.header.example }] }
        : { header_text: [b.header.example] };
    }
    components.push(h);
  }
  // One example per variable in order of appearance (as the editor lists them). Meta reads
  // body_text by number, {{1}} first, wherever each variable sits in the text.
  const vars = variablesIn(b.body.text);
  const body: any = { type: 'BODY', text: b.body.text };
  if (vars.length) {
    const ex = b.body.examples ?? [];
    if (ex.length < vars.length) throw badRequest(`Agrega un ejemplo para cada variable del cuerpo (${vars.length})`);
    const exampleOf = new Map(vars.map((v, i) => [v, ex[i]]));
    body.example = named
      ? { body_text_named_params: vars.map((v) => ({ param_name: v, example: exampleOf.get(v) })) }
      : { body_text: [orderedVariables(b.body.text).map((v) => exampleOf.get(v))] };
  }
  components.push(body);
  if (b.footer) components.push({ type: 'FOOTER', text: b.footer });
  if (b.buttons?.length) {
    components.push({
      type: 'BUTTONS',
      buttons: b.buttons.map((btn) =>
        btn.type === 'URL' && variablesIn(btn.url).length ? { ...btn, example: [btn.example ?? btn.url.replace(/\{\{[^{}]*\}\}/g, 'ejemplo')] } : btn,
      ),
    });
  }
  return { components, parameter_format: named ? ('NAMED' as const) : ('POSITIONAL' as const) };
}

export async function templateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/templates', async (req) => {
    const a = await requireWs(ctx, req);
    const q = parse(z.object({ channel_id: uuid.optional(), status: z.string().optional() }), req.query);
    const { rows } = await ctx.db.query<TemplateRow>(
      `SELECT * FROM templates WHERE workspace_id = $1 AND ($2::uuid IS NULL OR channel_id = $2::uuid) AND ($3::text IS NULL OR status = $3)
       ORDER BY name, language`,
      [a.workspaceId, q.channel_id ?? null, q.status ?? null],
    );
    return { templates: rows.map(withSchema) };
  });

  app.post('/api/templates/sync', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(z.object({ channel_id: uuid.optional() }), req.body ?? {});
    const channel = await getChannel(ctx.db, a.workspaceId, body.channel_id);
    try {
      const count = await syncTemplates(ctx, channel);
      return { synced: count };
    } catch (err) {
      if (err instanceof MetaApiError) throw metaError(err);
      throw err;
    }
  });

  app.post('/api/templates', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(createSchema, req.body);
    const channel = await getChannel(ctx.db, a.workspaceId, body.channel_id);
    const { components, parameter_format } = buildCreateComponents(body);
    try {
      const t = await createTemplate(ctx, channel, {
        name: body.name,
        language: body.language,
        category: body.category,
        components,
        parameter_format,
      });
      return { template: withSchema(t) };
    } catch (err) {
      if (err instanceof MetaApiError) throw metaError(err, 'Meta rechazó la plantilla: ');
      throw err;
    }
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { rows } = await ctx.db.query<TemplateRow>(`SELECT * FROM templates WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    const t = rows[0];
    if (!t) throw notFound('Plantilla');
    const channel = await getChannel(ctx.db, a.workspaceId, t.channel_id);
    try {
      await providerFor(ctx, channel).deleteTemplate(t.name);
    } catch (err) {
      if (err instanceof MetaApiError) throw metaError(err);
      throw err;
    }
    await ctx.db.query(`DELETE FROM templates WHERE channel_id = $1 AND name = $2`, [t.channel_id, t.name]);
    return noContent(reply);
  });
}
