import {
  MetaApiError,
  type CreateTemplateInput,
  type MetaTemplate,
  type PhoneInfo,
  type WaMessage,
  type WhatsAppProvider,
} from './types.js';

export interface CloudApiOptions {
  baseUrl: string; // https://graph.facebook.com
  version: string; // v23.0
  accessToken: string;
  phoneNumberId: string;
  wabaId: string | null;
  fetch?: typeof fetch;
  /** Largest inbound media file we download (WhatsApp documents go up to 100 MB). */
  maxMediaBytes?: number;
}

// Explicit timeouts: a hung Graph call must end long before the job runner re-queues the job.
const API_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120_000; // media uploads and downloads

/** Marks an error the job runner must not retry (it reads `retry`). */
function permanent<E extends Error>(e: E): E {
  return Object.assign(e, { retry: false });
}

/** Meta serves media from its own CDNs; anything else in a Graph answer is not followed. */
function isMetaMediaHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'lookaside.fbsbx.com' || h === 'graph.facebook.com' || h.endsWith('.fbsbx.com') || h.endsWith('.fbcdn.net') || h.endsWith('.whatsapp.net');
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const tooBig = () => permanent(new MetaApiError(`El archivo supera el máximo de ${Math.round(max / 1024 / 1024)} MB`, null, 413));
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Client for the official WhatsApp Business Cloud API (Meta Graph API). */
export class CloudApiProvider implements WhatsAppProvider {
  readonly kind = 'cloud_api' as const;
  private f: typeof fetch;

  constructor(private o: CloudApiOptions) {
    this.f = o.fetch ?? fetch;
  }

  private url(path: string) {
    return `${this.o.baseUrl}/${this.o.version}/${path.replace(/^\//, '')}`;
  }

  private async call<T>(method: string, path: string, body?: unknown, form?: FormData, timeoutMs = API_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.accessToken}` };
    let payload: BodyInit | undefined;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.f(this.url(path), { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok || json?.error) {
      const e = json?.error ?? {};
      throw new MetaApiError(
        e.error_user_msg || e.message || `Meta respondió HTTP ${res.status}`,
        typeof e.code === 'number' ? e.code : null,
        res.status,
        e.error_data ?? e,
      );
    }
    return json as T;
  }

  private requireWaba(): string {
    if (!this.o.wabaId) throw new MetaApiError('Configura el WhatsApp Business Account ID (WABA ID) del canal', null, 400);
    return this.o.wabaId;
  }

  async send(to: string, message: WaMessage, replyToWamid?: string) {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...message,
    };
    if (replyToWamid) body.context = { message_id: replyToWamid };
    const r = await this.call<{ messages?: { id: string }[]; contacts?: { input?: string; wa_id?: string }[] }>(
      'POST',
      `${this.o.phoneNumberId}/messages`,
      body,
    );
    const wamid = r?.messages?.[0]?.id;
    if (!wamid) throw new MetaApiError('Meta no devolvió el id del mensaje', null, 502, r);
    // The WhatsApp id Meta resolved can differ from the number we sent to (Brazil's 9th digit, Argentina's 9).
    const waId = String(r.contacts?.[0]?.wa_id ?? '');
    return { wamid, waId: /^\d{6,20}$/.test(waId) ? waId : null };
  }

  async markRead(wamid: string, typing = false) {
    const body: Record<string, unknown> = { messaging_product: 'whatsapp', status: 'read', message_id: wamid };
    if (typing) body.typing_indicator = { type: 'text' };
    await this.call('POST', `${this.o.phoneNumberId}/messages`, body);
  }

  async uploadMedia(data: Buffer, mime: string, filename: string) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename);
    const r = await this.call<{ id: string }>('POST', `${this.o.phoneNumberId}/media`, undefined, form, TRANSFER_TIMEOUT_MS);
    return r.id;
  }

  /** Only Meta's media hosts (or the configured Graph origin, e.g. a local emulator) receive our token. */
  private mediaUrl(raw: unknown): URL | null {
    let u: URL;
    try {
      u = new URL(String(raw ?? ''));
    } catch {
      return null;
    }
    if (u.username || u.password) return null;
    if (u.origin === new URL(this.o.baseUrl).origin) return u;
    return u.protocol === 'https:' && !u.port && isMetaMediaHost(u.hostname) ? u : null;
  }

  async downloadMedia(mediaId: string) {
    // Media ids are numeric. Anything else (e.g. "123?fields=url") would let a forged webhook
    // choose the Graph path and query, and then make us fetch whatever URL that node returns.
    if (!/^\d{1,32}$/.test(mediaId)) throw permanent(new MetaApiError('Id de archivo de Meta inválido', null, 400));
    const meta = await this.call<{ url?: string; mime_type?: string }>('GET', mediaId);
    let url = this.mediaUrl(meta?.url);
    let res: Response;
    // Redirects are followed by hand so every hop is checked against the allowlist.
    for (let hop = 0; ; hop++) {
      if (!url) throw permanent(new MetaApiError('Meta devolvió una dirección de descarga no permitida', null, 502));
      res = await this.f(url.toString(), {
        headers: { Authorization: `Bearer ${this.o.accessToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location || hop >= 3) throw new MetaApiError(`No se pudo descargar el archivo (HTTP ${res.status})`, null, res.status);
      let next: string | null = null;
      try {
        next = new URL(location, url).toString();
      } catch {
        /* invalid Location: refused below */
      }
      url = this.mediaUrl(next);
    }
    if (!res.ok) throw new MetaApiError(`No se pudo descargar el archivo (HTTP ${res.status})`, null, res.status);
    const data = await readCapped(res, this.o.maxMediaBytes ?? 100 * 1024 * 1024);
    return { data, mime: meta?.mime_type ?? '' };
  }

  async getPhoneInfo() {
    return this.call<PhoneInfo>(
      'GET',
      `${this.o.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput`,
    );
  }

  /** Phone number ids registered in the WABA (proves the number belongs to that account). */
  async listPhoneNumberIds(): Promise<string[]> {
    const r = await this.call<{ data: { id: string }[] }>('GET', `${this.requireWaba()}/phone_numbers?fields=id&limit=100`);
    return (r.data ?? []).map((p) => String(p.id));
  }

  async subscribeApp() {
    await this.call('POST', `${this.requireWaba()}/subscribed_apps`);
  }

  async listTemplates() {
    const out: MetaTemplate[] = [];
    let path: string | null =
      `${this.requireWaba()}/message_templates?limit=100&fields=id,name,language,status,category,components,parameter_format,rejected_reason`;
    for (let page = 0; path && page < 50; page++) {
      const r: { data: MetaTemplate[]; paging?: { next?: string } } = await this.call('GET', path);
      out.push(...r.data);
      const next = r.paging?.next;
      path = next ? next.slice(next.indexOf(this.o.version) + this.o.version.length + 1) : null;
    }
    return out;
  }

  async createTemplate(input: CreateTemplateInput) {
    return this.call<{ id: string; status: string; category: string }>(
      'POST',
      `${this.requireWaba()}/message_templates`,
      input,
    );
  }

  async deleteTemplate(name: string) {
    await this.call('DELETE', `${this.requireWaba()}/message_templates?name=${encodeURIComponent(name)}`);
  }
}
