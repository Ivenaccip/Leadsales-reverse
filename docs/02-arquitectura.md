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
- **Sin Redis.** La cola de trabajos vive en PostgreSQL (`jobs`), con reintentos
  exponenciales, deduplicación (`dedupe_key`) y `SKIP LOCKED` para escalar a varias
  réplicas si hace falta.
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
  *superadmin* de la instancia.
- **Secretos cifrados.** Tokens de Meta y llaves de IA se guardan con AES-256-GCM
  (`ENCRYPTION_KEY`). Sesiones con JWT en cookie `httpOnly` + `SameSite=Lax`.

## Modelo de datos (resumen)

| Tabla | Para qué |
|---|---|
| `users`, `workspaces`, `memberships` | Cuentas, espacios y roles (con `receives_leads` y `last_assigned_at` para round-robin) |
| `channels` | Números conectados (`cloud_api` / `sandbox`), credenciales cifradas, verify token |
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
   plantilla aprobada.
2. Se estima el costo y se **reserva** en el libro (en `prepaid` falla si no hay saldo).
3. Se llama a Graph API (`POST /{phone-number-id}/messages`).
4. Si Meta responde error: mensaje `failed` con explicación en español y reembolso.
5. Los webhooks de estado actualizan ✓, ✓✓, leído o fallido y concilian el costo real.

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
