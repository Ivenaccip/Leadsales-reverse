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
- **Fallos**: si Meta rechaza o no entrega el mensaje, se reembolsa.
- Todo queda en **Créditos → Movimientos** (libro contable por espacio).

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

## Estimar una campaña

En **Difusiones → Nueva**, el paso de audiencia muestra destinatarios, desglose por país
y costo total antes de enviar. Los contactos que respondieron **BAJA/STOP** se excluyen.

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
