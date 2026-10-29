import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODEL } from '../services/ai-agent.js';
import { fakeFetch, setup, type TestEnv } from './helpers.js';

const replies: any[] = [];
const claude = fakeFetch([
  (c) => {
    if (!c.url.startsWith('https://api.anthropic.com/v1/messages')) return undefined;
    if (c.headers['x-api-key'] === 'sk-ant-bad' || c.headers.authorization === 'Bearer sk-ant-bad') {
      return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    }
    const next = replies.shift();
    if (next?.status) return { status: next.status, json: next.json, headers: next.headers };
    return { json: { id: `msg_${claude.calls.length}`, type: 'message', role: 'assistant', model: c.body.model, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }, ...next } };
  },
]);

let env: TestEnv;
let channelId: string;
let workspaceId: string;
/** Runs once, during the next Claude call: lets a test act while the AI is "writing". */
let duringClaude: (() => Promise<void>) | null = null;
const fetchWithHook = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (duringClaude && url.startsWith('https://api.anthropic.com/')) {
    const hook = duringClaude;
    duringClaude = null;
    await hook();
  }
  return claude.fetch(input, init);
}) as typeof fetch;

async function runDueJobs() {
  await env.built.ctx.db.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
  await env.drain();
}

async function say(from: string, text: string) {
  const r = await env.api('POST', `/api/channels/${channelId}/simulate`, { from, text, name: 'Ana' });
  await env.drain();
  await runDueJobs();
  return r.body.message.contact_id as string;
}

beforeAll(async () => {
  env = await setup({ fetch: fetchWithHook });
  workspaceId = (await env.register('ia@test.com', 'Inmobiliaria')).workspaceId;
  channelId = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' })).body.channel.id;
});
afterAll(() => env.close());

describe('AI agent (Lead Agent)', () => {
  it('requires an API key to enable AI mode', async () => {
    const r = await env.api('PUT', '/api/workspace/settings', { automation_mode: 'ai' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('AI_KEY_REQUIRED');
  });

  it('answers, moves the lead and saves data using tools', async () => {
    const s = await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'ai',
      ai: {
        model: 'claude-opus-5-5',
        api_key: 'sk-ant-test',
        instructions: 'Vende departamentos.',
        knowledge: 'Departamento de 2 recámaras: $1,000,000 MXN.',
        handoff_message: 'Te paso con un asesor.',
        only_unassigned: false,
        max_replies: 10,
      },
    });
    expect(s.status).toBe(200);
    expect(s.body.workspace.settings.ai.has_api_key).toBe(true);
    expect(JSON.stringify(s.body)).not.toContain('sk-ant-test');

    replies.push(
      {
        content: [
          { type: 'text', text: 'Déjame revisar.' },
          { type: 'tool_use', id: 'tu_1', name: 'move_to_stage', input: { stage: 'Interesado' } },
          { type: 'tool_use', id: 'tu_2', name: 'update_contact', input: { email: 'ana@correo.com', deal_value: 1000000 } },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: '¡Hola Ana! El departamento de 2 recámaras cuesta $1,000,000 MXN. ¿Te gustaría visitarlo?' }], stop_reason: 'end_turn' },
    );
    const id = await say('5215566667777', 'Hola, ¿cuánto cuesta el depa de 2 recámaras? mi correo es ana@correo.com');

    const calls = claude.calls.filter((c) => c.url.includes('api.anthropic.com'));
    expect(calls).toHaveLength(2);
    const first = calls[0].body;
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.fallbacks).toBe('default');
    expect(calls[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.output_config).toEqual({ effort: 'low' });
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(first.system[0].text).toContain('Departamento de 2 recámaras');
    expect(first.system[1].text).toContain('Etapa actual: Nuevo');
    expect(first.tools.map((t: any) => t.name)).toEqual(['move_to_stage', 'add_tag', 'update_contact', 'handoff_to_human']);
    expect(first.tools[0].input_schema.properties.stage.enum).toContain('Interesado');
    expect(first.messages).toEqual([{ role: 'user', content: 'Hola, ¿cuánto cuesta el depa de 2 recámaras? mi correo es ana@correo.com' }]);
    const second = calls[1].body;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2].content.map((r: any) => r.tool_use_id)).toEqual(['tu_1', 'tu_2']);

    const c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    const stages = (await env.api('GET', '/api/funnels')).body.funnels[0].stages;
    expect(c.stage_id).toBe(stages.find((s: any) => s.name === 'Interesado').id);
    expect(c.email).toBe('ana@correo.com');
    expect(c.deal_value).toBe(1000000);
    const msgs = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages;
    const out = msgs.filter((m: any) => m.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0].sent_by).toBe('ai');
    expect(out[0].body).toContain('$1,000,000 MXN');
  });

  it('hands off to a human and pauses itself', async () => {
    replies.push(
      { content: [{ type: 'tool_use', id: 'tu_h', name: 'handoff_to_human', input: { reason: 'Quiere apartar' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Perfecto, un asesor te contactará para apartarlo.' }], stop_reason: 'end_turn' },
    );
    const id = await say('5215566667777', 'Lo quiero apartar ya');
    const c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.ai_paused).toBe(true);
    expect(c.assigned_user_id).toBeTruthy();
    const msgs = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages;
    expect(msgs.some((m: any) => m.type === 'note' && m.body.includes('Quiere apartar'))).toBe(true);
    // paused: no more AI calls
    const before = claude.calls.length;
    await say('5215566667777', '¿hola?');
    expect(claude.calls.length).toBe(before);
  });

  it('debounces bursts of messages into one reply', async () => {
    replies.push({ content: [{ type: 'text', text: 'Con gusto te ayudo.' }], stop_reason: 'end_turn' });
    const before = claude.calls.length;
    await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215511110000', text: 'hola' });
    await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215511110000', text: 'quiero info' });
    await env.drain();
    await runDueJobs();
    expect(claude.calls.length - before).toBe(1);
    const last = claude.calls[claude.calls.length - 1].body.messages;
    expect(last).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'user', content: 'quiero info' },
    ]);
  });

  it('leaves a note for the team when the API key is invalid', async () => {
    await env.api('PUT', '/api/workspace/settings', {
      ai: { model: 'claude-haiku-5-5', api_key: 'sk-ant-bad', instructions: 'x', knowledge: '', handoff_message: 'x', only_unassigned: false, max_replies: 10 },
    });
    const id = await say('5215599990000', 'hola');
    const last = claude.calls[claude.calls.length - 1];
    expect(last.body.fallbacks).toBeUndefined(); // Haiku: no server-side fallback
    const msgs = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages;
    expect(msgs.some((m: any) => m.type === 'note' && m.body.includes('inválida'))).toBe(true);
  });
});

describe('AI agent fixes', () => {
  const aiSettings = {
    model: DEFAULT_AI_MODEL,
    api_key: 'sk-ant-test',
    instructions: 'Vende departamentos.',
    knowledge: 'Depa de 2 recámaras: $1,000,000 MXN, con un cajón de estacionamiento.',
    handoff_message: 'Te paso con un asesor.',
    only_unassigned: false,
    max_replies: 10,
  };
  const claudeCalls = () => claude.calls.filter((c) => c.url.includes('api.anthropic.com'));
  const messagesOf = async (id: string) => (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages;

  beforeAll(async () => {
    const r = await env.api('PUT', '/api/workspace/settings', { automation_mode: 'ai', ai: aiSettings });
    expect(r.status).toBe(200);
  });

  it('answers a message that arrives while the AI is still writing the previous reply', async () => {
    const from = '5215577770001';
    duringClaude = async () => {
      await env.api('POST', `/api/channels/${channelId}/simulate`, { from, text: '¿Tiene estacionamiento?', name: 'Ana' });
    };
    replies.push(
      { content: [{ type: 'text', text: 'Cuesta $1,000,000 MXN.' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Sí, incluye un cajón.' }], stop_reason: 'end_turn' },
    );
    const before = claudeCalls().length;
    const id = await say(from, '¿Precio del depa?');
    await runDueJobs();
    const calls = claudeCalls().slice(before);
    expect(calls).toHaveLength(2);
    // The follow-up is shown after the reply that did not see it, so it gets its own answer.
    expect(calls[1].body.messages).toEqual([
      { role: 'user', content: '¿Precio del depa?' },
      { role: 'assistant', content: 'Cuesta $1,000,000 MXN.' },
      { role: 'user', content: '¿Tiene estacionamiento?' },
    ]);
    const msgs = await messagesOf(id);
    const out = msgs.filter((m: any) => m.direction === 'out');
    expect(out.map((m: any) => m.body)).toEqual(['Cuesta $1,000,000 MXN.', 'Sí, incluye un cajón.']);
    const firstIn = msgs.find((m: any) => m.body === '¿Precio del depa?');
    const row = (await env.built.ctx.db.query(`SELECT payload FROM messages WHERE id = $1`, [out[0].id])).rows[0];
    expect(row.payload.ai_last_in).toBe(firstIn.id);
    // Nothing left to answer: no third call.
    await runDueJobs();
    expect(claudeCalls().length - before).toBe(2);
  });

  it('keeps a handoff the AI decided even if the next Claude call fails', async () => {
    replies.push(
      {
        content: [
          { type: 'text', text: 'Claro, te comunico con un asesor.' },
          { type: 'tool_use', id: 'tu_p', name: 'handoff_to_human', input: { reason: 'Pidió hablar con una persona' } },
        ],
        stop_reason: 'tool_use',
      },
      { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'Overloaded' } }, headers: { 'x-should-retry': 'false' } },
    );
    const id = await say('5215577770002', 'Quiero hablar con una persona');
    const c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.ai_paused).toBe(true);
    expect(c.assigned_user_id).toBeTruthy();
    const msgs = await messagesOf(id);
    expect(msgs.filter((m: any) => m.direction === 'out').map((m: any) => m.body)).toEqual(['Claro, te comunico con un asesor.']);
    expect(msgs.some((m: any) => m.type === 'note' && m.body.includes('Pidió hablar con una persona'))).toBe(true);
    const jobs = await env.built.ctx.db.query(`SELECT status FROM jobs WHERE type = 'ai.reply' AND payload->>'contactId' = $1`, [id]);
    expect(jobs.rows.map((j: any) => j.status)).toEqual(['done']);
  });

  it('does not answer the opt-out itself, but still answers a contact who opted out of broadcasts', async () => {
    const before = claudeCalls().length;
    const id = await say('5215577770003', 'BAJA');
    expect(claudeCalls().length).toBe(before);
    replies.push({ content: [{ type: 'text', text: 'Hola, ¿en qué te ayudo?' }], stop_reason: 'end_turn' });
    await say('5215577770003', 'hola');
    expect(claudeCalls().length).toBe(before + 1);
    expect((await messagesOf(id)).filter((m: any) => m.direction === 'out').map((m: any) => m.body)).toEqual(['Hola, ¿en qué te ayudo?']);
  });
});
