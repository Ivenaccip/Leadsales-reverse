// Prueba de punta a punta del modelo "sin mensualidad, solo créditos" contra una instancia NUEVA
// de LeadLibre y una Graph API de Meta simulada que este script levanta (ver docs/04-despliegue.md,
// "Comprobar una instalación nueva"). Crea cuentas de prueba: se niega a correr en una instancia
// que ya tiene usuarios.
// Uso: node deploy/smoke/creditos.mjs <url de la instancia> <puerto de la Graph simulada> <META_APP_SECRET> [first|after-restart <saldo>]
import crypto from 'node:crypto';
import http from 'node:http';

const BASE = process.argv[2];
const GRAPH_PORT = Number(process.argv[3]);
const META_SECRET = process.argv[4];
const PHASE = process.argv[5] ?? 'all';
if (!BASE || !GRAPH_PORT || !META_SECRET) {
  console.error('Uso: node deploy/smoke/creditos.mjs <url de la instancia> <puerto de la Graph simulada> <META_APP_SECRET> [first|after-restart <saldo>]');
  process.exit(2);
}

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('✔', msg);
  else {
    failures++;
    console.log('✘', msg, extra !== undefined ? JSON.stringify(extra) : '');
  }
};
const round = (n) => Math.round(n * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`se agotó la espera: ${what}`);
    await sleep(250);
  }
}

// ------------------------------------------------------------------ Graph API de Meta simulada
const FLOR = { phoneId: '1010101010101', waba: '2020202020202', display: '+52 55 1111 0001' };
const TALLER = { phoneId: '3030303030303', waba: '4040404040404', display: '+52 33 2222 0002' };
const NUMBERS = { [FLOR.phoneId]: FLOR, [TALLER.phoneId]: TALLER };
const TEMPLATES = (waba) => [
  { id: `${waba}1`, name: 'promo', language: 'es_MX', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: '¡Promo de temporada!' }] },
  { id: `${waba}2`, name: 'aviso', language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Tu pedido va en camino' }] },
];
const sends = [];
const failTo = new Set();
let wamidSeq = 0;
// El wa_id que Meta devuelve para un número de México enviado sin el 1.
const metaWaId = (to) => (/^52\d{10}$/.test(to) ? `521${to.slice(2)}` : to);

const graph = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://graph');
    const parts = url.pathname.split('/').filter(Boolean); // [v23.0, id, arista?]
    const [, id, edge] = parts;
    const body = raw ? JSON.parse(raw) : null;
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && NUMBERS[id] && !edge) {
      return json(200, { id, display_phone_number: NUMBERS[id].display, verified_name: 'Negocio', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', platform_type: 'CLOUD_API' });
    }
    const byWaba = Object.values(NUMBERS).find((n) => n.waba === id);
    if (byWaba && edge === 'phone_numbers') return json(200, { data: [{ id: byWaba.phoneId }] });
    if (byWaba && edge === 'subscribed_apps') return json(200, { success: true });
    if (byWaba && edge === 'message_templates') return json(200, { data: TEMPLATES(id) });
    const tpl = Object.values(NUMBERS).flatMap((n) => TEMPLATES(n.waba)).find((t) => t.id === id);
    if (tpl && !edge) return json(200, tpl);
    if (NUMBERS[id] && edge === 'messages' && req.method === 'POST') {
      if (body?.status === 'read') return json(200, { success: true });
      const to = body.to;
      sends.push({ phoneId: id, to, type: body.type, template: body.template?.name ?? null, cb: body.biz_opaque_callback_data ?? null });
      if (failTo.has(to) || failTo.has(metaWaId(to))) return json(400, { error: { message: '(#131026) Message undeliverable', type: 'OAuthException', code: 131026, fbtrace_id: 'smoke' } });
      return json(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: metaWaId(to) }], messages: [{ id: `wamid.SMOKE.${++wamidSeq}` }] });
    }
    json(404, { error: { message: `Graph simulada: no hay ruta para ${req.method} ${url.pathname}`, code: 100 } });
  });
});
await new Promise((r) => graph.listen(GRAPH_PORT, '127.0.0.1', r));

// ------------------------------------------------------------------ cliente de LeadLibre
class User {
  constructor(name) {
    this.name = name;
    this.cookie = '';
    this.ws = null;
  }
  async req(method, path, body, ws = this.ws) {
    const headers = { origin: BASE };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (ws) headers['x-workspace-id'] = ws;
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      if (pair.startsWith('ll_token=')) this.cookie = pair;
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, body: data };
  }
}

async function webhook(number, value, secret) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: number.waba, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: number.display.replace(/\D/g, ''), phone_number_id: number.phoneId }, ...value } }] }],
  });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(`${BASE}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` }, body });
  return res.status;
}
const now = () => String(Math.floor(Date.now() / 1000));
let inSeq = 0;
const inbound = (from, text) => ({ contacts: [{ profile: { name: 'Cliente' }, wa_id: from }], messages: [{ from, id: `wamid.IN.${Date.now()}.${++inSeq}`, timestamp: now(), type: 'text', text: { body: text } }] });
const status = (wamid, st, recipient, extra = {}) => ({ statuses: [{ id: wamid, status: st, timestamp: now(), recipient_id: recipient, ...extra }] });
const PAID = (category) => ({ pricing: { billable: true, pricing_model: 'PMP', category, type: 'regular' } });
const FREE = (category) => ({ pricing: { billable: false, pricing_model: 'PMP', category, type: 'free_customer_service' } });

const op = new User('operadora');
const rosa = new User('rosa');
const beto = new User('beto');
const balanceOf = async (u) => (await u.req('GET', '/api/credits')).body;
const messagesOf = async (u, contactId) => (await u.req('GET', `/api/contacts/${contactId}/messages`)).body.messages;
const lastOut = async (u, contactId) => (await messagesOf(u, contactId)).filter((m) => m.direction === 'out').sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
async function contactByPhone(u, phone) {
  const r = await u.req('GET', `/api/contacts?search=${phone}`);
  return (r.body.items ?? []).find((c) => c.phone === phone) ?? null;
}

async function login(u, email, password) {
  const r = await u.req('POST', '/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`no se pudo iniciar sesión como ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  u.ws = r.body.workspaces?.[0]?.id ?? u.ws;
  return r.body;
}

if (PHASE === 'all' || PHASE === 'first') {
  const inst = await (await fetch(`${BASE}/api/instance`)).json();
  if (inst.hasUsers) {
    console.error('Esta instancia ya tiene usuarios: la prueba crea cuentas de ejemplo, córrela solo en una instancia nueva.');
    process.exit(2);
  }
  // ---------------------------------------------------------------- 1. la instancia está arriba
  const health = await fetch(`${BASE}/health`);
  ok(health.ok, `la instancia responde /health (${health.status})`);
  const page = await (await fetch(`${BASE}/`)).text();
  ok(/<div id="root">/.test(page), 'la aplicación web se sirve desde la misma instancia');

  // ---------------------------------------------------------------- 2. cuentas
  const r1 = await op.req('POST', '/api/auth/register', { name: 'Operadora Comunidad', email: 'op@comunidad.mx', password: 'operadora123', workspaceName: 'Comunidad' });
  ok(r1.status === 200 && r1.body.user?.is_superadmin === true, 'la primera cuenta es la operadora de la instancia (superadmin)', r1.body?.user);
  op.ws = r1.body.workspaces?.[0]?.id;
  const r2 = await rosa.req('POST', '/api/auth/register', { name: 'Rosa Flores', email: 'rosa@floreria.mx', password: 'rosa12345', workspaceName: 'Florería Rosa' });
  ok(r2.status === 200 && !r2.body.user?.is_superadmin, 'un negocio de la comunidad se registra solo, sin mensualidad');
  rosa.ws = r2.body.workspaces?.[0]?.id;
  const r3 = await beto.req('POST', '/api/auth/register', { name: 'Beto Taller', email: 'beto@taller.mx', password: 'beto12345', workspaceName: 'Taller Beto' });
  ok(r3.status === 200, 'se registra un segundo negocio');
  beto.ws = r3.body.workspaces?.[0]?.id;

  // ---------------------------------------------------------------- 3. la operadora le vende créditos a Florería
  const sw = await op.req('PATCH', `/api/admin/workspaces/${rosa.ws}`, { billing_mode: 'prepaid' });
  ok(sw.status === 200 && sw.body.workspace?.billing_mode === 'prepaid', 'la operadora pasa a Florería a créditos prepagados', sw.body);
  const top = await op.req('POST', `/api/admin/workspaces/${rosa.ws}/credits`, { amount: 1, description: 'Recarga inicial (pago de Rosa)' });
  ok(top.status === 200, 'la operadora recarga 1.00 USD de créditos', top.body);
  let c = await balanceOf(rosa);
  ok(c.billing_mode === 'prepaid' && round(c.balance) === 1, `Florería ve su saldo: ${c.balance} (${c.billing_mode})`, c);

  // ---------------------------------------------------------------- 4. números
  const self = await rosa.req('POST', '/api/channels', { provider: 'cloud_api', name: 'Florería', phone_number_id: FLOR.phoneId, waba_id: FLOR.waba, access_token: 'EAAG-rosa-own-token-xxxxxxxxxxxx', app_secret: 'rosa-own-app-secret-123456' });
  ok(self.status === 403, `un negocio prepagado no puede conectar un número con su propia app (${self.status})`);
  const chF = await op.req('POST', '/api/channels', { provider: 'cloud_api', name: 'Florería', phone_number_id: FLOR.phoneId, waba_id: FLOR.waba, access_token: 'EAAG-operator-token-xxxxxxxxxxxx', app_secret: META_SECRET }, rosa.ws);
  ok(chF.status === 200 && chF.body.channel?.operator_verified === true, 'la operadora conecta el número de Florería con la app de Meta de la instancia', chF.body);
  const tplF = await rosa.req('GET', '/api/templates');
  ok((tplF.body.templates ?? []).map((t) => t.name).sort().join(',') === 'aviso,promo', 'sus plantillas se leyeron de Meta', tplF.body);
  const chT = await beto.req('POST', '/api/channels', { provider: 'cloud_api', name: 'Taller', phone_number_id: TALLER.phoneId, waba_id: TALLER.waba, access_token: 'EAAG-beto-own-token-xxxxxxxxxxxx', app_secret: 'beto-own-app-secret-123456' });
  ok(chT.status === 200, 'un negocio que paga directo a Meta conecta su propio número');

  // ---------------------------------------------------------------- 5. una clienta escribe; las respuestas en la ventana son gratis
  const ANA = '5215512345678';
  ok((await webhook(FLOR, inbound(ANA, 'Hola, ¿tienen rosas rojas?'), META_SECRET)) === 200, 'Meta entrega el mensaje de una clienta (firmado con la App Secret de la instancia)');
  const ana = await until(() => contactByPhone(rosa, '525512345678'), 'Ana en Florería');
  ok(!!ana, 'la clienta aparece en la bandeja de Florería');
  ok(!(await contactByPhone(beto, '525512345678')), 'y en ningún otro negocio');
  const reply = await rosa.req('POST', `/api/contacts/${ana.id}/messages`, { type: 'text', text: 'Sí, a 50 pesos la docena 🌹' });
  ok(reply.status === 200 && reply.body.message.cost === 0, 'Rosa responde dentro de la ventana de 24 h: cuesta 0', reply.body?.message);
  const replyTo = sends.at(-1)?.to;
  ok(replyTo === ANA || replyTo === '525512345678', `la respuesta fue al número de la clienta (${replyTo})`);
  await webhook(FLOR, status(reply.body.message.wamid, 'delivered', ANA, FREE('service')), META_SECRET);
  await sleep(1500);
  c = await balanceOf(rosa);
  ok(round(c.balance) === 1, `el saldo no cambia tras la respuesta gratuita: ${c.balance}`);

  // ---------------------------------------------------------------- 6. una plantilla de marketing se cobra a la tarifa de Meta
  const rates = (await rosa.req('GET', '/api/credits/rates')).body.rates;
  const P = rates.find((r) => r.market === 'MX' && r.category === 'marketing').price;
  const U = rates.find((r) => r.market === 'MX' && r.category === 'utility').price;
  console.log(`  tarifas: MX marketing ${P}, MX utilidad ${U}`);
  const t1 = await rosa.req('POST', `/api/contacts/${ana.id}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
  ok(t1.status === 200 && round(t1.body.message.cost) === round(P), `una plantilla de marketing se cobra ${t1.body?.message?.cost}`, t1.body);
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(1 - P), `saldo ${c.balance} = 1 - ${P}`);
  await webhook(FLOR, status(t1.body.message.wamid, 'delivered', ANA, PAID('marketing')), META_SECRET);
  await until(async () => (await lastOut(rosa, ana.id))?.status === 'delivered', 'palomita de entregado');
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(1 - P), `Meta confirma que es cobrable: el cargo se queda (${c.balance})`);

  // ---------------------------------------------------------------- 7. una plantilla de utilidad dentro de la ventana resulta gratis: se reembolsa
  const t2 = await rosa.req('POST', `/api/contacts/${ana.id}/messages`, { type: 'template', name: 'aviso', language: 'es_MX' });
  ok(t2.status === 200 && round(t2.body.message.cost) === round(U), `una plantilla de utilidad se reserva en ${t2.body?.message?.cost}`);
  await webhook(FLOR, status(t2.body.message.wamid, 'delivered', ANA, FREE('utility')), META_SECRET);
  await until(async () => round((await balanceOf(rosa)).balance) === round(1 - P), 'reembolso de utilidad', 10000).catch(() => null);
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(1 - P), `Meta dice que fue gratis (ventana de servicio): se reembolsa, saldo ${c.balance}`);

  // ---------------------------------------------------------------- 8. las fallas se reembolsan
  const LUIS = '5215598765432';
  await webhook(FLOR, inbound(LUIS, 'Quiero un arreglo'), META_SECRET);
  const luis = await until(() => contactByPhone(rosa, '525598765432'), 'Luis en Florería');
  failTo.add(LUIS);
  const t3 = await rosa.req('POST', `/api/contacts/${luis.id}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
  ok(t3.body?.message?.status === 'failed', `Meta rechaza un envío (131026): el mensaje queda fallido`, t3.body);
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(1 - P), `y su cargo se reembolsa al instante (${c.balance})`);
  failTo.delete(LUIS);
  const t4 = await rosa.req('POST', `/api/contacts/${ana.id}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
  ok(t4.status === 200, 'otra promoción se envía y se cobra');
  await webhook(FLOR, status(t4.body.message.wamid, 'sent', ANA, PAID('marketing')), META_SECRET);
  await webhook(FLOR, status(t4.body.message.wamid, 'failed', ANA, { errors: [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.' }] }), META_SECRET);
  await until(async () => (await lastOut(rosa, ana.id))?.status === 'failed', 'estado fallido');
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(1 - P), `Meta la reporta no entregada después: se reembolsa (${c.balance})`);
  // El mismo 'failed' entregado otra vez nunca reembolsa dos veces.
  await webhook(FLOR, status(t4.body.message.wamid, 'failed', ANA, { errors: [{ code: 131049, title: 'again' }] }), META_SECRET);
  await sleep(1500);
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(1 - P), `un 'failed' repetido no reembolsa dos veces (${c.balance})`);

  // ---------------------------------------------------------------- 9. otro negocio no puede tocar el dinero de Florería
  const forged = status(t1.body.message.wamid, 'failed', ANA, { errors: [{ code: 131026, title: 'forged' }] });
  ok((await webhook(TALLER, forged, 'beto-own-app-secret-123456')) === 200, 'Beto falsifica una falla para el mensaje de Florería con la App Secret de su propia app');
  const forged2 = await webhook(FLOR, forged, 'beto-own-app-secret-123456');
  await sleep(1500);
  c = await balanceOf(rosa);
  const t1now = (await messagesOf(rosa, ana.id)).find((m) => m.id === t1.body.message.id);
  ok(round(c.balance) === round(1 - P) && t1now.status === 'delivered', `nada cambia: sin reembolso, el mensaje sigue entregado (${c.balance}, ${t1now.status}; firmado para el número de Florería → ${forged2})`);

  // ---------------------------------------------------------------- 10. sin créditos no hay envíos
  const drain = round(c.balance - P / 2);
  await op.req('POST', `/api/admin/workspaces/${rosa.ws}/credits`, { amount: -drain, description: 'Ajuste de prueba' });
  c = await balanceOf(rosa);
  ok(c.balance < P, `el saldo queda por debajo de una plantilla: ${c.balance}`);
  const before = sends.length;
  const t5 = await rosa.req('POST', `/api/contacts/${ana.id}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
  ok(t5.status === 402 && t5.body?.error?.code === 'INSUFFICIENT_CREDITS' && sends.length === before, `una plantilla sin créditos se rechaza antes de llegar a Meta (${t5.status} ${t5.body?.error?.code})`);
  const free = await rosa.req('POST', `/api/contacts/${ana.id}/messages`, { type: 'text', text: '¿Te aparto la docena?' });
  ok(free.status === 200, 'las respuestas gratuitas dentro de la ventana siguen funcionando sin créditos');
  const bc = await rosa.req('POST', '/api/broadcasts', { name: 'Día de muertos', channel_id: chF.body.channel.id, template_name: 'promo', template_language: 'es_MX', audience: { contact_ids: [ana.id, luis.id] } });
  ok(bc.status === 200, 'Rosa prepara una difusión a 2 clientes', bc.body);
  const est = await rosa.req('POST', '/api/broadcasts/estimate', { template_name: 'promo', template_language: 'es_MX', audience: { contact_ids: [ana.id, luis.id] } });
  ok(est.body.estimate.recipients === 2 && round(est.body.estimate.cost) === round(2 * P) && est.body.estimate.sufficient === false, `la estimación muestra ${est.body.estimate.cost} y que el saldo no alcanza`, est.body.estimate);
  const l1 = await rosa.req('POST', `/api/broadcasts/${bc.body.broadcast.id}/launch`);
  ok(l1.status === 402 && sends.length === before + 1, `lanzarla sin créditos se rechaza (${l1.status} ${l1.body?.error?.code})`);
  await op.req('POST', `/api/admin/workspaces/${rosa.ws}/credits`, { amount: 1, description: 'Segunda recarga' });
  const balBefore = (await balanceOf(rosa)).balance;
  const l2 = await rosa.req('POST', `/api/broadcasts/${bc.body.broadcast.id}/launch`);
  ok(l2.status === 200, 'tras una recarga la difusión arranca', l2.body);
  const done = await until(async () => {
    const b = (await rosa.req('GET', `/api/broadcasts/${bc.body.broadcast.id}`)).body.broadcast;
    return b?.status === 'completed' ? b : null;
  }, 'difusión terminada', 30000);
  ok(!!done, 'la difusión termina');
  c = await balanceOf(rosa);
  ok(round(c.balance) === round(balBefore - 2 * P), `cada destinatario se cobra una vez: ${balBefore} → ${c.balance}`);

  // ---------------------------------------------------------------- 11. el libro de créditos cuadra
  const ledger = (await rosa.req('GET', '/api/credits/ledger')).body;
  const entries = ledger.entries ?? ledger.ledger ?? [];
  const kinds = [...new Set(entries.map((e) => e.kind))].sort();
  console.log(`  libro de créditos: ${entries.length} movimientos, tipos ${kinds.join(', ')}`);
  const sum = round(entries.reduce((s, e) => s + Number(e.amount), 0));
  ok(sum === round(c.balance), `la suma de los movimientos (${sum}) es igual al saldo (${c.balance})`);
  const newest = [...entries].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  ok(round(Number(newest.balance_after)) === round(c.balance), 'el balance_after del movimiento más reciente es el saldo');

  // ---------------------------------------------------------------- 12. meta_direct: nunca se bloquea, el gasto se mide
  const MARIO = '5213312345678';
  await webhook(TALLER, inbound(MARIO, 'Mi coche hace un ruido'), 'beto-own-app-secret-123456');
  const mario = await until(() => contactByPhone(beto, '523312345678'), 'Mario en Taller');
  const bt = await beto.req('POST', `/api/contacts/${mario.id}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
  const cb = await balanceOf(beto);
  ok(bt.status === 200 && cb.billing_mode === 'meta_direct' && round(cb.balance) === 0, `un negocio que paga directo a Meta envía con 0 créditos (${bt.status}, saldo ${cb.balance})`);
  console.log(`  /api/credits de Taller: ${JSON.stringify(cb)}`);
  console.log(`  saldo final de Florería: ${c.balance} (para la fase after-restart)`);
}

if (PHASE === 'after-restart') {
  // ---------------------------------------------------------------- 13. los datos sobreviven a un reinicio
  await login(rosa, 'rosa@floreria.mx', 'rosa12345');
  const c = await balanceOf(rosa);
  const expected = Number(process.argv[6]);
  ok(round(c.balance) === round(expected), `tras reiniciar la instancia el saldo sigue en ${c.balance}`);
  const ana = await contactByPhone(rosa, '525512345678');
  ok(!!ana && (await messagesOf(rosa, ana.id)).length >= 5, 'y el historial de la conversación sigue ahí');
}

graph.close();
console.log(failures ? `FALLAS: ${failures}` : 'TODO BIEN');
process.exit(failures ? 1 : 0);
