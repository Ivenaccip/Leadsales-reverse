# LeadLibre

**CRM de WhatsApp para vender en equipo, sobre la API oficial de Meta ("WAPI"). Libre,
autohospedable y sin mensualidad: cada negocio solo paga sus créditos de WhatsApp.**

LeadLibre es una alternativa abierta a herramientas como Leadsales: bandeja compartida,
embudos de venta tipo Kanban, etiquetas, asignación automática, difusiones, bot de menú
y agente con IA. La diferencia: no cobra por usuario ni por mes. Conectas **tu propio
número** de la WhatsApp Business Cloud API y **Meta te cobra directo** solo los mensajes
que envías.

> Análisis de Leadsales y decisiones de diseño: [`docs/01-analisis-leadsales.md`](docs/01-analisis-leadsales.md)

## ¿Por qué?

| | Leadsales (Plan WAPI) | **LeadLibre** |
|---|---|---|
| Mensualidad | ~$133–247 USD al mes | **$0** |
| Créditos de WhatsApp | Paquetes con margen | **Costo real de Meta**, conciliado mensaje por mensaje |
| Usuarios y embudos | Limitados por plan | **Ilimitados** |
| Conexión | QR (no oficial) o API | **Solo API oficial** (sin riesgo de bloqueo) |
| IA | Incluida en planes altos | **Tu llave de Claude**: pagas solo tu uso |
| Datos | En su nube | **En tu servidor** |

## Funciones

- **Bandeja compartida en tiempo real**: todo el equipo atiende el mismo número; filtros
  Todas / Mías / Sin asignar / No leídos; notas internas; respuestas rápidas con `/`;
  adjuntos; plantillas; mensajes programados; indicador de la **ventana de 24 h**;
  palomitas de enviado, entregado y leído; errores de Meta explicados en español.
- **Embudos (Kanban)**: embudos y etapas ilimitados, arrastrar y soltar, valor por etapa,
  etapas de ganado/perdido para reportes.
- **Contactos**: búsqueda, filtros, **acciones masivas** (etiquetar, mover, asignar,
  archivar), importación y exportación CSV, campos personalizados, historial.
- **Asignación automática round-robin** por embudo entre los miembros que reciben leads.
- **Plantillas**: sincroniza y crea plantillas de Meta con vista previa.
- **Difusiones**: segmenta por embudo, etapas, etiquetas, asesor y fechas; personaliza con
  `{primer_nombre}`; **estimación de costo por país antes de enviar**; envío con control de
  velocidad; métricas de enviados, entregados, leídos y respuestas; respeta las bajas
  (**BAJA/STOP**).
- **Bot de menú** (como Leadbot): hasta 3 niveles, botones/listas de WhatsApp, cada opción
  responde, mueve de etapa, etiqueta, asigna o pasa a un asesor.
- **Agente con IA** (como Lead Agent) con Claude: responde con la información de tu
  negocio, actualiza el CRM con herramientas y pasa a un humano cuando hace falta.
- **Horario de atención**, mensaje de ausencia y de bienvenida.
- **Créditos**: libro contable por espacio, conciliado con el `pricing` que Meta envía en
  cada webhook; modo **pago directo a Meta** o **prepagado**.
- **Reportes**: leads por día, mensajes, embudo, origen de leads, rendimiento y tiempo de
  primera respuesta por agente.
- **Integraciones**: API REST con llaves, webhooks salientes firmados (Make, Zapier, n8n,
  Facebook Lead Ads, formularios).
- **Multi-negocio**: una instancia para toda la comunidad, con panel de administración
  (espacios, recargas, tarifas de Meta).
- **Canal sandbox** para probar todo sin cuenta de Meta.

## Inicio rápido

### Con Docker (producción)

```bash
git clone <este-repo> leadlibre && cd leadlibre
cp .env.example .env              # define PUBLIC_URL, DOMAIN y POSTGRES_PASSWORD
docker compose --profile https up -d --build
```

Abre `https://TU_DOMINIO`, crea la primera cuenta (será la administradora de la
instancia) y conecta tu número en **Ajustes → Canales de WhatsApp**. Guía completa:
[`docs/04-despliegue.md`](docs/04-despliegue.md).

### Sin Docker / para probar en tu computadora

Requiere Node.js 20.12 o superior. No necesitas PostgreSQL: sin `DATABASE_URL` usa una
base PostgreSQL embebida.

```bash
npm ci
npm run build
npm start                         # http://localhost:3000
```

Prueba en 2 minutos sin Meta: regístrate → **Ajustes → Canales → Crear canal de pruebas
(sandbox)** → "Simular un cliente que escribe" → responde desde la **Bandeja**.

## Conectar WhatsApp (API oficial)

Necesitas una app de Meta con WhatsApp, el *Phone Number ID*, el *WABA ID*, un token
permanente de usuario del sistema y la *App Secret*. Paso a paso, con la ruta de cada
menú de Meta: [`docs/03-conectar-whatsapp-meta.md`](docs/03-conectar-whatsapp-meta.md).

## Créditos y costos

Meta cobra por plantilla entregada según categoría y país. LeadLibre estima antes de
enviar y concilia con lo que Meta reporta. Detalles, modos `meta_direct`/`prepaid` y
tarifas: [`docs/05-creditos-y-costos.md`](docs/05-creditos-y-costos.md).

## Para operadores de una comunidad

- `ALLOW_SIGNUP=true` permite que cada miembro cree su espacio de trabajo.
- Cada negocio suma a su equipo con **enlaces de invitación** (Ajustes → Equipo): sirven
  aunque `ALLOW_SIGNUP=false` y nadie puede agregar la cuenta de otra persona ni ponerle
  contraseña.
- Corre **una sola réplica** del contenedor `app` (el tiempo real vive en memoria); ver
  [`docs/04-despliegue.md`](docs/04-despliegue.md).
- Cada espacio conecta su propio número y paga a Meta con su tarjeta (`meta_direct`), o
  el operador recarga saldo (`prepaid`) desde **Administración**.
- El operador mantiene actualizadas las tarifas de Meta (cambian cada trimestre).

## Documentación

| Documento | Contenido |
|---|---|
| [01 · Análisis de Leadsales](docs/01-analisis-leadsales.md) | Ingeniería inversa: funciones, planes, créditos, arquitectura |
| [02 · Arquitectura](docs/02-arquitectura.md) | Diseño técnico, modelo de datos, flujos |
| [03 · Conectar WhatsApp](docs/03-conectar-whatsapp-meta.md) | Configuración en Meta paso a paso |
| [04 · Despliegue](docs/04-despliegue.md) | Docker, VPS, respaldos, desarrollo, seguridad |
| [05 · Créditos y costos](docs/05-creditos-y-costos.md) | Cómo cobra Meta y cómo lo concilia LeadLibre |
| [06 · API y webhooks](docs/06-api.md) | API pública, webhooks salientes, recetas |

## Tecnología

Node.js + TypeScript (Fastify, Socket.IO, Zod), PostgreSQL o PGlite, React + Vite +
Tailwind, WhatsApp Business Cloud API (Graph API), Claude API para el agente IA.
Un solo proceso y un solo puerto; la cola de trabajos vive en PostgreSQL (sin Redis).

```bash
npm run dev         # API (:3000) + interfaz con recarga en caliente (:5173)
npm test            # pruebas del servidor (integración) y de la interfaz
npm run typecheck
```

## Hoja de ruta

- Alta de números con *Embedded Signup* (para comunidades con app Tech Provider).
- Canales de Instagram y Messenger.
- Conector nativo de Facebook Lead Ads (hoy: vía API/Make/Zapier).
- Recargas de créditos con pasarela de pago (Stripe / Mercado Pago) en modo prepagado.
- Flujos de automatización visuales y recordatorios de seguimiento.

## Licencia

[AGPL-3.0-or-later](LICENSE). Puedes usarlo, modificarlo y ofrecerlo a tu comunidad; si
lo ofreces como servicio, debes compartir tus cambios con tus usuarios. Así LeadLibre
sigue siendo libre para todos.
