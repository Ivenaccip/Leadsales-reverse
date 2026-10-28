import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let channelId: string;
let stages: any[];
let tags: any[];

beforeAll(async () => {
  env = await setup();
  await env.register('bot@test.com', 'Clínica Dental');
  channelId = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' })).body.channel.id;
  stages = (await env.api('GET', '/api/funnels')).body.funnels[0].stages;
  tags = (await env.api('GET', '/api/tags')).body.tags;
});
afterAll(() => env.close());

async function say(from: string, text: string, reply_id?: string) {
  const r = await env.api('POST', `/api/channels/${channelId}/simulate`, { from, text, name: 'Paciente', reply_id });
  expect(r.status).toBe(200);
  await env.drain();
  return r.body.message.contact_id as string;
}

async function lastOut(contactId: string) {
  const msgs = (await env.api('GET', `/api/contacts/${contactId}/messages`)).body.messages;
  return msgs.filter((m: any) => m.direction === 'out').pop();
}

describe('menu bot (Leadbot)', () => {
  it('rejects menus deeper than 3 levels', async () => {
    const deep = { prompt: 'a', options: [{ key: '1', label: 'x', submenu: { prompt: 'b', options: [{ key: '1', label: 'y', submenu: { prompt: 'c', options: [{ key: '1', label: 'z', submenu: { prompt: 'd', options: [{ key: '1', label: 'w' }] } }] } }] } }] };
    const r = await env.api('PUT', '/api/workspace/settings', { automation_mode: 'menu', bot: { menu: deep, fallback: 'f', handoff_message: 'h', interactive: false, only_unassigned: false } });
    expect(r.status).toBe(400);
  });

  it('guides the customer through the menu and applies actions', async () => {
    const menu = {
      prompt: '¡Hola! ¿Qué necesitas?',
      options: [
        {
          key: '1',
          label: 'Agendar cita',
          reply: 'Perfecto 🦷',
          submenu: {
            prompt: '¿Qué tratamiento?',
            options: [
              { key: '1', label: 'Limpieza', reply: 'La limpieza cuesta $500.', stage_id: stages[2].id, tag_ids: [tags[0].id], handoff: true },
              { key: '2', label: 'Ortodoncia', handoff: true },
            ],
          },
        },
        { key: '2', label: 'Hablar con alguien', handoff: true },
      ],
    };
    const r = await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'menu',
      bot: { menu, fallback: 'No entendí.', handoff_message: 'Te atiende un asesor.', interactive: true, only_unassigned: false },
    });
    expect(r.status).toBe(200);
    const id = await say('5215500001111', 'hola');
    let out = await lastOut(id);
    expect(out.sent_by).toBe('bot');
    expect(out.type).toBe('interactive');
    expect(out.payload.interactive.type).toBe('button');
    expect(out.payload.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['1', '2']);

    await say('5215500001111', 'algo raro');
    out = await lastOut(id);
    expect(out.body).toContain('No entendí.');

    await say('5215500001111', 'Agendar cita', '1');
    out = await lastOut(id);
    expect(out.payload.interactive.type).toBe('list'); // nested menu adds "0. Menú principal"
    expect(out.payload.interactive.action.sections[0].rows.map((r: any) => r.id)).toEqual(['1', '2', '0']);

    await say('5215500001111', '1');
    out = await lastOut(id);
    expect(out.body).toBe('La limpieza cuesta $500.');
    const c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.stage_id).toBe(stages[2].id);
    expect(c.tag_ids).toContain(tags[0].id);
    expect(c.assigned_user_id).toBeTruthy(); // handoff assigns a human (round robin)
    expect(c.bot_state.done).toBe(true);

    // Once finished, the bot stays quiet until the customer asks for the menu again
    const before = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages.length;
    await say('5215500001111', 'gracias');
    expect((await env.api('GET', `/api/contacts/${id}/messages`)).body.messages.length).toBe(before + 1);
    await say('5215500001111', 'menú');
    expect((await lastOut(id)).payload.interactive.type).toBe('button');
  });

  it('stops when a human replies', async () => {
    const id = await say('5215500002222', 'hola');
    await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Hola, soy Ana, te ayudo' });
    const c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.bot_state.done).toBe(true);
    const before = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages.length;
    await say('5215500002222', '1');
    expect((await env.api('GET', `/api/contacts/${id}/messages`)).body.messages.length).toBe(before + 1);
  });
});

describe('welcome and away messages', () => {
  it('sends the welcome message to new contacts when the bot is off', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', welcome: { enabled: true, text: '¡Bienvenido a la clínica!' } });
    const id = await say('5215500003333', 'buenas');
    expect((await lastOut(id)).body).toBe('¡Bienvenido a la clínica!');
    await say('5215500003333', 'otra vez');
    const outs = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages.filter((m: any) => m.direction === 'out');
    expect(outs).toHaveLength(1);
  });

  it('answers outside business hours once every 12 hours', async () => {
    await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'off',
      welcome: { enabled: false, text: '' },
      away: { enabled: true, text: 'Estamos cerrados', hours: {} }, // no hours = always closed
    });
    const id = await say('5215500004444', 'hola?');
    expect((await lastOut(id)).body).toBe('Estamos cerrados');
    await say('5215500004444', 'hola??');
    const outs = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages.filter((m: any) => m.direction === 'out');
    expect(outs).toHaveLength(1);
    await env.api('PUT', '/api/workspace/settings', { away: { enabled: false, text: 'x', hours: {} } });
  });

  it('opts contacts out with BAJA', async () => {
    const id = await say('5215500005555', 'BAJA');
    const c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.opted_out).toBe(true);
  });
});
