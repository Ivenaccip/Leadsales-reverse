/** Message object accepted by POST /{phone-number-id}/messages, minus messaging_product/to. */
export type WaMessage = Record<string, unknown> & { type: string };

export interface PhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  platform_type?: string;
  throughput?: { level?: string };
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: any[];
  parameter_format?: string;
  rejected_reason?: string;
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  components: any[];
  parameter_format?: 'POSITIONAL' | 'NAMED';
}

export interface WhatsAppProvider {
  readonly kind: 'cloud_api' | 'sandbox';
  send(to: string, message: WaMessage, replyToWamid?: string): Promise<{ wamid: string }>;
  markRead(wamid: string, typing?: boolean): Promise<void>;
  uploadMedia(data: Buffer, mime: string, filename: string): Promise<string>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }>;
  getPhoneInfo(): Promise<PhoneInfo>;
  subscribeApp(): Promise<void>;
  listTemplates(): Promise<MetaTemplate[]>;
  createTemplate(input: CreateTemplateInput): Promise<{ id: string; status: string; category: string }>;
  deleteTemplate(name: string): Promise<void>;
}

export interface ChannelCredentials {
  accessToken?: string;
  appSecret?: string;
}

/** Parameters to fill a template, independent of Meta's component format. */
export interface TemplateParams {
  header?:
    | { type: 'text'; text: string }
    | { type: 'image' | 'video' | 'document'; link?: string; mediaId?: string; filename?: string };
  body?: string[];
  bodyNamed?: Record<string, string>;
  buttons?: { index: number; text: string }[];
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public code: number | null,
    public httpStatus: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Human explanations (Spanish) for the Cloud API errors people hit most. */
export function explainMetaError(code: number | null | undefined, fallback: string): string {
  const map: Record<number, string> = {
    0: 'No se pudo autenticar con Meta. Revisa el token de acceso.',
    190: 'El token de acceso expiró o es inválido. Genera un token permanente (usuario del sistema).',
    10: 'La app no tiene permiso para este número. Revisa los permisos whatsapp_business_messaging.',
    100: 'Parámetro inválido en la solicitud a Meta.',
    131000: 'Error desconocido de WhatsApp. Intenta de nuevo.',
    131005: 'Acceso denegado: el token no tiene permisos sobre este número.',
    131008: 'Falta un parámetro requerido.',
    131009: 'Valor de parámetro inválido.',
    131021: 'No puedes enviarte mensajes a tu propio número.',
    131026: 'Mensaje no entregable: el número no tiene WhatsApp o no aceptó los términos recientes.',
    131030: 'El número no está en la lista de destinatarios permitidos (número de prueba de Meta).',
    131031: 'La cuenta de WhatsApp Business está bloqueada o restringida.',
    131042: 'Problema con el método de pago de tu cuenta de WhatsApp Business en Meta.',
    131045: 'El número no está registrado correctamente en la Cloud API.',
    131047: 'Pasaron más de 24 h desde el último mensaje del cliente: usa una plantilla.',
    131048: 'Límite de envío por spam: Meta restringió temporalmente tus envíos.',
    131049: 'Meta no entregó este marketing para cuidar la experiencia del usuario (límite por usuario).',
    131050: 'El usuario dejó de recibir mensajes de marketing de tu negocio.',
    131051: 'Tipo de mensaje no soportado.',
    131052: 'No se pudo descargar el archivo multimedia.',
    131053: 'No se pudo subir el archivo multimedia (formato o tamaño no soportado).',
    131056: 'Demasiados mensajes al mismo usuario en poco tiempo. Espera un momento.',
    132000: 'El número de variables no coincide con la plantilla.',
    132001: 'La plantilla no existe o no está aprobada en ese idioma.',
    132005: 'El texto de la plantilla con variables es demasiado largo.',
    132007: 'El contenido de la plantilla viola las políticas de WhatsApp.',
    132012: 'Formato de variables de la plantilla incorrecto.',
    132015: 'La plantilla está pausada por baja calidad.',
    132016: 'La plantilla fue deshabilitada por baja calidad.',
    133010: 'El número no está registrado en la Cloud API.',
    130429: 'Límite de velocidad alcanzado. Se reintentará.',
    80007: 'Límite de llamadas a la API alcanzado para esta cuenta.',
  };
  return (code != null && map[code]) || fallback;
}
