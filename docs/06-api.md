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

- `header`: el valor de la variable del encabezado de texto. Si la plantilla tiene un
  encabezado de **ubicación**, envía el objeto
  `{ "type": "location", "latitude": 19.4326, "longitude": -99.1332, "name": "Sucursal Centro", "address": "Av. Juárez 10" }`
  (`name` y `address` son opcionales).
- `buttons`: el valor de cada botón que lo pide, por su posición (`index`, desde 0): la
  parte variable de un botón de URL o el código de un botón de **cupón** (máx. 15
  caracteres). El tipo de cada botón sale de la plantilla sincronizada; `sub_type`
  (`"url"` o `"copy_code"`) solo cuenta si la plantilla todavía no está sincronizada en
  LeadLibre.
- Plantillas de autenticación: `"body": ["123456"]` (el código); LeadLibre pone el mismo
  código en el botón de copiar código.

Texto libre (solo si el cliente escribió en las últimas 24 h):

```json
{ "phone": "5512345678", "text": "¡Gracias por tu compra!" }
```

Si no existe un contacto con ese teléfono se crea (acepta `name`). Respuesta:
`{ "message": {...}, "contact_id": "…" }`.

El texto de `header` y los valores de `body` aceptan `{nombre}`, `{primer_nombre}`,
`{telefono}`, `{correo}`, `{empresa}` y `{campo.clave}`, con valor por defecto:
`{primer_nombre|amigo}`.

Errores comunes:

| Código | HTTP | Cuándo |
|---|---|---|
| `WINDOW_CLOSED` | 400 | Texto libre fuera de la ventana de 24 h |
| `INSUFFICIENT_CREDITS` | 402 | Espacio prepagado sin saldo suficiente |
| `TEMPLATE_NOT_APPROVED` | 400 | La plantilla existe pero Meta no la ha aprobado |
| `TEMPLATE_PARAMS_MISSING` | 400 | Falta algo que la plantilla pide: una variable del encabezado o del cuerpo, la imagen, video, documento o ubicación del encabezado, el valor de un botón de URL o el código de cupón |
| `TEMPLATE_PARAMS_INVALID` | 400 | Un valor no es válido (código de cupón de más de 15 caracteres) |
| `TEMPLATE_UNSUPPORTED` | 400 | La plantilla usa algo que LeadLibre todavía no envía: carrusel, oferta con vencimiento, producto del catálogo en el encabezado o botones de catálogo |
| `SEND_FAILED` | 502 | Meta rechazó el envío: `error.message` trae el motivo y `error.details.message` el mensaje guardado (`failed`) |

Las validaciones de parámetros usan la copia sincronizada de la plantilla y ocurren
antes de guardar o cobrar el mensaje; si la plantilla no está sincronizada, decide Meta.

### Estados de un mensaje

`status` de un mensaje saliente: `pending` (enviándose) → `sent` → `delivered` → `read`,
o `failed` (con `error.message` en español). `unknown` ("Sin confirmar" en la
bandeja) significa que LeadLibre lo envió pero la respuesta de Meta se perdió (falla de
red, tiempo agotado o error 5xx de Meta): Meta pudo haberlo entregado. La API responde
200 con ese estado, LeadLibre no lo reenvía solo y conserva su cargo; **no lo reenvíes de
inmediato**, podría llegar duplicado. Las plantillas llevan el id del mensaje en
`biz_opaque_callback_data`: si Meta manda después sus estados, el mensaje pasa a `sent`,
`delivered`, `read` o `failed` y se emite `message.status`.

## Webhooks salientes

LeadLibre hace `POST` a tus URLs con:

```json
{ "event": "contact.created", "workspace_id": "…", "sent_at": "2026-10-28T17:00:00Z", "data": { … } }
```

Se configuran en **Ajustes → Integraciones y API** (dueños y administradores): hasta 10
webhooks por espacio; crear uno más responde `400 WEBHOOK_LIMIT`.

Eventos: `contact.created`, `contact.updated`, `contact.stage_changed`,
`contact.assigned`, `message.received`, `message.sent`, `message.status`,
`broadcast.completed` (o `*` para todos). El botón **Probar** envía un evento `ping`.
`message.status` trae `data: { id, wamid, contact_id, status, error }`.

Encabezados: `X-LeadLibre-Event` y `X-LeadLibre-Signature: sha256=<hex>`, donde el hex es
`HMAC_SHA256(secreto_del_webhook, cuerpo_crudo)`.

Entrega y reintentos:

- Cada intento espera tu respuesta hasta **10 s**: responde 2xx en cuanto recibas el
  evento y procésalo después.
- Si respondes 5xx o 429, no respondes a tiempo o la conexión falla, LeadLibre reintenta:
  hasta **12 intentos en unas 34 h**, con esperas de 30 s, 2 min, 5 min, 15 min, 30 min,
  1 h, 2 h, 4 h, 6 h, 8 h y 12 h.
- No se reintenta un 3xx (las redirecciones no se siguen: usa la URL final), otro 4xx ni
  una URL que apunta a una red privada. El `ping` de **Probar** se envía una sola vez.
- Un evento puede llegar más de una vez (por ejemplo, si respondiste tarde) y no siempre
  en orden: `sent_at` es la hora del evento y no cambia entre reintentos.
- Los webhooks salientes tienen su propio carril en la cola y cada espacio recibe como
  máximo 3 entregas a la vez: un receptor lento no frena el resto de LeadLibre.
- En **Ajustes → Integraciones y API** ves el último código HTTP y el último error de
  cada webhook.

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
documentada por el código en `server/src/routes/`. Lo que más conviene saber:

### Sesiones

- `POST /api/auth/login` y `POST /api/auth/register` abren una sesión (fila en
  `sessions`) y ponen la cookie `ll_token` (JWT `{ uid, sid }`, 30 días). Las cookies
  emitidas antes de las sesiones revocables ya no sirven: hay que iniciar sesión otra vez.
- `POST /api/auth/logout` revoca esa sesión; sus sockets reciben `session:revoked` y se
  desconectan.
- `PATCH /api/auth/me { currentPassword, password }` revoca todas las demás sesiones de
  la cuenta (la actual sigue activa).
- Inicio de sesión: `429 TOO_MANY_REQUESTS` tras demasiados intentos fallidos (ver
  límites en `04-despliegue.md`). Correo máx. 254 caracteres; contraseñas nuevas de 8 a
  200.
- Registro: `403` si `ALLOW_SIGNUP=false` y la instancia ya tiene usuarios (entra con una
  invitación), `409 EMAIL_TAKEN` si el correo ya tiene cuenta y `429` tras 10 intentos de
  registro (exitosos o no) desde la misma red en 15 minutos (el registro por invitación
  tiene su propio límite igual).

### Equipo e invitaciones

- `POST /api/workspace/members { email, name?, role: "admin"|"agent", password? }`
  (dueño/admin). Crea una invitación y responde
  `{ "invitation": { id, email, role, expires_at }, "invite_url": "<PUBLIC_URL>/invitacion/<token>" }`.
  Comparte el enlace por tu cuenta (WhatsApp, correo…); vence en 7 días y sirve una vez.
  Una nueva invitación al mismo correo reemplaza a la anterior. Solo el administrador de
  la instancia, con `password` y para un correo sin cuenta, crea la cuenta directamente
  (`{ id, existing_user: false }`). `409` si esa persona ya es del equipo (también si
  está desactivada: reactívala con `PATCH`).
- `GET /api/workspace/invitations` (dueño/admin) → `{ invitations: [{ id, email, name,
  role, created_at, expires_at, invited_by_name }] }` (solo pendientes).
- `DELETE /api/workspace/invitations/:id` (dueño/admin) → `204`, el enlace deja de servir.
- `GET /api/invitations/:token` (público) → `{ workspace_name, email, role, expires_at,
  account_exists }`, o `404 INVITATION_INVALID` si no existe, se usó, se revocó o venció.
- `POST /api/invitations/:token/accept` (con sesión; el correo de la cuenta debe ser el de
  la invitación, si no `403 INVITATION_EMAIL_MISMATCH`) → `{ workspace_id }`.
- `POST /api/invitations/:token/register { name, password }` (público; solo si no existe
  una cuenta con ese correo, si no `409 EMAIL_TAKEN`) crea la cuenta con el correo de la
  invitación, la agrega al espacio e inicia sesión. Responde como `/api/auth/register`
  más `workspace_id`. Funciona aunque `ALLOW_SIGNUP=false`.
- `PATCH`/`DELETE /api/workspace/members/:id`: la membresía del administrador de la
  instancia solo la cambia él mismo (`403`). Desactivar o quitar a alguien de su único
  espacio cierra todas sus sesiones.

### Canales

- `POST /api/channels/:id/test` solo informa el estado con Meta: no reactiva un número
  desactivado (eso es `PATCH { status: "active" }`).
- `POST /api/channels/:id/simulate { from, name?, text?, reply_id? }` (sandbox,
  dueño/admin): `from` va con lada; un número de 10 dígitos sin `+` recibe la lada
  predeterminada del espacio, como los contactos creados a mano. `409 REAL_CONTACT` si el
  número es de un contacto que no está ya en ese canal sandbox.
- `POST /api/channels` / `PATCH /api/channels/:id`: `409 WABA_TAKEN` si la WABA ya está
  conectada en otro espacio. `operator_verified` solo es `true` si el operador capturó la
  `app_secret` con el espacio en prepagado (o si el número ya estaba en un espacio
  prepagado al actualizar a esta versión: ver `04-despliegue.md`). En espacios prepagados, `PATCH { status:
  "active" }` de un número no verificado responde `400 OPERATOR_VERIFICATION_REQUIRED`:
  el operador debe enviar `access_token` y `app_secret` de su propia app de Meta (eso marca
  `operator_verified`, suscribe esa app a la WABA —`warnings` si falla— y reactiva el
  número desactivado al pasar a prepagado). Una `app_secret` que ya está en un número no
  verificado del espacio (por ejemplo, la que tenía ese mismo número) responde
  `400 APP_SECRET_NOT_NEW`, también en `POST`.

### Plantillas

- `GET /api/templates` → `{ templates: [...] }`. Cada plantilla trae `inputs`, lo que pide
  al enviarla: `header` (`{ type: "text"|"image"|"video"|"document"|"location", variables }`
  o `null`), `body` (nombres o números de sus variables), `buttons`
  (`[{ index, type: "URL"|"COPY_CODE", text, variables }]`, solo los que piden un valor)
  y `unsupported`: `null`, o el motivo en español por el que LeadLibre todavía no puede
  enviarla (carrusel, oferta con vencimiento, producto del catálogo en el encabezado,
  botones de catálogo). La interfaz las marca como no compatibles y muestra el motivo;
  enviarlas responde `400 TEMPLATE_UNSUPPORTED`.
- `POST /api/templates` (dueño/admin) `{ channel_id, name, language, category, header?,
  body?, footer?, buttons? }`: `category` es `MARKETING`, `UTILITY` o `AUTHENTICATION`;
  `header { text, example? }`, `body { text, examples? }` (un ejemplo por variable),
  `footer` y hasta 10 botones `QUICK_REPLY`, `URL` o `PHONE_NUMBER`. Si Meta la rechaza,
  `400 META_ERROR` con el motivo.
- Con `category: "AUTHENTICATION"`, Meta escribe el texto ("<código> es tu código de
  verificación") en el idioma de la plantilla: `header`, `body`, `footer` y `buttons` se
  ignoran y `body` no es obligatorio. Campos propios: `security_recommendation` (agrega
  la recomendación de no compartir el código; `true` si no se envía),
  `code_expiration_minutes` (1 a 90: "Este código caduca en N minutos" en el pie) y
  `otp_button_text` (texto del botón de copiar código, máx. 25; sin él, el de WhatsApp).

### Parámetros de plantilla (bandeja, programados y difusiones)

Los envíos de plantilla de la bandeja (`POST /api/contacts/:id/messages` con
`type: "template"`) y los programados (`POST /api/contacts/:id/scheduled`) reciben
`params`:

```json
{ "header": { "type": "location", "latitude": 19.4326, "longitude": -99.1332, "name": "Sucursal Centro" },
  "body": ["{primer_nombre}", "20%"],
  "buttons": [{ "index": 1, "text": "PROMO20", "sub_type": "copy_code" }] }
```

- `header`: `{ type: "text", text }`, `{ type: "image"|"video"|"document", link, filename? }`
  o `{ type: "location", latitude, longitude, name?, address? }`.
- `bodyNamed: { "variable": "valor" }` en lugar de `body` para plantillas con variables
  con nombre.
- `buttons[]`: `{ index, text, sub_type? }`, como en `/api/v1/messages`.
- Las difusiones (`POST`/`PATCH /api/broadcasts`) usan la misma forma, pero con `value`
  en lugar de `text` en el encabezado de texto y en los botones:
  `header: { type: "text", value }`, `buttons: [{ index, value, sub_type? }]`.
- El encabezado de texto, el cuerpo y los botones aceptan los marcadores
  `{primer_nombre}`, `{campo.clave}`…, resueltos para cada contacto.
- Se validan contra la plantilla sincronizada antes de guardar o cobrar
  (`TEMPLATE_PARAMS_MISSING`, `TEMPLATE_PARAMS_INVALID`, `TEMPLATE_UNSUPPORTED`). Una
  difusión los valida al crearla, al cambiar su plantilla o sus parámetros y al lanzarla o
  reanudarla. Si una sincronización cambia la plantilla mientras se envía, la difusión se
  pausa con el motivo; un cupón demasiado largo para un contacto solo hace fallar a ese
  destinatario.
- Programados: `GET /api/contacts/:id` devuelve en `scheduled` los pendientes, los que se
  están enviando y los que fallaron en los últimos 7 días (con `error`). `DELETE /api/scheduled/:id` cancela uno
  pendiente o descarta uno fallido; `409 SCHEDULED_SENDING` si ya se está enviando.

### Archivos y envíos

- `POST /api/media` (multipart, un archivo) → `{ media: { id, mime, size, filename } }`.
  Solo acepta los tipos que acepta WhatsApp, con su límite:

  | Tipo | Formatos | Máximo |
  |---|---|---|
  | Imagen | JPG, PNG | 5 MB |
  | Sticker | WebP de exactamente 512×512 px | 100 KB (500 KB si es animado) |
  | Video | MP4, 3GP | 16 MB |
  | Audio | AAC, AMR, MP3, M4A, OGG | 16 MB |
  | Documento | PDF, Word, Excel, PowerPoint, TXT | 100 MB |

  Además, ningún archivo puede pasar de `MAX_UPLOAD_MB` (16 por omisión). Errores (400):
  `MEDIA_TYPE_NOT_SUPPORTED`, `MEDIA_TOO_LARGE` y `STICKER_NOT_VALID`, con el motivo en
  español. Los mismos límites se revisan al enviar un archivo guardado (por ejemplo,
  reenviar uno recibido) y al guardar una respuesta rápida con adjunto; si Meta rechaza la
  subida, `400 META_ERROR`. Al enviar, estos errores llegan antes de guardar o cobrar el
  mensaje.
- `POST /api/contacts/:id/messages` → `{ message }`, con `{ type: "text", text,
  reply_to_wamid? }`, `{ type: "media", media_file_id, caption? }`, `{ type: "template",
  name, language, params? }` o `{ type: "quick_reply", quick_reply_id }`. `caption` admite
  hasta 1024 caracteres; los audios y stickers no admiten texto:
  `400 CAPTION_NOT_SUPPORTED` (envía el texto como un mensaje aparte).

### Respuestas rápidas

- `POST /api/quick-replies { shortcut, title?, body, media_file_id? }` (dueño/admin): el
  atajo admite letras, números, `-` y `_` y se guarda en minúsculas. Crear nunca
  sobrescribe: `409 SHORTCUT_TAKEN` si el atajo ya existe (también en `PATCH` al cambiar
  a un atajo ocupado). En `PATCH`, `title: null` (o vacío) borra el título y
  `media_file_id: null` quita el adjunto. Un adjunto que WhatsApp no acepta se rechaza con
  los códigos de `POST /api/media`.
- Al enviarla (`type: "quick_reply"`), el texto va como pie del archivo en imágenes,
  videos y documentos (hasta 1024 caracteres); con audios, stickers o un texto más largo
  sale primero el archivo y después el texto como otro mensaje. Con adjunto la respuesta
  es `{ message, messages }`: `messages` trae todos los mensajes enviados (1 o 2) y
  `message` es el primero. Sin adjunto, `{ message }`.

### Contactos

- `POST /api/contacts`: si el teléfono ya existe responde ese contacto con
  `created: false`; un agente que solo ve sus conversaciones recibe
  `409 CONTACT_EXISTS` si ese contacto está asignado a otra persona.
- `POST /api/contacts/import { csv, funnel_id?, stage_id?, tag_ids? }` (dueño/admin): el
  texto del CSV, máx. 20,000 filas. El separador (`,`, `;` o tabulador) se detecta en la
  fila de encabezados. Encabezados reconocidos: `telefono` (o `celular`, `whatsapp`…),
  `nombre`, `correo`, `empresa`, `etiquetas` (separadas por `;`, `,` o `|`) y `valor`;
  las demás columnas van a campos personalizados. El texto debe venir en UTF-8: si trae
  `�` (un archivo ANSI leído como UTF-8, como el "CSV (delimitado por comas)" de Excel en
  español) responde `400 CSV_NOT_UTF8`. La interfaz web convierte sola esos archivos.
  Responde `{ total, created, existing, errors, error_count }`.
- `GET /api/contacts/export.csv` (dueño/admin; mismos filtros que la lista): UTF-8 con
  BOM y cada valor entre comillas (las celdas vacías van sin ellas). Una celda que empieza
  con `=`, `+`, `-` o `@` (o un tramo así después de `;`, `,`, tabulador o salto de línea)
  lleva `'` delante para que Excel no la ejecute como fórmula; por eso los teléfonos salen
  como `'+5255…`. Al importar ese mismo archivo se quita ese `'` cuando está al inicio de
  la celda (el teléfono vuelve a ser `+5255…`).

### Eventos de tiempo real (Socket.IO)

`message:new`, `message:update`, `contact:new`, `contact:update`, `contacts:bulk`,
`scheduled:update { id, contact_id, status, error? }`, `credits:update` (sin datos: vuelve
a pedir `/api/credits`), `template:update`; `broadcast:update` (solo dueños y
administradores); `contact:revoked { id }` (un agente limitado deja de ver ese chat);
`session:refresh` (vuelve a hacer `join`) y `session:revoked` (sesión terminada: ir a
iniciar sesión).
