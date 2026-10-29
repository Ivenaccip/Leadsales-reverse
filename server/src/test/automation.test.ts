import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTitles } from '../services/automation.js';
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

/** Id of the button or list row with that title in the latest menu that showed it, as WhatsApp sends it back on a tap. */
async function tapId(contactId: string, title: string): Promise<string> {
  const msgs = (await env.api('GET', `/api/contacts/${contactId}/messages`)).body.messages.filter((m: any) => m.direction === 'out').reverse();
  for (const m of msgs) {
    const i = m.payload?.interactive;
    const choices = [...(i?.action?.buttons ?? []).map((b: any) => b.reply), ...(i?.action?.sections ?? []).flatMap((s: any) => s.rows)];
    const hit = choices.find((c: any) => c.title === title);
    if (hit) return hit.id;
  }
  throw new Error(`no menu showed "${title}"`);
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
    // Ids carry the option's place in the menu tree (plus a hash of its labels), so old menus can still be tapped safely.
    expect(out.payload.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual([expect.stringMatching(/^menu:0:/), expect.stringMatching(/^menu:1:/)]);

    await say('5215500001111', 'algo raro');
    out = await lastOut(id);
    expect(out.body).toContain('No entendí.');

    await say('5215500001111', 'Agendar cita', await tapId(id, 'Agendar cita'));
    out = await lastOut(id);
    expect(out.payload.interactive.type).toBe('list'); // nested menu adds "0. Menú principal"
    expect(out.payload.interactive.action.sections[0].rows.map((r: any) => r.id)).toEqual([
      expect.stringMatching(/^menu:0\.0:/),
      expect.stringMatching(/^menu:0\.1:/),
      'menu:home',
    ]);

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

async function outs(contactId: string) {
  return (await env.api('GET', `/api/contacts/${contactId}/messages`)).body.messages.filter((m: any) => m.direction === 'out');
}

/** Stores an inbound message without running the queue, like a burst arriving while the worker is busy. */
async function arrive(from: string, text: string) {
  const r = await env.api('POST', `/api/channels/${channelId}/simulate`, { from, text, name: 'Paciente' });
  expect(r.status).toBe(200);
  return r.body.message.contact_id as string;
}

const dentalMenu = () => ({
  prompt: '¡Hola! ¿Qué necesitas?',
  options: [
    {
      key: '1',
      label: 'Agendar cita',
      submenu: {
        prompt: '¿Qué tratamiento?',
        options: [
          { key: '1', label: 'Limpieza', reply: 'La limpieza cuesta $500.', stage_id: stages[2].id, handoff: true },
          { key: '2', label: 'Ortodoncia', reply: 'La ortodoncia empieza en $20,000.', handoff: true },
        ],
      },
    },
    { key: '2', label: 'Hablar con alguien', handoff: true },
  ],
});

async function menuMode(menu = dentalMenu()) {
  const r = await env.api('PUT', '/api/workspace/settings', {
    automation_mode: 'menu',
    away: { enabled: false, text: 'x', hours: {} },
    welcome: { enabled: false, text: '' },
    bot: { menu, fallback: 'No entendí.', handoff_message: 'Te atiende un asesor.', interactive: true, only_unassigned: false },
  });
  expect(r.status).toBe(200);
}

describe('automation fixes', () => {
  it('handles a burst of messages from one contact one at a time (one menu, one away notice)', async () => {
    await menuMode();
    const id = await arrive('5215500006001', 'Hola');
    await arrive('5215500006001', 'quiero info');
    await env.drain();
    const bot = await outs(id);
    // In order: the menu for "Hola", then the fallback for an answer that is not an option.
    expect(bot).toHaveLength(2);
    expect(bot[0].body.startsWith('¡Hola! ¿Qué necesitas?')).toBe(true);
    expect(bot[1].body.startsWith('No entendí.')).toBe(true);

    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', away: { enabled: true, text: 'Estamos cerrados', hours: {} } });
    const other = await arrive('5215500006002', 'hola');
    await arrive('5215500006002', 'buenas noches');
    await arrive('5215500006002', 'quisiera información');
    await env.drain();
    expect((await outs(other)).map((m: any) => m.body)).toEqual(['Estamos cerrados']);
    await env.api('PUT', '/api/workspace/settings', { away: { enabled: false, text: 'x', hours: {} } });
  });

  it('does not answer the opt-out itself, but still answers what the contact writes later (opting out only stops broadcasts)', async () => {
    await menuMode();
    const id = await say('5215500006003', 'BAJA');
    expect((await env.api('GET', `/api/contacts/${id}`)).body.contact.opted_out).toBe(true);
    expect(await outs(id)).toHaveLength(0);
    await say('5215500006003', 'hola');
    expect((await outs(id)).map((m: any) => m.body.split('\n')[0])).toEqual(['¡Hola! ¿Qué necesitas?']);

    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', welcome: { enabled: true, text: '¡Bienvenido!' }, away: { enabled: true, text: 'Cerrado', hours: {} } });
    const fresh = await say('5215500006004', 'STOP');
    expect(await outs(fresh)).toHaveLength(0);
    await say('5215500006004', 'hola');
    expect((await outs(fresh)).map((m: any) => m.body)).toEqual(['Cerrado']);
    await env.api('PUT', '/api/workspace/settings', { welcome: { enabled: false, text: '' }, away: { enabled: false, text: 'x', hours: {} } });
  });

  it('never sends two reply buttons with the same title', async () => {
    expect(uniqueTitles([{ key: '1', label: 'Información sobre precios' }, { key: '2', label: 'Información sobre horarios' }], 20)).toEqual([
      '1. Información…',
      '2. Información…',
    ]);
    const dupKeys = uniqueTitles([{ key: '1', label: 'Información sobre precios' }, { key: '1', label: 'Información sobre horarios' }, { key: '3', label: 'Otro' }], 20);
    expect(new Set(dupKeys).size).toBe(3);
    expect(dupKeys.every((t) => t.length <= 20)).toBe(true);

    await menuMode({
      prompt: 'Elige',
      options: [
        { key: '1', label: 'Información sobre precios' },
        { key: '2', label: 'Información sobre horarios' },
        { key: '3', label: 'Hablar con un asesor' },
      ],
    } as any);
    const id = await say('5215500006005', 'hola');
    const buttons = (await outs(id))[0].payload.interactive.action.buttons;
    const titles = buttons.map((b: any) => b.reply.title);
    expect(new Set(titles).size).toBe(3);
    expect(titles.every((t: string) => t.length <= 20)).toBe(true);
    expect(new Set(buttons.map((b: any) => b.reply.id)).size).toBe(3);
  });

  it('reads a tap on an old menu against the menu it came from', async () => {
    await menuMode();
    const from = '5215500006006';
    const id = await say(from, 'hola');
    const agendar = await tapId(id, 'Agendar cita');
    await say(from, 'Agendar cita', agendar);
    let c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.bot_state.path).toEqual(['1']);
    const before = (await outs(id)).length;

    // Double tap on "Agendar cita": not read as option 1 of the submenu (Limpieza).
    await say(from, 'Agendar cita', agendar);
    expect(await outs(id)).toHaveLength(before);
    c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.bot_state).toMatchObject({ path: ['1'] });
    expect(c.bot_state.done).toBeFalsy();
    expect(c.stage_id).not.toBe(stages[2].id);

    // From inside the submenu, the customer taps "Hablar con alguien" on the main menu: not "Ortodoncia".
    await say(from, 'Hablar con alguien', await tapId(id, 'Hablar con alguien'));
    const bodies = (await outs(id)).map((m: any) => m.body);
    expect(bodies).not.toContain('La ortodoncia empieza en $20,000.');
    expect(bodies[bodies.length - 1]).toBe('Te atiende un asesor.');
    c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.bot_state).toMatchObject({ path: [], done: true });
    expect(c.assigned_user_id).toBeTruthy();

    // A submenu row still works, and an id from a menu that no longer exists only re-sends the menu.
    const other = '5215500006007';
    const id2 = await say(other, 'hola');
    await say(other, 'Agendar cita', await tapId(id2, 'Agendar cita'));
    const limpieza = await tapId(id2, 'Limpieza');
    await say(other, 'Viejo', 'menu:7.3:AAAAAAAA');
    expect((await outs(id2)).pop().body.startsWith('No entendí.')).toBe(true);
    await say(other, 'Limpieza', limpieza);
    expect((await outs(id2)).some((m: any) => m.body === 'La limpieza cuesta $500.')).toBe(true);
    expect((await env.api('GET', `/api/contacts/${id2}`)).body.contact.stage_id).toBe(stages[2].id);
  });

  it('ignores a tap on a menu sent before the admin added or removed options', async () => {
    const opts = (...o: any[]) => ({ prompt: '¿Qué necesitas?', options: o });
    const precios = { label: 'Ver precios', reply: 'Precio: $100' };
    const humano = { label: 'Hablar con alguien', handoff: true };
    await menuMode(opts({ key: '1', ...precios }, { key: '2', ...humano }) as any);
    const from = '5215500006008';
    const id = await say(from, 'hola');
    const oldPrecios = await tapId(id, 'Ver precios');

    // A promotion becomes the first option: the old "Ver precios" button now sits where the promotion is.
    const promo = { key: '1', label: 'Promoción del mes', reply: 'Promo 2x1 solo hoy', tag_ids: [tags[0].id] };
    await menuMode(opts(promo, { key: '2', ...precios }, { key: '3', ...humano }) as any);
    await say(from, 'Ver precios', oldPrecios);
    let bodies = (await outs(id)).map((m: any) => m.body);
    expect(bodies).not.toContain('Promo 2x1 solo hoy');
    expect(bodies[bodies.length - 1].startsWith('No entendí.')).toBe(true); // the current menu again
    let c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.tag_ids).not.toContain(tags[0].id);
    expect(c.bot_state.done).toBeFalsy();
    const assigned = c.assigned_user_id;

    // The promotion is removed again: "Ver precios" of the menu just sent (position 1) is now "Hablar con alguien".
    const precios3 = await tapId(id, 'Ver precios');
    await menuMode(opts({ key: '1', ...precios }, { key: '2', ...humano }) as any);
    await say(from, 'Ver precios', precios3);
    bodies = (await outs(id)).map((m: any) => m.body);
    expect(bodies).not.toContain('Te atiende un asesor.');
    expect(bodies[bodies.length - 1].startsWith('No entendí.')).toBe(true);
    c = (await env.api('GET', `/api/contacts/${id}`)).body.contact;
    expect(c.assigned_user_id).toBe(assigned);
    expect(c.bot_state.done).toBeFalsy();

    // A button from the current menu still works.
    await say(from, 'Ver precios', await tapId(id, 'Ver precios'));
    expect((await outs(id)).pop().body).toBe('Precio: $100');
  });
});
