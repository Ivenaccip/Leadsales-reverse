import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, sleep, type TestEnv } from './helpers.js';

let env: TestEnv;
let funnel: any;
let agentA: { id: string; cookie: string };
let agentB: { id: string; cookie: string };

async function login(email: string, password: string) {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return `ll_token=${r.cookies[0].value}`;
}

beforeAll(async () => {
  env = await setup();
  await env.register('crm@test.com', 'Agencia');
  await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' });
  funnel = (await env.api('GET', '/api/funnels')).body.funnels[0];
  for (const [i, email] of ['a@test.com', 'b@test.com'].entries()) {
    const r = await env.api('POST', '/api/workspace/members', { email, name: `Agente ${i}`, password: 'agente1234', role: 'agent' });
    const cookie = await login(email, 'agente1234');
    if (i === 0) agentA = { id: r.body.id, cookie };
    else agentB = { id: r.body.id, cookie };
  }
  // the owner does not take leads in this test
  const me = (await env.api('GET', '/api/auth/me')).body.user;
  await env.api('PATCH', `/api/workspace/members/${me.id}`, { receives_leads: false });
});
afterAll(() => env.close());

describe('contacts & funnels', () => {
  it('dedupes contacts by normalized phone', async () => {
    const a = await env.api('POST', '/api/contacts', { phone: '+52 1 55 4444 3333', name: 'Uno' });
    const b = await env.api('POST', '/api/contacts', { phone: '5544443333', name: 'Dos' });
    expect(a.body.created).toBe(true);
    expect(b.body.created).toBe(false);
    expect(b.body.contact.id).toBe(a.body.contact.id);
    const bad = await env.api('POST', '/api/contacts', { phone: '12345' });
    expect(bad.status).toBe(400);
  });

  it('auto-assigns new leads round robin when the funnel has it enabled', async () => {
    await env.api('PATCH', `/api/funnels/${funnel.id}`, { auto_assign: true });
    const ids = [];
    for (const p of ['5511110001', '5511110002', '5511110003', '5511110004']) {
      ids.push((await env.api('POST', '/api/contacts', { phone: p })).body.contact.assigned_user_id);
    }
    expect(ids.filter((x) => x === agentA.id)).toHaveLength(2);
    expect(ids.filter((x) => x === agentB.id)).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    await env.api('PATCH', `/api/funnels/${funnel.id}`, { auto_assign: false });
  });

  it('restricts agents to their leads when visibility is "assigned"', async () => {
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' });
    const all = (await env.api('GET', '/api/contacts')).body.total;
    const mine = await env.api('GET', '/api/contacts', undefined, { cookie: agentA.cookie });
    expect(mine.body.total).toBeLessThan(all);
    expect(mine.body.items.every((c: any) => c.assigned_user_id === agentA.id || c.assigned_user_id === null)).toBe(true);
    const other = (await env.api('GET', `/api/contacts?assigned_user_id=${agentB.id}`)).body.items[0];
    const denied = await env.api('GET', `/api/contacts/${other.id}`, undefined, { cookie: agentA.cookie });
    expect(denied.status).toBe(400);
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'all' });
  });

  it('moves leads between stages and records the history', async () => {
    const c = (await env.api('POST', '/api/contacts', { phone: '5599990001', name: 'Kanban' })).body.contact;
    const won = funnel.stages.find((s: any) => s.kind === 'won');
    const r = await env.api('PATCH', `/api/contacts/${c.id}`, { stage_id: won.id, deal_value: 2500 });
    expect(r.body.contact.stage_id).toBe(won.id);
    const detail = (await env.api('GET', `/api/contacts/${c.id}`)).body;
    expect(detail.events[0].type).toBe('stage_changed');
    expect(detail.events[0].data.kind).toBe('won');
    const board = (await env.api('GET', `/api/funnels/${funnel.id}/board`)).body.stages;
    const wonCol = board.find((s: any) => s.id === won.id);
    expect(wonCol.count).toBe(1);
    expect(wonCol.value).toBe(2500);
    const report = (await env.api('GET', '/api/reports/overview')).body;
    expect(report.totals.won).toBe(1);
    expect(report.totals.won_value).toBe(2500);
    expect(report.daily.length).toBeGreaterThan(25);
    expect(report.agents.length).toBe(3);
  });

  it('applies bulk actions', async () => {
    const tag = (await env.api('POST', '/api/tags', { name: 'Feria 2026', color: '#123456' })).body.tag;
    const list = (await env.api('GET', '/api/contacts?limit=3&sort=created')).body.items;
    const ids = list.map((c: any) => c.id);
    const r = await env.api('POST', '/api/contacts/bulk', { ids, action: 'add_tags', tag_ids: [tag.id] });
    expect(r.body.updated).toBe(3);
    const tagged = await env.api('GET', `/api/contacts?tag_id=${tag.id}`);
    expect(tagged.body.total).toBe(3);
    const mv = await env.api('POST', '/api/contacts/bulk', { ids, action: 'move_stage', stage_id: funnel.stages[1].id });
    expect(mv.body.updated).toBe(3);
    const del = await env.api('POST', '/api/contacts/bulk', { ids: [ids[0]], action: 'delete' }, { cookie: agentA.cookie });
    expect(del.status).toBe(400);
  });

  it('imports and exports CSV', async () => {
    const csv = 'Nombre,Teléfono,Correo,Etiquetas,Ciudad\nJuan Pérez,55 1234 9999,juan@x.com,VIP;Expo,Puebla\nSin tel,,x@x.com,,\nRepetido,+52 1 55 1234 9999,,,\n';
    const r = await env.api('POST', '/api/contacts/import', { csv });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 3, created: 1, existing: 1, error_count: 1 });
    const juan = (await env.api('GET', '/api/contacts?search=Juan')).body.items[0];
    expect(juan.custom_fields).toEqual({ Ciudad: 'Puebla' });
    expect(juan.tag_ids).toHaveLength(2);
    expect(juan.source).toBe('import');
    const exp = await env.api('GET', '/api/contacts/export.csv');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.raw).toContain('Juan Pérez');
    expect(exp.raw).toContain('+525512349999');
  });

  it('manages funnels and stages', async () => {
    const f = await env.api('POST', '/api/funnels', { name: 'Postventa' });
    expect(f.status).toBe(200);
    const created = f.body.funnels.find((x: any) => x.name === 'Postventa');
    expect(created.stages).toHaveLength(4);
    const st = await env.api('POST', `/api/funnels/${created.id}/stages`, { name: 'Encuesta', color: '#abcdef' });
    expect(st.body.stage.position).toBe(4);
    const order = [st.body.stage.id, ...created.stages.map((s: any) => s.id)];
    const re = await env.api('PUT', `/api/funnels/${created.id}/stages/order`, { stage_ids: order });
    expect(re.body.funnels.find((x: any) => x.id === created.id).stages[0].name).toBe('Encuesta');
    const c = (await env.api('POST', '/api/contacts', { phone: '5588887777', funnel_id: created.id })).body.contact;
    expect(c.stage_id).toBe(st.body.stage.id);
    expect((await env.api('DELETE', `/api/funnels/${created.id}`)).status).toBe(204);
    const moved = (await env.api('GET', `/api/contacts/${c.id}`)).body.contact;
    expect(moved.funnel_id).toBe(funnel.id);
  });

  it('schedules messages', async () => {
    const ch = (await env.api('GET', '/api/channels')).body.channels[0];
    const sim = await env.api('POST', `/api/channels/${ch.id}/simulate`, { from: '5215570707070', text: 'hola' });
    const id = sim.body.message.contact_id;
    const past = await env.api('POST', `/api/contacts/${id}/scheduled`, { send_at: new Date(Date.now() - 3600_000).toISOString(), content: { type: 'text', text: 'x' } });
    expect(past.status).toBe(400);
    const r = await env.api('POST', `/api/contacts/${id}/scheduled`, { send_at: new Date(Date.now() + 1200).toISOString(), content: { type: 'text', text: 'Recordatorio: mañana es tu cita' } });
    expect(r.status).toBe(200);
    await sleep(1500);
    await env.drain();
    const s = (await env.api('GET', '/api/scheduled')).body.scheduled.find((x: any) => x.id === r.body.scheduled.id);
    expect(s.status).toBe('sent');
    const msgs = (await env.api('GET', `/api/contacts/${id}/messages`)).body.messages;
    expect(msgs.pop().body).toBe('Recordatorio: mañana es tu cita');
  });

  it('uploads media and sends it, and quick replies with placeholders', async () => {
    const ch = (await env.api('GET', '/api/channels')).body.channels[0];
    const sim = await env.api('POST', `/api/channels/${ch.id}/simulate`, { from: '5215580808080', name: 'Rosa María', text: 'hola' });
    const id = sim.body.message.contact_id;
    const boundary = '----x';
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="catalogo.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 fake\r\n--${boundary}--\r\n`;
    const up = await env.api('POST', '/api/media', payload, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.status).toBe(200);
    expect(up.body.media.mime).toBe('application/pdf');
    const sent = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'media', media_file_id: up.body.media.id, caption: 'Catálogo' });
    expect(sent.body.message.type).toBe('document');
    expect(sent.body.message.status).toBe('sent');
    const bad = await env.api('POST', '/api/media', payload.replace('application/pdf', 'application/x-msdownload'), {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(bad.status).toBe(400);

    const qr = await env.api('POST', '/api/quick-replies', { shortcut: 'hola', body: 'Hola {primer_nombre} 👋\n¿En qué te ayudo?' });
    expect(qr.status).toBe(200);
    const m = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'quick_reply', quick_reply_id: qr.body.quick_reply.id });
    expect(m.body.message.body).toBe('Hola Rosa 👋\n¿En qué te ayudo?');
  });
});
