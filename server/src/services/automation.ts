import type { AppContext } from '../context.js';
import type { BotMenu, BotMenuOption, ContactRow, MessageRow, WorkspaceRow, WorkspaceSettings } from '../types.js';
import { pickAssignee } from './assignment.js';
import { getContact, updateContact } from './contacts.js';
import { isWindowOpen, sendMessage } from './messages.js';

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

/**
 * Runs after every inbound customer message (job "automation.inbound"):
 * away message, welcome message, menu bot (Leadbot-style) or AI agent.
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
  const mode = settings.automation_mode ?? 'off';

  if (mode !== 'ai' && settings.away?.enabled && !isWithinBusinessHours(settings.away.hours, ws.timezone)) {
    const recentlyNotified = contact.last_away_at && Date.now() - new Date(contact.last_away_at).getTime() < 12 * 3600 * 1000;
    if (!recentlyNotified) {
      await ctx.db.query(`UPDATE contacts SET last_away_at = now() WHERE id = $1`, [contact.id]);
      await sendMessage(ctx, { workspaceId: ws.id, contactId: contact.id, content: { type: 'text', text: settings.away.text }, sentBy: 'system' });
    }
  }

  if (mode === 'off') {
    if (p.isNew && settings.welcome?.enabled && settings.welcome.text.trim()) {
      await sendMessage(ctx, { workspaceId: ws.id, contactId: contact.id, content: { type: 'text', text: settings.welcome.text }, sentBy: 'system' });
    }
    return;
  }
  if (mode === 'menu') {
    await runMenuBot(ctx, ws, settings, contact, message);
    return;
  }
  if (mode === 'ai' && !contact.ai_paused && !(settings.ai?.only_unassigned && contact.assigned_user_id)) {
    // Debounce: people often send several short messages in a row.
    await ctx.queue.enqueue('ai.reply', { workspaceId: ws.id, contactId: contact.id }, { delayMs: 4000, dedupeKey: `ai:${contact.id}`, maxAttempts: 2 });
  }
}

const RESET_WORDS = new Set(['0', 'menu', 'menú', 'inicio', 'volver']);

/** WhatsApp limits button (20) and list row (24) titles: cut at a word boundary with an ellipsis. */
export function fitTitle(label: string, max: number): string {
  if (label.length <= max) return label;
  const cut = label.slice(0, max - 1);
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

export function resolveMenu(root: BotMenu, path: string[]): BotMenu {
  let menu = root;
  for (const key of path) {
    const next = menu.options.find((o) => o.key === key)?.submenu;
    if (!next?.options?.length) break;
    menu = next;
  }
  return menu;
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

async function sendMenu(ctx: AppContext, ws: WorkspaceRow, contact: ContactRow, menu: BotMenu, interactive: boolean, nested: boolean, intro?: string) {
  const prompt = intro ? `${intro}\n\n${menu.prompt}` : menu.prompt;
  const text = `${prompt}\n\n${menu.options.map((o) => `*${o.key}.* ${o.label}`).join('\n')}${nested ? '\n\n*0.* Menú principal' : ''}`;
  const base = { workspaceId: ws.id, contactId: contact.id, sentBy: 'bot' as const };
  if (interactive && menu.options.length <= 3 && !nested) {
    await sendMessage(ctx, {
      ...base,
      content: {
        type: 'interactive',
        text,
        interactive: {
          type: 'button',
          body: { text: prompt.slice(0, 1024) },
          action: { buttons: menu.options.map((o) => ({ type: 'reply', reply: { id: o.key, title: fitTitle(o.label, 20) } })) },
        },
      },
    });
  } else if (interactive && menu.options.length + (nested ? 1 : 0) <= 10) {
    const rows = menu.options.map((o) => ({ id: o.key, title: fitTitle(o.label, 24), ...(o.label.length > 24 ? { description: o.label.slice(0, 72) } : {}) }));
    if (nested) rows.push({ id: '0', title: 'Menú principal' });
    await sendMessage(ctx, {
      ...base,
      content: {
        type: 'interactive',
        text,
        interactive: {
          type: 'list',
          body: { text: prompt.slice(0, 1024) },
          action: { button: 'Ver opciones', sections: [{ title: 'Opciones', rows }] },
        },
      },
    });
  } else {
    await sendMessage(ctx, { ...base, content: { type: 'text', text } });
  }
}

async function saveState(ctx: AppContext, contactId: string, state: { path: string[]; done?: boolean }) {
  await ctx.db.query(`UPDATE contacts SET bot_state = $2 WHERE id = $1`, [contactId, JSON.stringify({ ...state, updated_at: new Date().toISOString() })]);
}

async function runMenuBot(ctx: AppContext, ws: WorkspaceRow, settings: ReturnType<typeof settingsWithDefaults>, contact: ContactRow, message: MessageRow) {
  const bot = settings.bot;
  if (!bot?.menu?.options?.length) return;
  if (bot.only_unassigned && contact.assigned_user_id && !contact.bot_state) return;
  const replyId = (message.payload as any)?.reply_id as string | undefined;
  const input = (replyId ?? message.body ?? '').trim();
  const state = contact.bot_state;

  if (!state || (state.done && RESET_WORDS.has(norm(input)) && norm(input) !== '0')) {
    await saveState(ctx, contact.id, { path: [] });
    await sendMenu(ctx, ws, contact, bot.menu, bot.interactive, false);
    return;
  }
  if (state.done) return;

  if (RESET_WORDS.has(norm(input))) {
    await saveState(ctx, contact.id, { path: [] });
    await sendMenu(ctx, ws, contact, bot.menu, bot.interactive, false);
    return;
  }

  const menu = resolveMenu(bot.menu, state.path ?? []);
  const option = matchOption(menu, input);
  if (!option) {
    await sendMenu(ctx, ws, contact, menu, bot.interactive, (state.path ?? []).length > 0, bot.fallback);
    return;
  }

  const patch: Parameters<typeof updateContact>[3] = {};
  if (option.stage_id) patch.stageId = option.stage_id;
  if (option.tag_ids?.length) patch.addTagIds = option.tag_ids;
  if (option.assign_user_id) patch.assignedUserId = option.assign_user_id;
  if (Object.keys(patch).length) await updateContact(ctx, ws.id, contact.id, patch).catch((err) => ctx.log.warn({ err: err.message }, 'bot action failed'));

  if (option.reply?.trim()) {
    await sendMessage(ctx, { workspaceId: ws.id, contactId: contact.id, content: { type: 'text', text: option.reply }, sentBy: 'bot' });
  }
  if (option.submenu?.options?.length) {
    const path = [...(state.path ?? []), option.key];
    await saveState(ctx, contact.id, { path });
    await sendMenu(ctx, ws, contact, option.submenu, bot.interactive, true);
    return;
  }
  await saveState(ctx, contact.id, { path: state.path ?? [], done: true });
  if (option.handoff) {
    if (bot.handoff_message?.trim() && !option.reply?.trim()) {
      await sendMessage(ctx, { workspaceId: ws.id, contactId: contact.id, content: { type: 'text', text: bot.handoff_message }, sentBy: 'bot' });
    }
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
