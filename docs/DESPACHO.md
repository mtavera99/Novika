# Despacho: guías y novedades de entrega

El tramo que va desde *«el pedido está confirmado»* hasta *«el cliente tiene su paquete en la mano y pagó»*. Es donde se gana o se pierde el margen: en contraentrega, un pedido despachado todavía no es plata, es plata en riesgo.

Dos flujos, con la misma forma y por la misma razón.

---

## La forma: tres pasos, y el del medio es el que vale

```
1. subir el archivo   →  se PROPONE un plan        no se envía nada
2. revisar en pantalla →  el operador marca cuáles
3. enviar              →  salen solo las marcadas
```

El paso 2 no es burocracia. Es donde se ve que la guía de un cliente quedó sin parear, o que una novedad cayó en «motivo no reconocido». Un flujo de un solo paso sería más corto y mandaría la etiqueta equivocada.

**Y revisar es gratis.** Se puede subir un PDF, mirar el pareo entero y cerrar la pestaña sin que salga nada. Eso es lo que permite operar el panel completo con `PANEL_ENVIO_MANUAL=0`.

---

## Flujo 1 · El lote de guías

El dueño genera las guías en la plataforma de la transportadora y recibe **un PDF con todas las etiquetas pegadas**. Hay que partirlo y mandarle a cada cliente la suya.

| Ruta | Qué hace |
|---|---|
| `POST /panel/guias/revisar` | Sube el PDF, lo parte y propone el pareo. **No envía nada** |
| `POST /panel/guias/asignar` | El operador elige el pedido de una hoja que no cruzó sola |
| `POST /panel/guias/enviar` | Manda las hojas marcadas |

A mano sigue existiendo (`POST /panel/guias/despachar`) y no se va: un despacho suelto no necesita un PDF.

**Mandar la guía es despachar.** El envío registra la transición del dominio (`dominioPedido.despachar`) **antes** de salir, así que el pedido queda despachado con su guía, versionado y en el historial. Si no se registrara, el pedido seguiría en «por despachar» con su guía ya en manos del cliente: la lista de pendientes mentiría y en el siguiente lote esa misma guía volvería a ofrecerse.

Va antes del envío a propósito. Si el envío falla después, queda un pedido despachado y un aviso que dice que no salió — eso se reintenta, y mientras tanto la información es correcta: el paquete salió. Al revés sería peor. Y como `despachar` exige que el pedido esté listo, uno sin dirección completa no puede colarse por aquí.

### Por qué el pareo no es solo por teléfono

Porque **el cliente a veces da en la guía un número distinto al de su WhatsApp**: el del marido, el de la mamá, el del vecino que recibe. Pareando solo por teléfono esas guías no se podrían mandar, o peor, se mandarían mal.

Y equivocarse aquí no es cosmético. **La etiqueta lleva nombre, dirección y teléfono impresos**: mandarle a un cliente la guía de otro es filtrarle datos personales de un tercero a un desconocido. Es de las pocas cosas de este sistema que no se arreglan pidiendo perdón.

De ahí la forma: varias señales, un puntaje y dos candados.

| Señal | Puntos | Por qué ese peso |
|---|---|---|
| Teléfono del pedido | 50 | Es único. Por sí solo alcanza el mínimo |
| Teléfono del chat | 50 | Solo si es **otro** número. El mismo no se cuenta dos veces: sería inflar la certeza sin más evidencia |
| Nombre | hasta 45 | Repartido entre sus palabras. Se repite —hay dos «Jorge» en la misma semana— |
| Números de la dirección | hasta 40 | Uno solo vale la mitad: «calle 80» coincide con cualquier dirección que tenga un 80 |
| Ciudad | 10 | Vale poco a propósito. En la referencia de BIKERPRO una sola ciudad era el ~30 % de los pedidos: coincidir casi no informa |

**Los dos candados:**

- **Mínimo 50.** Por debajo no se envía. 50 = un teléfono exacto, o el nombre completo más algo. Menos es adivinar.
- **Margen 20.** El mejor tiene que superar al segundo por 20 puntos. Dos hermanos en la misma casa empatan, y el empate es justo donde el error es más probable y más caro.

Con una excepción que evita bloqueos inútiles: si los empatados son **dos pedidos del mismo cliente** —pidió otra variante, o uno para un amigo—, se envía, porque mandar la guía al único número que tienen los dos no le filtra nada a nadie. Sin este matiz, el cliente que compra dos veces era justo el que nunca recibía su guía automáticamente.

### Cuando no alcanza, se dice qué faltó

El mensaje no es «no corresponde a ningún pedido (45 de 50)». Eso es lo que decía BIKERPRO, y el dueño lo leyó y preguntó, con razón: *«no sé por qué, como que no la reconoce»*. Un error que no permite actuar es una pantalla de ayuda que no ayuda.

Ahora dice **contra quién** casi coincidió y **qué señal** faltó —«el teléfono de la etiqueta (3209998877) no es el del pedido (3001112233)»—, y ofrece los tres candidatos más parecidos para asignar a mano. Con eso se arregla el dato en el pedido y la próxima vez cruza solo.

Con **0 puntos no se nombra a nadie**: decir «el más parecido es Jorge» cuando Jorge no coincide en nada manda al operador a mirar un pedido sin ninguna relación con esa etiqueta.

### Las etiquetas no salen del servidor

El navegador recibe lo que se **leyó** de cada etiqueta, nunca el PDF. Cada hoja lleva los datos de un cliente, y mandarlas todas al navegador sería publicar los datos de todo el lote en una pestaña.

Los candidatos para asignar a mano van con el teléfono recortado a los últimos cuatro dígitos: para reconocer al cliente alcanza.

> En BIKERPRO esa lista venía recortada a 60 pedidos y filtrada por «sin guía». Las dos cosas escondían justo al cliente que hacía falta.

### `pdfjs` y los 71 MB

`pdfjs` **no devuelve la memoria que usa**. Medido, y no se arregla con `cleanup()`, ni con `destroy()`, ni forzando el recolector:

```
solo CARGAR el módulo pdfjs        +41 MB
leer 40 páginas                    +30 MB
después de destroy() + recolector    0 MB devueltos
                                   ─────────
                                    71 MB que no vuelven nunca
```

Con el contenedor de 512 MB de Render, dos o tres lotes y el proceso muere. **La salida:** cuando un proceso termina, el sistema recupera el 100 % de lo que tenía. Así que el texto se extrae en un proceso hijo que se muere con la memoria dentro (`src/despacho/leer-pdf-worker.js`). Cuesta ~300 ms por PDF; los PDF se suben a mano unas veces al día.

Si el hijo no puede arrancar, se cae con gracia al camino de siempre —mejor gastar memoria que no poder mandar las guías— **pero queda anotado en el diario**, porque una fuga de 71 MB por lote registrada como una lectura normal es un reinicio por memoria que nadie sabe explicar.

Y las dos operaciones van **en secuencia, nunca en paralelo**: las dos cargan el PDF entero, Node es de un solo hilo y esto es CPU, así que `Promise.all` no lo hacía más rápido, solo duplicaba el pico de memoria. En BIKERPRO llegó el correo de Render: *«exceeded its memory limit»*.

---

## Flujo 2 · Novedades de entrega

Cuando la transportadora no logra entregar, alguien tiene que avisarle al cliente **hoy**. Un paquete con una novedad sin gestionar se devuelve en pocos días, y en contraentrega eso cuesta el flete de ida, el de vuelta y la venta.

> En la referencia de BIKERPRO la devolución estaba en el 19 %, y su rechazo bajo (5,0 %) **no era suerte**: era la gestión diaria de novedades a mano, cliente por cliente, desde el WhatsApp del celular. Esto es para que esa gestión no dependa de que alguien tenga tiempo.

| Ruta | Qué hace |
|---|---|
| `POST /panel/novedades/archivo` | Convierte el CSV/XLSX de la transportadora en texto. Opcional |
| `POST /panel/novedades/revisar` | Cruza con los pedidos y propone el plan |
| `POST /panel/novedades/avisar` | Avisa solo a los marcados |

### Se puede pegar el texto, y eso es deliberado

Todavía no se sabe qué formato exportará la transportadora que use NOVIKA —ni si exportará algo—. **Pegar lo que se ve en su pantalla funciona hoy**, sin depender de esa decisión. Si mañana hay export, el mismo clasificador lo lee.

Es la diferencia entre una pantalla que funciona y una que espera a que alguien decida algo.

El lector de archivos reconoce las columnas **por su nombre, no por su posición**. Leer «la tercera columna» funciona hasta el día en que la transportadora mete una columna nueva: entonces se le manda a cada cliente el mensaje de otro y nada avisa. Si no reconoce los encabezados, lo dice —la causa suele ser que cambió el formato— en vez de mostrar «0 novedades», que parece un archivo vacío.

### Los tipos, y a cuáles se les escribe

| Tipo | Se avisa | Por qué |
|---|---|---|
| `direccion` | sí | Se le pide la dirección completa y un punto de referencia, que es lo que desatasca el reparto |
| `ausente` | sí | Se le pide día y hora, u ofrecer una oficina |
| `oficina` | sí | Dónde reclamarlo y hasta cuándo |
| `rechazado` | **no** | Si rechazó el paquete, un automático molesta; y si fue un malentendido, hay que hablarlo |
| `telemercadeo` | **no** | Significa que la transportadora quiere que alguien **llame**, pero no dice qué dato falta. Un mensaje genérico sería inventar el motivo |
| `desconocida` | **no** | Escribirle un motivo inventado lo manda a resolver un problema que no tiene |

Las señales de cada tipo **se escriben a mano, y ese es su riesgo.** En BIKERPRO faltaba `"no se localiza dirección del destinatario"` —el texto literal de la plataforma, y **el caso más frecuente de todos**—, así que esas novedades caían en «motivo no reconocido» y el cliente no recibía nada. Se descubrió comparando la lista con la pantalla real, no por un error. Por eso el panel muestra siempre las no reconocidas: son la señal de que falta una palabra en esa lista.

### La oficina nunca se inventa

El 14-sep el bot de BIKERPRO le prometió a una clienta *«la oficina de Servientrega en Potosí»*. **Servientrega no presta recogida en oficina.** La clienta lo leyó.

Desde entonces: ese dato solo puede venir de la novedad.

- Si la oficina y el plazo **vienen en el archivo**, se usa la plantilla con los dos dentro.
- Si **no vienen**, la fila queda bloqueada pidiéndolos, y se pueden escribir a mano en la pantalla.
- El texto libre de oficina **no nombra ninguna oficina**: le pide al cliente que espere los datos exactos.

El orden de las variables importa: cambiarlo manda la fecha donde va la oficina.

> Lo escrito a mano **viaja siempre**, también en un segundo envío. En BIKERPRO las filas ya resueltas dejaban de dibujar sus campos, esos datos no viajaban, y las filas volvían a bloquearse pidiendo lo que ya se había escrito.

---

## La ventana de 24 horas, que gobierna los dos flujos

Meta solo entrega **texto libre** durante las 24 horas siguientes al último mensaje **del cliente**. Después, lo único que entrega son plantillas aprobadas.

Y los dos mensajes de este documento caen fuera de esa ventana **siempre**:

- la guía se despacha **al día siguiente** de la compra
- una novedad se reporta **1 a 3 días** después

**No es la excepción: es el caso normal.** Por eso las plantillas no son opcionales.

Con texto libre fuera de la ventana, Meta responde `131047` y el cliente no recibe nada. Peor aún: hay casos en que Meta **acepta** el mensaje —responde `ok` con su `wamid`— y no lo entrega. Se midió en BIKERPRO con el cierre diario.

De ahí las tres reglas que atraviesan todo el módulo:

1. **La ventana la abre el cliente.** Que el bot haya contestado hace cinco minutos no la reabre. Si contara el último mensaje de cualquiera, cada respuesta la renovaría y el sistema creería tenerla abierta para siempre.
2. **Sin dato, se asume cerrada.** Equivocarse hacia el lado cerrado cuesta una plantilla, que llega igual. Hacia el lado abierto cuesta un cliente sin avisar que nadie sabe que no se avisó.
3. **Aceptado por Meta no es entregado.** `avisoAlCliente.entregadoEn` nace en `null` y solo lo confirma el acuse del webhook.

### `es_CO`, no `es`

Para Meta son **dos traducciones distintas** de la misma plantilla. Una plantilla subida en Spanish (COL) y enviada con `es` se rechaza con `132001` — *«template name does not exist in the translation»* — aunque esté aprobada y visible en el panel de Meta.

El mensaje de error habla del **nombre**, así que se busca el fallo en el nombre y no en el idioma, que es donde está. Por eso el panel lo traduce.

---

## Qué falta, y no es código

| Qué | Quién lo desbloquea |
|---|---|
| `PLANTILLA_NOVEDAD_DIRECCION`, `_AUSENTE`, `_OFICINA` | Crearlas en Meta Business Manager y esperar aprobación. La de oficina con dos variables: `{{1}}` oficina, `{{2}}` plazo |
| `PLANTILLA_GUIA` | Igual, con el PDF en la cabecera (tipo documento) |
| `TELEFONOS_REMITENTE` | El número propio que va **impreso** en la etiqueta. Aparte de `OWNER_WHATSAPP`: son dos preguntas distintas, y confundirlas hizo que el número propio entrara al pareo como si fuera de un cliente |
| `PANEL_ENVIO_MANUAL=1` | Decisión del dueño. Hasta entonces el panel se opera completo y cada fila dice que la frenó el interruptor |
| Ajustar los rótulos del lector | Solo si la transportadora elegida imprime rótulos distintos a `GUIA No.` / `DESTINATARIO:` / `DIRECCION:` / `CIUDAD:`. Es una línea en `extraerCampos`, con 34 pruebas de red |

Todo esto se ve sin credenciales en `/health`: `plantillas_de_novedad`, `plantilla_de_guia`, `idioma_de_plantillas`, `telefonos_remitente`, `panel_envio_manual`. Se publica el **número**, nunca los nombres: un nombre de plantilla es un dato de la cuenta de Meta.

---

## Los módulos

| Archivo | Qué es | Puro |
|---|---|---|
| `src/despacho/guias.js` | El pareo: pesos, candados, a quién se le manda, qué se le dice | **sí** |
| `src/despacho/pdf.js` | Leer y partir el PDF. Lo único que toca un archivo | no |
| `src/despacho/leer-pdf-worker.js` | El proceso hijo que se muere con la memoria dentro | no |
| `src/despacho/novedades.js` | Clasificar, cruzar y armar el plan | **sí** |
| `src/despacho/hoja-de-calculo.js` | CSV y XLSX, sin dependencias nuevas (`zlib`) | **sí** |
| `src/despacho/planes.js` | El paso entre revisar y enviar | no |
| `src/whatsapp/ventana.js` | La regla de las 24 h, en un solo sitio | **sí** |

**La separación entre decidir y leer es el cambio de diseño respecto a BIKERPRO**, donde las dos cosas viven en la misma función. Por eso allí hacía falta un PDF real para probar cualquier cosa, y aquí el pareo se prueba con líneas de texto escritas a mano.

### Los planes no van a la base de datos

Un plan de guías contiene **las hojas del PDF**: decenas de MB en un lote grande. Y es reproducible: volver a subir el mismo archivo da el mismo plan. Guardar en la base algo pesado, efímero y reproducible es pagar su coste sin ganar nada.

Viven en memoria con dos topes: **2 h sin usarse** (se refresca en cada uso, para que un reintento no obligue a volver a subir el PDF) y **6 h en total** (no se refresca nunca; sin este tope, un plan reintentado cada hora y media se queda para siempre con sus PDF dentro).

El precio se paga explícito: **un reinicio entre revisar y enviar pierde el plan.** En BIKERPRO eso devolvía un 400 pelado y parecía un fallo del panel. Aquí se distinguen los tres casos —nunca existió, caducó, se reinició el servicio— porque «hubo un despliegue, no hiciste nada mal, vuelve a subirlo» y «esperaste demasiado» son dos cosas distintas.

---

## Las pruebas

```
npm test
```

| Archivo | Qué cubre |
|---|---|
| `test/despacho-guias.test.js` | El pareo entero, sin ningún PDF: pesos, los dos candados, el empate del mismo cliente, los BSUID, «La Playa», el teléfono en seis formatos |
| `test/despacho-lote-de-guias.test.js` | **Punta a punta con un PDF generado**: leer, partir, parear por HTTP, y el candado del interruptor |
| `test/despacho-novedades.test.js` | Clasificación, el número más largo, la ventana, y el incidente de la oficina |
| `test/despacho-archivos-y-planes.test.js` | CSV, un `.xlsx` construido en la prueba, las columnas, los topes del plan y el PDF reenviado |
| `test/whatsapp-plantillas.test.js` | El candado en los caminos nuevos, `es_CO`, y que no se sube un PDF que no se va a poder enviar |

Ninguna sale a la red, ninguna usa credenciales reales y ninguna escribe fuera de `/tmp`.
