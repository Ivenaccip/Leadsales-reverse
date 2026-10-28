# API pública y webhooks

Crea una llave en **Ajustes → Integraciones y API**. Envíala como
`Authorization: Bearer ll_live_…` (o `X-Api-Key`). Todas las rutas responden JSON.
Los errores tienen la forma `{"error": {"code": "...", "message": "..."}}`.

## Contactos

### `POST /api/v1/contacts` — crear o actualizar por teléfono

```json
{
  "phone": "+52 55 1234 5678",
  "name": "Ana López",
  "email": "ana@correo.com",
  "company": "Tacos SA",
  "deal_value": 1500,
  "tags": ["Facebook Ads", "Caliente"],
  "funnel": "Ventas",
  "stage": "Interesado",
  "source": "facebook_lead_ads",
  "custom_fields": { "campaña": "Octubre" }
}
```

- `funnel`/`stage` aceptan nombre o id. Las etiquetas que no existen se crean.
- Si el contacto ya existe se actualiza (las etiquetas se agregan, los campos
  personalizados se combinan). Respuesta: `{ "contact": {...}, "created": true|false }`.

### `GET /api/v1/contacts?phone=525512345678`

### `GET /api/v1/funnels` — embudos con sus etapas e ids

## Mensajes

### `POST /api/v1/messages`

Plantilla (siempre permitida):

```json
{ "phone": "5512345678", "template": { "name": "seguimiento", "language": "es_MX",
  "header": "Octubre", "body": ["{primer_nombre}", "20%"],
  "buttons": [{ "index": 0, "text": "promo-oct" }] } }
```

Texto libre (solo si el cliente escribió en las últimas 24 h):

```json
{ "phone": "5512345678", "text": "¡Gracias por tu compra!" }
```

Los valores aceptan `{nombre}`, `{primer_nombre}`, `{telefono}`, `{correo}`,
`{empresa}` y `{campo.clave}`, con valor por defecto: `{primer_nombre|amigo}`.

Errores comunes: `WINDOW_CLOSED` (400), `INSUFFICIENT_CREDITS` (402),
`TEMPLATE_NOT_APPROVED` (400), `SEND_FAILED` (502, incluye el motivo de Meta).

## Webhooks salientes

LeadLibre hace `POST` a tus URLs con:

```json
{ "event": "contact.created", "workspace_id": "…", "sent_at": "2026-10-28T17:00:00Z", "data": { … } }
```

Eventos: `contact.created`, `contact.updated`, `contact.stage_changed`,
`contact.assigned`, `message.received`, `message.sent`, `message.status`,
`broadcast.completed` (o `*` para todos).

Encabezados: `X-LeadLibre-Event` y `X-LeadLibre-Signature: sha256=<hex>`, donde el hex es
`HMAC_SHA256(secreto_del_webhook, cuerpo_crudo)`. Reintentos con espera exponencial
(hasta 6) si tu servidor responde 5xx/429 o no responde en 10 s.

Verificación en Node.js:

```js
import crypto from 'node:crypto';
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-leadlibre-signature']));
```

## Recetas

- **Facebook Lead Ads → LeadLibre**: en Make/Zapier, disparador "New Lead" →
  acción HTTP `POST /api/v1/contacts` con `source: "facebook_lead_ads"` y
  `stage: "Nuevo"`; opcionalmente otra acción `POST /api/v1/messages` con una plantilla
  de bienvenida.
- **Formulario de tu web**: el backend de tu formulario llama a `POST /api/v1/contacts`.
- **Venta ganada → facturación**: webhook `contact.stage_changed` y filtra
  `data.stage.kind == "won"`.

## API interna

La interfaz web usa `/api/*` con sesión (cookie) y el encabezado `X-Workspace-Id`. Está
documentada por el código en `server/src/routes/`.
