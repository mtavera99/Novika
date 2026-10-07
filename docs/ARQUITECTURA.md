# Arquitectura de NOVIKA

## El principio

> **Una instrucción al modelo no es un candado.**

La IA entiende lenguaje y redacta bien. No es un mecanismo de garantía. Si algo no puede fallar, no se le pide al modelo: se calcula en código y se prueba.

Reparto de trabajo:

| La IA | El código |
|---|---|
| entender la intención | qué producto es |
| conversar con naturalidad | el precio |
| responder con información autorizada | la cantidad y las variantes |
| detectar señales de compra | el total |
| redactar | los datos del cliente |
| | el estado del pedido |
| | la confirmación |
| | la cancelación y las modificaciones |
| | la deduplicación |
| | la persistencia |

Corolario operativo: **cuando el modelo se equivoque, el arreglo es un candado y una prueba, no un párrafo más de prompt.**

## Prioridades, en orden

Cuando dos objetivos choquen, gana el de arriba:

1. No perder ventas
2. No cobrar valores incorrectos
3. No guardar pedidos incorrectos
4. No confundir productos
5. No duplicar pedidos
6. No inventar información
7. Minimizar devoluciones causadas por el bot

De aquí sale una **asimetría deliberada**: ante una ambigüedad, nunca se descarta una venta real. Se guarda marcada y se escala a una persona. Ante una ambigüedad de cantidad, se elige la menor: nunca cobrar de más.

## Estructura

```
src/
  config.js            único sitio que lee process.env; valida y falla rápido
  aislamiento.js       candados NOVIKA ≠ BIKERPRO (arranque y por evento)
  log.js               una línea JSON por evento; enmascara datos del cliente
  app.js               cableado de Express; sin lógica de negocio
  server.js            arranque, apagado ordenado
  comprobar-config.js  `npm run comprobar-config`

  webhook/
    firma.js           HMAC X-Hub-Signature-256
    rutas.js           GET verificación · POST recepción
    normalizar.js      payload de Meta → eventos de NOVIKA
    procesar.js        compuertas: aislamiento → clase → dedup → manejo

  almacen/
    diario.js          registro append-only, un JSONL por día
    vistos.js          ids ya procesados; persistido

  catalogo/
    esquema.js         validación del producto
    index.js           carga desde /catalogo/productos

catalogo/productos/    un JSON por producto (fuente de verdad)
test/                  una batería por comportamiento crítico
```

Separación deliberada: `app.js` solo cablea, `normalizar.js` es la única frontera que conoce la forma del payload de Meta, y el negocio no vive en el mismo archivo que las rutas. Cuando Meta cambie de versión, se toca un archivo.

## El camino de un mensaje

```
Meta
 │
 ├─ POST /webhook
 │   1. ¿firma válida?        no → 403, no se procesa
 │   2. escribir en el diario              ← ANTES del acuse
 │   3. responder 200 a Meta
 │   4. procesar aparte
 │
 └─ procesar
     1. ¿es del número de NOVIKA?   no → descartar, avisar
     2. ¿mensaje o acuse de entrega?
     3. ¿wamid ya visto?            sí → descartar
     4. manejar
```

### Por qué el diario se escribe antes del 200

Meta reintenta mientras no recibe un 200, y deja de reintentar en cuanto lo recibe. Si el proceso muere entre el acuse y el final del procesamiento —un SIGTERM de despliegue, por ejemplo— el mensaje se perdió para siempre. Desde fuera eso es indistinguible de "hoy no escribió nadie": no hay error, no hay alerta, solo una venta que no ocurrió.

Escribir antes cuesta un append de unos cientos de bytes.

### Por qué la deduplicación va en la puerta

Ese reintento de Meta trae el mismo mensaje otra vez. Si se procesa dos veces, hoy significa responder dos veces; cuando haya pedidos, significa un pedido que nadie hizo. Y un pedido inventado es peor que un paquete de más: el dueño decide con esos números —coste por venta, tasa de cierre— y un pedido fantasma los corrompe todos.

El candado está antes de cualquier efecto, no después. `vistos.esNuevo(id)` marca y pregunta en la misma operación, a propósito: si fueran dos llamadas, cualquier `await` entre ellas abriría la ventana que el candado cierra.

### Por qué los acuses de entrega se procesan

`messages` trae también `statuses`. Un `failed` ahí es la única forma de saber que Meta aceptó un mensaje con 200 y después no lo entregó, y el motivo viene en `errors[].code`. Ignorarlos hace que el bot crea que contestó cuando no llegó nada.

### Por qué la persistencia se comprueba y no se supone

El sistema de archivos de un Web Service de Render es efímero. Lo peligroso no es olvidarse del disco: es declarar `DATA_DIR=/var/data` y creer que eso lo crea. Si el Disk no está montado, `/var/data` es una carpeta corriente del contenedor que se borra en cada despliegue, con un nombre que tranquiliza.

Y lo que se borra es el antiduplicados. Meta reintenta durante 36 horas, así que el reintento llega después del despliegue que borró la memoria.

Por eso se comparan los ids de dispositivo de `DATA_DIR` y del código —un disco montado es otro sistema de archivos— y además se lleva un contador de arranques: si tras varios despliegues sigue en 1, la carpeta se está borrando, diga lo que diga la configuración. Ambas cosas se publican en `/health`.

Y hay un candado: con almacenamiento efímero, `RESPUESTA_AUTOMATICA=1` bloquea el arranque. Recibir y verificar funciona igual; responder sin memoria durable, no.

Qué se guarda, qué se pierde en cada escenario y a dónde migra: [`PERSISTENCIA.md`](PERSISTENCIA.md).

### Una puerta única al almacenamiento

```
src/almacen/diario.js    anotar(tipo, datos) · ultimas(n) · resumenDeHoy()
src/almacen/vistos.js    esNuevo(id) · cuantos()
```

Ningún otro módulo abre un archivo. Cuando los pedidos obliguen a migrar a Postgres, se reescriben esos dos y la lógica no se toca.

Dos detalles que ya apuntan ahí: el diario es **append-only** (traducir a `INSERT` es directo; un almacén que se reescribe entero no tiene traducción), y `esNuevo(id)` **marca y pregunta en una sola operación**, que en Postgres es un `INSERT ... ON CONFLICT DO NOTHING RETURNING` atómico. Partirlo en dos llamadas heredaría la carrera que el candado cierra.

## Catálogo multiproducto

El producto es **dato**, no código: un JSON por producto en `catalogo/productos/`. Añadir un producto no es un despliegue.

Dos reglas cargan con casi todo el peso:

- **No hay producto por defecto.** Si no se puede identificar el producto, se pregunta. En multicategoría, adivinar es despachar el equivocado.
- **Un producto no puede estar activo si le falta un dato crítico.** La validación es permisiva con los borradores y estricta con lo que el bot puede vender hoy.

El detalle está en [`catalogo/README.md`](../catalogo/README.md).

## Secretos

Tres niveles de privilegio, tres valores distintos:

| Secreto | Quién lo usa | Qué protege |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Meta, una vez | el handshake del webhook |
| `META_APP_SECRET` | Meta, en cada evento | que el evento venga de Meta |
| `PANEL_TOKEN` | tú | datos de clientes |

Compartirlos no es cómodo, es caro: el valor acaba copiado en varios sitios y publicado. Y **ningún secreto tiene valor por defecto en el código**: si falta, el proceso no arranca. Hay una prueba que lo verifica.

## Qué no existe todavía

Explícito para que nadie lo dé por hecho:

- flujo conversacional (`RESPUESTA_AUTOMATICA=0`)
- integración con un proveedor de IA
- motor de cotización
- pedidos, confirmación, modificaciones, cancelaciones
- panel de administración
- productos reales

## Qué se aprendió de BIKERPRO y qué no se copió

BIKERPRO (`mtavera99/impermeables`) se auditó **en solo lectura**. Nada de su código, sus datos ni su configuración está aquí.

**Se reutilizó el concepto:**

- el principio de la instrucción que no es candado, y la asimetría de fallos
- separar producto de conversación, y estampar el producto desde el código
- `datosConfirmados` / `sinDatoConfirmado`, con precedencia de la duda
- alias por raíces con nivel de confianza; un alias ambiguo no es alias
- `noHeredar` y `provisional` + `revisarCuando` en las políticas de envío
- procesar los acuses de entrega, no solo los mensajes
- distinguir "Meta no llegó" de "llegó y fallamos"
- `/health` que dice qué commit está corriendo
- la zona horaria del negocio en todos los cortes de día, con `Intl` reutilizado
- una batería por comportamiento crítico, sin credenciales y sin red, y cada prueba documentando el incidente que la originó
- escribir la razón de cada decisión al lado del código

**Se corrigió lo que allí falta:**

| En BIKERPRO | En NOVIKA |
|---|---|
| sin verificación de firma | HMAC obligatorio para procesar |
| sin deduplicación de entrantes | candado persistido en la puerta |
| 200 antes de guardar nada | diario antes del 200 |
| secretos con respaldo en el código | sin respaldos; no arranca si faltan |
| bitácora en memoria, 60 entradas | diario en disco |
| `DATA_DIR` se avisa pero no se verifica de verdad | se comprueba el dispositivo + contador de arranques |
| productos en código, y dos catálogos que pueden divergir | un catálogo, en datos |
| producto por defecto | sin producto por defecto |
| un archivo de 3.000 líneas | módulos por responsabilidad |
| datos de clientes en claro en los logs | enmascarados salvo `LOG_PII=1` |

**No se trajo nada** de sus productos, precios, promesas comerciales, fichas técnicas, tarifas, transportadoras, guion, marca, credenciales ni infraestructura.
