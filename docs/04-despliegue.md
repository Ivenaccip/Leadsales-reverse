# Despliegue

Elige según quién lo va a usar:

| Escenario | Recomendación |
|---|---|
| Un negocio | VPS pequeño (1 vCPU, 1–2 GB RAM) con Docker y PostgreSQL |
| La comunidad comparte una instancia | VPS de 2 vCPU / 4 GB, `ALLOW_SIGNUP=true`, respaldos diarios |
| Probar en tu computadora | `npm` + base embebida, canal sandbox |

> **Una sola réplica.** Corre siempre un solo proceso/contenedor `app` por instancia
> (escala con más CPU y memoria, no con más réplicas). El tiempo real (quién recibe cada
> evento, expulsar a un miembro, cerrar sesiones) y los límites de intentos de inicio de
> sesión viven en la memoria del proceso: con dos réplicas detrás de un balanceador, los
> mensajes que procesa una no aparecen en los navegadores conectados a la otra y un
> miembro quitado o un espacio suspendido seguiría recibiendo eventos en la otra. Con
> PostgreSQL, si al arrancar detecta otra instancia activa en la misma base, LeadLibre lo
> advierte en el log.

## Opción A — Docker en un VPS (recomendado)

Requisitos: un VPS con Docker, un dominio (`crm.tudominio.com`) apuntando a la IP del
servidor y los puertos 80/443 abiertos.

```bash
git clone <este repositorio> leadlibre && cd leadlibre
cp .env.example .env
nano .env          # PUBLIC_URL=https://crm.tudominio.com, DOMAIN=crm.tudominio.com, POSTGRES_PASSWORD
docker compose --profile https up -d --build
docker compose logs -f app
```

- `app`: LeadLibre (puerto 3000), datos en el volumen `leadlibre-data`.
- `db`: PostgreSQL 16, datos en `leadlibre-db`.
- `caddy`: HTTPS automático con Let's Encrypt (Meta exige HTTPS para el webhook).

Abre `https://crm.tudominio.com`, crea la primera cuenta (será la administradora de
la instancia) y sigue `03-conectar-whatsapp-meta.md`.

Sin dominio propio todavía: `docker compose up -d` y publica el puerto 3000 detrás del
proxy que ya tengas (Nginx, Traefik, Cloudflare Tunnel…).

### Actualizar

```bash
git pull && docker compose --profile https up -d --build
```

Las migraciones de base de datos se aplican solas al arrancar. Al detenerse, LeadLibre
deja de tomar trabajos, espera hasta 7 s a los que están corriendo y devuelve el resto a
la cola: el contenedor nuevo los retoma al arrancar.

#### Actualizar desde una versión anterior

Si vienes de una versión sin la migración `004_hardening` (sesiones revocables,
invitaciones y números verificados por el operador):

- **Todos vuelven a iniciar sesión una vez.** Las sesiones ahora se pueden revocar y las
  cookies anteriores dejan de servir.
- **Números de espacios prepagados.** La migración marca como verificados por el
  operador los números de los espacios que ya estaban en prepagado, porque desde la
  versión anterior solo tú podías conectarlos ahí. Pero si un negocio conectó su propio
  número cuando pagaba directo a Meta y después pasaste su espacio a prepagado, ese
  número sigue con una *App Secret* que el negocio conoce y con la que podría firmar
  estados falsos. Abre ese espacio (**Administración → Abrir**) y, en **Ajustes → Canales
  de WhatsApp**, vuelve a capturar el token y la *App Secret* de **tu propia app de
  Meta** (o desconecta el número). Después pulsa **Re-suscribir webhook** en ese número
  (suscribe tu app a la WABA con el token que acabas de capturar) y configura el webhook
  de tu app como en el paso 6 de `03-conectar-whatsapp-meta.md`: ese número ya contaba
  como verificado, así que nada garantiza que tu app ya esté suscrita. Si no lo está, los
  webhooks seguirán llegando firmados con la clave anterior, LeadLibre los rechazará y no
  verás mensajes nuevos de ese número.
- **Equipo.** Los administradores de un espacio ya no crean cuentas con contraseña:
  **Ajustes → Equipo** genera un enlace de invitación de un solo uso.
- Lo demás se migra solo: los mensajes de espacios prepagados que seguían pendientes de
  Meta conservan su reembolso si fallan, los montos pasan a 6 decimales y los webhooks
  salientes en cola se mueven a su propio carril.

### Respaldos

```bash
docker compose exec db pg_dump -U leadlibre leadlibre | gzip > respaldo-$(date +%F).sql.gz
docker run --rm -v leadlibre_leadlibre-data:/data -v "$PWD":/backup alpine tar czf /backup/archivos-$(date +%F).tgz -C /data .
```

Guarda también `JWT_SECRET`/`ENCRYPTION_KEY` (o `DATA_DIR/secrets.json`): sin la llave de
cifrado no se pueden leer los tokens de Meta guardados.

## Opción B — Sin Docker (Node.js 20.12+)

```bash
npm ci
npm run build
cp .env.example .env    # sin DATABASE_URL usa la base embebida en ./data
npm start               # http://localhost:3000
```

Para producción ponlo detrás de un proxy con HTTPS y un gestor de procesos
(`systemd`, `pm2`). Ejemplo de unidad systemd:

```ini
[Unit]
Description=LeadLibre
After=network.target

[Service]
WorkingDirectory=/opt/leadlibre
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
User=leadlibre
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Opción C — Plataformas administradas (Railway, Render, Fly.io…)

- Construye con el `Dockerfile` del repositorio.
- Agrega un PostgreSQL administrado y define `DATABASE_URL`.
- Define `PUBLIC_URL` con la URL pública HTTPS que te asigna la plataforma.
- Monta un volumen persistente en `/data` (archivos multimedia y llaves).
- Configura **una sola instancia** (sin réplicas ni autoescalado horizontal): ver la nota
  "Una sola réplica" al inicio.

## Probar en local con Meta real

Meta necesita una URL pública. Usa un túnel (por ejemplo `cloudflared tunnel --url
http://localhost:3000`) y pon esa URL en `PUBLIC_URL` antes de arrancar.

## Desarrollo

```bash
npm ci
npm run dev        # API en :3000 (tsx watch) + interfaz en :5173 (Vite con proxy)
npm test           # pruebas del servidor (integración, base embebida) y de la interfaz
TEST_DATABASE_URL=postgres://usuario@localhost:5432/postgres npm test   # contra PostgreSQL real
npm run typecheck
```

## Seguridad

- Webhook de Meta verificado con HMAC-SHA256 (App Secret por canal). Cada payload solo
  puede afectar a los canales cuya clave lo firmó: un negocio no puede inyectar eventos en
  el número de otro.
- Al conectar un número, LeadLibre comprueba con Meta que el token controla ese número y
  que el número pertenece a la WABA indicada (nadie puede "apartar" el número de otro).
- En espacios con créditos prepagados, solo el administrador de la instancia conecta o
  edita números oficiales, y solo los números que él verificó pueden estar activos y
  firmar webhooks: quien conoce la *App Secret* de un número podría firmar estados falsos
  para generar reembolsos. Verificar significa capturar, con el espacio ya en prepagado, el
  token y la *App Secret* de **tu propia app de Meta**: una clave que el negocio no conoce.
  Al pasar un espacio a prepagado se desactivan los números que conectó el propio negocio
  y también los que capturaste tú mientras el negocio pagaba directo a Meta (normalmente
  son las credenciales de su app). Para reactivarlos, edita el número con el token y la
  *App Secret* de tu app (LeadLibre suscribe tu app a la WABA); volver a capturar la clave
  que ya tenía se rechaza (`APP_SECRET_NOT_NEW`), porque el negocio puede conocerla.
  "Probar conexión" nunca reactiva un número desactivado.
- Una cuenta de WhatsApp Business (WABA) solo puede conectarse en un espacio: las
  plantillas viven por WABA en Meta y otro espacio podría leerlas o borrarlas.
- Tokens de Meta y llaves de IA cifrados en reposo (AES-256-GCM).
- Contraseñas con bcrypt. Un correo inexistente tarda lo mismo que una contraseña
  incorrecta (no se puede averiguar quién tiene cuenta por el tiempo de respuesta).
- Sesiones revocables: cada inicio de sesión es una fila en `sessions`. Cerrar sesión la
  revoca; cambiar la contraseña revoca todas las demás (una cookie robada deja de
  funcionar); quitar o desactivar a alguien de su único espacio revoca todas. Los sockets
  de esas sesiones reciben `session:revoked` y se desconectan. Las sesiones anteriores a
  esta versión deben volver a iniciar sesión una vez.
- Cookies `httpOnly`, `SameSite=Lax`, `Secure` cuando `PUBLIC_URL` es HTTPS.
- Equipo por invitación: un administrador de espacio no puede crear cuentas con
  contraseña ni agregar cuentas existentes; genera un enlace de un solo uso (7 días) que
  la persona abre con su cuenta de ese correo o con el que crea la cuenta (funciona aunque
  `ALLOW_SIGNUP=false`). Solo el administrador de la instancia puede crear una cuenta
  nueva directamente con contraseña. El administrador de la instancia es dueño en todos
  los espacios y ningún espacio puede degradarlo ni desactivarlo.
- El simulador del canal sandbox es solo para dueños y administradores, y nunca escribe en
  un contacto real (uno que no esté ya en ese canal sandbox).
- Webhooks salientes: solo destinos públicos, verificados al conectar (contra DNS
  rebinding), sin seguir redirecciones (protección SSRF).
- Archivos recibidos por WhatsApp: solo imágenes, audio y video conocidos se muestran en el
  navegador; el resto (SVG, HTML…) se descarga, con CSP `sandbox`.
- Exportación CSV protegida contra inyección de fórmulas.
- Límite de intentos fallidos de inicio de sesión (15 min): 50 por red del cliente (una
  IPv6 /64 cuenta como una), 10 por red y cuenta, y 30 por cuenta desde cualquier lugar.
  Los límites por red y por cuenta no frenan a una red desde la que ya se inició sesión
  en esa cuenta (últimos 90 días; con IPv6 cuenta la /64, aunque el dispositivo cambie de
  dirección cada día); esa red sigue limitada a 10 intentos fallidos por cuenta. Así,
  contraseñas falsas desde otras redes, o basura desde la misma oficina, no dejan fuera al
  dueño. Lo que sí puede hacer alguien de la misma red (misma oficina o NAT) es gastar
  esos 10 intentos de una cuenta concreta y bloquearla desde esa red 15 minutos. Los
  contadores tienen memoria acotada (llaves con hash, nunca se borran los activos al
  llenarse) y los correos y contraseñas tienen longitud máxima. `TRUST_PROXY` controla
  qué proxies pueden indicar la IP del cliente: si no coincide con tus proxies reales (por
  ejemplo Cloudflare delante de Caddy sin configurar sus rangos), todos los clientes
  parecen venir de unas pocas IPs, comparten los mismos contadores y cualquiera puede
  bloquear el inicio de sesión de todos.
- Las difusiones reclaman destinatarios de forma atómica: nunca se envía (ni se cobra) dos
  veces al mismo contacto aunque se pause/reanude o se reinicie el servidor.
- Aislamiento por espacio de trabajo en todas las consultas y en el tiempo real; con
  "los agentes solo ven sus conversaciones", cada agente recibe solo los eventos de sus
  chats y de los no asignados, y un aviso (`contact:revoked`) cuando uno de ellos pasa a
  otra persona. Los eventos de difusiones solo llegan a dueños y administradores. Quitarle
  a alguien el rol de administrador de la instancia lo saca en el acto de los espacios
  ajenos que tenía abiertos.
