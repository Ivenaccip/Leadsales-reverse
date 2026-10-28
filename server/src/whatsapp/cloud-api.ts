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

  private async call<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.accessToken}` };
    let payload: BodyInit | undefined;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.f(this.url(path), { method, headers, body: payload });
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
    const r = await this.call<{ messages: { id: string }[] }>('POST', `${this.o.phoneNumberId}/messages`, body);
    const wamid = r.messages?.[0]?.id;
    if (!wamid) throw new MetaApiError('Meta no devolvió el id del mensaje', null, 502, r);
    return { wamid };
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
    const r = await this.call<{ id: string }>('POST', `${this.o.phoneNumberId}/media`, undefined, form);
    return r.id;
  }

  async downloadMedia(mediaId: string) {
    const meta = await this.call<{ url: string; mime_type: string }>('GET', mediaId);
    const res = await this.f(meta.url, { headers: { Authorization: `Bearer ${this.o.accessToken}` } });
    if (!res.ok) throw new MetaApiError(`No se pudo descargar el archivo (HTTP ${res.status})`, null, res.status);
    return { data: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type };
  }

  async getPhoneInfo() {
    return this.call<PhoneInfo>(
      'GET',
      `${this.o.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput`,
    );
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
