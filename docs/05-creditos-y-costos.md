# Créditos y costos: "sin mensualidad, solo tus créditos"

## Qué cobra Meta

Desde julio de 2025 Meta cobra **por mensaje de plantilla entregado** (modelo PMP,
*per-message pricing*). El precio depende de:

1. **Categoría de la plantilla**: Marketing (la más cara), Utilidad, Autenticación.
2. **País del destinatario** (por su lada).

Las respuestas libres dentro de la **ventana de 24 h** (después de que el cliente te
escribe) son mensajes de *servicio*: tienen un nivel gratuito mensual por número y,
fuera de él, se cobran a tarifa de utilidad. Meta indica en cada webhook de estado si
el mensaje fue cobrable (`pricing.billable`) y su categoría.

## Cómo lo maneja LeadLibre

```
Envío ──► estimado = tarifa(país, categoría) ──► cargo en el libro de créditos
                                                  │
Webhook de estado de Meta (pricing.billable, category)
                                                  ▼
                       ajuste automático: reembolso o cargo de la diferencia
Mensaje fallido ─────────────────────────────────► reembolso completo
```

- **Estimación al enviar**: plantillas → tarifa del país y la categoría; texto libre → 0.
- **Conciliación**: con el primer webhook que trae `pricing`, LeadLibre ajusta el cargo
  al costo real (por ejemplo, una plantilla de utilidad enviada dentro de la ventana de
  servicio es gratis → se reembolsa). Se procesa una sola vez por mensaje.
- **Fallos**: si Meta rechaza o no entrega el mensaje, se reembolsa. Meta solo cobra lo
  entregado: un mensaje que ya se había conciliado como cobrable al pasar a "enviado" y
  después falla sin entregarse también recupera su cargo.
- **Sin conexión con Meta**: si la conexión falla antes de llegar a Meta (DNS, conexión
  rechazada, certificado), nada salió: el mensaje queda fallido (`error.network`) y se
  reembolsa. Las difusiones y los programados lo reintentan solos, sobre el mismo mensaje
  y con espera creciente (de 30 s a 8 min); también reintentan los envíos que Meta frena
  por velocidad. Una difusión se pausa si la conexión no vuelve en unos 15 minutos, sin
  dar por fallido a nadie (la reanudas cuando todo funcione), y un programado se da por
  fallido tras 5 reintentos. Un mensaje que espera su reintento lo dice en la bandeja
  (`error.auto_retry`): no lo reenvíes a mano o llegaría duplicado. Los envíos de la
  bandeja, la API, el bot y la IA no se reintentan solos.
- **Sin confirmar**: si la respuesta de Meta a un envío se pierde (falla de red, tiempo
  agotado o error 5xx de Meta), el mensaje queda "Sin confirmar" (`unknown`). Meta pudo
  haberlo entregado y cobrado, así que el cargo se conserva y LeadLibre no lo reenvía
  solo. Todo envío, no solo las plantillas, lleva el id del mensaje en
  `biz_opaque_callback_data`: cuando llegan los webhooks de estado de Meta, se concilia o
  se reembolsa como cualquier otro. Meta reintenta sus webhooks hasta 7 días: un mensaje
  que a los 7 días sigue sin confirmar (o `pending`, porque el servidor se cayó a medio
  envío) sin ningún estado de Meta nunca llegó, así que pasa a fallido y se reembolsa.
- **Borrar contactos**: un contacto con un mensaje cobrado del saldo prepagado que Meta
  todavía puede reembolsar o ajustar (hasta 30 días después del envío) no se borra: el
  ajuste necesita el mensaje. Borrarlo responde `409 CONTACT_BILLING_PENDING`, y el borrado
  masivo lo archiva en su lugar (responde cuántos se archivaron); podrás borrarlo cuando
  Meta confirme sus mensajes.
- **Cada cargo recuerda su modo**: los reembolsos y ajustes de un mensaje van a donde fue
  su cargo (el saldo prepagado o el gasto medido de `meta_direct`), según el modo del
  espacio al enviarlo. Cambiar de modo con mensajes en camino no crea ni pierde créditos.
  Los reembolsos y ajustes de un mensaje cobrado del saldo prepagado solo los aceptan
  estados firmados con una clave que el negocio no conoce (la `META_APP_SECRET` global o
  la *App Secret* de un número que verificó el operador): si el espacio vuelve a
  `meta_direct` y el negocio pone su propia clave en el número, sus estados actualizan las
  palomitas pero ya no mueven el saldo prepagado.
- Todo queda en **Créditos → Movimientos** (libro contable por espacio). El gasto "de
  este mes" es el mes calendario en la zona horaria del espacio.

## Dos modos (por espacio de trabajo)

| Modo | Quién paga a Meta | Qué hace LeadLibre | Ideal para |
|---|---|---|---|
| `meta_direct` (predeterminado) | Cada negocio, con **su tarjeta** en WhatsApp Manager | Mide el gasto estimado/real; nunca bloquea envíos | Comunidades donde cada miembro conecta su número |
| `prepaid` | El operador de la comunidad (o el negocio le paga al operador) | Mantiene un **saldo**; bloquea plantillas y pausa difusiones si no alcanza | Operadores que revenden créditos o quieren topes de gasto |

El administrador de la instancia cambia el modo y recarga saldo en **Administración**.
Para nuevos espacios, el modo por defecto se define con `BILLING_MODE` y los créditos de
regalo con `SIGNUP_CREDITS`.

## Tarifas de referencia

La instancia trae tarifas de referencia (USD por mensaje, octubre 2026) para México,
Colombia, Brasil, Argentina, Chile, Perú, España, EE. UU./Canadá, resto de
Latinoamérica y resto del mundo. **Meta las actualiza cada trimestre**: el
administrador debe revisarlas en la tabla oficial de precios de la WhatsApp Business
Platform y editarlas en **Administración → Tarifas de Meta**. La conciliación con el
webhook corrige la categoría y si fue cobrable, pero el monto sale de esta tabla.

El mercado sale de la lada del contacto. La lada +1 no es solo Norteamérica: EE. UU. y
Canadá usan la tarifa de EE. UU./Canadá; República Dominicana, Puerto Rico y Jamaica, la
de resto de Latinoamérica; y el resto del Caribe y territorios con +1 (Bahamas, Trinidad
y Tobago, Barbados…), la de resto del mundo.

## Estimar una campaña

En **Difusiones → Nueva**, el paso de audiencia muestra destinatarios, desglose por país
y costo total antes de enviar. Los contactos que respondieron **BAJA/STOP** (o que tu
equipo marcó como baja) se excluyen. La baja solo los saca de las difusiones: si después
te escriben, el bot y la IA les responden como a cualquiera; el mensaje de baja en sí no
recibe respuesta automática.

## Comparación con Leadsales

| | Leadsales (Plan WAPI) | LeadLibre |
|---|---|---|
| Mensualidad | ~$133–247 USD/mes | $0 |
| Créditos | Paquetes con margen (250–10,250) | Costo de Meta, transparente y conciliado |
| Usuarios / embudos | Limitados por plan | Ilimitados |
| Tus datos | En su nube | En tu servidor |

## IA

El agente IA usa **tu propia llave de Claude (Anthropic)**: también pagas solo tus
créditos de uso en console.anthropic.com. Por defecto usa `claude-opus-5-5` con esfuerzo
bajo (respuestas rápidas y económicas) y caché del prompt; puedes elegir Sonnet o Haiku
para reducir costo.

Para acotar el gasto y el tiempo, cada respuesta del agente tiene un tope de unos 1024
tokens (si se corta, termina en la última oración completa) y sale en mensajes de hasta
4096 caracteres, el máximo de WhatsApp. Cada petición a Claude se corta a los 60 s y
cada respuesta completa (con reintentos y herramientas) a los 4 minutos. El agente
responde a contactos que se dieron de baja de las difusiones, pero no al mensaje de baja.
