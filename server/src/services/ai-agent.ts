import Anthropic from '@anthropic-ai/sdk';
import type { AppContext } from '../context.js';
import { decrypt } from '../lib/crypto.js';
import type { MessageRow, WorkspaceRow } from '../types.js';
import { assignIfUnassigned, HUMAN_SENDERS, isOptOutMessage, isSendSkipped, stillOurTurn } from './automation.js';
import { getContact, updateContact, type Contact } from './contacts.js';
import { addNote, isWindowOpen, MAX_TEXT_LENGTH, sendMessage } from './messages.js';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recomendado)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (más económico)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (el más económico)' },
];
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

// Models that accept the server-side refusal fallback ("fallbacks: default").
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const MAX_TOOL_ROUNDS = 4;
const HISTORY_LIMIT = 40;
// Chat replies are short (the prompt asks for 1 to 4 sentences); this also leaves room for tool calls.
const MAX_REPLY_TOKENS = 1024;

/**
 * A reply must end long before the job runner gives up on it (10 minutes) and runs the job again
 * while the first run is still going: each Claude request, retries and tool rounds included, stops
 * at these limits.
 */
export const AI_TIMEOUTS = { requestTimeoutMs: 60_000, deadlineMs: 4 * 60_000 };

export const DEFAULT_AI_SETTINGS = {
  model: DEFAULT_AI_MODEL,
  instructions:
    'Eres el asistente de ventas por WhatsApp del negocio. Responde en español, de forma breve, cálida y profesional. ' +
    'Tu objetivo es entender qué necesita el cliente, resolver dudas con la información del negocio y llevarlo a la compra o a una cita.',
  knowledge: '',
  handoff_message: 'Te comunico con un asesor de nuestro equipo, en breve te atiende. 🙌',
  only_unassigned: false,
  max_replies: 20,
};

interface AgentContext {
  contact: Contact;
  stages: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  /** Reason of the handoff, once it is saved. */
  handedOff?: string;
}

function buildTools(c: AgentContext): Anthropic.Beta.BetaTool[] {
  return [
    {
      name: 'move_to_stage',
      description:
        'Mueve al cliente a otra etapa del embudo de ventas cuando su situación cambie (por ejemplo, ya pidió cotización o ya compró).',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { stage: { type: 'string', enum: c.stages.map((s) => s.name), description: 'Nombre exacto de la etapa' } },
        required: ['stage'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_tag',
      description: 'Agrega una etiqueta existente al cliente para clasificarlo (interés, producto, ciudad, etc.).',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { tag: { type: 'string', enum: c.tags.length ? c.tags.map((t) => t.name) : ['(sin etiquetas)'] } },
        required: ['tag'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_contact',
      description: 'Guarda datos que el cliente comparta: nombre, correo, empresa o el valor estimado de la venta.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          company: { type: 'string' },
          deal_value: { type: 'number', description: 'Valor estimado de la venta en la moneda del negocio' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'handoff_to_human',
      description:
        'Pasa la conversación a una persona del equipo. Úsalo si el cliente lo pide, si está listo para pagar o agendar, ' +
        'si está molesto, o si no tienes la información para responder con certeza.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Motivo breve para el equipo' } },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  ];
}

function stableSystemPrompt(ws: WorkspaceRow, s: typeof DEFAULT_AI_SETTINGS): string {
  return [
    `Trabajas para "${ws.name}" atendiendo clientes por WhatsApp dentro de un CRM.`,
    '',
    '## Instrucciones del negocio',
    s.instructions.trim(),
    '',
    '## Información del negocio (úsala como única fuente de verdad)',
    s.knowledge.trim() || '(El negocio no cargó información. Si te preguntan precios o detalles, pasa la conversación a un humano.)',
    '',
    '## Reglas',
    '- Escribe mensajes cortos, como en WhatsApp: 1 a 4 oraciones. Puedes usar *negritas* y emojis con moderación.',
    '- No inventes precios, existencias, horarios ni políticas que no estén en la información del negocio.',
    '- Usa las herramientas para mantener el CRM al día (etapa, etiquetas, datos del cliente) sin mencionárselo al cliente.',
    '- Cuando pases la conversación a un humano, despídete brevemente indicando que un asesor continuará.',
  ].join('\n');
}

function volatileContext(c: AgentContext): string {
  const stage = c.stages.find((s) => s.id === c.contact.stage_id)?.name ?? 'sin etapa';
  const tags = c.tags.filter((t) => c.contact.tag_ids.includes(t.id)).map((t) => t.name);
  return [
    '## Datos actuales del cliente en el CRM',
    `- Nombre: ${c.contact.name ?? 'desconocido'}`,
    `- Teléfono: +${c.contact.phone}`,
    `- Correo: ${c.contact.email ?? '—'}`,
    `- Empresa: ${c.contact.company ?? '—'}`,
    `- Etapa actual: ${stage}`,
    `- Etiquetas: ${tags.length ? tags.join(', ') : 'ninguna'}`,
    `- Fecha y hora: ${new Date().toISOString()}`,
  ].join('\n');
}

/**
 * Customer messages that arrived while an AI reply was being written were not part of it (the reply
 * records the last one it saw): list them after that reply, so they get answered next instead of
 * hiding behind it.
 */
export function inSeenOrder(history: MessageRow[]): MessageRow[] {
  const out: MessageRow[] = [];
  for (const m of history) {
    const seen = m.direction === 'out' && m.sent_by === 'ai' ? (m.payload as { ai_last_in?: string } | null)?.ai_last_in : undefined;
    const at = seen ? out.findIndex((x) => x.id === seen) : -1;
    if (at < 0) {
      out.push(m);
      continue;
    }
    const later = out.splice(at + 1);
    out.push(...later.filter((x) => x.direction !== 'in'), m, ...later.filter((x) => x.direction === 'in'));
  }
  return out;
}

/**
 * WhatsApp text messages hold at most MAX_TEXT_LENGTH characters: a longer reply goes out as
 * several, cut between paragraphs, else lines, sentences or words.
 */
export function splitReply(text: string, max = MAX_TEXT_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    const at = (re: RegExp) => {
      let cut = -1;
      for (const m of head.matchAll(re)) if (m.index! + m[0].length <= max) cut = m.index! + m[0].length;
      return cut > max / 3 ? cut : -1;
    };
    let cut = [/\n\s*\n/g, /\n/g, /[.!?…](?=\s)/g, /\s/g].map(at).find((c) => c > 0) ?? max;
    // Never split a surrogate pair (emoji).
    if (cut === max && /[\ud800-\udbff]/.test(rest[cut - 1])) cut--;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A reply cut off by max_tokens ends at its last complete sentence or line, not mid-word. */
function completeSentences(text: string): string {
  const last = [...text.matchAll(/[.!?…](?=\s|$)|\n/g)].pop();
  const end = last ? last.index! + last[0].length : -1;
  return end > 0 ? text.slice(0, end).trim() : text;
}

function historyToMessages(history: MessageRow[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    if (m.direction === 'internal' || m.status === 'failed') continue;
    const text = (m.body ?? '').trim() || `[${m.type}]`;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out;
}

export function aiApiKey(ctx: AppContext, ws: WorkspaceRow): string | null {
  const enc = ws.settings?.ai?.api_key_enc;
  if (enc) {
    try {
      return decrypt(ctx.config.encryptionKey, enc);
    } catch {
      return null;
    }
  }
  return ctx.config.anthropicApiKey;
}

/**
 * Job "ai.reply": Lead Agent answers the latest customer messages and updates the CRM. A contact
 * who opted out of broadcasts is still answered, but never right after an opt-out message (STOP
 * sent during the debounce); the reply is dropped if, while it was written, a person answered, the
 * AI was paused, or the customer sent an opt-out message.
 */
export async function runAiReply(
  ctx: AppContext,
  p: { workspaceId: string; contactId: string },
  limits: Partial<typeof AI_TIMEOUTS> = {},
): Promise<void> {
  const { requestTimeoutMs, deadlineMs } = { ...AI_TIMEOUTS, ...limits };
  const wsRes = await ctx.db.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1`, [p.workspaceId]);
  const ws = wsRes.rows[0];
  if (!ws || ws.settings?.automation_mode !== 'ai') return;
  const settings = { ...DEFAULT_AI_SETTINGS, ...(ws.settings.ai ?? {}) };
  let contact = await getContact(ctx.db, ws.id, p.contactId);
  if (contact.ai_paused || !isWindowOpen(contact.last_inbound_at)) return;

  const apiKey = aiApiKey(ctx, ws);
  if (!apiKey) {
    ctx.log.warn({ workspace: ws.id }, 'AI mode enabled without API key');
    return;
  }

  const { rows: historyDesc } = await ctx.db.query<MessageRow>(
    `SELECT * FROM messages WHERE contact_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [contact.id, HISTORY_LIMIT],
  );
  const history = inSeenOrder(historyDesc.reverse());
  // Only answer if the customer spoke last (avoids double replies), and not to "STOP".
  const lastVisible = [...history].reverse().find((m) => m.direction !== 'internal');
  if (!lastVisible || lastVisible.direction !== 'in' || isOptOutMessage(lastVisible)) return;
  const lastSeenId = lastVisible.id;

  const aiReplies = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND sent_by = 'ai'`,
    [contact.id],
  );
  if (aiReplies.rows[0].n >= settings.max_replies) {
    await handoff(ctx, ws.id, contact.id, settings.handoff_message, 'Límite de respuestas de IA alcanzado');
    return;
  }

  const stages = await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM stages WHERE funnel_id = $1 ORDER BY position`, [
    contact.funnel_id,
  ]);
  const tags = await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM tags WHERE workspace_id = $1 ORDER BY name`, [ws.id]);
  const agentCtx: AgentContext = { contact, stages: stages.rows, tags: tags.rows };

  const client = new Anthropic({ apiKey, fetch: ctx.fetch, maxRetries: 1, timeout: requestTimeoutMs });
  const deadline = AbortSignal.timeout(deadlineMs);
  const tools = buildTools(agentCtx);
  const messages = historyToMessages(history);
  if (!messages.length) return;
  const model = settings.model || DEFAULT_AI_MODEL;
  const useFallback = FALLBACK_MODELS.has(model);

  let finalText = '';
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: MAX_REPLY_TOKENS,
          // Chat replies: low effort keeps answers fast and cheap.
          output_config: { effort: 'low' },
          ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: [
            { type: 'text', text: stableSystemPrompt(ws, settings), cache_control: { type: 'ephemeral' } },
            { type: 'text', text: volatileContext(agentCtx) },
          ],
          tools,
          messages,
        },
        { signal: deadline },
      );

      if (response.stop_reason === 'refusal') {
        await pauseForHuman(ctx, ws.id, contact.id, 'La IA no pudo responder este mensaje');
        agentCtx.handedOff = 'La IA no pudo responder este mensaje';
        break;
      }
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) finalText = response.stop_reason === 'max_tokens' ? completeSentences(text) : text;

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      // max_tokens can cut a tool input short: never run tools from a truncated turn.
      if (response.stop_reason !== 'tool_use' || !toolUses.length) break;

      messages.push({ role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const r = await executeTool(ctx, ws.id, agentCtx, tu.name, tu.input as Record<string, unknown>);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.message, ...(r.error ? { is_error: true } : {}) });
        contact = await getContact(ctx.db, ws.id, contact.id);
        agentCtx.contact = contact;
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    const timedOut = err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError;
    const reason =
      err instanceof Anthropic.AuthenticationError
        ? 'la llave de API de Claude es inválida'
        : err instanceof Anthropic.RateLimitError
          ? 'límite de uso de la API de Claude alcanzado'
          : timedOut
            ? 'la API de Claude tardó demasiado en responder'
            : err instanceof Anthropic.APIConnectionError || !(err instanceof Anthropic.APIError)
              ? 'error de conexión con la API de Claude'
              : `error de la API de Claude (${err.status})`;
    ctx.log.warn({ err: (err as Error).message, contact: contact.id }, 'AI reply failed');
    await addNote(ctx, ws.id, contact.id, await anyOwnerId(ctx, ws.id), `🤖 La IA no respondió: ${reason}.`).catch(() => {});
    if (agentCtx.handedOff) {
      // The handoff is already saved (a retry would stop at ai_paused): still say goodbye to the customer.
      await sendReply(finalText || settings.handoff_message).catch((e) => ctx.log.warn({ err: e.message }, 'AI goodbye failed'));
      return;
    }
    if (timedOut || err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)) throw err;
    return;
  }

  await sendReply(finalText || (agentCtx.handedOff ? settings.handoff_message : ''));

  async function sendReply(text: string) {
    const sent: string[] = [];
    for (const part of splitReply(text)) {
      try {
        const m = await sendMessage(ctx, {
          workspaceId: ws!.id,
          contactId: contact.id,
          content: { type: 'text', text: part },
          sentBy: 'ai',
          // Checked under the contact's lock: nobody answered (a person, or another run of this
          // job), the AI was not paused (unless this run handed off) and the customer did not opt out.
          precondition: stillOurTurn({
            contactId: contact.id,
            since: lastSeenId,
            answeredBy: HUMAN_SENDERS,
            aiAnswered: true,
            own: sent,
            aiPaused: !agentCtx.handedOff,
          }),
          // Remember the last customer message this reply answered (see inSeenOrder).
          onCreated: async (q, m) => {
            m.payload = { ...(m.payload ?? {}), ai_last_in: lastSeenId };
            await q.query(`UPDATE messages SET payload = $2 WHERE id = $1`, [m.id, JSON.stringify(m.payload)]);
          },
        });
        sent.push(m.id);
        if (m.status === 'failed') return;
      } catch (err) {
        if (isSendSkipped(err)) {
          ctx.log.info({ contact: contact.id }, 'AI reply dropped: the conversation changed while it was written');
          return;
        }
        throw err;
      }
    }
  }
}

async function anyOwnerId(ctx: AppContext, workspaceId: string): Promise<string> {
  const { rows } = await ctx.db.query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE workspace_id = $1 ORDER BY (role = 'owner') DESC, created_at LIMIT 1`,
    [workspaceId],
  );
  return rows[0]?.user_id;
}

async function handoff(ctx: AppContext, workspaceId: string, contactId: string, message: string | null, reason: string) {
  if (message?.trim()) {
    await sendMessage(ctx, { workspaceId, contactId, content: { type: 'text', text: message }, sentBy: 'ai' });
  }
  await pauseForHuman(ctx, workspaceId, contactId, reason);
}

/** Pauses the AI for this contact and hands it to a person (round robin when nobody owns it). */
async function pauseForHuman(ctx: AppContext, workspaceId: string, contactId: string, reason: string) {
  await updateContact(ctx, workspaceId, contactId, { aiPaused: true });
  await assignIfUnassigned(ctx, workspaceId, contactId);
  await addNote(ctx, workspaceId, contactId, await anyOwnerId(ctx, workspaceId), `🤖 La IA pasó la conversación a un humano: ${reason}`);
}

async function executeTool(
  ctx: AppContext,
  workspaceId: string,
  c: AgentContext,
  name: string,
  input: Record<string, unknown>,
): Promise<{ message: string; error?: boolean }> {
  try {
    switch (name) {
      case 'move_to_stage': {
        const stage = c.stages.find((s) => s.name === input.stage);
        if (!stage) return { message: `No existe la etapa "${input.stage}"`, error: true };
        await updateContact(ctx, workspaceId, c.contact.id, { stageId: stage.id });
        return { message: `Cliente movido a la etapa "${stage.name}"` };
      }
      case 'add_tag': {
        const tag = c.tags.find((t) => t.name === input.tag);
        if (!tag) return { message: `No existe la etiqueta "${input.tag}"`, error: true };
        await updateContact(ctx, workspaceId, c.contact.id, { addTagIds: [tag.id] });
        return { message: `Etiqueta "${tag.name}" agregada` };
      }
      case 'update_contact': {
        const patch: Parameters<typeof updateContact>[3] = {};
        if (typeof input.name === 'string' && input.name.trim()) patch.name = input.name;
        if (typeof input.email === 'string' && input.email.includes('@')) patch.email = input.email;
        if (typeof input.company === 'string' && input.company.trim()) patch.company = input.company;
        if (typeof input.deal_value === 'number' && input.deal_value >= 0) patch.dealValue = input.deal_value;
        if (!Object.keys(patch).length) return { message: 'No había datos válidos que guardar', error: true };
        await updateContact(ctx, workspaceId, c.contact.id, patch);
        return { message: 'Datos del cliente guardados' };
      }
      case 'handoff_to_human': {
        // Saved as soon as the model decides it: a failure in a later round must not lose it.
        if (!c.handedOff) {
          const reason = (typeof input.reason === 'string' && input.reason.trim()) || 'Solicitud de la IA';
          await pauseForHuman(ctx, workspaceId, c.contact.id, reason);
          c.handedOff = reason;
        }
        return { message: 'Listo: un asesor humano continuará la conversación. Despídete brevemente.' };
      }
      default:
        return { message: `Herramienta desconocida: ${name}`, error: true };
    }
  } catch (err) {
    return { message: `Error: ${(err as Error).message}`, error: true };
  }
}
