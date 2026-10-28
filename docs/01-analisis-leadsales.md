# Análisis e ingeniería inversa de Leadsales

> Objetivo: entender qué vende Leadsales, cómo funciona por dentro (lo que se puede
> inferir desde fuera) y qué hay que construir para ofrecer lo mismo a la comunidad
> **sin mensualidad**: cada negocio solo paga sus créditos de WhatsApp (Meta).
>
> Fuentes: sitio y blog de Leadsales, comparativas de terceros y documentación pública
> de la WhatsApp Business Platform (Cloud API). Las cifras de precios cambian seguido;
> se citan como referencia de octubre 2026.

## 1. Qué es Leadsales

Leadsales es un **CRM conversacional** para LATAM: centraliza las conversaciones de
WhatsApp (y Messenger/Instagram) en una bandeja compartida y las organiza como
*leads* dentro de **embudos de venta** tipo Kanban. El valor está en que un equipo de
ventas atiende desde **un mismo número** y nadie pierde el seguimiento.

### 1.1 Planes y cómo cobran

| Plan | Conexión | Precio aprox. | Usuarios | Embudos | Créditos |
|---|---|---|---|---|---|
| Básico | WhatsApp por **QR** (WhatsApp Web no oficial) | ~$97 USD/mes (~$2,363 MXN) | 3 | limitado | 0 (sin campañas) |
| Profesional | **WAPI** = WhatsApp Business API oficial (Meta) | ~$133 USD/mes (~$3,240 MXN) | 4 | 10 | 250/mes (ampliable a 1,250 / 3,250 / 5,250 / 10,250) |
| Avanzado | WAPI | ~$247 USD/mes (~$6,017 MXN) | 5 | ilimitados | 500/mes |

Descuentos de 10 % (trimestral), 15 % (semestral) y 20 % (anual). Usuarios extra se cobran aparte.

**Créditos**: Leadsales vende paquetes de créditos que se consumen al enviar
*plantillas* (mensajes que inician conversación fuera de la ventana de 24 h:
campañas, recordatorios, seguimientos). Por debajo, **Meta cobra por cada plantilla
entregada** según la categoría (marketing, utilidad, autenticación) y el país del
destinatario; Leadsales revende ese costo con margen y además cobra la mensualidad.

➡️ **Oportunidad para la comunidad:** la mensualidad paga software, no mensajes. Si el
software es libre y autohospedado (o lo hospeda la comunidad), cada negocio conecta
**su propio número de WhatsApp API** y le paga **directamente a Meta** solo lo que
consume. Eso es exactamente LeadLibre.

### 1.2 Inventario de funciones (lo que hay que igualar)

| Área | Leadsales | Notas de ingeniería inversa |
|---|---|---|
| Bandeja compartida | Todos los agentes atienden el mismo número; filtros "míos / sin asignar / todos" | Una conversación = un lead. Tiempo real vía websockets. |
| Embudos y etapas | Embudos ilimitados (según plan), etapas con nombre libre, tablero Kanban con arrastrar y soltar | El lead pertenece a un embudo + etapa. Se registran eventos de cambio de etapa para reportes. |
| Etiquetas | Clasificación por colores; filtros | Relación muchos-a-muchos lead↔etiqueta. |
| Acciones masivas | Filtrar por etiquetas, fechas, embudo, etapa, estatus y aplicar: mover de embudo, etiquetar, asignar | Endpoint de operaciones en lote. |
| Respuestas rápidas | Atajos con texto y adjuntos | Disparadas con "/" en el compositor. |
| Asignación automática | Reparte leads nuevos de forma equitativa entre usuarios activos del embudo; solo Owner/Admin la activan | Round-robin por "último asignado". |
| Notas internas | Notas en el chat no visibles para el cliente | Se guardan como mensajes internos. |
| Mensajes programados | Programar un mensaje a un lead para fecha/hora | Cola de trabajos con `run_at`. Fuera de 24 h requiere plantilla. |
| Plantillas | Gestión de plantillas aprobadas por Meta | Sincronizar/crear con Graph API (`/{waba-id}/message_templates`). |
| Difusiones / campañas | Envío masivo segmentado con plantillas (solo API oficial) | Cola con *throttling*, métricas enviado/entregado/leído/fallido, consumo de créditos. |
| Leadbot | Menú numérico (hasta 3 niveles), cada opción responde, adjunta y mueve de etapa | Máquina de estados por contacto. |
| Lead Agent (IA) | Agente que entiende lenguaje natural, califica y mueve en el embudo, pasa a humano | LLM con herramientas (mover etapa, etiquetar, pasar a humano). Solo un bot activo por espacio. |
| Horario / ausencia | Mensaje de bienvenida y fuera de horario | Configuración por espacio de trabajo. |
| Roles | Owner, Admin, Usuario | Permisos por rol. |
| Reportes | Rendimiento de equipo, leads por etapa | Agregaciones sobre mensajes y eventos. |
| Integraciones | WhatsApp QR, Cloud API, *Coexistence*, Facebook Lead Ads, Messenger, Instagram | Lead Ads normalmente vía Make/Zapier → API pública. |
| Exportar/Importar | CSV | — |

### 1.3 Arquitectura inferida

1. **Conexión a WhatsApp**: dos caminos.
   - *QR* (no oficial): emula WhatsApp Web (tipo Baileys). Barato pero con riesgo de
     bloqueo y sin plantillas/difusiones legales.
   - *WAPI* (oficial): Cloud API de Meta. Webhook único que recibe `messages` y
     `statuses`; envíos por `POST /{phone-number-id}/messages`.
2. **Backend multi-tenant**: espacios de trabajo, usuarios con roles, cola de trabajos
   para campañas y programados, websockets para la bandeja.
3. **Facturación**: suscripción mensual + monedero de créditos descontado al enviar
   plantillas.
4. **IA**: Lead Agent sobre un LLM con instrucciones del negocio.

### 1.4 Puntos débiles detectados (que corregimos)

- Mensualidad alta aunque el negocio envíe pocos mensajes.
- Créditos con margen y sin transparencia del costo real de Meta.
- Límites artificiales de usuarios y embudos por plan.
- Reportes de inestabilidad en sincronización de mensajes en algunos casos.

## 2. Cómo lo resolvemos en LeadLibre

| Decisión | Por qué |
|---|---|
| **Solo API oficial (Cloud API de Meta)** | Sin riesgo de bloqueo por QR, permite plantillas y campañas, y Meta factura directo al negocio. |
| **Cada espacio conecta su propio número** (Phone Number ID + token) | El negocio paga a Meta con su tarjeta; LeadLibre no intermedia dinero. |
| **Libro de créditos con reconciliación real** | Al enviar se estima el costo (categoría × país); cuando Meta manda el webhook de estado con `pricing.billable` se ajusta al costo real. |
| **Dos modos de créditos** | `meta_direct` (por defecto: solo mide gasto, Meta cobra directo) y `prepaid` (el operador de la comunidad recarga saldo y se bloquean envíos sin saldo). |
| **Sin límites de usuarios/embudos** | Es software libre. |
| **Proveedor *sandbox*** | Probar todo el flujo sin Meta (simular mensajes entrantes). |
| **IA opcional con llave propia** | Lead Agent usa la API de Claude con la llave del negocio: también "solo pagas tus créditos". |
| **Autohospedable con Docker o multi-tenant** | La comunidad decide: cada miembro instala el suyo o se ofrece una instancia compartida. |

### 2.1 Tabla de equivalencias

| Leadsales | LeadLibre |
|---|---|
| Plan WAPI | Canal `cloud_api` (gratis; pagas a Meta) |
| Créditos | Libro de créditos (`credit_ledger`) con tarifas editables por país/categoría |
| Bandeja | `/bandeja` (tiempo real con Socket.IO) |
| Embudos | `/embudos` (Kanban con arrastrar y soltar) |
| Leadbot | Bot de menú (hasta 3 niveles, acciones por opción) |
| Lead Agent | Agente IA (Claude) con herramientas de CRM |
| Difusiones | `/difusiones` con estimación de costo y *throttling* |
| Integraciones | API pública con llaves + webhooks salientes |

Ver `docs/02-arquitectura.md` para el diseño técnico.
