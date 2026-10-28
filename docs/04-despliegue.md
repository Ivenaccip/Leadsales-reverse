# Despliegue

Elige según quién lo va a usar:

| Escenario | Recomendación |
|---|---|
| Un negocio | VPS pequeño (1 vCPU, 1–2 GB RAM) con Docker y PostgreSQL |
| La comunidad comparte una instancia | VPS de 2 vCPU / 4 GB, `ALLOW_SIGNUP=true`, respaldos diarios |
| Probar en tu computadora | `npm` + base embebida, canal sandbox |

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

Las migraciones de base de datos se aplican solas al arrancar.

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

## Probar en local con Meta real

Meta necesita una URL pública. Usa un túnel (por ejemplo `cloudflared tunnel --url
http://localhost:3000`) y pon esa URL en `PUBLIC_URL` antes de arrancar.

## Desarrollo

```bash
npm ci
npm run dev        # API en :3000 (tsx watch) + interfaz en :5173 (Vite con proxy)
npm test           # 89 pruebas de integración (base embebida)
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
  edita números oficiales.
- Tokens de Meta y llaves de IA cifrados en reposo (AES-256-GCM).
- Contraseñas con bcrypt; límite de intentos de inicio de sesión.
- Cookies `httpOnly`, `SameSite=Lax`, `Secure` cuando `PUBLIC_URL` es HTTPS.
- Webhooks salientes: solo destinos públicos, verificados al conectar (contra DNS
  rebinding), sin seguir redirecciones (protección SSRF).
- Archivos recibidos por WhatsApp: solo imágenes, audio y video conocidos se muestran en el
  navegador; el resto (SVG, HTML…) se descarga, con CSP `sandbox`.
- Exportación CSV protegida contra inyección de fórmulas.
- Límite de intentos de inicio de sesión por IP y por cuenta; `TRUST_PROXY` controla qué
  proxies pueden indicar la IP del cliente.
- Las difusiones reclaman destinatarios de forma atómica: nunca se envía (ni se cobra) dos
  veces al mismo contacto aunque se pause/reanude o haya varias réplicas.
- Aislamiento por espacio de trabajo en todas las consultas y en el tiempo real; con
  "los agentes solo ven sus conversaciones", cada agente recibe solo los eventos de sus
  chats y de los no asignados.
