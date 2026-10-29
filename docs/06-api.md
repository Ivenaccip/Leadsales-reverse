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
- Límites: `phone` de 6 a 40 caracteres, `name` y `company` hasta 120, `source` hasta 40 y
  hasta 50 etiquetas por petición. Una etiqueta nueva tiene hasta 40 caracteres y su nombre
  no puede llevar `;`, `,` ni `|`: `"VIP, Expo"` son dos etiquetas (`VIP` y `Expo`), como
  en la importación CSV, salvo que ya exista una etiqueta con ese nombre exacto (creada
  antes de esta regla).

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

Límites (los de WhatsApp): `text` hasta 4096 caracteres; en `template`, el encabezado de
texto hasta 60, `body` hasta 30 valores de hasta 1024 caracteres cada uno y `buttons`
hasta 10 (`index` de 0 a 9, `text` hasta 200). `phone` y `name`, como en
`/api/v1/contacts`.

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
| `TEXT_TOO_LONG` | 400 | Un texto de más de 4096 caracteres, el máximo de WhatsApp (en `text` de esta ruta lo frena antes la validación: `VALIDATION`) |
| `VALIDATION` | 400 | Un campo falta o pasa de su límite: `error.message` dice cuál |
| `SEND_FAILED` | 502 | Meta rechazó el envío, o no se pudo conectar con Meta (`error.network: true` en el mensaje): `error.message` trae el motivo y `error.details.message` el mensaje guardado (`failed`, con su cargo reembolsado) |

Las validaciones de parámetros usan la copia sincronizada de la plantilla y ocurren
antes de guardar o cobrar el mensaje; si la plantilla no está sincronizada, decide Meta.

### Estados de un mensaje

`status` de un mensaje saliente: `pending` (enviándose) → `sent` → `delivered` → `read`,
o `failed` (con `error.message` en español). `unknown` ("Sin confirmar" en la
bandeja) significa que LeadLibre lo envió pero la respuesta de Meta se perdió (falla de
red, tiempo agotado o error 5xx de Meta): Meta pudo haberlo entregado. La API responde
200 con ese estado, LeadLibre no lo reenvía solo y conserva su cargo; **no lo reenvíes de
inmediato**, podría llegar duplicado. Todo envío (no solo las plantillas) lleva el id del
mensaje en `biz_opaque_callback_data`: si Meta manda después sus estados, el mensaje pasa
a `sent`, `delivered`, `read` o `failed` y se emite `message.status`. Si a los 7 días sigue
`unknown` (o `pending`, porque el servidor se cayó a medio envío) sin ningún estado de
Meta, pasa a `failed` y su cargo se reembolsa.

Campos de `error` en un mensaje `failed`:

- `network: true`: la conexión falló antes de llegar a Meta (DNS, conexión rechazada,
  certificado), así que no salió y su cargo se reembolsó. Se puede reenviar sin riesgo de
  duplicado, salvo que también traiga `auto_retry`.
- `auto_retry: true`: una difusión o un programado lo reintentará solo, como el mismo
  mensaje (mismo `id`), porque no llegó a Meta o Meta frenó el envío por velocidad. **No
  lo reenvíes a mano**: llegaría duplicado. Si al final no se reintenta (se canceló la
  difusión o el programado, o se acabaron los reintentos), el campo desaparece y
  `error.message` explica el motivo: entonces sí puedes reenviarlo.

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
  Cada sesión queda ligada a la versión de la contraseña con la que se abrió: si la
  contraseña cambia mientras alguien inicia sesión con la anterior, esa sesión nace
  inválida (`401`, y el socket se rechaza).
- Al iniciar sesión (y al registrarse o cambiar la contraseña) también se pone la cookie
  `ll_device` (`httpOnly`, ruta `/api/auth`, 1 año): entradas firmadas
  `usuario.versión.nonce.firma` de hasta 5 cuentas que entraron desde ese navegador. Con
  ella, ese navegador puede iniciar sesión aunque el límite por cuenta esté lleno (ver
  `04-despliegue.md`). Cambiar la contraseña invalida las entradas anteriores de la cuenta.
  El registro por invitación no la toca (el navegador no la envía fuera de `/api/auth` y
  reescribirla borraría las entradas de las otras cuentas): la cuenta nueva recibe su
  entrada en su siguiente inicio de sesión.
- `POST /api/auth/logout` revoca esa sesión; sus sockets reciben `session:revoked` y se
  desconectan.
- `PATCH /api/auth/me { currentPassword, password }` revoca todas las demás sesiones de
  la cuenta (la actual sigue activa). `400 WRONG_PASSWORD` si `currentPassword` no es
  correcta; tras 10 intentos fallidos en 15 minutos desde la misma sesión (contando los de
  las acciones del operador que también la piden), `429 TOO_MANY_REQUESTS` en esa
  sesión (aunque la siguiente sea la correcta). El límite es por sesión: quien robó una
  sesión no puede gastar los intentos de las demás, y la dueña siempre puede cambiar la
  contraseña desde su propia sesión para cerrar la robada. `409 PASSWORD_CHANGED` si otra
  sesión cambió la contraseña al mismo tiempo (gana solo una).
- Inicio de sesión: `429 TOO_MANY_REQUESTS` tras demasiados intentos fallidos (ver
  límites en `04-despliegue.md`). Correo máx. 254 caracteres; contraseñas nuevas de 8 a
  200.
- `503 BUSY` en inicio de sesión, registro, registro por invitación y cambio de
  contraseña: el servidor ya está calculando el máximo de contraseñas a la vez (bcrypt
  en hilos aparte, con una cola corta). No cuenta como intento fallido: reintenta en unos
  segundos.
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
  (`{ id, existing_user: false }`); eso revoca las invitaciones pendientes de ese correo
  en el espacio. `409` si esa persona ya es del equipo (también si está desactivada:
  reactívala con `PATCH`).
- `GET /api/workspace/invitations` (dueño/admin) → `{ invitations: [{ id, email, name,
  role, created_at, expires_at, invited_by_name }] }` (solo pendientes).
- `DELETE /api/workspace/invitations/:id` (dueño/admin) → `204`, el enlace deja de servir.
- `GET /api/invitations/:token` (público) → `{ workspace_name, email, role, expires_at }`,
  o `404 INVITATION_INVALID` si no existe, se usó, se revocó o venció. Ya no dice si el
  correo tiene cuenta (`account_exists` se quitó: quien invita tiene el enlace y podía
  preguntarlo por cualquier correo); la página ofrece iniciar sesión o crear la cuenta.
- `POST /api/invitations/:token/accept` (con sesión; el correo de la cuenta debe ser el de
  la invitación, si no `403 INVITATION_EMAIL_MISMATCH`) → `{ workspace_id }`. Si ya eres
  miembro activo, consume la invitación sin cambiar tu rol; si tu membresía está
  desactivada, `409 MEMBER_DEACTIVATED` (reactivar es decisión de un administrador). Al
  aceptar se revocan las demás invitaciones pendientes de ese correo en el espacio.
- `POST /api/invitations/:token/register { name, password }` (público; solo si no existe
  una cuenta con ese correo, si no `409 EMAIL_TAKEN`) crea la cuenta con el correo de la
  invitación, la agrega al espacio e inicia sesión. Responde como `/api/auth/register`
  más `workspace_id`. Funciona aunque `ALLOW_SIGNUP=false`. Quien tenga el enlace (también
  quien invitó) puede crear así la cuenta de ese correo: ver "Cuentas creadas por otra
  persona" en `04-despliegue.md`.
- `PATCH`/`DELETE /api/workspace/members/:id`: la membresía del administrador de la
  instancia solo la cambia él mismo (`403`). Desactivar o quitar a alguien de su único
  espacio cierra todas sus sesiones. Cambiar el rol, desactivar o quitar a alguien revoca
  sus invitaciones pendientes en el espacio. Degradar, desactivar o quitar al último
  propietario **activo** responde `400` ("Debe quedar al menos un propietario activo"):
  un propietario desactivado no cuenta.

### Administración de la instancia (solo el administrador de la instancia)

- `GET /api/admin/users` → `{ users: [{ id, email, name, is_superadmin, created_at,
  workspaces, workspace_names }] }`.
- `PATCH /api/admin/users/:id { is_superadmin, currentPassword }` da o quita el rol de
  administrador de la instancia. `currentPassword` es la contraseña actual de quien lo
  hace: `400 WRONG_PASSWORD` si falta o no es correcta, y `429` tras 10 intentos fallidos
  en 15 minutos desde la misma sesión (el mismo límite que `PATCH /api/auth/me`). `400`
  si te quitas el rol a ti mismo.
- `POST /api/admin/users/:id/password { password, currentPassword }` pone una contraseña
  temporal, cierra todas las sesiones de la cuenta (y sus sockets) e invalida sus cookies
  `ll_device`. `currentPassword` como arriba. `400` para tu propia cuenta o la de otro
  administrador de la instancia (esas se cambian desde el perfil, con la contraseña
  actual).
- `DELETE /api/admin/users/:id` → `204`, borra una cuenta que no es miembro de ningún
  espacio (libera el correo). `409 USER_HAS_WORKSPACES` si todavía es miembro de alguno
  (quítala primero desde cada espacio); `400` para administradores de la instancia.
- `PATCH /api/admin/workspaces/:id { billing_mode, is_active }` →
  `{ workspace, warnings }`: pasar a `prepaid` desactiva los números que el operador no
  verificó y vuelve a leer de Meta las plantillas de los verificados (`warnings` si no se
  pudo); volver a `meta_direct` reactiva los que se desactivaron solo por eso. Todos los
  miembros reciben `session:refresh`.

### Canales

- `POST /api/channels/:id/test` solo informa el estado con Meta: no reactiva un número
  desactivado (eso es `PATCH { status: "active" }`). En un número desactivado, una prueba
  fallida no reemplaza el motivo de la desactivación en `last_error`.
- `PATCH /api/channels/:id` de un canal sandbox: `400 SANDBOX_NO_CREDENTIALS` si trae
  `waba_id`, `access_token` o `app_secret` (un sandbox no tiene cuenta de Meta). Solo los
  números oficiales cuentan para `WABA_TAKEN`.
- `POST /api/channels/:id/simulate { from, name?, text?, reply_id? }` (sandbox,
  dueño/admin): `from` va con lada; un número de 10 dígitos sin `+` recibe la lada
  predeterminada del espacio, como los contactos creados a mano. `409 REAL_CONTACT` si el
  número es de un contacto que no está ya en ese canal sandbox, también escrito de otra
  forma que llegaría a ese contacto (Brasil con o sin el 9, Argentina con o sin el 9 o el
  15) o si es el número anterior de un cliente que cambió de número.
- `POST /api/channels` / `PATCH /api/channels/:id`: `409 WABA_TAKEN` si la WABA ya está
  conectada en otro espacio. `operator_verified` solo es `true` si el operador capturó la
  `app_secret` con el espacio en prepagado (al actualizar, los números no verificados de
  espacios prepagados se desactivan hasta que el operador los verifique: ver
  `04-despliegue.md`). En espacios prepagados, `PATCH { status:
  "active" }` de un número no verificado responde `400 OPERATOR_VERIFICATION_REQUIRED`:
  el operador debe enviar `access_token` y `app_secret` de su propia app de Meta (eso marca
  `operator_verified`, suscribe esa app a la WABA —`warnings` si falla— y reactiva el
  número desactivado al pasar a prepagado). Al quedar verificado, el número vuelve a leer
  sus plantillas de Meta (`warnings` si no se pudo). Una `app_secret` que ya está en un
  número no verificado del espacio (por ejemplo, la que tenía ese mismo número) responde
  `400 APP_SECRET_NOT_NEW`, también en `POST`, salvo la `META_APP_SECRET` de la
  instancia.

### Plantillas

- `GET /api/templates` → `{ templates: [...] }`. Cada plantilla trae `inputs`, lo que pide
  al enviarla: `header` (`{ type: "text"|"image"|"video"|"document"|"location", variables }`
  o `null`), `body` (sus variables en el orden en que se envían sus valores: las numeradas
  por número, `{{1}}` primero aunque aparezca después en el texto; las de nombre, en el
  orden en que aparecen), `buttons`
  (`[{ index, type: "URL"|"COPY_CODE", text, variables }]`, solo los que piden un valor)
  y `unsupported`: `null`, o el motivo en español por el que LeadLibre todavía no puede
  enviarla (carrusel, oferta con vencimiento, producto del catálogo en el encabezado,
  botones de catálogo). La interfaz las marca como no compatibles y muestra el motivo;
  enviarlas responde `400 TEMPLATE_UNSUPPORTED`.
- `POST /api/templates` (dueño/admin) `{ channel_id, name, language, category, header?,
  body?, footer?, buttons? }`: `category` es `MARKETING`, `UTILITY` o `AUTHENTICATION`;
  `header { text, example? }`, `body { text, examples? }` (un ejemplo por variable, en el
  orden en que aparecen en el texto: con `"Hola {{2}}, tu pedido {{1}}"`, el primer ejemplo
  es el de `{{2}}`), `footer` y hasta 10 botones `QUICK_REPLY`, `URL` o `PHONE_NUMBER`. Si
  Meta la rechaza, `400 META_ERROR`: `error.message` trae el motivo que da Meta
  (precedido de una explicación en español cuando LeadLibre conoce el código), y
  `error.details: { code, subcode, message }` (el código, el subcódigo y el texto
  original de Meta).
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
- `body`: los valores en el orden de `inputs.body` (hasta 30, de hasta 1024 caracteres).
- `bodyNamed: { "variable": "valor" }` en lugar de `body` para plantillas con variables
  con nombre (hasta 30 variables).
- `buttons[]`: `{ index, text, sub_type? }`, como en `/api/v1/messages` (hasta 10).
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
  están enviando y los que fallaron en los últimos 7 días (con `error`).
  `DELETE /api/scheduled/:id` cancela uno pendiente o descarta uno fallido;
  `409 SCHEDULED_SENDING` si ya se está enviando. Si el envío no llega a Meta (falla de
  red) o Meta lo frena por velocidad, el programado vuelve a `pending` con el motivo en
  `error` y se reintenta solo, hasta 5 veces (de 30 s a 8 min de espera); después queda
  `failed`.

### Difusiones

- `PATCH /api/broadcasts/:id` edita un borrador o una difusión **en pausa** (`400` en
  cualquier otro estado). En pausa se pueden cambiar `name`, `template_name`,
  `template_language`, `channel_id`, `params` y `scheduled_at`, pero no la audiencia: sus
  destinatarios se eligieron al lanzarla (`400 AUDIENCE_LOCKED` si envías `audience`).
  `400 BROADCAST_CHANGED` si la difusión cambió de estado mientras la editabas (recarga y
  vuelve a intentar).
- `POST /api/broadcasts/:id/launch` lanza un borrador o reanuda una difusión en pausa: solo
  la reciben los destinatarios que faltan, con la plantilla y los parámetros vigentes.
  `400 BROADCAST_CHANGED` si cambió de estado al mismo tiempo.
- Audiencia: `created_from` y `created_to` son días `AAAA-MM-DD` (ambos incluidos) en la
  zona horaria del espacio; otro formato responde `400`. Los contactos dados de baja
  (`opted_out`) nunca entran.
- Si Meta frena el envío por velocidad, la difusión espera 1 minuto y sigue. Si no se puede
  conectar con Meta, reintenta con espera creciente y se pausa tras unos 15 minutos sin
  conexión; esos destinatarios vuelven a la cola y nadie queda fallido por ello.

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
- `GET /api/media/:id` (con `X-Workspace-Id`, o `?ws=<id>` para `<img>`, `<video>` y
  `<audio>`) responde por rangos de bytes: `Accept-Ranges: bytes`, y con
  `Range: bytes=inicio-fin` (o `inicio-`, o `-últimos`) responde `206` con
  `Content-Range`; un rango fuera del archivo responde `416`. Varios rangos en una
  petición o uno mal formado reciben el archivo completo (`200`).
- `POST /api/contacts/:id/messages` → `{ message }`, con `{ type: "text", text,
  reply_to_wamid? }`, `{ type: "media", media_file_id, caption? }`, `{ type: "template",
  name, language, params? }` o `{ type: "quick_reply", quick_reply_id }`. `caption` admite
  hasta 1024 caracteres; los audios y stickers no admiten texto:
  `400 CAPTION_NOT_SUPPORTED` (envía el texto como un mensaje aparte). `text` hasta 4096
  caracteres.
- Los archivos que manda el cliente se descargan en segundo plano (hasta 10 intentos en
  unas 28 h). Si no se puede (WhatsApp no incluyó el archivo, el número ya no está
  conectado o Meta no lo entregó), el mensaje trae `media.download_error` con el motivo
  en español (con el mensaje o en un `message:update`): pídele al cliente que lo reenvíe.

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

- `GET /api/contacts?…&sort=recent&limit=30` → `{ items, total, page, limit, next_cursor }`.
  Con `sort=recent` (el orden de la bandeja, el de omisión), `next_cursor` es un texto
  opaco, o `null` si no hay más: pide la página siguiente con `cursor=<next_cursor>` (y
  los mismos filtros). Las páginas por cursor no se saltan ni repiten conversaciones
  aunque entretanto alguna suba al principio o salga del filtro (con `page` sí podía
  pasar). `page` sigue funcionando para todos los órdenes; con los demás, `next_cursor` es
  `null`. Un cursor que no salió de esta ruta, o con otro `sort`, responde
  `400 INVALID_CURSOR`.
- `POST /api/contacts`: si el teléfono ya existe responde ese contacto con
  `created: false`; un agente que solo ve sus conversaciones recibe
  `409 CONTACT_EXISTS` si ese contacto está asignado a otra persona.
- `POST /api/contacts/import { csv, funnel_id?, stage_id?, tag_ids?, lossy? }`
  (dueño/admin): el texto del CSV, máx. 20,000 filas y 200 columnas
  (`400 CSV_TOO_MANY_COLUMNS`, antes de leer las filas). La fila de encabezados es la
  primera que no está en blanco; el separador (`,`, `;` o tabulador) se detecta en ella.
  Encabezados reconocidos: `telefono` (o `celular`, `whatsapp`…), `nombre`, `correo`,
  `empresa`, `etiquetas` (separadas por `;`, `,` o `|`) y `valor`; las demás columnas van
  a campos personalizados. Responde
  `{ total, created, existing, errors, error_count }`; una fila sin teléfono, con nombre o
  empresa de más de 120 caracteres, o con una etiqueta nueva de más de 40, va a `errors`
  (con su número de fila) y las demás se importan.
- Un archivo exportado por LeadLibre (tiene todas las columnas `campos`, `embudo`, `etapa`,
  `asignado_a`, `origen`, `creado` y `ultimo_mensaje`) vuelve como era: `campos` (un objeto
  JSON) se convierte otra vez en los campos personalizados del contacto, `embudo` y
  `etapa` lo colocan en el embudo y la etapa con esos nombres si existen en el espacio (y
  no elegiste `funnel_id` ni `stage_id`), y `asignado_a`, `origen`, `creado` y
  `ultimo_mensaje` no se guardan como campos. Una fila cuyo `campos` no es un objeto JSON
  (editado a mano) guarda todas sus columnas no reconocidas como campos personalizados,
  igual que en cualquier otro archivo: en otros archivos, toda columna no reconocida
  (también una llamada `Campos` u `Origen`) va a campos personalizados.
- El texto debe venir en UTF-8. Un archivo ANSI (como el "CSV (delimitado por comas)" de
  Excel en español) leído como UTF-8 pierde los acentos, que quedan como `�` (U+FFFD), y
  responde `400 CSV_NOT_UTF8`. `lossy` dice cómo convertiste el archivo en texto:
  `true` si tuviste que reemplazar bytes que no eran UTF-8 (cualquier `�` responde
  `CSV_NOT_UTF8`), `false` si no se perdió nada (un `�` se importa como dato, por ejemplo
  el de un nombre de WhatsApp que exportó LeadLibre). Sin `lossy`, solo un `�` en la fila
  de encabezados o pegado a una letra dentro de un valor responde `CSV_NOT_UTF8`
  (indicando la fila); uno suelto se importa como dato. La interfaz web convierte sola los
  archivos ANSI y UTF-16 y siempre envía `lossy`.
- `POST /api/tags { name, color? }` (cualquier miembro): si ya existe una etiqueta con ese
  nombre, responde esa etiqueta sin cambiarla. Cambiar el nombre o el color de una
  etiqueta es `PATCH /api/tags/:id` (dueño/admin).
- Etiquetas: una etiqueta nueva tiene hasta 40 caracteres y su nombre no puede llevar `;`,
  `,` ni `|` (`POST`/`PATCH /api/tags` responden `400`), porque son los separadores de la
  columna `etiquetas`. Las etiquetas creadas antes de esa regla siguen funcionando: al
  importar en el mismo espacio, su nombre dentro de la celda `etiquetas` vuelve a esa
  etiqueta completa en lugar de partirse.
- `GET /api/contacts/export.csv` (dueño/admin; mismos filtros que la lista): UTF-8 con
  BOM y cada valor entre comillas (las celdas vacías van sin ellas). Una celda que empieza
  con `=`, `+`, `-` o `@` (o un tramo así después de `;`, `,`, tabulador o salto de línea)
  lleva `'` delante para que Excel no la ejecute como fórmula; por eso los teléfonos salen
  como `'+5255…`. Al importar ese mismo archivo se quita cada `'` que agregó la
  exportación, al inicio de la celda o después de un separador (el teléfono vuelve a ser
  `+5255…`).
- `DELETE /api/contacts/:id` (dueño/admin) → `204`. `409 CONTACT_BILLING_PENDING` si el
  contacto tiene un mensaje cobrado del saldo prepagado que Meta todavía puede reembolsar
  o ajustar (hasta 30 días después del envío): archívalo y bórralo cuando se confirme.
- `POST /api/contacts/bulk { ids, action }`: con `action: "delete"` responde
  `{ updated, archived }`: `updated` son los borrados y `archived` los que se archivaron en
  lugar de borrarse por la misma razón. Las demás acciones responden `{ updated }`.
- `GET /api/contacts/:id/messages?before_id=<id>&limit=60` → `{ messages, has_more }`,
  del más antiguo al más reciente. `before_id` es el `id` del mensaje más antiguo que ya
  tienes y trae los anteriores sin saltarse ni repetir ninguno, aunque varios compartan la
  misma hora (preferido). `before=<fecha ISO>` sigue funcionando. `limit` de 1 a 200.

### Reportes y créditos

- `GET /api/reports/overview?from=AAAA-MM-DD&to=AAAA-MM-DD`: días del calendario (ambos
  incluidos) en la zona horaria del espacio, y cada día de las gráficas va de medianoche a
  medianoche en esa zona. Sin `to`, hoy en esa zona; sin `from`, los 30 días que terminan
  en `to`. Otro formato, `from` después de `to` o más de 400 días responden `400`.
  `range` trae `from`/`to` (instantes) y `from_day`, `to_day` y `timezone`.
- `GET /api/credits`: el gasto y los mensajes cobrables "de este mes" cuentan desde el
  día 1 del mes calendario en la zona horaria del espacio.

### Webhook de Meta (`POST /webhooks/whatsapp`)

- Cuerpo máximo 3 MB (`413`) y como máximo 1000 elementos por payload
  (`413 TOO_MANY_EVENTS`): entradas, cambios y cada elemento de las listas de un cambio
  (`messages`, `statuses`, `message_echoes`, `contacts`, `errors`…). Los lotes reales de
  Meta son mucho más chicos.
- Cada payload firmado se reparte por espacio de trabajo: un trabajo `wa.webhook` por
  espacio, con solo sus eventos (`{ body, channelIds, trustedChannelIds }`), en el carril
  de entrada con reparto justo entre espacios.
- `trustedChannelIds`: los números cuyo payload firmó una clave que el negocio no puede
  conocer (la `META_APP_SECRET` global o la de un número verificado por el operador).
  Solo esos estados pueden reembolsar o ajustar mensajes cobrados del saldo prepagado.

### Eventos de tiempo real (Socket.IO)

`message:new`, `message:update` (un reintento automático reutiliza el mensaje fallido:
llega como `message:update` con `status: "pending"` y un `created_at` nuevo, y luego su
resultado), `contact:new`, `contact:update`, `contacts:bulk`,
`scheduled:update { id, contact_id, status, error? }`, `credits:update` (sin datos: vuelve
a pedir `/api/credits`), `template:update`; `broadcast:update` (solo dueños y
administradores); `contact:revoked { id }` (un agente limitado deja de ver ese chat);
`session:refresh` (vuelve a hacer `join`) y `session:revoked` (sesión terminada: ir a
iniciar sesión).

- `contacts:bulk { action: "delete"|"archive", ids }`: chats borrados o archivados de una
  vez. Un agente que solo ve sus conversaciones recibe solo los `ids` de los chats que
  podía ver (suyos o sin asignar), a veces en varios eventos.
- `session:refresh { workspaceId }` llega a **todas** las pestañas de la persona (cada
  socket está en la sala de su usuario), vean el espacio que vean, cuando cambian sus
  permisos: rol o acceso en cualquier espacio, rol de administrador de la instancia,
  espacio suspendido o reactivado, invitación aceptada. Vuelve a leer `/api/auth/me`.
- Conexión rechazada: `connect_error` con `unauthorized` si no hay sesión válida (sin
  cookie, token inválido, sesión cerrada o contraseña cambiada) y `unavailable` si el
  servidor no pudo comprobarla (por ejemplo, la base de datos se está reiniciando).
  Socket.IO no reintenta solo tras un rechazo: el cliente reintenta `unavailable` con
  espera creciente y, ante `unauthorized`, consulta `/api/auth/me` (solo un `401` cierra
  la sesión).
