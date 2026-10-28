import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { renderPlaceholders } from '../services/broadcasts.js';
import { CONTACT_COLUMNS, createContact, getContact, updateContact } from '../services/contacts.js';
import { addNote, isWindowOpen, sendMessage, type SendContent } from '../services/messages.js';
import { cancelScheduled, scheduleMessage } from '../services/scheduled.js';
import type { MessageRow } from '../types.js';
import { getChannel, providerFor } from '../whatsapp/provider.js';
import type { TemplateParams } from '../whatsapp/types.js';
import { ADMIN_ROLES, agentRestricted, noContent, parse, requireWs, uuid, type WsAuth } from './helpers.js';

const boolish = z
  .enum(['1', '0', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional();

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  funnel_id: uuid.optional(),
  stage_id: uuid.optional(),
  tag_id: uuid.optional(),
  inbox: z.enum(['all', 'mine', 'unassigned']).optional(),
  assigned_user_id: uuid.optional(),
  unread: boolish,
  archived: boolish,
  has_messages: boolish,
  opted_out: boolish,
  sort: z.enum(['recent', 'created', 'name', 'value']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
type ListFilters = z.infer<typeof listSchema>;

const visibilityFilter = agentRestricted;

function buildWhere(a: WsAuth, f: Partial<ListFilters>, restrictToMine: boolean) {
  const params: unknown[] = [a.workspaceId];
  const conds = ['c.workspace_id = $1'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.search) {
    const digits = f.search.replace(/\D/g, '');
    const like = p(`%${f.search}%`);
    conds.push(
      `(c.name ILIKE ${like} OR c.email ILIKE ${like} OR c.company ILIKE ${like}${digits.length >= 3 ? ` OR c.phone LIKE ${p(`%${digits}%`)}` : ''})`,
    );
  }
  if (f.funnel_id) conds.push(`c.funnel_id = ${p(f.funnel_id)}`);
  if (f.stage_id) conds.push(`c.stage_id = ${p(f.stage_id)}`);
  if (f.tag_id) conds.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ${p(f.tag_id)})`);
  if (f.inbox === 'mine') conds.push(`c.assigned_user_id = ${p(a.user.id)}`);
  if (f.inbox === 'unassigned') conds.push('c.assigned_user_id IS NULL');
  if (f.assigned_user_id) conds.push(`c.assigned_user_id = ${p(f.assigned_user_id)}`);
  if (f.unread) conds.push('c.unread_count > 0');
  conds.push(f.archived ? 'c.is_archived' : 'NOT c.is_archived');
  if (f.has_messages) conds.push('c.last_message_at IS NOT NULL');
  if (f.opted_out !== undefined) conds.push(f.opted_out ? 'c.opted_out' : 'NOT c.opted_out');
  if (restrictToMine) conds.push(`(c.assigned_user_id = ${p(a.user.id)} OR c.assigned_user_id IS NULL)`);
  return { where: conds.join(' AND '), params };
}

const ORDER: Record<string, string> = {
  recent: 'c.last_message_at DESC NULLS LAST, c.created_at DESC',
  created: 'c.created_at DESC',
  name: 'c.name ASC NULLS LAST',
  value: 'c.deal_value DESC',
};

const templateParamsSchema = z.object({
  header: z
    .union([
      z.object({ type: z.literal('text'), text: z.string().min(1).max(60) }),
      z.object({ type: z.enum(['image', 'video', 'document']), link: z.string().url(), filename: z.string().optional() }),
    ])
    .optional(),
  body: z.array(z.string().max(1024)).max(30).optional(),
  bodyNamed: z.record(z.string(), z.string().max(1024)).optional(),
  buttons: z.array(z.object({ index: z.number().int().min(0).max(9), text: z.string().min(1).max(200) })).optional(),
});

const sendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4096), reply_to_wamid: z.string().optional() }),
  z.object({ type: z.literal('media'), media_file_id: uuid, caption: z.string().max(1024).optional() }),
  z.object({ type: z.literal('template'), name: z.string().min(1), language: z.string().min(2), params: templateParamsSchema.optional() }),
  z.object({ type: z.literal('quick_reply'), quick_reply_id: uuid }),
]);

function renderTemplateParams(p: TemplateParams | undefined, contact: Parameters<typeof renderPlaceholders>[1]): TemplateParams | undefined {
  if (!p) return p;
  const r = (s: string) => renderPlaceholders(s, contact);
  return {
    header: p.header?.type === 'text' ? { type: 'text', text: r(p.header.text) } : p.header,
    body: p.body?.map(r),
    bodyNamed: p.bodyNamed ? Object.fromEntries(Object.entries(p.bodyNamed).map(([k, v]) => [k, r(v)])) : undefined,
    buttons: p.buttons?.map((b) => ({ index: b.index, text: r(b.text) })),
  };
}

const HEADER_ALIASES: Record<string, string> = {
  telefono: 'phone', phone: 'phone', celular: 'phone', whatsapp: 'phone', numero: 'phone', movil: 'phone', tel: 'phone',
  nombre: 'name', name: 'name', 'nombre completo': 'name',
  correo: 'email', email: 'email', 'correo electronico': 'email', mail: 'email',
  empresa: 'company', company: 'company', negocio: 'company',
  etiquetas: 'tags', tags: 'tags', etiqueta: 'tags',
  valor: 'deal_value', monto: 'deal_value', deal_value: 'deal_value', 'valor de venta': 'deal_value',
};
const normHeader = (h: string) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export async function contactRoutes(app: FastifyInstance, ctx: AppContext) {
  async function ensureVisible(a: WsAuth, contactId: string) {
    const contact = await getContact(ctx.db, a.workspaceId, contactId);
    if ((await visibilityFilter(ctx, a)) && contact.assigned_user_id && contact.assigned_user_id !== a.user.id) {
      throw badRequest('Este contacto está asignado a otra persona', 'NOT_ASSIGNED_TO_YOU');
    }
    return contact;
  }

  app.get('/api/contacts', async (req) => {
    const a = await requireWs(ctx, req);
    const f = parse(listSchema, req.query);
    const { where, params } = buildWhere(a, f, await visibilityFilter(ctx, a));
    const total = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params);
    const { rows } = await ctx.db.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE ${where} ORDER BY ${ORDER[f.sort]} LIMIT ${f.limit} OFFSET ${(f.page - 1) * f.limit}`,
      params,
    );
    return { items: rows, total: total.rows[0].n, page: f.page, limit: f.limit };
  });

  app.get('/api/contacts/counts', async (req) => {
    const a = await requireWs(ctx, req);
    const restricted = await visibilityFilter(ctx, a);
    const vis = restricted ? `AND (assigned_user_id = $2 OR assigned_user_id IS NULL)` : '';
    const { rows } = await ctx.db.query<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE last_message_at IS NOT NULL)::int AS all,
         count(*) FILTER (WHERE last_message_at IS NOT NULL AND assigned_user_id = $2)::int AS mine,
         count(*) FILTER (WHERE last_message_at IS NOT NULL AND assigned_user_id IS NULL)::int AS unassigned,
         count(*) FILTER (WHERE unread_count > 0)::int AS unread
       FROM contacts WHERE workspace_id = $1 AND NOT is_archived ${vis}`,
      [a.workspaceId, a.user.id],
    );
    return rows[0];
  });

  app.post('/api/contacts', async (req) => {
    const a = await requireWs(ctx, req);
    const body = parse(
      z.object({
        phone: z.string().min(6),
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().email('Correo inválido').optional().or(z.literal('')),
        company: z.string().trim().max(120).optional(),
        funnel_id: uuid.optional(),
        stage_id: uuid.optional(),
        assigned_user_id: uuid.optional(),
        deal_value: z.number().min(0).optional(),
        custom_fields: z.record(z.string(), z.any()).optional(),
        tag_ids: z.array(uuid).optional(),
      }),
      req.body,
    );
    const { contact, created } = await createContact(
      ctx,
      a.workspaceId,
      {
        phone: body.phone,
        name: body.name,
        email: body.email || null,
        company: body.company,
        funnelId: body.funnel_id,
        stageId: body.stage_id,
        assignedUserId: body.assigned_user_id,
        dealValue: body.deal_value,
        customFields: body.custom_fields,
        tagIds: body.tag_ids,
        source: 'manual',
      },
      { userId: a.user.id },
    );
    return { contact, created };
  });

  app.get('/api/contacts/export.csv', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const f = parse(listSchema.partial(), req.query);
    const { where, params } = buildWhere(a, { ...f, archived: f.archived }, false);
    const { rows } = await ctx.db.query(
      `SELECT c.phone, c.name, c.email, c.company, c.deal_value, c.source, c.created_at, c.last_message_at, c.custom_fields,
         f.name AS funnel, s.name AS stage, u.name AS assigned_to,
         (SELECT string_agg(t.name, ';') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
       FROM contacts c LEFT JOIN funnels f ON f.id = c.funnel_id LEFT JOIN stages s ON s.id = c.stage_id LEFT JOIN users u ON u.id = c.assigned_user_id
       WHERE ${where} ORDER BY c.created_at`,
      params,
    );
    // Spreadsheet apps execute cells starting with = + - @: WhatsApp names are user-controlled.
    const cell = (v: unknown) => {
      const t = v == null ? '' : String(v);
      return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    };
    const csv = stringify(
      rows.map((r: any) => ({
        telefono: `+${r.phone}`,
        nombre: cell(r.name ?? ''),
        correo: cell(r.email ?? ''),
        empresa: cell(r.company ?? ''),
        embudo: cell(r.funnel ?? ''),
        etapa: cell(r.stage ?? ''),
        asignado_a: cell(r.assigned_to ?? ''),
        etiquetas: cell(r.tags ?? ''),
        valor: r.deal_value,
        origen: r.source,
        creado: new Date(r.created_at).toISOString(),
        ultimo_mensaje: r.last_message_at ? new Date(r.last_message_at).toISOString() : '',
        campos: cell(JSON.stringify(r.custom_fields ?? {})),
      })),
      { header: true },
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`);
    return '﻿' + csv;
  });

  app.post('/api/contacts/import', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({ csv: z.string().min(1).max(10_000_000), funnel_id: uuid.optional(), stage_id: uuid.optional(), tag_ids: z.array(uuid).optional() }),
      req.body,
    );
    let records: Record<string, string>[];
    try {
      records = parseCsv(body.csv.replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
    } catch (err) {
      throw badRequest(`No se pudo leer el CSV: ${(err as Error).message}`);
    }
    if (records.length > 20_000) throw badRequest('Máximo 20,000 filas por importación');
    const tagsRes = await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM tags WHERE workspace_id = $1`, [a.workspaceId]);
    const tagByName = new Map(tagsRes.rows.map((t) => [t.name.toLowerCase(), t.id]));
    let created = 0;
    let existing = 0;
    const errors: { row: number; error: string }[] = [];
    for (const [i, rec] of records.entries()) {
      const mapped: Record<string, string> = {};
      const custom: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        const target = HEADER_ALIASES[normHeader(k)];
        if (target) mapped[target] = v;
        else if (v) custom[k.trim()] = v;
      }
      if (!mapped.phone) {
        errors.push({ row: i + 2, error: 'Falta el teléfono' });
        continue;
      }
      const tagIds = [...(body.tag_ids ?? [])];
      for (const name of (mapped.tags ?? '').split(/[;,|]/).map((s) => s.trim()).filter(Boolean)) {
        let id = tagByName.get(name.toLowerCase());
        if (!id) {
          const t = await ctx.db.query<{ id: string }>(
            `INSERT INTO tags (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [a.workspaceId, name],
          );
          id = t.rows[0].id;
          tagByName.set(name.toLowerCase(), id);
        }
        tagIds.push(id);
      }
      try {
        const r = await createContact(
          ctx,
          a.workspaceId,
          {
            phone: mapped.phone,
            name: mapped.name,
            email: mapped.email && mapped.email.includes('@') ? mapped.email : null,
            company: mapped.company,
            dealValue: mapped.deal_value ? Number(String(mapped.deal_value).replace(/[^\d.]/g, '')) || 0 : 0,
            customFields: custom,
            funnelId: body.funnel_id,
            stageId: body.stage_id,
            tagIds,
            source: 'import',
          },
          { userId: a.user.id },
        );
        if (r.created) created++;
        else {
          existing++;
          if (tagIds.length) await updateContact(ctx, a.workspaceId, r.contact.id, { addTagIds: tagIds });
        }
      } catch (err) {
        errors.push({ row: i + 2, error: (err as Error).message });
      }
    }
    return { total: records.length, created, existing, errors: errors.slice(0, 200), error_count: errors.length };
  });

  app.post('/api/contacts/bulk', async (req) => {
    const a = await requireWs(ctx, req);
    const body = parse(
      z.object({
        ids: z.array(uuid).min(1).max(5000),
        action: z.enum(['add_tags', 'remove_tags', 'move_stage', 'assign', 'archive', 'unarchive', 'opt_out', 'delete']),
        tag_ids: z.array(uuid).optional(),
        stage_id: uuid.optional(),
        user_id: uuid.nullable().optional(),
      }),
      req.body,
    );
    if (['delete', 'opt_out'].includes(body.action) && a.role === 'agent') throw badRequest('Solo administradores pueden hacer esta acción');
    if (await visibilityFilter(ctx, a)) {
      const visible = await ctx.db.query<{ id: string }>(
        `SELECT id FROM contacts WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND (assigned_user_id = $3 OR assigned_user_id IS NULL)`,
        [a.workspaceId, body.ids, a.user.id],
      );
      body.ids = visible.rows.map((r) => r.id);
    }
    if (body.action === 'delete') {
      const r = await ctx.db.query(`DELETE FROM contacts WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [a.workspaceId, body.ids]);
      ctx.realtime.emit(a.workspaceId, 'contacts:bulk', { action: 'delete', ids: body.ids });
      return { updated: r.rowCount };
    }
    let updated = 0;
    for (const id of body.ids) {
      const patch: Parameters<typeof updateContact>[3] = {};
      if (body.action === 'add_tags') patch.addTagIds = body.tag_ids ?? [];
      if (body.action === 'remove_tags') patch.removeTagIds = body.tag_ids ?? [];
      if (body.action === 'move_stage') {
        if (!body.stage_id) throw badRequest('Elige la etapa destino');
        patch.stageId = body.stage_id;
      }
      if (body.action === 'assign') patch.assignedUserId = body.user_id ?? null;
      if (body.action === 'archive') patch.isArchived = true;
      if (body.action === 'unarchive') patch.isArchived = false;
      if (body.action === 'opt_out') patch.optedOut = true;
      try {
        await updateContact(ctx, a.workspaceId, id, patch, { userId: a.user.id });
        updated++;
      } catch {
        // contact deleted meanwhile or not in workspace: skip
      }
    }
    return { updated };
  });

  app.get('/api/contacts/:id', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    const events = await ctx.db.query(
      `SELECT e.*, u.name AS user_name FROM contact_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.contact_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
      [id],
    );
    const scheduled = await ctx.db.query(
      `SELECT * FROM scheduled_messages WHERE contact_id = $1 AND status = 'pending' ORDER BY send_at`,
      [id],
    );
    return { contact, events: events.rows, scheduled: scheduled.rows, window_open: isWindowOpen(contact.last_inbound_at) };
  });

  app.patch('/api/contacts/:id', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ensureVisible(a, id);
    const body = parse(
      z.object({
        name: z.string().trim().max(120).nullable().optional(),
        email: z.string().trim().email('Correo inválido').nullable().optional().or(z.literal('')),
        company: z.string().trim().max(120).nullable().optional(),
        deal_value: z.number().min(0).optional(),
        custom_fields: z.record(z.string(), z.any()).optional(),
        funnel_id: uuid.optional(),
        stage_id: uuid.optional(),
        assigned_user_id: uuid.nullable().optional(),
        ai_paused: z.boolean().optional(),
        is_archived: z.boolean().optional(),
        opted_out: z.boolean().optional(),
        tag_ids: z.array(uuid).optional(),
        add_tag_ids: z.array(uuid).optional(),
        remove_tag_ids: z.array(uuid).optional(),
        reset_bot: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.reset_bot) await ctx.db.query(`UPDATE contacts SET bot_state = NULL WHERE id = $1`, [id]);
    const contact = await updateContact(
      ctx,
      a.workspaceId,
      id,
      {
        name: body.name,
        email: body.email === '' ? null : body.email,
        company: body.company,
        dealValue: body.deal_value,
        customFields: body.custom_fields,
        funnelId: body.funnel_id,
        stageId: body.stage_id,
        assignedUserId: body.assigned_user_id,
        aiPaused: body.ai_paused,
        isArchived: body.is_archived,
        optedOut: body.opted_out,
        tagIds: body.tag_ids,
        addTagIds: body.add_tag_ids,
        removeTagIds: body.remove_tag_ids,
      },
      { userId: a.user.id },
    );
    return { contact };
  });

  app.delete('/api/contacts/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ctx.db.query(`DELETE FROM contacts WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    ctx.realtime.emit(a.workspaceId, 'contacts:bulk', { action: 'delete', ids: [id] });
    return noContent(reply);
  });

  // ---- Conversation ----
  app.get('/api/contacts/:id/messages', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }), req.query);
    await ensureVisible(a, id);
    const { rows } = await ctx.db.query<MessageRow>(
      `SELECT m.*, mf.mime AS file_mime, mf.filename AS file_name, mf.size AS file_size, u.name AS user_name
       FROM messages m LEFT JOIN media_files mf ON mf.id = m.media_file_id LEFT JOIN users u ON u.id = m.user_id
       WHERE m.contact_id = $1 AND m.workspace_id = $2 ${q.before ? 'AND m.created_at < $3' : ''}
       ORDER BY m.created_at DESC LIMIT ${q.limit}`,
      q.before ? [id, a.workspaceId, q.before] : [id, a.workspaceId],
    );
    return { messages: rows.reverse(), has_more: rows.length === q.limit };
  });

  app.post('/api/contacts/:id/messages', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    const body = parse(sendSchema, req.body);
    const send = (content: SendContent, replyTo?: string) =>
      sendMessage(ctx, { workspaceId: a.workspaceId, contactId: id, content, sentBy: 'user', userId: a.user.id, replyToWamid: replyTo });
    if (body.type === 'quick_reply') {
      const qr = await ctx.db.query<{ body: string; media_file_id: string | null }>(
        `SELECT body, media_file_id FROM quick_replies WHERE id = $1 AND workspace_id = $2`,
        [body.quick_reply_id, a.workspaceId],
      );
      if (!qr.rows[0]) throw badRequest('Respuesta rápida no encontrada');
      const text = renderPlaceholders(qr.rows[0].body, contact, false);
      const messages = [];
      if (qr.rows[0].media_file_id) messages.push(await send({ type: 'media', mediaFileId: qr.rows[0].media_file_id, caption: text }));
      else messages.push(await send({ type: 'text', text }));
      return { message: messages[0] };
    }
    if (body.type === 'text') return { message: await send({ type: 'text', text: body.text }, body.reply_to_wamid) };
    if (body.type === 'media') return { message: await send({ type: 'media', mediaFileId: body.media_file_id, caption: body.caption }) };
    return {
      message: await send({ type: 'template', name: body.name, language: body.language, params: renderTemplateParams(body.params, contact) }),
    };
  });

  app.post('/api/contacts/:id/notes', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ensureVisible(a, id);
    const body = parse(z.object({ text: z.string().trim().min(1).max(4000) }), req.body);
    return { message: await addNote(ctx, a.workspaceId, id, a.user.id, body.text) };
  });

  app.post('/api/contacts/:id/read', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    if (contact.unread_count > 0) {
      await ctx.db.query(`UPDATE contacts SET unread_count = 0 WHERE id = $1`, [id]);
      const last = await ctx.db.query<{ wamid: string; channel_id: string }>(
        `SELECT wamid, channel_id FROM messages WHERE contact_id = $1 AND direction = 'in' AND wamid IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      if (last.rows[0]) {
        try {
          const ch = await getChannel(ctx.db, a.workspaceId, last.rows[0].channel_id);
          await providerFor(ctx, ch).markRead(last.rows[0].wamid);
        } catch (err) {
          ctx.log.debug({ err: (err as Error).message }, 'markRead failed');
        }
      }
      ctx.realtime.emit(a.workspaceId, 'contact:update', await getContact(ctx.db, a.workspaceId, id));
    }
    return { ok: true };
  });

  // ---- Scheduled messages ----
  app.get('/api/scheduled', async (req) => {
    const a = await requireWs(ctx, req);
    const restricted = await visibilityFilter(ctx, a);
    const { rows } = await ctx.db.query(
      `SELECT s.*, c.name AS contact_name, c.phone AS contact_phone, u.name AS created_by_name FROM scheduled_messages s
       JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = s.created_by
       WHERE s.workspace_id = $1 AND (s.status = 'pending' OR s.send_at > now() - interval '7 days')
         AND (NOT $2 OR c.assigned_user_id IS NULL OR c.assigned_user_id = $3)
       ORDER BY s.send_at`,
      [a.workspaceId, restricted, a.user.id],
    );
    return { scheduled: rows };
  });

  app.post('/api/contacts/:id/scheduled', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ensureVisible(a, id);
    const body = parse(
      z.object({
        send_at: z.string().datetime({ offset: true }),
        content: z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string().min(1).max(4096) }),
          z.object({ type: z.literal('template'), name: z.string().min(1), language: z.string().min(2), params: templateParamsSchema.optional() }),
        ]),
      }),
      req.body,
    );
    const s = await scheduleMessage(ctx, a.workspaceId, id, a.user.id, body.content as SendContent, new Date(body.send_at));
    return { scheduled: s };
  });

  app.delete('/api/scheduled/:id', async (req, reply) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const s = await ctx.db.query<{ contact_id: string }>(`SELECT contact_id FROM scheduled_messages WHERE id = $1 AND workspace_id = $2`, [
      id,
      a.workspaceId,
    ]);
    if (s.rows[0]) await ensureVisible(a, s.rows[0].contact_id);
    await cancelScheduled(ctx, a.workspaceId, id);
    return noContent(reply);
  });

  // ---- Kanban board ----
  app.get('/api/funnels/:id/board', async (req: FastifyRequest) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const f = parse(listSchema.pick({ search: true, tag_id: true, assigned_user_id: true, inbox: true }), req.query);
    const stages = await ctx.db.query<{ id: string }>(`SELECT * FROM stages WHERE funnel_id = $1 AND workspace_id = $2 ORDER BY position`, [
      id,
      a.workspaceId,
    ]);
    const { where, params } = buildWhere(a, { ...f, funnel_id: id }, await visibilityFilter(ctx, a));
    const totals = await ctx.db.query<{ stage_id: string; count: number; value: number }>(
      `SELECT c.stage_id, count(*)::int AS count, COALESCE(sum(c.deal_value), 0)::float AS value FROM contacts c WHERE ${where} GROUP BY c.stage_id`,
      params,
    );
    const { rows } = await ctx.db.query<any>(
      `SELECT * FROM (
         SELECT ${CONTACT_COLUMNS}, row_number() OVER (PARTITION BY c.stage_id ORDER BY c.stage_changed_at DESC NULLS LAST, c.created_at DESC) AS rn
         FROM contacts c WHERE ${where}
       ) x WHERE x.rn <= 100`,
      params,
    );
    return {
      stages: stages.rows.map((s) => {
        const t = totals.rows.find((r) => r.stage_id === s.id);
        return { ...s, count: t?.count ?? 0, value: t?.value ?? 0, contacts: rows.filter((c) => c.stage_id === s.id) };
      }),
    };
  });
}
