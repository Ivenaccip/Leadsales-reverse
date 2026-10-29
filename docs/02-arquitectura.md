# Arquitectura

```
                    ┌──────────────────────── Servidor LeadLibre (Node.js) ─────────────────────────┐
 Navegador (React)  │                                                                                │
 ───────────────────┤  Fastify (REST /api)   Socket.IO (tiempo real)   Archivos estáticos (web/dist)   │
   Bandeja, Kanban, │        │                      ▲                                                 │
   Difusiones…      │        ▼                      │ emit(ws:{id})                                   │
                    │   Servicios: contactos · mensajes · créditos · difusiones · bot · IA · reportes  │
 Meta (Cloud API)   │        │              ▲                                                         │
 ──webhook firmado──┼─► /webhooks/whatsapp ─┤ cola de trabajos (tabla jobs, FOR UPDATE SKIP LOCKED)   │
 ◄──Graph API───────┼── proveedor cloud_api │   wa.webhook · media.download · automation.inbound      │
                    │   proveedor sandbox   │   ai.reply · broadcast.process · scheduled.send ·        │
 Claude API ◄───────┼── agente IA           │   webhook.deliver                                        │
 Make/Zapier/n8n ◄──┼── webhooks salientes  │                                                         │
                    └──────────────┬───────────────────────────────────────────────────────────────────┘
                                   ▼
                     PostgreSQL 16  — o —  PostgreSQL embebido (PGlite) en DATA_DIR
```

## Decisiones

- **Un solo proceso, un solo puerto.** API, webhook, tiempo real y la interfaz web se
  sirven juntos: fácil de desplegar en un VPS, Railway, Render o una Raspberry Pi.
- **Una sola réplica.** Las salas de Socket.IO (quién recibe cada evento, la expulsión
  de un miembro, el cierre de sesiones) y los límites de intentos de inicio de sesión
  viven en la memoria del proceso. Con dos réplicas, los eventos que genera una no llegan
  a los navegadores conectados a la otra y un miembro quitado en una seguiría recibiendo
  mensajes en la otra. Corre **un solo contenedor `app`** (escala verticalmente).
- **Sin Redis.** La cola de trabajos vive en PostgreSQL (`jobs`), con reintentos
  exponenciales, deduplicación (`dedupe_key`) y `SKIP LOCKED`, así que un reinicio o un
  despliegue que se traslapa unos segundos no procesa nada dos veces (ver
  [Cola de trabajos](#cola-de-trabajos)).
- **Base de datos flexible.** Con `DATABASE_URL` usa PostgreSQL; sin ella usa PGlite
  (PostgreSQL compilado a WebAssembly) guardado en `DATA_DIR/pgdata`. Mismo SQL, mismas
  migraciones. Las pruebas corren en ambos.
- **Webhook rápido y durable.** El endpoint verifica la firma HMAC con la *App Secret*
  del canal, encola el payload y responde 200 de inmediato. El procesamiento es
  idempotente (`wamid` único) y reintenta si un estado llega antes que el mensaje.
- **Proveedores intercambiables.** `WhatsAppProvider` abstrae Cloud API y Sandbox
  (simulador con estados y precios falsos). Agregar otro proveedor es implementar esa
  interfaz.
- **Multi-tenant.** Todo cuelga de `workspace_id`. Un usuario puede pertenecer a varios
  espacios con distinto rol (`owner`, `admin`, `agent`). El primer usuario es
  *superadmin* de la instancia (el registro del primero se serializa con un candado de
  PostgreSQL: dos registros simultáneos nunca crean dos superadmins) y actúa como
  `owner` en cualquier espacio, aunque un espacio le haya dado una membresía menor.
- **Invitaciones, no cuentas ajenas.** Las cuentas son globales (una por correo) y nadie
  verifica correos, así que un espacio nunca agrega una cuenta existente por su correo ni
  le pone contraseña a otra persona: crea una invitación con un enlace de un solo uso
  (`/invitacion/<token>`, se guarda solo su SHA-256, vence en 7 días). Entra solo quien
  abre el enlace con la sesión de ese correo, o quien crea esa cuenta desde el enlace.
- **Secretos cifrados.** Tokens de Meta y llaves de IA se guardan con AES-256-GCM
  (`ENCRYPTION_KEY`).
- **Sesiones revocables.** La cookie (`httpOnly`, `SameSite=Lax`) lleva un JWT
  `{ uid, sid }` y cada petición y cada conexión de Socket.IO exigen que la fila `sid`
  de `sessions` exista y no esté revocada. Cerrar sesión revoca esa sesión; cambiar la
  contraseña revoca las demás; quitar o desactivar a alguien de su único espacio revoca
  todas. Sus pestañas abiertas reciben `session:revoked` y se desconectan.
- **Números oficiales del operador.** En espacios prepagados el operador paga a Meta, así
  que solo él conecta o edita números, y solo los números verificados por él
  (`channels.operator_verified`) pueden estar activos y firmar webhooks: quien conoce la
  *App Secret* puede firmar estados falsos y provocar reembolsos. Un número queda
  verificado solo si el operador capturó su *App Secret* con el espacio ya en prepagado y
  esa clave no estaba en ningún número no verificado del espacio. Pasar un espacio a
  prepagado desactiva los demás (los que conectó el negocio y los que el operador capturó
  mientras el negocio pagaba directo a Meta, probablemente con la app del negocio); para
  reactivarlos el operador captura el token y la *App Secret* de su propia app de Meta
  (re-capturar la clave que ya tenía se rechaza con `APP_SECRET_NOT_NEW`) y LeadLibre
  suscribe esa app a la WABA. Un webhook firmado con la clave de un número prepagado no
  verificado se rechaza y desactiva ese número con el motivo visible. Una WABA solo puede
  estar en un espacio (Meta guarda las plantillas por WABA).

## Modelo de datos (resumen)

| Tabla | Para qué |
|---|---|
| `users`, `workspaces`, `memberships` | Cuentas, espacios y roles (con `receives_leads` y `last_assigned_at` para round-robin) |
| `sessions` | Una fila por inicio de sesión (IP, navegador, revocada o no) |
| `invitations` | Invitaciones al equipo: correo, rol, hash del token, vencimiento, aceptada/revocada |
| `channels` | Números conectados (`cloud_api` / `sandbox`), credenciales cifradas, verify token, `operator_verified` |
| `funnels`, `stages` | Embudos y etapas (`open` / `won` / `lost`) |
| `contacts`, `tags`, `contact_tags` | Leads: teléfono normalizado, etapa, asignado, valor, campos personalizados, estado del bot, ventana de 24 h |
| `messages` | Entrantes, salientes y notas internas; `wamid`, estado, error, categoría y costo |
| `contact_events` | Historial (creado, cambio de etapa, asignación, baja) para timeline y reportes |
| `templates` | Plantillas sincronizadas de Meta |
| `broadcasts`, `broadcast_recipients` | Difusiones y su avance por destinatario |
| `scheduled_messages` | Mensajes programados |
| `credit_ledger`, `rate_card` | Libro de créditos y tarifas de Meta por mercado/categoría |
| `quick_replies`, `media_files` | Respuestas rápidas y archivos |
| `api_keys`, `webhook_endpoints` | Integraciones |
| `jobs` | Cola de trabajos |

## Flujo de un mensaje entrante

1. Meta → `POST /webhooks/whatsapp` (firma verificada) → job `wa.webhook`.
2. Se crea/actualiza el contacto (teléfono normalizado: `521…` de México se guarda como
   `52…` para no duplicar), se coloca en la primera etapa del embudo predeterminado y,
   si el embudo tiene round-robin, se asigna.
3. Se guarda el mensaje (idempotente), se actualizan no leídos y ventana de 24 h, se
   encola la descarga de multimedia y se emite por Socket.IO.
4. Job `automation.inbound`: horario/ausencia, bienvenida, bot de menú o agente IA
   (con *debounce* de 4 s para juntar mensajes seguidos).

## Flujo de un envío

1. Validaciones: canal, **ventana de 24 h** (texto libre solo dentro de la ventana),
   plantilla aprobada y con todo lo que pide (variables, encabezado, cupón), archivo que
   WhatsApp acepta (tipo y tamaño).
2. Se estima el costo y se **reserva** en el libro (en `prepaid` falla si no hay saldo).
   El mensaje guarda quién pagó (`charged_prepaid`): sus reembolsos y ajustes van a esa
   misma cartera aunque después cambie el modo del espacio.
3. Se llama a Graph API (`POST /{phone-number-id}/messages`).
4. Si Meta responde error (o la conexión falla antes de enviar): mensaje `failed` con
   explicación en español y reembolso.
5. Si la respuesta de Meta se pierde (falla de red, tiempo agotado o 5xx): mensaje
   `unknown` ("Sin confirmar"). Meta pudo haberlo entregado, así que conserva el cargo y
   nunca se reenvía solo; las plantillas llevan el id del mensaje en
   `biz_opaque_callback_data` para que sus webhooks de estado lo encuentren.
6. Los webhooks de estado actualizan ✓, ✓✓, leído o fallido y concilian el costo real.

## Cola de trabajos

Todo lo que no debe frenar una petición (procesar el webhook de Meta, descargar
multimedia, bot e IA, difusiones, programados y webhooks salientes) es una fila de
`jobs`. El worker corre en el mismo proceso y toma trabajos con `FOR UPDATE SKIP LOCKED`
en cuanto se libera un lugar, así que un trabajo lento no detiene a los demás.

- **Carriles.** Cada carril tiene sus propios lugares: `default` (10 a la vez) para casi
  todo y `webhooks` (8 a la vez) para los webhooks salientes, así un receptor lento o
  caído nunca frena los mensajes entrantes, el bot ni las difusiones. En `webhooks` un
  espacio ocupa como máximo 3 lugares y los libres se reparten entre espacios: primero
  el que menos tiempo de carril usó últimamente, así que un negocio con endpoints que no
  responden no acapara el carril.
- **Un contacto a la vez.** `automation.inbound` y `ai.reply` de un mismo contacto
  comparten `serial_key` (`contact:<id>`) y nunca corren al mismo tiempo: leen el estado
  del bot o la conversación y luego actúan sobre ella. Los de otros contactos siguen en
  paralelo.
- **Reintentos.** Por omisión, 5 intentos con espera creciente (5 s, 10 s, 20 s, 40 s).
  Los webhooks salientes hacen hasta 12 intentos en unas 34 h (ver `06-api.md`) y la
  descarga de multimedia hasta 10 en unas 28 h. Un error definitivo no se reintenta.
- **Recuperación.** Cada proceso escribe un latido (`worker_heartbeats`) cada 15 s. Con
  PostgreSQL, los trabajos que dejó a medias un proceso que murió vuelven a la cola cuando
  su latido cumple 60 s (en un minuto, más o menos); con PGlite, que vive dentro del
  proceso, vuelven de inmediato al arrancar. Un trabajo que pasa de 10 min libera su
  lugar y se reintenta. Al recibir `SIGTERM`, LeadLibre deja de tomar trabajos, espera
  hasta 7 s a los que corren y devuelve los demás a la cola.
- **Una sola réplica.** La cola aguantaría varias instancias, pero el tiempo real y los
  límites de inicio de sesión viven en memoria (ver "Una sola réplica" arriba). Con
  PostgreSQL, si al arrancar detecta otra instancia activa en la misma base, LeadLibre lo
  advierte en el log.

## Tiempo real

El navegador abre un Socket.IO con su cookie (se valida la sesión) y entra al espacio con
`join`. El servidor decide sus salas: `ws:{id}` (ve todo), `ws:{id}:admins` (dueños,
administradores y el operador: eventos `broadcast:*`), o, para agentes limitados a "sus
conversaciones", `ws:{id}:restricted` + `ws:{id}:u:{usuario}`, que solo reciben eventos
de sus chats y de los no asignados. Cuando un chat que un agente limitado veía pasa a
otra persona, ese agente recibe `contact:revoked { id }` para quitarlo de su bandeja.
`session:refresh` pide volver a entrar (cambió el rol, la visibilidad o se perdió el
acceso) y `session:revoked` manda a iniciar sesión.

## Código

```
server/src/
  app.ts, index.ts, config.ts        arranque y configuración
  db/                                adaptador Postgres/PGlite y migraciones
  jobs/                              cola, worker y handlers
  whatsapp/                          cloud-api.ts, sandbox.ts, provider.ts, inbound.ts (webhook)
  services/                          lógica de negocio (contacts, messages, credits, broadcasts,
                                     automation, ai-agent, templates, reports, scheduled…)
  routes/                            endpoints REST
  test/                              pruebas de integración (vitest)
web/src/
  pages/                             Bandeja, Embudos, Contactos, Difusiones, Plantillas,
                                     Bot e IA, Reportes, Créditos, Ajustes, Administración
  components/                        UI compartida, selectores, formularios de plantillas, gráficas
  lib/                               cliente API, sesión, tiempo real, formatos, tipos
```
