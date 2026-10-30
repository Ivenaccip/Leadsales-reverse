# Conectar tu número de WhatsApp (API oficial de Meta / "WAPI")

LeadLibre usa la **WhatsApp Business Cloud API** de Meta. Cada negocio conecta **su
propio número** y **Meta le cobra directamente** los mensajes que envía. No hay
intermediarios ni mensualidad.

> Tiempo estimado: 30–60 minutos la primera vez. Necesitas un portafolio comercial
> (Business Manager) y una tarjeta para los pagos de Meta.

## Antes de empezar

- Un **número que no esté registrado en la app de WhatsApp** (personal o Business).
  Si lo está, bórralo de la app primero o usa un número nuevo. Algunos proveedores
  ofrecen *Coexistencia* (usar la app y la API a la vez); LeadLibre ya procesa los
  eventos de coexistencia (`smb_message_echoes`).
- Tu instancia de LeadLibre publicada con **HTTPS** (ver `04-despliegue.md`). Meta no
  envía webhooks a `http://` ni a `localhost`.

## Paso 1. Crear la app de Meta

1. Entra a <https://developers.facebook.com> → **Mis apps** → **Crear app**.
2. Tipo de app: **Empresa** (Business). Vincúlala a tu portafolio comercial.
3. En el panel de la app, agrega el producto **WhatsApp** → **Configurar**.

## Paso 2. Registrar el número

1. En **WhatsApp → Configuración de la API** (API Setup) pulsa **Agregar número de teléfono**.
2. Completa el perfil (nombre visible, categoría) y verifica el número por SMS o llamada.
3. Copia:
   - **Identificador del número de teléfono** → `Phone Number ID`
   - **Identificador de la cuenta de WhatsApp Business** → `WABA ID`
4. **Registra el número en la Cloud API.** Agregarlo y verificarlo no basta: hasta
   registrarlo no puede enviar ni recibir mensajes por la API (cada envío falla con el
   error `133010`, "Account not registered"), y solo se registra con una llamada a la API.
   Elige un PIN de 6 dígitos: queda como la verificación en dos pasos del número (si ya
   tiene una, usa ese PIN). Con el token temporal de esta misma página (o el permanente
   del paso 3):

   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/PHONE_NUMBER_ID/register" \
     -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" \
     -d '{"messaging_product": "whatsapp", "pin": "123456"}'
   ```

   Debe responder `{"success": true}`. Meta limita los intentos (unos 10 cada 72 horas):
   revisa el PIN antes de repetir. Un número que viene de la API local (On-Premises) o de
   otro proveedor se migra primero a la Cloud API y luego se registra igual.

> El número de prueba que Meta da por defecto solo puede escribir a 5 números
> registrados; sirve para probar, no para vender.

## Paso 3. Token de acceso permanente

El token temporal del panel caduca en 24 h. Crea uno permanente:

1. <https://business.facebook.com> → **Configuración del negocio** → **Usuarios** →
   **Usuarios del sistema** → **Agregar** (rol *Administrador*).
2. **Asignar activos**: tu app (control total) y tu cuenta de WhatsApp (control total).
3. **Generar token** → elige tu app → caducidad **Nunca** → permisos:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
4. Copia el token (empieza con `EAA…`). Solo se muestra una vez.

## Paso 4. Clave secreta de la app (App Secret)

En la app: **Configuración de la app → Básica → Clave secreta de la app → Mostrar**.
LeadLibre la usa para comprobar la firma `X-Hub-Signature-256` de cada webhook: así
nadie puede inyectar mensajes falsos.

## Paso 5. Conectar en LeadLibre

**Ajustes → Canales de WhatsApp → Conectar WhatsApp API oficial**, pega los 4 datos
y pulsa **Verificar y conectar**. LeadLibre:

- valida el número con Meta (`GET /{phone-number-id}`), comprueba que pertenece a tu
  cuenta (`GET /{waba-id}/phone_numbers`) y que está registrado en la Cloud API
  (`platform_type`: si no lo está, no lo conecta y te dice cómo registrarlo, paso 2),
- suscribe tu app a la cuenta (`POST /{waba-id}/subscribed_apps`),
- descarga tus plantillas (`GET /{waba-id}/message_templates`),
- guarda el token y la clave **cifrados** (AES-256-GCM) en tu servidor.

## Paso 6. Configurar el webhook

LeadLibre te muestra dos datos. En Meta: **WhatsApp → Configuración → Webhook →
Editar**:

| Campo en Meta | Valor |
|---|---|
| URL de devolución de llamada | `https://TU_DOMINIO/webhooks/whatsapp` |
| Token de verificación | el *verify token* que muestra LeadLibre |

Pulsa **Verificar y guardar** y luego, en **Campos del webhook**, suscríbete a:

- `messages` (mensajes y estados de entrega, incluye el precio de cada mensaje)
- `message_template_status_update` (aprobación/rechazo de plantillas)
- `message_template_components_update` (cambios en el contenido de una plantilla, por
  ejemplo al editarla en WhatsApp Manager: LeadLibre vuelve a leerla de Meta para enviar
  siempre la versión vigente)
- opcional: `template_category_update`, `smb_message_echoes` (coexistencia)

Escríbele a tu número desde otro WhatsApp: el mensaje debe aparecer en la **Bandeja**.

## Paso 7. Método de pago (tus créditos)

En **WhatsApp Manager → Configuración de la cuenta → Pagos**, agrega tu tarjeta.
Meta te cobra **por plantilla entregada** según categoría y país (ver
`05-creditos-y-costos.md`). Las respuestas dentro de la ventana de 24 h tienen un nivel
gratuito mensual. LeadLibre te muestra el gasto estimado y lo concilia con el precio
que Meta reporta en cada webhook.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| "El token de acceso expiró" | Usaste el token temporal. Genera uno de usuario del sistema (paso 3). |
| No llegan mensajes | Webhook sin verificar, campo `messages` sin suscribir, URL sin HTTPS o app no suscrita (botón **Re-suscribir webhook**). |
| Firma inválida en los logs | La clave secreta del canal no corresponde a la app que envía el webhook. |
| "No está registrado en la Cloud API" al conectar o probar, o error 133010 al enviar | Falta registrar el número (paso 2, punto 4). |
| Error 131047 al responder | Pasaron más de 24 h desde el último mensaje del cliente: usa una plantilla. |
| Error 131030 | Estás usando el número de prueba de Meta y el destinatario no está en la lista permitida. |
| Error 131042 | Problema con el método de pago en Meta. |
| Plantilla rechazada | Revisa el motivo en **Plantillas**; evita contenido promocional en categoría *Utilidad*. |

## Varios negocios con una sola app (opcional, para operadores)

Si la comunidad tiene una app verificada como **Tech Provider**, puede usar *Embedded
Signup* para que cada negocio conecte su número con un clic. Configura
`META_APP_SECRET` y `META_VERIFY_TOKEN` globales en el servidor; cada canal sigue
guardando su propio token. (El flujo de Embedded Signup en la interfaz queda como
mejora futura; mientras tanto, el alta manual de este documento funciona para todos.)
