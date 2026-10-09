# Auditoría del 2026-10-09 · 33 chats, 0 pedidos

Marco pidió una revisión chat por chat del panel de producción, con una queja
concreta:

> «a veces no sabe qué decir, o me tira a contacto humano con cualquier
> pregunta — y la idea de un bot es que pueda vender»

Tenía razón, y el problema no era de tono. Este documento es lo que se
encontró, con los mensajes reales, y lo que quedó arreglado.

---

## El dato de partida

De `/panel/indicadores` y `/panel/auditoria`, el 2026-10-08:

| | |
|---|---|
| Conversaciones | **33** |
| Pedidos | **0** |
| Cierre | **0 %** |
| Rescatados a mano por un operador | **3** |
| Clientes inalcanzables (sin teléfono) | **6 de 25** |

Con una campaña de Facebook encendida pagando cada uno de esos chats.

**Y una pista falsa.** El embudo decía que los 33 se caían en la primera
etapa, «Identificó producto: 0». Era mentira: 25 de esos chats estaban en
estado `producto_identificado`. El embudo comparaba contra cuatro nombres de
estado que **no existen** (`"producto"`, `"datos"`, `"resumen"`,
`"modificado"`), así que todo el mundo caía a la primera etapa. El indicador
que existe para decir *dónde* se escapan los clientes apuntaba al sitio
equivocado — y la prueba que lo cubría usaba los mismos nombres inventados,
así que pasaba.

Corregido, con la mezcla real de estados, el embudo dice lo que pasaba de
verdad: **18 de 25 se quedan justo después de ver el producto.**

---

## La causa raíz: un `\b` mal puesto

`src/dominio/confirmacion.js` tenía esto en la lista de negaciones:

```js
/^no\b/,
```

`\b` cierra en el espacio, así que casaba con **cualquier mensaje que
empezara por «no»**. En un WhatsApp colombiano eso es media bandeja:

| El cliente escribió | El bot entendió |
|---|---|
| «No habría manera de que llegue hoy?» | cancelación |
| «No entiendo» | cancelación |
| «No cargaron» | cancelación |
| «no me alcanza» | cancelación |
| «no confío en estas páginas» | cancelación |
| «no me ha llegado» | cancelación |

Clasificado como negación → acción `CANCELAR` → no había pedido que cancelar
→ `situacion = "escalado"` → **el bot se pausaba 12 horas**.

El cliente recibía *«esto lo reviso con una persona del equipo»* y después
silencio. Esto explica, solo, las tres conversaciones que tuvo que rescatar
una persona a mano.

Y **no se veía en ningún sitio**: los cuatro contadores que miden la pausa y
el silencio no estaban en el vocabulario de métricas, así que sumaban todos en
`"desconocido"`. Un bot que deja de responder no da error, no rompe nada y no
aparece en los logs. Desde fuera parece un día flojo de ventas.

---

## Las tres conversaciones que se perdieron

Se replican con `node herramientas/revivir.js`. **Las tres acaban ahora en
pedido.**

### Mauricio · San Andrés de Sotavento (Córdoba)

```
cliente · Me interesa
cliente · San andres de sotavento Córdoba
cliente · Uno
cliente · Barrio buenos aires
bot     · Para preparar tu pedido me pasas la dirección 🙌
cliente · No entiendo
bot     · Esto lo reviso con una persona del equipo…      ← y silencio 12 h
cliente · Interapidisimo
bot     · (no enviado: conversacion_pausada)
          ─ 13:13, una persona escribe a mano para rescatarlo ─
```

Dos defectos a la vez, y el segundo era peor que perder la venta:

1. **«Barrio buenos aires» se rechazaba como dirección.** Había dos candados
   en serie exigiendo un número, mientras el propio bot le pedía *«dime el
   barrio y, si tienes, la calle con el número, o un punto de referencia»*.
   Pedía el barrio y no lo aceptaba. En un pueblo o una vereda no hay
   nomenclatura: la dirección **es** el barrio más una referencia.

2. **La ciudad quedó como «San Andres»** — el archipiélago, a 700 km de
   Córdoba y con flete aéreo. `\bsan andres\b` casa dentro de «san andres de
   sotavento». Iba a despachar al departamento equivocado.

### Andrés · Popayán, con prisa

```
cliente · Estoy en Popayán
cliente · No habría manera de que llegue hoy?
bot     · Esto lo reviso con una persona del equipo…      ← y silencio 12 h
cliente · Por favor
bot     · (no enviado: conversacion_pausada)
```

El cliente más caliente del día: quien pregunta si llega hoy tiene el cólico
hoy. La respuesta honesta estaba aprobada en la ficha desde el 07-oct —
«1 a 3 días hábiles según tu ciudad» — y el bot se calló.

### La clienta de Bogotá que pidió ayuda para comprar

```
cliente · Con cables para cargar
bot     · Sí, es justo para eso: el calor… alivia el cólico     ← otra cosa
cliente · Trae cargador
bot     · ¿Cuántos quieres? Y para preparar tu pedido…          ← otra cosa
cliente · Algo contra entrega
bot     · el precio no te lo quiero decir a medias…             ← lo sabía
cliente · Que costó tiene
bot     · Esa no te la quiero contestar a medias…               ← lo sabía
cliente · Solo 1
bot     · ¡Perfecto, gracias! 🙌                                 ← y se murió
cliente · Ayuda con pedido
```

Tuvo que pedir ella que la ayudaran a comprar. La mayoría de estos ya estaban
arreglados en el código actual; lo que quedaba era el cargador.

---

## Lo que sí tenía que escalar, y no escalaba

Medido con el código que estaba en producción:

| El cliente escribió | El bot contestó |
|---|---|
| «quiero hablar con una persona» | «¡Perfecto, gracias! Para preparar tu pedido me pasas la ciudad…» |
| «me llegó dañado, quiero la garantía» | «¡Claro que sí! Tiene 1 mes de garantía, **así que compras con tranquilidad**. ¡Perfecto! Para preparar tu pedido me pasas…» |
| «esto es un robo, son unos estafadores, los voy a denunciar» | «¡Perfecto, gracias! Para preparar tu pedido me pasas…» |

Le vendía la garantía como argumento comercial a quien la estaba
**reclamando**, y le pedía los datos de entrega otra vez a quien ya había
recibido el pedido. Ninguno de los tres existía como señal en el código.

Estaba exactamente al revés de lo que pidió Marco: escalaba por una duda sobre
el material y no escalaba por un reclamo.

---

## El muro de «no te lo quiero decir a medias»

Se corrieron **65 preguntas** copiadas del panel (`node herramientas/sondear.js`).
**22 recibían la misma frase:**

> «Esa no te la quiero contestar a medias. La dejo anotada para el equipo: una
> persona la revisa y te responde por aquí.»

El hallazgo importante: **no faltaba el dato, faltaba el tema.** La frase se
disparaba por no reconocer la pregunta, no por no tener la respuesta. Preguntas
cuya respuesta estaba en la ficha acababan en un callejón.

Ejemplos, con de dónde sale ahora la respuesta:

| Pregunta | De dónde sale la respuesta |
|---|---|
| «¿se puede lavar?» | `garantiaNoCubre` incluye «mojarlo» |
| «¿llega a una vereda?» | `politicaEnvio` = incluido, sin acotar destinos |
| «¿en qué ciudad están?» | tienda en línea, envíos a todo el país, pago al recibir |
| «¿es original?» | marca propia + garantía + contraentrega |
| «¿viene en caja?» | `caracteristicasAutorizadas`: «se entrega con su empaque» |
| «¿sirve para una niña de 13?» | `ajuste.graduable` (sin prometer contorno) |
| «¿y si no me funciona?» | contraentrega primero, garantía después |
| «¿sirve si estoy embarazada?» | **se deriva al médico**, y no se insinúa que sí |

**Ninguna respuesta nueva afirma nada que no estuviera ya aprobado.** Se
miraron fichas de otros vendedores del mismo producto para entender *qué
pregunta la gente*; nada de lo que dicen (3 niveles de calor, infrarrojos,
calienta en 3 segundos, batería recargable) entró en el bot. Hay una prueba
que recorre **todas** las respuestas y comprueba que ninguna viola
`claimsProhibidos`.

---

## Tres enrutamientos que contestaban otra cosa

- **`carga\w*` casaba «cargaron».** Del chat de Marco: el bot le habló de la
  batería a quien le decía que las fotos no le habían cargado. Y escaló.
- **`demora` mandaba «¿cuánto demora en calentar?»** al plazo de la
  transportadora.
- **`viene en \w+` leía «¿viene en caja?»** como una pregunta de color.

---

## La escalera de precio no era una escalera

Cuatro objeciones seguidas recibían **el mismo párrafo, palabra por palabra**.
Y a «no me alcanza» le contestaba *«si llevas dos, te quedan en $85.000»*: a
quien acaba de decir que no le alcanza se le ofrecía gastar más.

La causa: la guarda que evita repetir las condiciones estaba siempre activa,
porque **todos los clientes entran por el anuncio** y el primer mensaje del bot
ya dice «con envío incluido y pagas al recibir». Así que la escalera empezaba
directamente por el tercer escalón.

Ahora hay un contador persistido: condiciones → la pareja → una persona.
**Sigue sin ofrecer ningún descuento**, y es a propósito: no hay política
aprobada.

---

## Lo que queda, y no es código

### 🔴 El dato que más se pregunta y no tenemos: cómo se enciende

De las 5 preguntas que siguen sin respuesta en el sondeo, **3 son de
energía**: «¿trae cargador?», «¿con cables para cargar?», «¿es recargable o de
pilas?». Y es lo primero que se piensa de un aparato que calienta.

Está en el punto 4 de [`DATOS-PENDIENTES.md`](DATOS-PENDIENTES.md). Hoy el bot
contesta con honestidad y sigue vendiendo, pero cada una de esas deja una tarea
en la bandeja.

### 🔴 6 de 25 clientes no se pueden contestar

Seis chats son clientes con **nombre de usuario de WhatsApp** en vez de
teléfono (identificador `CO.…`). El bot prepara la respuesta y Meta la rechaza;
los mensajes del operador también fallan. Es **un 24 % del tráfico del anuncio
tirado a la basura**, y no es un defecto de NOVIKA.

Detalle y qué hay que comprobar en
[`PENDIENTES-TECNICOS.md`](PENDIENTES-TECNICOS.md).

### 🟡 La tasa de rechazo sigue sin poder medirse

Falta un estado `devuelto`. Es el número que separa un canal rentable de uno
que no lo es, y hoy un paquete que volvió es indistinguible de uno en camino.
Ya estaba anotado en `ESTADO-Y-PENDIENTES.md`.

---

## Resumen de lo medido

| | Antes | Después |
|---|---|---|
| Respuestas con síntomas (de 65 preguntas reales) | 29 | **12** |
| — el bot se queda mudo | 7 | **4** (los 4 escalados legítimos) |
| — «no te lo quiero decir a medias» | 21 | **5** (datos que faltan de verdad) |
| Ventas reales perdidas que ahora cierran | 0 de 3 | **3 de 3** |
| Batería de pruebas | 960 | **1008**, 0 fallos |

Las herramientas para volver a medirlo, sin red y sin tocar producción:

```bash
node herramientas/sondear.js --malas   # 65 preguntas reales, marca las malas
node herramientas/revivir.js           # las 3 ventas perdidas, de punta a punta
node herramientas/conversar.js         # los diálogos completos, para leerlos
npm test                               # 1008
```
