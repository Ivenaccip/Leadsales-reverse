import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidPhone, normalizePhone } from '../lib/phone.js';
import type { ContactRow } from '../types.js';
import { pickAssignee } from './assignment.js';
import { dispatchWebhook, recordEvent } from './events.js';

export type Contact = ContactRow & { tag_ids: string[] };

/*
 * Custom fields: one set of limits for every way in (the inbox, the public API, the CSV import).
 * Every byte is stored, sent with every list page, socket event and webhook of the contact.
 */
export const CUSTOM_FIELD_KEY_MAX = 100;
export const CUSTOM_FIELD_VALUE_MAX = 1000;
export const CUSTOM_FIELDS_MAX_KEYS = 100;
export const CUSTOM_FIELDS_MAX_BYTES = 64 * 1024;

const customFieldValue = z.union([z.string().max(CUSTOM_FIELD_VALUE_MAX, `Máximo ${CUSTOM_FIELD_VALUE_MAX} caracteres por campo personalizado`), z.number(), z.boolean(), z.null()], {
  error: `Cada campo personalizado admite texto (máximo ${CUSTOM_FIELD_VALUE_MAX} caracteres), un número, sí/no o vacío`,
});

/** Size limits of a whole set of custom fields (also after the public API merges it into the stored one). */
export function customFieldsTooBig(fields: Record<string, unknown>): string | null {
  if (Object.keys(fields).length > CUSTOM_FIELDS_MAX_KEYS) return `Máximo ${CUSTOM_FIELDS_MAX_KEYS} campos personalizados por contacto`;
  if (Buffer.byteLength(JSON.stringify(fields)) > CUSTOM_FIELDS_MAX_BYTES) {
    return `Los campos personalizados de un contacto admiten máximo ${CUSTOM_FIELDS_MAX_BYTES / 1024} KB`;
  }
  return null;
}

export const customFieldsSchema = z
  .record(
    z
      .string()
      .min(1, 'El nombre de un campo personalizado no puede estar vacío')
      .max(CUSTOM_FIELD_KEY_MAX, `El nombre de un campo personalizado admite máximo ${CUSTOM_FIELD_KEY_MAX} caracteres`),
    customFieldValue,
    // A bad key: say what is wrong with it, not just that it is invalid.
    { error: (iss) => (iss.code === 'invalid_key' ? (iss.issues as { message: string }[] | undefined)?.[0]?.message : undefined) },
  )
  .superRefine((fields, c) => {
    const err = customFieldsTooBig(fields);
    if (err) c.addIssue({ code: 'custom', message: err });
  });

/** Null when these custom fields can be stored, else why not (in Spanish, for the user). */
export function customFieldsError(fields: unknown): string | null {
  const r = customFieldsSchema.safeParse(fields);
  if (r.success) return null;
  const first = r.error.issues[0];
  const key = first?.path?.[0];
  return key !== undefined && first.code !== 'custom' ? `Campo "${String(key).slice(0, 60)}": ${first.message}` : (first?.message ?? 'Campos personalizados inválidos');
}

function assertCustomFields(fields: Record<string, unknown> | undefined) {
  if (fields === undefined) return;
  const err = customFieldsError(fields);
  if (err) throw badRequest(err, 'INVALID_CUSTOM_FIELDS');
}

export const CONTACT_COLUMNS = `c.*,
  COALESCE((SELECT json_agg(ct.tag_id) FROM contact_tags ct WHERE ct.contact_id = c.id), '[]'::json) AS tag_ids`;

export async function getContact(q: Queryable, workspaceId: string, id: string): Promise<Contact> {
  const { rows } = await q.query<Contact>(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.workspace_id = $1 AND c.id = $2`, [
    workspaceId,
    id,
  ]);
  if (!rows[0]) throw notFound('Contacto');
  return rows[0];
}

interface FunnelRow {
  id: string;
  auto_assign: boolean;
  assignee_ids: string[];
}

/** Funnel + first stage for a new lead (the default funnel when none is given). */
export async function defaultPlacement(
  q: Queryable,
  workspaceId: string,
  funnelId?: string | null,
): Promise<{ funnel: FunnelRow | null; stageId: string | null }> {
  const { rows } = await q.query<FunnelRow>(
    `SELECT id, auto_assign, assignee_ids FROM funnels WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
     ORDER BY is_default DESC, position ASC, created_at ASC LIMIT 1`,
    [workspaceId, funnelId ?? null],
  );
  const funnel = rows[0] ?? null;
  if (!funnel) {
    if (funnelId) throw notFound('Embudo');
    return { funnel: null, stageId: null };
  }
  const st = await q.query<{ id: string }>(`SELECT id FROM stages WHERE funnel_id = $1 ORDER BY position ASC, created_at ASC LIMIT 1`, [
    funnel.id,
  ]);
  return { funnel, stageId: st.rows[0]?.id ?? null };
}

async function stageInWorkspace(q: Queryable, workspaceId: string, stageId: string) {
  const { rows } = await q.query<{ id: string; funnel_id: string; name: string; kind: string }>(
    `SELECT id, funnel_id, name, kind FROM stages WHERE id = $1 AND workspace_id = $2`,
    [stageId, workspaceId],
  );
  if (!rows[0]) throw notFound('Etapa');
  return rows[0];
}

async function assertMember(q: Queryable, workspaceId: string, userId: string) {
  const { rows } = await q.query(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
  if (!rows[0]) throw badRequest('El usuario no pertenece a este espacio de trabajo');
}

export async function replaceTags(q: Queryable, workspaceId: string, contactId: string, tagIds: string[]) {
  await q.query(`DELETE FROM contact_tags WHERE contact_id = $1`, [contactId]);
  await addTags(q, workspaceId, contactId, tagIds);
}

export async function addTags(q: Queryable, workspaceId: string, contactId: string, tagIds: string[]) {
  if (!tagIds.length) return;
  await q.query(
    `INSERT INTO contact_tags (contact_id, tag_id)
     SELECT $1, id FROM tags WHERE workspace_id = $2 AND id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [contactId, workspaceId, tagIds],
  );
}

export async function removeTags(q: Queryable, contactId: string, tagIds: string[]) {
  if (!tagIds.length) return;
  await q.query(`DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = ANY($2::uuid[])`, [contactId, tagIds]);
}

export interface CreateContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  source?: string;
  funnelId?: string | null;
  stageId?: string | null;
  assignedUserId?: string | null;
  dealValue?: number;
  customFields?: Record<string, unknown>;
  tagIds?: string[];
  channelId?: string | null;
  waId?: string | null;
}

/**
 * Creates a lead (or returns the existing one with the same phone).
 * New leads land in the default funnel's first stage and are auto-assigned
 * when the funnel has round-robin enabled.
 */
export async function createContact(
  ctx: AppContext,
  workspaceId: string,
  input: CreateContactInput,
  actor: { userId?: string | null } = {},
): Promise<{ contact: Contact; created: boolean }> {
  const ws = await ctx.db.query<{ default_country_code: string }>(`SELECT default_country_code FROM workspaces WHERE id = $1`, [
    workspaceId,
  ]);
  const phone = normalizePhone(input.phone, ws.rows[0]?.default_country_code ?? '52');
  if (!isValidPhone(phone)) throw badRequest(`Número de teléfono inválido: ${input.phone}`, 'INVALID_PHONE');
  assertCustomFields(input.customFields);

  const result = await ctx.db.tx(async (q) => {
    let funnelId = input.funnelId ?? null;
    let stageId = input.stageId ?? null;
    let funnel: FunnelRow | null = null;
    if (stageId) {
      const st = await stageInWorkspace(q, workspaceId, stageId);
      funnelId = st.funnel_id;
      funnel = (await q.query<FunnelRow>(`SELECT id, auto_assign, assignee_ids FROM funnels WHERE id = $1`, [funnelId])).rows[0];
    } else {
      const p = await defaultPlacement(q, workspaceId, funnelId);
      funnel = p.funnel;
      funnelId = p.funnel?.id ?? null;
      stageId = p.stageId;
    }
    if (input.assignedUserId) await assertMember(q, workspaceId, input.assignedUserId);

    const ins = await q.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, phone, wa_id, name, email, company, source, funnel_id, stage_id,
         assigned_user_id, deal_value, custom_fields, channel_id, stage_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (workspace_id, phone) DO NOTHING RETURNING id`,
      [
        workspaceId,
        phone,
        input.waId ?? null,
        input.name?.trim() || null,
        input.email?.trim() || null,
        input.company?.trim() || null,
        input.source ?? 'manual',
        funnelId,
        stageId,
        input.assignedUserId ?? null,
        input.dealValue ?? 0,
        JSON.stringify(input.customFields ?? {}),
        input.channelId ?? null,
      ],
    );
    if (!ins.rows[0]) {
      const existing = await q.query<{ id: string }>(`SELECT id FROM contacts WHERE workspace_id = $1 AND phone = $2`, [workspaceId, phone]);
      return { id: existing.rows[0].id, created: false };
    }
    const id = ins.rows[0].id;
    let assigned = input.assignedUserId ?? null;
    if (!assigned && funnel?.auto_assign) {
      assigned = await pickAssignee(q, workspaceId, funnel.assignee_ids ?? [], ctx.log);
      if (assigned) await q.query(`UPDATE contacts SET assigned_user_id = $2 WHERE id = $1`, [id, assigned]);
    }
    if (input.tagIds?.length) await addTags(q, workspaceId, id, input.tagIds);
    await recordEvent(q, { workspaceId, contactId: id, type: 'created', data: { source: input.source ?? 'manual', stage_id: stageId }, userId: actor.userId });
    if (assigned) {
      await recordEvent(q, { workspaceId, contactId: id, type: 'assigned', data: { to: assigned, auto: !input.assignedUserId }, userId: actor.userId });
    }
    return { id, created: true };
  });

  const contact = await getContact(ctx.db, workspaceId, result.id);
  if (result.created) {
    ctx.realtime.emit(workspaceId, 'contact:new', contact);
    await dispatchWebhook(ctx, workspaceId, 'contact.created', contact);
  }
  return { contact, created: result.created };
}

export interface UpdateContactInput {
  name?: string | null;
  email?: string | null;
  company?: string | null;
  dealValue?: number;
  customFields?: Record<string, unknown>;
  funnelId?: string;
  stageId?: string;
  assignedUserId?: string | null;
  aiPaused?: boolean;
  isArchived?: boolean;
  optedOut?: boolean;
  tagIds?: string[];
  addTagIds?: string[];
  removeTagIds?: string[];
  unreadCount?: number;
}

export async function updateContact(
  ctx: AppContext,
  workspaceId: string,
  id: string,
  patch: UpdateContactInput,
  actor: { userId?: string | null } = {},
): Promise<Contact> {
  assertCustomFields(patch.customFields);
  const changes = await ctx.db.tx(async (q) => {
    const current = await getContact(q, workspaceId, id);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length + 1}`);
    };
    const out = { stageChanged: null as null | { from: string | null; to: string; kind: string; name: string }, assignedChanged: false };

    if (patch.name !== undefined) set('name', patch.name?.trim() || null);
    if (patch.email !== undefined) set('email', patch.email?.trim() || null);
    if (patch.company !== undefined) set('company', patch.company?.trim() || null);
    if (patch.dealValue !== undefined) set('deal_value', patch.dealValue);
    if (patch.customFields !== undefined) set('custom_fields', JSON.stringify(patch.customFields));
    if (patch.aiPaused !== undefined) set('ai_paused', patch.aiPaused);
    if (patch.isArchived !== undefined) set('is_archived', patch.isArchived);
    if (patch.optedOut !== undefined) set('opted_out', patch.optedOut);
    if (patch.unreadCount !== undefined) set('unread_count', patch.unreadCount);

    let targetStage: string | null = null;
    if (patch.stageId) targetStage = patch.stageId;
    else if (patch.funnelId && patch.funnelId !== current.funnel_id) {
      const p = await defaultPlacement(q, workspaceId, patch.funnelId);
      targetStage = p.stageId;
      if (!targetStage) {
        set('funnel_id', patch.funnelId);
        set('stage_id', null);
      }
    }
    if (targetStage && targetStage !== current.stage_id) {
      const st = await stageInWorkspace(q, workspaceId, targetStage);
      set('stage_id', st.id);
      set('funnel_id', st.funnel_id);
      sets.push('stage_changed_at = now()');
      out.stageChanged = { from: current.stage_id, to: st.id, kind: st.kind, name: st.name };
      await recordEvent(q, {
        workspaceId,
        contactId: id,
        type: 'stage_changed',
        data: { from: current.stage_id, to: st.id, to_name: st.name, kind: st.kind, funnel_id: st.funnel_id },
        userId: actor.userId,
      });
    }

    if (patch.assignedUserId !== undefined && patch.assignedUserId !== current.assigned_user_id) {
      if (patch.assignedUserId) await assertMember(q, workspaceId, patch.assignedUserId);
      set('assigned_user_id', patch.assignedUserId);
      out.assignedChanged = true;
      await recordEvent(q, {
        workspaceId,
        contactId: id,
        type: 'assigned',
        data: { from: current.assigned_user_id, to: patch.assignedUserId },
        userId: actor.userId,
      });
    }

    if (patch.tagIds) await replaceTags(q, workspaceId, id, patch.tagIds);
    if (patch.addTagIds) await addTags(q, workspaceId, id, patch.addTagIds);
    if (patch.removeTagIds) await removeTags(q, id, patch.removeTagIds);

    sets.push('updated_at = now()');
    await q.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
    return out;
  });

  const contact = await getContact(ctx.db, workspaceId, id);
  ctx.realtime.emit(workspaceId, 'contact:update', contact);
  await dispatchWebhook(ctx, workspaceId, 'contact.updated', contact);
  if (changes.stageChanged) await dispatchWebhook(ctx, workspaceId, 'contact.stage_changed', { contact, stage: changes.stageChanged });
  if (changes.assignedChanged) await dispatchWebhook(ctx, workspaceId, 'contact.assigned', contact);
  return contact;
}
