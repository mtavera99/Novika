# El cerebro de NOVIKA (Fase 2)

Cómo viaja un mensaje, y dónde está cada candado.

---

## El principio

> **La IA redacta y entiende lenguaje. El código controla los hechos y las transacciones.**

| La IA puede | El código decide |
|---|---|
| entender intención | producto |
| clasificar | precio, cantidad, descuento, envío, total |
| extraer **candidatos** | validez de los datos del cliente |
| redactar | estado del pedido |
| manejar objeciones | confirmación, cancelación, modificación |
| | creación del pedido, identificadores, duplicados |

---

## El camino de un mensaje

```
Meta → POST /webhook        (Fase 1, sin cambios)
  │  firma → diario → 200 → procesar aparte
  │
  └─ procesar: aislamiento → clase → dedup por wamid
       │
       └─ cerebro.procesar(evento)
            │
            └─ enSerie(contactoId)   ← todo el turno en exclusiva
                 │
                 1. contexto .............. contacto + conversación del disco
                 2. CONFIRMACIÓN .......... determinista, ANTES de la IA
                 3. producto .............. señales con prioridad y confianza
                 4. IA .................... intención + candidatos + borrador
                 5. candidatos ............ heurística + IA → proponer
                 6. validación ............ confirmar sólo lo que pasa
                 7. cotización ............ determinista, desde el catálogo
                 8. acción ................ confirmar / cancelar / corregir / avanzar
                 9. estado ................ transición en lista blanca
                10. respuesta ............. preparar SIEMPRE, enviar casi nunca
                11. guardar ............... conversación + diario
```

### Tres reglas de orden, y por qué

**1. La confirmación se evalúa antes de llamar a la IA.** Así el modelo no puede influir en si existe un pedido. Aunque devolviera `intencion: "confirma"`, la decisión ya está tomada por código.

**2. Todo el turno va dentro de una cola por contacto.** Node es monohilo, y eso engaña: cada `await` es un punto donde entra otra tarea. Dos mensajes seguidos del mismo cliente comprobarían "no hay pedido" antes de que el primero acabe de escribir. El resultado no sería un estado raro: serían dos pedidos.

**3. La respuesta se prepara siempre; se envía sólo si el interruptor lo permite.** Es el modo sombra.

---

## Cómo se impide que el LLM altere un hecho

Cuatro capas, de la más fuerte a la más débil. La primera es la que de verdad cierra el problema.

### 1. No existe el campo

`src/ia/contrato.js` define una lista cerrada de lo que el modelo puede proponer:

```
nombre · telefono · documento · ciudad · departamento
direccion · referencia · cantidad · variante
```

Fíjate en lo que **no** está: `precio`, `total`, `subtotal`, `envio`, `descuento`, `pedidoId`, `confirmado`, `estado`. El modelo no tiene dónde escribirlos.

**Lo que no se puede expresar no se puede colar.** Y si aparece una de esas claves —a cualquier profundidad del JSON— la respuesta se descarta **completa**. No se rescata "la parte buena": una respuesta que intenta fijar un hecho crítico es una respuesta en la que no se puede confiar.

### 2. Candidato ≠ confirmado

`src/dominio/campos.js`. Cada dato tiene estado explícito: `vacio` → `candidato` → `confirmado` / `rechazado`.

```js
valorConfirmado(campo)  // null si no está confirmado. Sin excepciones.
```

No devuelve el candidato "por si sirve". Quien necesita un hecho recibe `null` y tiene que decidir qué hacer con esa ausencia — que es exactamente lo que queremos que pase. Y un candidato **nunca pisa** un dato ya confirmado.

### 3. Los números los calcula el cotizador

`src/dominio/cotizador.js` no contiene ni una constante monetaria, a propósito: todo sale del catálogo. Si falta un dato, **no cotiza y dice qué falta**. Una cantidad fuera de la tabla **no se interpola**: se escala.

### 4. Lista blanca de importes y de claims

La cotización declara `importesAutorizados`. Antes de enviar, `src/cerebro/responder.js` revisa el borrador del modelo:

- ¿contiene una cifra de dinero que el código no calculó? → bloqueado
- ¿contiene un claim de la lista de prohibidos del producto? → bloqueado

Si falla cualquiera, **se descarta el borrador completo** y se usa el texto determinista. No se corrige la frase mala: arreglarla deja las demás sin revisar.

> Por qué el filtro de claims importa tanto aquí: el primer producto es para dolor menstrual. El riesgo no es exagerar un precio, es hacer una promesa médica. *"Cura los cólicos"* no es una venta agresiva: es una devolución y, potencialmente, un problema regulatorio.

### Si la IA falla

No se pierde el mensaje, no se inventa nada, no se confirma nada. `src/ia/cliente.js` **nunca lanza**: devuelve un análisis de respaldo con intención `no_se_entiende`, y el turno sigue por el camino determinista. Timeout, red caída, 429, JSON ilegible y contrato incumplido se reintentan; un 401 o un 400 no, porque saldrían igual de mal.

Y el camino determinista **funciona sin IA**: la extracción heurística (`src/dominio/extraer.js`) saca cantidad, ciudad y dirección con reglas. Si todo dependiera del modelo, un fallo del proveedor significaría cero ventas.

---

## Confirmación: el candado más importante

`src/dominio/confirmacion.js`. El orden de los bloques **es** la lógica:

| Orden | Qué | Por qué está ahí |
|---|---|---|
| 1 | negaciones | *"no confirmo"* contiene *"confirmo"* |
| 2 | preguntas de estado | *"si mandaron el pedido gracias"* es una pregunta y empieza por "si" |
| 3 | afirmaciones inequívocas | dicen **qué** se afirma |
| 4 | correcciones | cambian un dato; no son sí ni no |
| 5 | acuses / "si" suelto | lo que signifique depende del estado |

### Después de confirmar, nada lo cambia

```js
if (estado === CONFIRMADO || estado === POSVENTA) { ... }
```

Esa rama va **antes** de mirar la clase del mensaje. Es la diferencia entre "intentamos no duplicar" y "no se puede duplicar": ningún texto, por mucho que parezca una confirmación, crea un segundo pedido desde ahí. **El estado lo impide, no el patrón.**

`"sí"`, `"ok"`, `"gracias"`, `"listo"`, `"perfecto"` → se acusa recibo y no se toca nada. Sólo atraviesan el blindaje caminos con nombre: cancelar, modificar, responder estado.

### La asimetría: nunca se tira una venta

Una respuesta ambigua frente a un resumen (`"gracias"`, algo que no encaja) **no se descarta y no se guarda a ciegas**: escala a una persona. Puede ser un *"hágale"* que no reconocemos. Perder una venta real es peor que revisar una a mano.

---

## Identificación de producto

Prioridad explícita, en `src/catalogo/senales.js`:

| # | Señal | Por qué en ese puesto |
|---|---|---|
| 1 | alias en **este** mensaje | el cliente lo está diciendo ahora |
| 2 | producto confirmado de la conversación | el historial se rota; sin esto el bot olvida de qué hablaban a mitad de la venta |
| 3 | referral del anuncio | fiable, pero lo que dijo el cliente pesa más |
| 4 | señal en la ventana reciente | rescate |
| 5 | **DESCONOCIDO** | no hay producto por defecto |

**Dos productos en la misma frase → no se elige.** Elegir en un empate es cómo se despacha mal.

### El detector de falsa señal

El incidente: en una conversación sobre intercomunicadores el cliente preguntó *"¿son impermeables?"*. "Impermeable" era el nombre del otro producto; el sistema leyó un cambio y el pedido se guardó con el producto equivocado al precio equivocado.

En NOVIKA esto va a pasar **más**: *térmico*, *inalámbrico*, *portátil*, *antideslizante* son a la vez adjetivos y nombres de producto.

```
"y eso sirve para los cólicos?"   → pregunta. NO cambia el producto.
"mejor quiero el cinturón"        → cambio explícito. SÍ cambia.
"cuánto vale el cinturón?"        → pide precio de otro. SÍ cambia.
```

Y con un pedido vivo, **el producto no se cambia nunca**: cambiarlo es despachar el artículo equivocado.

---

## Idempotencia: dos duplicados distintos

| Duplicado | Qué pasa | Candado |
|---|---|---|
| Meta retransmite el evento | mismo `wamid` | `claveDeEvento` |
| El cliente escribe "sí" dos veces | otro `wamid`, **misma oferta** | `claveDeOferta` |

Con una sola clave se escapa uno de los dos. Las dos son restricciones de unicidad del **almacén**, no comprobaciones en memoria: un `Set` en memoria se borra al reiniciar, y el reintento de Meta puede llegar hasta **36 horas** después, con un despliegue en medio.

Hay además tres capas por delante: dedup por `wamid` en el webhook (Fase 1), la cola por conversación, y el blindaje de estado. Un pedido cancelado **libera** su oferta: un cliente que se arrepiente de cancelar tiene que poder volver a comprar.

---

## Snapshot: el histórico no cambia solo

El pedido guarda una **copia** de la cotización y del destinatario tal como estaban al confirmar, más `politicaVersion` y `versionCatalogo`.

Si mañana sube el precio, el pedido de ayer sigue valiendo lo que el cliente aceptó. Guardar sólo un `productoId` y recalcular al consultar significa que el histórico cambia solo — y entonces la contabilidad del negocio no es auditable.

Las modificaciones **no pisan: versionan**. Y si un cambio afecta al precio, exige cotización nueva: dejar la cantidad en 3 con el total de 2 es la inconsistencia que acaba en devolución.

---

## Modo sombra

`MODO_SOMBRA=1` (por defecto) y `RESPUESTA_AUTOMATICA=0`:

- el mensaje real se procesa **de principio a fin**
- la respuesta se **prepara** y se valida contra los hechos
- se **registra** en el diario, con la situación, los bloqueos y el estado
- **no sale**

Permite auditar conversaciones reales antes de dejar hablar al bot.

El candado del envío vive en `src/whatsapp/enviar.js`, que es el **único** camino al exterior y empieza comprobando el interruptor. No está en la capa de arriba a propósito: "acordarse de comprobar el interruptor en cada sitio que envía" es una instrucción, y las instrucciones se incumplen cuando alguien con prisa añade un flujo. Además, enviar exige un `permiso` declarado; una llamada que no dice por qué tiene derecho a escribirle a un cliente se rechaza.

La línea que hay que mirar en `/metricas`:

```
respuesta_preparada   puede subir
respuesta_enviada     tiene que quedarse en 0
```

Si `respuesta_enviada` sube con el interruptor apagado, es un incidente. Hay pruebas que lo vigilan: el `fetch` del emisor es un doble que **falla la prueba** si alguien lo llama.

---

## Observabilidad

`GET /metricas?token=…` — sólo números. Ningún teléfono, texto ni documento, así que la vista completa se puede exponer sin filtrar nada.

`GET /eventos?token=…` — el diario, que **sí** guarda la conversación: es la trazabilidad y vive en el disco privado del servicio, no en los logs del hosting. Los logs llevan estado, acción y situación; nunca dirección, documento ni teléfono completo.

---

## Lo que todavía no existe

- **Productos reales.** El catálogo tiene la plantilla y el borrador del cinturón, inactivo con 14 pendientes.
- **Proveedor de IA configurado.** Sin `IA_API_KEY` el sistema funciona por el camino determinista.
- **PostgreSQL.** Interfaces y esquema listos; ver [`PERSISTENCIA.md`](PERSISTENCIA.md).
- **Panel de administración.**
- **Respuestas a clientes.**
