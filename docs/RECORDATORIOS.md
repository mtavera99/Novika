# Recordatorios

El bot escribiéndole **primero** a quien se quedó callado.

Lo autorizó Marco el 2026-10-10: *«deja por lo menos uno […] como tú dijiste a
los 30 minutos, y quizás otro a las dos o tres horas»*.

> ⚠️ **Está APAGADO por defecto.** Se enciende con `RECORDATORIOS=1` en
> Render. Es la única función del bot que manda mensajes que nadie pidió, a
> números de clientes reales, con una campaña encendida.

---

## Por qué existe

Hasta ahora el bot solo hablaba si el cliente escribía primero. Si alguien
preguntaba el precio y desaparecía, nadie volvía a decirle nada. Nunca.

Y eso era, con diferencia, lo que más plata dejaba en la mesa: **de los 25
chats del panel, diez no recibieron un segundo mensaje.** Preguntaron algo, no
contestaron, y ahí quedaron.

## Los tiempos, y por qué estos

| toque | silencio | qué dice |
|---|---|---|
| 1 | **30 min** | retoma donde se quedó y pide **una** sola cosa |
| 2 | **3 h** | añade el argumento: paga al recibir + prueba de 7 días |

La guía habitual para carritos abandonados pone el primer toque entre 60 y
180 minutos, y luego a las 24 h y 48-72 h ([Wati](https://www.wati.io/en/blog/whatsapp-abandoned-cart-messages/),
[Maestra](https://maestra.io/blog/q-and-a/whatsapp-marketing-playbook-dtc)).
Los tiempos de Marco son más agresivos en el primer toque, y **aciertan en lo
que de verdad manda aquí**:

> **La ventana de 24 horas de WhatsApp.** Meta solo entrega texto libre
> durante las 24 h siguientes al último mensaje **del cliente**; la ventana es
> rodante y se reabre cada vez que el cliente escribe. Fuera de ella solo
> entran **plantillas aprobadas**
> ([Twilio](https://www.twilio.com/docs/whatsapp/key-concepts), [error 131047](https://helo.ai/resources/blog/whatsapp-api-error-131047)).

Los dos toques caben dentro de la ventana, así que **no necesitan trámite**.
Los toques clásicos de 24 h y 72 h son justo los que exigen la plantilla que
Marco va a tramitar; cuando exista, se añade el toque largo.

*Contenido de las fuentes reformulado para cumplir con sus restricciones de
licencia.*

## Qué le dice

Tres reglas, y las tres salieron de los chats del panel:

1. **Se retoma donde se quedó, no se saluda otra vez.** «¡Hola! ¿En qué te
   puedo ayudar?» a quien ya tuvo media conversación es volver a empezar, y es
   lo que más delata a un bot.
2. **Una sola cosa que hacer.** Si falta la dirección, se pide la dirección.
   Un recordatorio con tres preguntas no se contesta: tiene que ser *más*
   fácil de responder que la pedida original, no igual de difícil.
3. **El segundo toque añade el argumento, no la presión.** No «¿sigues ahí?»
   otra vez, sino lo que quita el miedo: que paga al recibir y que lo prueba
   7 días. Los dos datos salen del catálogo.

Ejemplos reales que produce hoy:

```
Falta la dirección
  30 min · Hola, Ana 😊 ¿Seguimos con tu pedido? Me falta tu dirección y te
           lo dejo listo 🙌
  3 h    · Hola, Ana 😊 Te dejo el pedido apartado por si lo quieres. Pagas
           cuando te llegue, no por adelantado. Y lo pruebas 7 días: si no te
           sirve, te devolvemos tu dinero. ¿Me pasas tu dirección?

Ya vio el resumen y falta el «sí»
  30 min · Hola, Alejandro 😊 Te dejé el resumen de tu pedido aquí arriba 👆
           ¿Te lo confirmo?
  3 h    · Hola, Alejandro 😊 ¿Seguimos con tu pedido? Con un "sí" lo dejo
           listo. Recuerda que pagas cuando te llegue, no por adelantado.

Solo preguntó y se fue
  30 min · ¿Te quedó alguna duda del cinturón? Aquí estoy 🙌
  3 h    · Te cuento por si te animas: pagas cuando te llegue, no por
           adelantado, y lo pruebas 7 días: si no te sirve, te devolvemos tu
           dinero. ¿Para qué ciudad sería?
```

**Y nunca inventa una urgencia.** «Quedan pocas unidades» o «la oferta vence
hoy» convierten mucho en el corto plazo y no se pueden sostener: no hay
inventario en el catálogo que lo respalde, y una urgencia falsa repetida
convierte el número en spam. Hay una prueba que lo vigila.

---

## Cuándo NO escribe

Esto es el producto. Un recordatorio mal decidido no es un texto feo: es spam
desde el número de la empresa, y **un reporte de spam cuesta la calidad del
número, que vale más que cualquier venta suelta.**

| no escribe si… | por qué |
|---|---|
| el interruptor está apagado | y lo está por defecto |
| **el último mensaje es del cliente** | el bot le debe una **respuesta**, no un recordatorio. Pasa de verdad con el chat pausado |
| ya tiene un pedido | pedirle que compre a quien acaba de comprar destruye la confianza |
| está en manos de una persona | incluye escalado: si el bot dijo «te paso con una persona», callar es parte de la promesa |
| el chat está pausado | comprobado **tres veces**: al decidir, antes de enviar, y en el emisor |
| **dijo que no** | insistirle no es vender |
| pasaron más de 24 h | Meta no lo entregaría; no se gasta la llamada |
| ya recibió sus dos toques | |
| es antes de las 8 o después de las 21 **en Bogotá** | |
| el bot nunca le dijo nada | no hay conversación que retomar |

**La serie se reinicia si el cliente vuelve a escribir.** Cada silencio nuevo
es una oportunidad nueva: dos toques por silencio, no dos por cliente de por
vida.

---

## Cómo está hecho

| pieza | qué hace |
|---|---|
| `src/dominio/recordatorios.js` | **puro**: decide si toca y cuál. Todas las guardas de arriba |
| `src/cerebro/recordar.js` | el barrido y los textos: recorre, envía, apunta |
| `src/server.js` | arranca el barrido tras `listen` |
| `test/recordatorios.test.js` | 26 pruebas, la mayoría de «cuándo **no**» |

### Por qué un barrido y no un temporizador por cliente

Lo obvio sería `setTimeout(30 min)` al terminar cada turno. **Y se pierde en
el primer despliegue:** Render manda `SIGTERM`, el proceso muere y con él
todos los temporizadores en memoria. Con el disco persistente activado no hay
despliegues sin interrupción, así que esto pasa en **cada** deploy.

El barrido no tiene ese problema porque **no recuerda nada**: cada pasada
recalcula desde lo guardado —cuándo escribió el cliente, cuántos
recordatorios lleva— así que un reinicio no pierde nada, solo retrasa la
pasada siguiente. Es el mismo razonamiento por el que `trabajo.jsonl` existe
para los eventos entrantes.

Pasa cada 5 minutos y mira hasta 500 conversaciones. No se solapa consigo
mismo: dos pasadas a la vez mandarían el mismo recordatorio dos veces.

### Dos decisiones que parecen detalles y no lo son

**1. Se apunta DESPUÉS de enviar, nunca antes.** Si se apuntara antes, un
interruptor apagado dejaría al cliente sin recordatorio **para siempre**,
porque el bot creería que ya se lo mandó. Es la misma lección del modo sombra.

**2. La marca de «cuándo escribió el cliente» va en su propio campo**
(`ultimoDelClienteEn`), no se saca del historial. `atencion` recorta el
historial a los últimos 60 mensajes: en un chat largo donde los últimos
sesenta son del bot y del operador, **el mensaje del cliente se cae de la
lista**. Buscarlo ahí devolvería «no se sabe» justo en los chats más
trabajados, que son los que más cerca están de cerrar.

### Permiso de envío

Usa `PERMISOS.CONVERSACION`, **no** `ATENCION_MANUAL`. Es el bot hablando, así
que tiene que obedecer `RESPUESTA_AUTOMATICA` y el candado de la pausa.
`ATENCION_MANUAL` se salta los dos: usarlo aquí sería colarse por la puerta
del operador.

---

## Encenderlo

En Render → Environment:

```
RECORDATORIOS=1
```

Y opcionalmente `RECORDATORIO_MINUTOS`, `RECORDATORIOS_DESDE_HORA`,
`RECORDATORIOS_HASTA_HORA`. Se ve en `/health` (`recordatorios`,
`recordatorio_minutos`) y se mide en `/metricas`
(`recordatorio_enviado`, `recordatorio_no_enviado`).

Cada recordatorio queda en el historial del chat marcado como
`recordatorio_1` / `recordatorio_2`, así que **en el panel se distingue de una
respuesta**, y en el diario con el silencio que lo disparó.

## Lo que falta

- **El toque largo (24 h o más)**, que necesita la plantilla aprobada por
  Meta. Marco dijo que la va a tramitar.
- **Medir si convierten.** Hoy se cuenta cuántos salen, no cuántos acaban en
  pedido. Para saber si valen la pena hay que cruzar `recordatorio_enviado`
  del diario con los pedidos posteriores.
