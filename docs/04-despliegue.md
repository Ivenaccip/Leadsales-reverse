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

- `app`: LeadLibre, publicada solo en `127.0.0.1:3000` del servidor (`APP_BIND`,
  `APP_PORT`), datos en el volumen `leadlibre-data`.
- `db`: PostgreSQL 16, datos en `leadlibre-db`.
- `caddy`: HTTPS automático con Let's Encrypt (Meta exige HTTPS para el webhook). Corre en
  la red del host (usa los puertos 80 y 443 del servidor) para ver la IP real de cada
  cliente, también por IPv6, y llega a la app por `127.0.0.1:3000`.

Abre `https://crm.tudominio.com`, crea la primera cuenta (será la administradora de
la instancia) y sigue `03-conectar-whatsapp-meta.md`.

Sin dominio propio todavía: `docker compose up -d` y apunta a `http://127.0.0.1:3000` el
proxy que ya tengas en ese servidor (Nginx, Traefik, Cloudflare Tunnel…).

**Por qué solo en 127.0.0.1.** La app cree el encabezado `X-Forwarded-For` (la IP del
cliente, que usan los límites de intentos de inicio de sesión) cuando la conexión viene
de loopback o de una red privada (`TRUST_PROXY`). Docker entrega las conexiones IPv6 a un
puerto publicado desde su puerta de enlace (`172.x.0.1`, una red privada): si el puerto
estuviera abierto a todos, cualquiera por IPv6 podría elegir su IP con ese encabezado
(y gastar los intentos de otra persona, o tener intentos ilimitados), y detrás de un
Caddy en la red de Docker todos los clientes IPv6 compartirían una sola IP. Si de verdad
necesitas que los clientes lleguen directo al puerto (sin proxy), define
`APP_BIND=0.0.0.0` y `TRUST_PROXY=false`; ten en cuenta que entonces los clientes IPv6
siguen llegando desde la puerta de enlace y comparten los límites: usa el perfil `https`.

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
- **Números de espacios prepagados: se desactivan hasta que los verifiques** (lo hace la
  migración `006_review_four`, que se aplica justo después: ver abajo). Nada en la base
  dice quién capturó las credenciales de un número: si un negocio conectó su propio número
  cuando pagaba directo a Meta y después pasaste su espacio a prepagado, ese número tiene
  una *App Secret* que el negocio conoce y con la que podría firmar estados falsos
  (reembolsos al saldo que tú pagas). Por eso ningún número existente queda verificado:
  los números oficiales de espacios prepagados quedan **desactivados** (con el aviso de
  prepagado en **Ajustes → Canales de WhatsApp**) y no envían ni reciben hasta que los
  verifiques como se explica en "Verificar los números de espacios prepagados".
  Planea la actualización: hasta que verifiques sus números, esos espacios no tienen
  WhatsApp.
- **Equipo.** Los administradores de un espacio ya no crean cuentas con contraseña ni
  agregan cuentas existentes: **Ajustes → Equipo** genera un enlace de invitación de un
  solo uso. Ojo: quien tiene el enlace, incluido quien invitó, puede crear la cuenta de ese
  correo (ver "Cuentas creadas por otra persona" en Seguridad).
- Lo demás se migra solo: los mensajes de espacios prepagados que seguían pendientes de
  Meta conservan su reembolso si fallan, los montos pasan a 6 decimales y los webhooks
  salientes en cola se mueven a su propio carril.

Si vienes de una versión sin la migración `005_review_three`:

- **Sesiones.** Cada sesión guarda la versión de la contraseña con la que se abrió. Las
  sesiones existentes siguen funcionando (nadie vuelve a iniciar sesión por esta
  migración). Cambiar la contraseña cierra las demás sesiones de la cuenta, también una
  que se estuviera abriendo en ese momento con la contraseña anterior.
- **Docker.** `docker-compose.yml` publica la app solo en `127.0.0.1` con Caddy en la red
  del host: si llegabas a la app directo por el puerto 3000 desde otra máquina, define
  `APP_BIND` y `TRUST_PROXY` como se explica arriba.
- **Webhook de Meta.** Suscribe también el campo `message_template_components_update`
  (paso 6 de `03-conectar-whatsapp-meta.md`) para que LeadLibre vea los cambios de tus
  plantillas.
- **Envíos sin confirmar.** En su primera pasada de mantenimiento (unos segundos después
  de arrancar), los mensajes "Sin confirmar" (o que se quedaron enviándose) de hace más de
  7 días sin ningún estado de Meta pasan a fallidos y, si tenían cargo, se reembolsan. Las
  versiones anteriores solo marcaban las plantillas para reconocer sus estados, así que un
  texto libre o un archivo de esos pudo haberse entregado aunque ahora se vea como
  fallido. Eso casi nunca mueve saldo: al enviar solo se cobran las plantillas, y llevan la
  marca desde que existe "Sin confirmar". Solo una plantilla que se quedó enviándose (el
  servidor se cayó a medio envío) en una versión que todavía no tenía "Sin confirmar" pudo
  entregarse y aun así reembolsarse.
- Lo demás se migra solo: los trabajos en cola pasan a sus carriles nuevos y las
  plantillas en estado `REINSTATED`, `FLAGGED`, `LOCKED` o `UNLOCKED` (avisos de Meta que
  no impiden enviarlas) quedan como aprobadas.

Si vienes de una versión sin la migración `006_review_four` (por ejemplo `ef96be8` o
`d15f26b`):

- **Números de espacios prepagados conectados antes de la `004`: se desactivan otra vez
  hasta que los verifiques.** La `004_hardening` de `ef96be8` dio por verificados todos los
  números de espacios prepagados sin que nadie los verificara, también los que un negocio
  conectó con su propia app mientras pagaba directo a Meta (conoce su *App Secret*). La
  `006` desmarca y **desactiva** los números oficiales de espacios prepagados que ya
  existían cuando tu instancia aplicó la `004`. Eso incluye los que **ya volviste a
  verificar en `d15f26b`**: la base no distingue tu verificación de la marca general de
  `ef96be8`, así que hay que verificarlos una vez más. Los números que se conectaron
  después de aplicar la `004` no cambian. Si vienes de una versión anterior a la `004`,
  esto aplica a todos los números de espacios prepagados.
- **Plantillas de los números verificados que siguen activos: vuelve a leerlas de Meta.**
  Antes, verificar un número o pasar un espacio a prepagado no volvía a leer sus
  plantillas, así que una categoría que el negocio falsificó mientras firmaba sus propios
  webhooks (por ejemplo `UTILITY` en una plantilla de marketing) puede seguir guardada y
  abaratar sus envíos y estimaciones. Después de actualizar, en cada espacio prepagado abre
  el espacio (**Administración → Abrir**) y, en **Plantillas**, pulsa **Sincronizar con
  Meta** para cada número. Con la API basta una llamada por espacio:
  `PATCH /api/admin/workspaces/:id { "billing_mode": "prepaid" }` (aunque ya sea
  prepagado) vuelve a leer las plantillas de todos sus números verificados y responde en
  `warnings` los que no se pudieron leer. Los números que desactiva la `006` se leen solos
  al verificarlos.
- **Archivos recibidos que ya no se iban a descargar** (la descarga se había rendido antes
  de que existiera el aviso): ahora muestran "No se pudo descargar el archivo de WhatsApp"
  en lugar de quedarse cargando. Pídele al cliente que lo reenvíe si lo necesitas.
- **Bot de menú:** no arranca en conversaciones que una persona del equipo ya respondió
  (la `006` las marca; antes solo quedaban marcadas las que el bot ya había atendido).
- **Administración de la instancia:** dar o quitar el rol de administrador de la instancia
  y poner una contraseña temporal a una cuenta ahora piden tu contraseña actual.

#### Verificar los números de espacios prepagados

Para cada número desactivado, abre el espacio (**Administración → Abrir**) y, en
**Ajustes → Canales de WhatsApp → Editar**, captura el token y la *App Secret* de **tu
propia app de Meta**: eso lo marca como verificado, suscribe tu app a la WABA, vuelve a
leer sus plantillas de Meta (sus categorías deciden el precio de cada envío) y lo
reactiva. Configura el webhook de tu app como en el paso 6 de
`03-conectar-whatsapp-meta.md`; mientras tu app no esté suscrita, los webhooks llegan
firmados con la clave anterior y LeadLibre los rechaza.

- Si usas la app de la instancia (la de `META_APP_SECRET`), captura esa *App Secret*
  aunque el número ya la tuviera: siempre se acepta, porque es tuya por definición.
- Si usas otra app tuya y el número ya tenía su *App Secret* (porque lo verificaste en
  `d15f26b`), capturarla otra vez se rechaza con `APP_SECRET_NOT_NEW`: LeadLibre no puede
  saber que esa clave la escribiste tú y no el negocio. Restablece la clave secreta de esa
  app en Meta (**Configuración de la app → Básica → Clave secreta de la app →
  Restablecer**) y captura la nueva en **todos** los números que usan esa app (de
  cualquier espacio): desde ese momento Meta firma sus webhooks con la clave nueva y
  LeadLibre rechaza los de los números que todavía tengan la anterior. Otra opción es
  verificar el número con otra app tuya o con la de la instancia.
- Si prefieres que ese negocio vuelva a pagar directo a Meta, pásalo a `meta_direct` en
  **Administración**: sus números desactivados por esto se reactivan solos.

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
  que ya tenía se rechaza (`APP_SECRET_NOT_NEW`), porque el negocio puede conocerla, salvo
  la `META_APP_SECRET` de la instancia. Al verificar un número, y al pasar un espacio a
  prepagado, LeadLibre vuelve a leer de Meta las plantillas de sus números verificados:
  una categoría que el negocio pudo falsificar mientras firmaba sus propios webhooks no
  sobrevive al cambio, y los siguientes cambios de estado o de categoría que mande Meta se
  aplican aunque el negocio hubiera fechado los suyos más adelante. "Probar conexión" nunca reactiva un número desactivado.
  Volver a pasar el espacio a `meta_direct` reactiva los números desactivados solo por
  eso. Los reembolsos y ajustes de mensajes cobrados del saldo prepagado solo los aceptan
  estados firmados con una clave que el negocio no conoce (la `META_APP_SECRET` global o la
  de un número que verificaste): si el negocio vuelve a pagar directo a Meta y cambia la
  clave del número, sus estados ya no mueven el saldo.
- Una cuenta de WhatsApp Business (WABA) solo puede conectarse en un espacio: las
  plantillas viven por WABA en Meta y otro espacio podría leerlas o borrarlas. Solo
  cuentan los números oficiales (comprobados con Meta): un canal sandbox no acepta WABA,
  token ni *App Secret*, así que nadie puede "apartar" la WABA de otro con él.
- Webhook de Meta: como máximo 3 MB y 1000 eventos por payload (cuentan todos los
  elementos de cada cambio: mensajes, estados, ecos de la app de WhatsApp Business,
  contactos, errores…), y cada payload se reparte
  en un trabajo por espacio de trabajo en un carril con turnos por espacio: un negocio que
  inunda su propio número no retrasa los mensajes de los demás.
- Tokens de Meta y llaves de IA cifrados en reposo (AES-256-GCM).
- Contraseñas con bcrypt. Un correo inexistente tarda lo mismo que una contraseña
  incorrecta, también cuando se responde 429 (no se puede averiguar quién tiene cuenta por
  el tiempo de respuesta). bcrypt corre en hilos aparte (1 o 2, según los núcleos) con una
  cola corta para todo el proceso: si se llena, inicio de sesión, registro y cambio de
  contraseña responden `503` al instante. Una avalancha de intentos desde muchas redes
  solo hace esperar a quienes inician sesión; el resto de la instancia (bandeja, sockets,
  webhooks de Meta, trabajos) sigue respondiendo.
- Sesiones revocables: cada inicio de sesión es una fila en `sessions`. Cerrar sesión la
  revoca; cambiar la contraseña revoca todas las demás (una cookie robada deja de
  funcionar); quitar o desactivar a alguien de su único espacio revoca todas. Los sockets
  de esas sesiones reciben `session:revoked` y se desconectan. Las cookies anteriores a la
  migración `004_hardening` dejan de servir (hay que iniciar sesión una vez). Cada sesión
  queda ligada a la versión de la contraseña: un inicio de sesión con la contraseña
  anterior que coincide con el cambio no sobrevive, y de dos cambios simultáneos solo gana
  uno.
- Cambiar la contraseña pide la actual, con un máximo de 10 intentos fallidos cada 15
  minutos por sesión: una sesión robada no sirve para adivinarla, y sus intentos no le
  quitan a la dueña los suyos (cambiar la contraseña desde su sesión cierra la robada).
  Lo mismo piden, con el mismo límite, dar o quitar el rol de administrador de la
  instancia y ponerle una contraseña temporal a una cuenta: una sesión robada del
  operador no puede quitarle el rol a otro operador (para luego cambiarle la contraseña)
  ni convertir en operador una cuenta suya.
- Cada espacio conserva al menos un propietario activo: no se puede degradar, desactivar
  ni quitar al último (un propietario desactivado no cuenta), tampoco con dos propietarios
  quitándose uno al otro al mismo tiempo.
- Tiempo real: al unirse a un espacio, el socket vuelve a leer sus permisos si mientras los
  leía alguien fue expulsado o cambió de permisos (quitar a un miembro, desactivarlo,
  limitar a los agentes a sus conversaciones): un `join` en curso no puede devolverle el
  acceso a quien se lo acaban de quitar. Solo cuentan los cambios de ese espacio, de esa
  persona o de esa sesión: los de otros espacios no hacen fallar el `join`. Un cambio de
  permisos (rol o acceso en cualquier espacio, rol de administrador de la instancia,
  espacio suspendido o reactivado) llega a todas las pestañas de la persona, vean el
  espacio que vean, y la interfaz vuelve a leer sus permisos. Un fallo pasajero al
  conectar el socket (por ejemplo, la base de datos reiniciándose) no cierra la sesión: el
  navegador lo reintenta.
- Cookies `httpOnly`, `SameSite=Lax`, `Secure` cuando `PUBLIC_URL` es HTTPS.
- Equipo por invitación: un administrador de espacio no agrega cuentas existentes ni
  escribe contraseñas en el formulario; genera un enlace de un solo uso (7 días) que la
  persona abre con su cuenta de ese correo o con el que crea la cuenta (funciona aunque
  `ALLOW_SIGNUP=false`). Solo el administrador de la instancia puede crear una cuenta
  nueva directamente con contraseña. Un enlace viejo no reactiva ni cambia el rol de quien
  ya es miembro, y cambiar el rol, desactivar o quitar a alguien revoca sus enlaces
  pendientes. El administrador de la instancia es dueño en todos los espacios y ningún
  espacio puede degradarlo ni desactivarlo.
- **Cuentas creadas por otra persona (riesgo que queda).** LeadLibre no envía correos, así
  que nadie comprueba que un correo sea de quien lo usa: el enlace de invitación lo tiene
  quien invita, y con él puede crear la cuenta de ese correo con una contraseña que él
  elige. La persona real ya no puede registrarse con ese correo (`EMAIL_TAKEN`) ni entrar.
  Con `ALLOW_SIGNUP=true` cualquiera puede hacer lo mismo con el registro abierto. La
  vista previa de la invitación ya no dice si un correo tiene cuenta. Si alguien no puede
  entrar a una cuenta que no creó, el administrador de la instancia, en **Administración →
  Usuarios**, revisa sus espacios y puede ponerle una contraseña temporal (cierra todas sus
  sesiones; se la das a la persona por un canal confiable y ella la cambia) o, si no es
  miembro de ningún espacio, borrarla para que se registre de nuevo con la invitación. En
  instancias con varios negocios, deja `ALLOW_SIGNUP=false` y crea los espacios solo para
  negocios de confianza.
- El simulador del canal sandbox es solo para dueños y administradores, y nunca escribe en
  un contacto real (uno que no esté ya en ese canal sandbox).
- Webhooks salientes: solo destinos públicos, verificados al conectar (contra DNS
  rebinding), sin seguir redirecciones (protección SSRF). Los dominios de los negocios se
  resuelven con c-ares (2 s de espera máxima), no con el `dns.lookup` del sistema, que
  ocupa los pocos hilos que también usan las llamadas a Meta: un dominio cuyos servidores
  DNS no responden no frena los envíos de nadie.
- Archivos recibidos por WhatsApp: solo imágenes, audio y video conocidos se muestran en el
  navegador; el resto (SVG, HTML…) se descarga, con CSP `sandbox`. Se sirven por rangos de
  bytes (`206`), que Safari y el iPhone necesitan para reproducir video y audio.
- Exportación CSV protegida contra inyección de fórmulas. La importación lee como máximo
  200 columnas y 20,000 filas, y procesa el archivo por partes, cediendo el turno entre
  ellas: un archivo grande de un negocio no congela la instancia para los demás.
- Límite de intentos fallidos de inicio de sesión (15 min): 50 por red del cliente (una
  IPv6 /64 cuenta como una), 10 por red y cuenta, y 30 por cuenta desde cualquier lugar.
  Los límites por red y por cuenta no frenan a un navegador desde el que ya se inició
  sesión en esa cuenta con su contraseña actual (cookie de dispositivo `ll_device`,
  firmada, 1 año; aunque cambie de IP o de red) ni a una red desde la que ya se inició
  sesión (últimos 90 días; con IPv6 cuenta la /64, aunque el dispositivo cambie de
  dirección cada día). Ese navegador o esa red siguen limitados a 10 intentos fallidos
  (por cookie y por red y cuenta). Así, contraseñas falsas desde otras redes, o basura
  desde la misma oficina, no dejan fuera al dueño aunque su proveedor le cambie la IP.
  Lo que sí puede hacer alguien de la misma red (misma oficina o NAT) es gastar los 10
  intentos de una cuenta concreta y bloquearla desde esa red 15 minutos; y quien entra
  desde un navegador y una red nuevos mientras otros llenan el límite de su cuenta debe
  esperar. Los contadores tienen memoria acotada (llaves con hash, nunca se borran los
  activos al llenarse) y los correos y contraseñas tienen longitud máxima. `TRUST_PROXY`
  controla qué proxies pueden indicar la IP del cliente (por omisión, loopback y redes
  privadas): si no coincide con tus proxies reales (por ejemplo Cloudflare delante de Caddy
  sin configurar sus rangos), todos los clientes parecen venir de unas pocas IPs,
  comparten los mismos contadores y cualquiera puede bloquear el inicio de sesión de
  todos; si los clientes llegan directo a la app desde una red privada (o por IPv6 a
  través de Docker), pueden elegir su IP: usa `TRUST_PROXY=false` o publica la app solo
  para tu proxy (ver Opción A).
- Las difusiones reclaman destinatarios de forma atómica: nunca se envía (ni se cobra) dos
  veces al mismo contacto aunque se pause/reanude o se reinicie el servidor.
- Aislamiento por espacio de trabajo en todas las consultas y en el tiempo real; con
  "los agentes solo ven sus conversaciones", cada agente recibe solo los eventos de sus
  chats y de los no asignados (también los avisos de chats borrados o archivados en
  bloque), y un aviso (`contact:revoked`) cuando uno de ellos pasa a otra persona. Los eventos de difusiones solo llegan a dueños y administradores. Quitarle
  a alguien el rol de administrador de la instancia lo saca en el acto de los espacios
  ajenos que tenía abiertos.
