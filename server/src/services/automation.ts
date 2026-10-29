import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { BotMenu, BotMenuOption, ContactRow, MessageRow, WorkspaceRow, WorkspaceSettings } from '../types.js';
import { optOutKeyword } from '../whatsapp/inbound.js';
import { pickAssignee } from './assignment.js';
import { getContact, updateContact } from './contacts.js';
import { isWindowOpen, sendMessage, type SendOptions } from './messages.js';

export const DEFAULT_SETTINGS: Required<Pick<WorkspaceSettings, 'automation_mode' | 'welcome' | 'away' | 'bot' | 'agent_visibility'>> = {
  automation_mode: 'off',
  welcome: { enabled: false, text: '¡Hola! 👋 Gracias por escribirnos. En un momento te atendemos.' },
  away: {
    enabled: false,
    text: 'Gracias por escribirnos. Nuestro horario es de lunes a viernes de 9:00 a 18:00. Te responderemos en cuanto abramos. 🙌',
    hours: {
      '1': [['09:00', '18:00']],
      '2': [['09:00', '18:00']],
      '3': [['09:00', '18:00']],
      '4': [['09:00', '18:00']],
      '5': [['09:00', '18:00']],
    },
  },
  bot: {
    menu: {
      prompt: '¡Hola! Soy el asistente virtual. ¿En qué te podemos ayudar? Responde con el número de la opción:',
      options: [
        { key: '1', label: 'Quiero información', reply: 'Con gusto. Un asesor te compartirá la información en breve.', handoff: true },
        { key: '2', label: 'Ya soy cliente', reply: '¡Gracias por tu preferencia! Cuéntanos en qué te ayudamos.', handoff: true },
        { key: '3', label: 'Hablar con un asesor', handoff: true },
      ],
    },
    fallback: 'No entendí tu respuesta 🙈. Elige una de las opciones:',
    handoff_message: 'Listo, te comunico con un asesor. 🙋',
    interactive: true,
    only_unassigned: false,
  },
  agent_visibility: 'all',
};

export function settingsWithDefaults(s: WorkspaceSettings | null | undefined): WorkspaceSettings & typeof DEFAULT_SETTINGS {
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) } as WorkspaceSettings & typeof DEFAULT_SETTINGS;
}

/** True when the workspace is inside its business hours (or has none configured). */
export function isWithinBusinessHours(hours: Record<string, [string, string][]>, timezone: string, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hhmm = `${get('hour').padStart(2, '0')}:${get('minute')}`;
  const ranges = hours[String(day)] ?? [];
  return ranges.some(([from, to]) => hhmm >= from && hhmm < to);
}

/** Senders whose message means a person of the team took the conversation (inbox or WhatsApp Business app). */
export const HUMAN_SENDERS = ['user', 'phone'];

type Content = Pick<MessageRow, 'type' | 'body' | 'payload'>;

/** A customer message asking to stop (STOP, BAJA...): it gets no automatic answer. */
export const isOptOutMessage = (m: Content) => optOutKeyword({ type: m.type, body: m.body, media: null, payload: m.payload }) !== null;

/**
 * True when the customer sent an opt-out message after message `since`: whatever was being prepared
 * for `since` is dropped. Only that cancels: a contact who opted out before (or whom the team took
 * off broadcasts) keeps getting answers to what they write.
 */
export async function optedOutSince(q: Queryable, contactId: string, since: string): Promise<boolean> {
  const { rows } = await q.query<Content>(
    `SELECT m.type, m.body, m.payload FROM messages m
     WHERE m.contact_id = $1 AND m.direction = 'in' AND m.created_at > (SELECT created_at FROM messages WHERE id = $2)
     ORDER BY m.created_at DESC LIMIT 50`,
    [contactId, since],
  );
  return rows.some(isOptOutMessage);
}

/** What an automated send checks again, under the contact's lock, right before it goes out. */
export interface TurnCheck {
  contactId: string;
  /** The customer message being answered: what happened after it is what changed meanwhile. */
  since: string;
  /** Out messages from these senders after `since` mean the customer was already answered. */
  answeredBy: string[];
  /** Stop if an AI reply already answered `since` or a later customer message (another run of the job). */
  aiAnswered?: boolean;
  /** Messages this run already sent (they never count as an answer). */
  own?: string[];
  /** Stop if the menu bot was finished meanwhile (a takeover marks bot_state.done). */
  botDone?: boolean;
  /** Stop if the AI was paused meanwhile. */
  aiPaused?: boolean;
}

/**
 * Precondition of an automated send (sendMessage runs it with the contact row locked, before
 * anything is stored or charged): cancels it with SEND_SKIPPED when a person answered, the bot was
 * stopped or the AI paused, or the customer sent an opt-out message after the one it answers.
 */
export function stillOurTurn(t: TurnCheck): NonNullable<SendOptions['precondition']> {
  return async (q: Queryable) => {
    const { rows } = await q.query<{ ai_paused: boolean; opted_out: boolean; bot_done: boolean; answered: boolean; ai_answered: boolean }>(
      `WITH since AS (SELECT created_at FROM messages WHERE id = $2)
       SELECT c.ai_paused, c.opted_out, COALESCE(c.bot_state->>'done' = 'true', false) AS bot_done,
         EXISTS (SELECT 1 FROM messages m
                 WHERE m.contact_id = c.id AND m.direction = 'out' AND m.sent_by = ANY($3::text[]) AND NOT (m.id = ANY($4::uuid[]))
                   AND m.created_at > (SELECT created_at FROM since)) AS answered,
         $5::boolean AND EXISTS (SELECT 1 FROM messages a
                 WHERE a.contact_id = c.id AND a.direction = 'out' AND a.sent_by = 'ai' AND NOT (a.id = ANY($4::uuid[]))
                   AND a.payload->>'ai_last_in' IN (SELECT i.id::text FROM messages i
                     WHERE i.contact_id = c.id AND i.direction = 'in' AND i.created_at >= (SELECT created_at FROM since))) AS ai_answered
       FROM contacts c WHERE c.id = $1`,
      [t.contactId, t.since, t.answeredBy, t.own ?? [], !!t.aiAnswered],
    );
    const r = rows[0];
    if (
      !r ||
      r.answered ||
      r.ai_answered ||
      (t.botDone && r.bot_done) ||
      (t.aiPaused && r.ai_paused) ||
      // An opt-out message always sets opted_out: without it there is nothing to look for.
      (r.opted_out && (await optedOutSince(q, t.contactId, t.since)))
    ) {
      throw new AppError(409, 'SEND_SKIPPED', 'Envío omitido: la conversación cambió mientras se preparaba la respuesta');
    }
  };
}

export const isSendSkipped = (err: unknown) => err instanceof AppError && err.code === 'SEND_SKIPPED';

/** Sends an automated message; false when the conversation changed meanwhile and it was not sent. */
export async function sendAutomated(ctx: AppContext, o: SendOptions): Promise<boolean> {
  try {
    await sendMessage(ctx, o);
    return true;
  } catch (err) {
    if (isSendSkipped(err)) return false;
    throw err;
  }
}

/**
 * Runs after every inbound customer message (job "automation.inbound"):
 * away message, welcome message, menu bot (Leadbot-style) or AI agent. A contact who opted out of
 * broadcasts still gets answers to what they write; the opt-out message itself starts no automation,
 * and neither does a message the customer followed with one (both in one webhook, or a backlog).
 */
export async function handleInboundAutomation(
  ctx: AppContext,
  p: { workspaceId: string; contactId: string; messageId: string; isNew: boolean },
): Promise<void> {
  const { rows } = await ctx.db.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1`, [p.workspaceId]);
  const ws = rows[0];
  if (!ws?.is_active) return;
  const settings = settingsWithDefaults(ws.settings);
  const contact = await getContact(ctx.db, p.workspaceId, p.contactId);
  const msgRes = await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [p.messageId]);
  const message = msgRes.rows[0];
  if (!message || !isWindowOpen(contact.last_inbound_at)) return;
  if (contact.opted_out && (await optedOutSince(ctx.db, contact.id, message.id))) return;
  const mode = settings.automation_mode ?? 'off';
  // Notices are not sent over a person who already answered this message.
  const notice = (text: string) =>
    sendAutomated(ctx, {
      workspaceId: ws.id,
      contactId: contact.id,
      content: { type: 'text', text },
      sentBy: 'system',
      precondition: stillOurTurn({ contactId: contact.id, since: message.id, answeredBy: HUMAN_SENDERS }),
    });

  if (mode !== 'ai' && settings.away?.enabled && !isWithinBusinessHours(settings.away.hours, ws.timezone)) {
    // Check and mark in one statement: only one of several messages in a burst sends the notice.
    const claimed = await ctx.db.query(
      `UPDATE contacts SET last_away_at = now()
       WHERE id = $1 AND (last_away_at IS NULL OR last_away_at < now() - interval '12 hours') RETURNING id`,
      [contact.id],
    );
    if (claimed.rows[0]) await notice(settings.away.text);
  }

  if (mode === 'off') {
    if (p.isNew && settings.welcome?.enabled && settings.welcome.text.trim()) await notice(settings.welcome.text);
    return;
  }
  if (mode === 'menu') {
    await runMenuBot(ctx, ws, settings, contact, message);
    return;
  }
  if (mode === 'ai' && !contact.ai_paused && !(settings.ai?.only_unassigned && contact.assigned_user_id)) {
    // Debounce: people often send several short messages in a row. The queue runs automation and
    // AI replies of one contact one at a time (serial key), so a reply never overlaps another.
    await ctx.queue.enqueue('ai.reply', { workspaceId: ws.id, contactId: contact.id }, { delayMs: 4000, dedupeKey: `ai:${contact.id}`, maxAttempts: 2 });
  }
}

const RESET_WORDS = new Set(['0', 'menu', 'menú', 'inicio', 'volver']);

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The longest start of `text` within `max` UTF-16 units that ends between two characters: a cut
 * inside an emoji would leave half of it (a lone surrogate), which jsonb refuses (the send could
 * never be stored) and Meta would get as garbage.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  // A single character longer than the limit (a long emoji sequence): cut it between code points.
  if (!end) {
    for (const ch of text) {
      if (end + ch.length > max) break;
      end += ch.length;
    }
  }
  return text.slice(0, end);
}

/** WhatsApp limits button (20) and list row (24) titles: cut at a word boundary with an ellipsis. */
export function fitTitle(label: string, max: number): string {
  if (label.length <= max) return label;
  const cut = cutText(label, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/** Follows option keys down the menu tree while they lead to a submenu. */
function locateMenu(root: BotMenu, path: string[]): { menu: BotMenu; keys: string[]; indices: number[]; labels: string[] } {
  let menu = root;
  const keys: string[] = [];
  const indices: number[] = [];
  const labels: string[] = [];
  for (const key of path) {
    const i = menu.options.findIndex((o) => o.key === key);
    const next = i >= 0 ? menu.options[i].submenu : null;
    if (!next?.options?.length) break;
    labels.push(menu.options[i].label);
    menu = next;
    keys.push(key);
    indices.push(i);
  }
  return { menu, keys, indices, labels };
}

export function resolveMenu(root: BotMenu, path: string[]): BotMenu {
  return locateMenu(root, path).menu;
}

export function matchOption(menu: BotMenu, input: string): BotMenuOption | null {
  const n = norm(input);
  if (!n) return null;
  return (
    menu.options.find((o) => o.key === input.trim()) ??
    menu.options.find((o) => norm(o.key) === n) ??
    menu.options.find((o) => norm(o.label) === n) ??
    null
  );
}

/**
 * Button and row ids carry the option's position in the menu tree and a short hash of the labels
 * along that path ("menu:0.1:3kQ9xZ_a"): WhatsApp keeps old menus tappable, and a tap must be read
 * against the menu it came from. If the menu was edited since (options added, removed, reordered or
 * renamed), the position may now hold another option: the hash no longer matches and the tap is
 * treated as gone instead of running that other option.
 */
const MENU_HOME_ID = 'menu:home';
const labelsHash = (labels: string[]) => crypto.createHash('sha256').update(labels.join('\u0000')).digest('base64url').slice(0, 8);
const menuOptionId = (indices: number[], labels: string[]) => `menu:${indices.join('.')}:${labelsHash(labels)}`;

type MenuTap =
  | { kind: 'home' }
  | { kind: 'option'; option: BotMenuOption; keys: string[]; indices: number[]; labels: string[] }
  | { kind: 'gone' };

function parseMenuTap(root: BotMenu, replyId: string): MenuTap | null {
  if (replyId === MENU_HOME_ID) return { kind: 'home' };
  const m = /^menu:(\d{1,3}(?:\.\d{1,3}){0,4}):([\w-]{8})$/.exec(replyId);
  // Ids of another shape (older versions used the option key) are read as typed text.
  if (!m) return replyId.startsWith('menu:') ? { kind: 'gone' } : null;
  const indices = m[1].split('.').map(Number);
  const keys: string[] = [];
  const labels: string[] = [];
  let menu: BotMenu | null | undefined = root;
  for (let d = 0; d < indices.length; d++) {
    const option: BotMenuOption | undefined = menu?.options?.[indices[d]];
    if (!option) break;
    labels.push(option.label);
    if (d === indices.length - 1) return labelsHash(labels) === m[2] ? { kind: 'option', option, keys, indices, labels } : { kind: 'gone' };
    keys.push(option.key);
    menu = option.submenu;
  }
  // The menu was edited after that message was sent.
  return { kind: 'gone' };
}

/** Reply-button titles must be unique within a message: options that shorten to the same title get their key, then a number. */
export function uniqueTitles(options: Pick<BotMenuOption, 'key' | 'label'>[], max: number): string[] {
  const fitted = options.map((o) => fitTitle(o.label, max));
  const out: string[] = [];
  options.forEach((o, i) => {
    let title = fitted.indexOf(fitted[i]) !== fitted.lastIndexOf(fitted[i]) ? fitTitle(`${o.key}. ${o.label}`, max) : fitted[i];
    for (let n = 2; out.includes(title); n++) title = `${fitTitle(o.label, max - String(n).length - 1)} ${n}`;
    out.push(title);
  });
  return out;
}

async function sendMenu(
  ctx: AppContext,
  ws: WorkspaceRow,
  contact: ContactRow,
  menu: BotMenu,
  at: { indices: number[]; labels: string[] },
  interactive: boolean,
  nested: boolean,
  precondition: SendOptions['precondition'],
  intro?: string,
): Promise<boolean> {
  const prompt = intro ? `${intro}\n\n${menu.prompt}` : menu.prompt;
  const text = `${prompt}\n\n${menu.options.map((o) => `*${o.key}.* ${o.label}`).join('\n')}${nested ? '\n\n*0.* Menú principal' : ''}`;
  const base = { workspaceId: ws.id, contactId: contact.id, sentBy: 'bot' as const, precondition };
  if (interactive && menu.options.length <= 3 && !nested) {
    const titles = uniqueTitles(menu.options, 20);
    return sendAutomated(ctx, {
      ...base,
      content: {
        type: 'interactive',
        text,
        interactive: {
          type: 'button',
          body: { text: cutText(prompt, 1024) },
          action: { buttons: menu.options.map((o, i) => ({ type: 'reply', reply: { id: menuOptionId([...at.indices, i], [...at.labels, o.label]), title: titles[i] } })) },
        },
      },
    });
  } else if (interactive && menu.options.length + (nested ? 1 : 0) <= 10) {
    const titles = uniqueTitles(menu.options, 24);
    const rows = menu.options.map((o, i) => ({
      id: menuOptionId([...at.indices, i], [...at.labels, o.label]),
      title: titles[i],
      ...(o.label.length > 24 ? { description: cutText(o.label, 72) } : {}),
    }));
    if (nested) rows.push({ id: MENU_HOME_ID, title: 'Menú principal' });
    return sendAutomated(ctx, {
      ...base,
      content: {
        type: 'interactive',
        text,
        interactive: {
          type: 'list',
          // Meta allows 1024 characters in a reply-button body but 4096 in a list body.
          body: { text: cutText(prompt, 4096) },
          action: { button: 'Ver opciones', sections: [{ title: 'Opciones', rows }] },
        },
      },
    });
  }
  return sendAutomated(ctx, { ...base, content: { type: 'text', text } });
}

/**
 * Saves where the customer is in the menu, unless a person took the chat after `since` (a takeover
 * sets bot_state.done, which only a restart by the customer may clear). False when it did: the
 * bot stops there.
 */
async function saveState(ctx: AppContext, contactId: string, since: string, state: { path: string[]; done?: boolean }, restart = false): Promise<boolean> {
  const { rows } = await ctx.db.query(
    `UPDATE contacts SET bot_state = $2 WHERE id = $1
       AND ($4 OR COALESCE(bot_state->>'done' = 'true', false) = false)
       AND NOT EXISTS (SELECT 1 FROM messages m
                       WHERE m.contact_id = $1 AND m.direction = 'out' AND m.sent_by = ANY($5::text[])
                         AND m.created_at > (SELECT l.created_at FROM messages l WHERE l.id = $3))
     RETURNING id`,
    [contactId, JSON.stringify({ ...state, updated_at: new Date().toISOString() }), since, restart, HUMAN_SENDERS],
  );
  return rows.length > 0;
}

async function runMenuBot(ctx: AppContext, ws: WorkspaceRow, settings: ReturnType<typeof settingsWithDefaults>, contact: ContactRow, message: MessageRow) {
  const bot = settings.bot;
  if (!bot?.menu?.options?.length) return;
  if (bot.only_unassigned && contact.assigned_user_id && !contact.bot_state) return;
  const replyId = (message.payload as any)?.reply_id as string | undefined;
  const tap = replyId ? parseMenuTap(bot.menu, replyId) : null;
  const input = (replyId ?? message.body ?? '').trim();
  const resetWord = !tap && RESET_WORDS.has(norm(input));
  const state = contact.bot_state;
  // Every send and state write stops once a person took over after this message.
  const guard = (ownDone = false) =>
    stillOurTurn({ contactId: contact.id, since: message.id, answeredBy: HUMAN_SENDERS, botDone: !ownDone });
  const save = (s: { path: string[]; done?: boolean }, restart = false) => saveState(ctx, contact.id, message.id, s, restart);

  const restart = !!state?.done && resetWord && norm(input) !== '0';
  if (!state || restart) {
    if (!(await save({ path: [] }, restart))) return;
    await sendMenu(ctx, ws, contact, bot.menu, { indices: [], labels: [] }, bot.interactive, false, guard());
    return;
  }
  if (state.done) return;

  if (resetWord || tap?.kind === 'home') {
    if (!(await save({ path: [] }))) return;
    await sendMenu(ctx, ws, contact, bot.menu, { indices: [], labels: [] }, bot.interactive, false, guard());
    return;
  }

  const current = locateMenu(bot.menu, state.path ?? []);
  // Where the chosen option lives: the menu its button came from, or the current one for typed answers.
  let keys = current.keys;
  let at: { indices: number[]; labels: string[] } = { indices: [], labels: [] };
  let option: BotMenuOption | null = null;
  if (tap?.kind === 'option') {
    // A second tap on the button that opened the current submenu (double tap): it is already on screen.
    const opened = [...tap.keys, tap.option.key];
    if (tap.option.submenu?.options?.length && opened.join('\u0000') === current.keys.join('\u0000')) return;
    option = tap.option;
    keys = tap.keys;
    at = { indices: tap.indices, labels: tap.labels };
  } else {
    option = tap ? null : matchOption(current.menu, input);
    if (option) at = { indices: [...current.indices, current.menu.options.indexOf(option)], labels: [...current.labels, option.label] };
  }
  if (!option) {
    await sendMenu(ctx, ws, contact, current.menu, current, bot.interactive, current.keys.length > 0, guard(), bot.fallback);
    return;
  }

  const patch: Parameters<typeof updateContact>[3] = {};
  if (option.stage_id) patch.stageId = option.stage_id;
  if (option.tag_ids?.length) patch.addTagIds = option.tag_ids;
  if (option.assign_user_id) patch.assignedUserId = option.assign_user_id;
  if (Object.keys(patch).length) await updateContact(ctx, ws.id, contact.id, patch).catch((err) => ctx.log.warn({ err: err.message }, 'bot action failed'));

  const say = (text: string, ownDone = false) =>
    sendAutomated(ctx, { workspaceId: ws.id, contactId: contact.id, content: { type: 'text', text }, sentBy: 'bot', precondition: guard(ownDone) });
  if (option.reply?.trim() && !(await say(option.reply))) return;
  if (option.submenu?.options?.length) {
    if (!(await save({ path: [...keys, option.key] }))) return;
    await sendMenu(ctx, ws, contact, option.submenu, at, bot.interactive, true, guard());
    return;
  }
  if (!(await save({ path: keys, done: true }))) return;
  if (option.handoff) {
    if (bot.handoff_message?.trim() && !option.reply?.trim() && !(await say(bot.handoff_message, true))) return;
    await assignIfUnassigned(ctx, ws.id, contact.id);
  }
}

/** Hands the conversation to a human: round-robin assignment when nobody owns it. */
export async function assignIfUnassigned(ctx: AppContext, workspaceId: string, contactId: string) {
  const contact = await getContact(ctx.db, workspaceId, contactId);
  if (contact.assigned_user_id) return;
  const funnel = await ctx.db.query<{ assignee_ids: string[] }>(`SELECT assignee_ids FROM funnels WHERE id = $1`, [contact.funnel_id]);
  const userId = await ctx.db.tx((q) => pickAssignee(q, workspaceId, funnel.rows[0]?.assignee_ids ?? []));
  if (userId) await updateContact(ctx, workspaceId, contactId, { assignedUserId: userId });
}
