import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { renderPlaceholders } from '../services/broadcasts.js';
import { CONTACT_COLUMNS, createContact, updateContact, type Contact } from '../services/contacts.js';
import { WEBHOOK_EVENTS } from '../services/events.js';
import { getWorkspace, sendMessage } from '../services/messages.js';
import { listFunnels } from './crm.js';
import { ADMIN_ROLES, noContent, parse, requireApiKey, requireWs, uuid } from './helpers.js';

const publicUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'Usa una URL http(s)');

export async function integrationRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- API keys ----
  app.get('/api/api-keys', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { rows } = await ctx.db.query(
      `SELECT id, name, prefix, last_used_at, created_at FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [a.workspaceId],
    );
    return { api_keys: rows };
  });

  app.post('/api/api-keys', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    const key = `ll_live_${randomToken(24)}`;
    const { rows } = await ctx.db.query(
      `INSERT INTO api_keys (workspace_id, name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, prefix, created_at`,
      [a.workspaceId, body.name, key.slice(0, 14), sha256Hex(key), a.user.id],
    );
    return { api_key: rows[0], key };
  });

  app.delete('/api/api-keys/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ctx.db.query(`DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    return noContent(reply);
  });

  // ---- Outgoing webhooks ----
  app.get('/api/webhooks', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { rows } = await ctx.db.query(`SELECT * FROM webhook_endpoints WHERE workspace_id = $1 ORDER BY created_at`, [a.workspaceId]);
    return { webhooks: rows, events: WEBHOOK_EVENTS };
  });

  app.post('/api/webhooks', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(z.object({ url: publicUrl, events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).default([]) }), req.body);
    const { rows } = await ctx.db.query(
      `INSERT INTO webhook_endpoints (workspace_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING *`,
      [a.workspaceId, body.url, `whsec_${randomToken(24)}`, body.events],
    );
    return { webhook: rows[0] };
  });

  app.patch('/api/webhooks/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ url: publicUrl.optional(), events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).optional(), is_active: z.boolean().optional() }),
      req.body,
    );
    const { rows } = await ctx.db.query(
      `UPDATE webhook_endpoints SET url = COALESCE($3, url), events = COALESCE($4, events), is_active = COALESCE($5, is_active)
       WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [id, a.workspaceId, body.url ?? null, body.events ?? null, body.is_active ?? null],
    );
    if (!rows[0]) throw notFound('Webhook');
    return { webhook: rows[0] };
  });

  app.delete('/api/webhooks/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ctx.db.query(`DELETE FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    return noContent(reply);
  });

  app.post('/api/webhooks/:id/test', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { rows } = await ctx.db.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    if (!rows[0]) throw notFound('Webhook');
    await ctx.queue.enqueue('webhook.deliver', { endpointId: id, event: 'ping', data: { message: 'Hola desde LeadLibre 👋' }, sentAt: new Date().toISOString() }, { maxAttempts: 1 });
    return { queued: true };
  });

  // ---- Public REST API (API key) — for Make, Zapier, n8n, forms, Facebook Lead Ads... ----
  async function findByPhone(workspaceId: string, phone: string): Promise<Contact | null> {
    const ws = await getWorkspace(ctx, workspaceId);
    const { rows } = await ctx.db.query<Contact>(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.workspace_id = $1 AND c.phone = $2`, [
      workspaceId,
      normalizePhone(phone, ws.default_country_code),
    ]);
    return rows[0] ?? null;
  }

  async function resolveStage(workspaceId: string, funnel?: string, stage?: string) {
    if (!funnel && !stage) return {};
    const funnels = await listFunnels(ctx, workspaceId);
    const f = funnel ? funnels.find((x: any) => x.id === funnel || x.name.toLowerCase() === funnel.toLowerCase()) : null;
    if (funnel && !f) throw badRequest(`No existe el embudo "${funnel}"`);
    if (!stage) return { funnelId: f.id as string };
    const pool = f ? [f] : funnels;
    for (const fx of pool) {
      const s = fx.stages.find((x: any) => x.id === stage || x.name.toLowerCase() === stage.toLowerCase());
      if (s) return { stageId: s.id as string };
    }
    throw badRequest(`No existe la etapa "${stage}"`);
  }

  async function tagIdsByName(workspaceId: string, names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      const t = await ctx.db.query<{ id: string }>(
        `INSERT INTO tags (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [workspaceId, name],
      );
      ids.push(t.rows[0].id);
    }
    return ids;
  }

  app.get('/api/v1/funnels', async (req) => {
    const k = await requireApiKey(ctx, req);
    return { funnels: await listFunnels(ctx, k.workspaceId) };
  });

  app.get('/api/v1/contacts', async (req) => {
    const k = await requireApiKey(ctx, req);
    const q = parse(z.object({ phone: z.string().min(6) }), req.query);
    const contact = await findByPhone(k.workspaceId, q.phone);
    if (!contact) throw notFound('Contacto');
    return { contact };
  });

  const upsertSchema = z.object({
    phone: z.string().min(6),
    name: z.string().trim().max(120).optional(),
    email: z.string().trim().email().optional(),
    company: z.string().trim().max(120).optional(),
    deal_value: z.number().min(0).optional(),
    custom_fields: z.record(z.string(), z.any()).optional(),
    tags: z.array(z.string()).optional(),
    funnel: z.string().optional(),
    stage: z.string().optional(),
    source: z.string().max(40).optional(),
  });

  app.post('/api/v1/contacts', async (req) => {
    const k = await requireApiKey(ctx, req);
    const body = parse(upsertSchema, req.body);
    const placement = await resolveStage(k.workspaceId, body.funnel, body.stage);
    const tagIds = await tagIdsByName(k.workspaceId, body.tags ?? []);
    const { contact, created } = await createContact(ctx, k.workspaceId, {
      phone: body.phone,
      name: body.name,
      email: body.email,
      company: body.company,
      dealValue: body.deal_value,
      customFields: body.custom_fields,
      tagIds,
      source: body.source ?? 'api',
      ...placement,
    });
    if (created) return { contact, created };
    const updated = await updateContact(ctx, k.workspaceId, contact.id, {
      name: body.name ?? undefined,
      email: body.email ?? undefined,
      company: body.company ?? undefined,
      dealValue: body.deal_value,
      customFields: body.custom_fields ? { ...contact.custom_fields, ...body.custom_fields } : undefined,
      addTagIds: tagIds,
      stageId: placement.stageId,
      funnelId: placement.funnelId,
    });
    return { contact: updated, created: false };
  });

  app.post('/api/v1/messages', async (req) => {
    const k = await requireApiKey(ctx, req);
    const body = parse(
      z.object({
        phone: z.string().min(6),
        name: z.string().optional(),
        text: z.string().min(1).max(4096).optional(),
        template: z
          .object({
            name: z.string().min(1),
            language: z.string().min(2).default('es_MX'),
            header: z.string().optional(),
            body: z.array(z.string()).optional(),
            buttons: z.array(z.object({ index: z.number().int(), text: z.string() })).optional(),
          })
          .optional(),
      }),
      req.body,
    );
    if (!body.text && !body.template) throw badRequest('Envía "text" o "template"');
    let contact = await findByPhone(k.workspaceId, body.phone);
    if (!contact) contact = (await createContact(ctx, k.workspaceId, { phone: body.phone, name: body.name, source: 'api' })).contact;
    const r = (s: string) => renderPlaceholders(s, contact!);
    const message = await sendMessage(ctx, {
      workspaceId: k.workspaceId,
      contactId: contact.id,
      sentBy: 'api',
      content: body.template
        ? {
            type: 'template',
            name: body.template.name,
            language: body.template.language,
            params: {
              header: body.template.header ? { type: 'text', text: r(body.template.header) } : undefined,
              body: body.template.body?.map(r),
              buttons: body.template.buttons,
            },
          }
        : { type: 'text', text: body.text! },
    });
    if (message.status === 'failed') {
      throw new AppError(502, 'SEND_FAILED', message.error?.message ?? 'No se pudo enviar', { message });
    }
    return { message, contact_id: contact.id };
  });
}
