import crypto from 'node:crypto';
import type { CreateTemplateInput, MetaTemplate, WaMessage, WhatsAppProvider } from './types.js';

export const SANDBOX_TEMPLATES: MetaTemplate[] = [
  {
    id: 'sbx-hello_world',
    name: 'hello_world',
    language: 'en_US',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hello World' },
      { type: 'BODY', text: 'Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API.' },
      { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' },
    ],
  },
  {
    id: 'sbx-bienvenida',
    name: 'bienvenida',
    language: 'es_MX',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: '¡Hola {{1}}! Gracias por tu interés en {{2}}. ¿Te puedo ayudar con algo hoy?' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí, por favor' }, { type: 'QUICK_REPLY', text: 'Ahora no' }] },
    ],
  },
  {
    id: 'sbx-seguimiento',
    name: 'seguimiento',
    language: 'es_MX',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}, te escribo para dar seguimiento a tu solicitud. ¿Seguimos en contacto?' }],
  },
  {
    id: 'sbx-promo',
    name: 'promo_mes',
    language: 'es_MX',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Promoción de {{1}}' },
      { type: 'BODY', text: '{{1}}, este mes tienes {{2}} de descuento en todos nuestros productos. ¡Aprovecha!' },
      { type: 'FOOTER', text: 'Responde BAJA para no recibir promociones' },
    ],
  },
];

export interface SandboxHooks {
  /** Called after a send so the platform can simulate Meta's status webhooks. */
  onSent(wamid: string, to: string, message: WaMessage): Promise<void>;
}

/**
 * Fake provider to try LeadLibre without a Meta account. Numbers ending in 0000
 * simulate an undeliverable recipient.
 */
export class SandboxProvider implements WhatsAppProvider {
  readonly kind = 'sandbox' as const;

  constructor(private phoneNumberId: string, private hooks: SandboxHooks) {}

  async send(to: string, message: WaMessage) {
    const wamid = `wamid.SANDBOX.${crypto.randomUUID()}`;
    await this.hooks.onSent(wamid, to, message);
    // No waId: only Meta knows the real WhatsApp id, and echoing the typed number would be
    // stored as if Meta had resolved it.
    return { wamid };
  }

  async markRead() {}

  async uploadMedia() {
    return `sandbox-media-${crypto.randomUUID()}`;
  }

  async downloadMedia(): Promise<{ data: Buffer; mime: string }> {
    throw new Error('El canal sandbox no descarga archivos de Meta');
  }

  async getPhoneInfo() {
    return { id: this.phoneNumberId, display_phone_number: '+52 55 0000 0000', verified_name: 'Sandbox LeadLibre', quality_rating: 'GREEN' };
  }

  async subscribeApp() {}

  async listTemplates() {
    return SANDBOX_TEMPLATES;
  }

  async createTemplate(input: CreateTemplateInput) {
    return { id: `sbx-${crypto.randomUUID()}`, status: 'APPROVED', category: input.category };
  }

  async deleteTemplate() {}
}
