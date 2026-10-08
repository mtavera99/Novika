# Panel: qué hay en BIKERPRO y qué corresponde en NOVIKA

Auditoría **de solo lectura** de `mtavera99/impermeables` en `a89f51c`. No se modificó nada ahí, y no se usa ni un cliente, pedido o secreto suyo.

~4.000 líneas de panel: `panel.js` (1.541), `panel-guias.js` (707), `panel-chat.js` (605), `panel-novedades.js` (605), `panel-auditoria.js` (429), más 1.464 líneas de pruebas de panel, móvil, memoria y JavaScript.

---

## 1 · Rutas encontradas

| BIKERPRO | Qué hace | NOVIKA |
|---|---|---|
| `GET /panel` | Tablero: KPIs del día, chats, pedidos | `GET /panel` |
| `GET /chat?id=` | Una conversación, con responder | `GET /panel/chat` |
| `POST /responder` | Respuesta manual + pausa el bot | `POST /panel/responder` |
| `POST /pausar` | Pausar / reanudar el bot en un chat | `POST /panel/control` |
| `POST /atendido` | "Ya lo resolví", con deshacer | `POST /panel/atendido` |
| `POST /pedido-manual` | Venta que el bot no capturó | `POST /panel/venta-manual` |
| `POST /anular` · `POST /reactivar` | Anular un pedido (no borrar) | `POST /panel/pedido/cancelar` · `/reactivar` |
| `GET /pedidos.csv` | Exportar | `GET /panel/pedidos.csv` |
| `GET /auditoria` | Embudo y atribución del día | `GET /panel/auditoria` |
| `GET /cierre` | Resumen del día, opcionalmente por WhatsApp | *no se porta* (ver §5) |
| `GET /guias` + 3 POST | Partir el PDF de la transportadora | `GET /panel/guias` · `POST /panel/guias/revisar` · `/asignar` · `/enviar` — **portado** (§5) |
| `GET /novedades` + 2 POST | Novedades de entrega por plantilla | `GET /panel/novedades` · `POST /panel/novedades/archivo` · `/revisar` · `/avisar` — **portado** (§5) |
| `GET /limpiar-duplicados`, `/recuperar-cliente`, `/limpiar-conversaciones-rotas` | Reparaciones manuales de su store | *no se porta*: son parches de un almacén que NOVIKA no tiene |

---

## 2 · Correcciones acumuladas que SÍ se reutilizan

Esto es lo que vale de verdad: cada una viene de un incidente.

**Móvil** (`test-panel-movil.js`)

| Corrección | Por qué |
|---|---|
| Inputs con `font-size: 16px` mínimo | iOS hace zoom solo al enfocar un input menor. Pasaba justo al escribirle a un cliente: la página saltaba. *"El detalle que más hacía sentir el panel roto."* |
| Objetivos táctiles ≥ 44px | Los botones tenían ~30px. Es la guía de Apple |
| Tablas que se apilan con `data-label` | 7 columnas en 390px no se leen, y es la pantalla que se usa con el celular en la mano |
| Las etiquetas también en el JS que pinta filas | Si la fila se arma en JavaScript, el CSS del servidor no la alcanza |

**Zona horaria y memoria** (`test-memoria-del-panel.js`)

| Corrección | Por qué |
|---|---|
| `diaBogota()` **pura**, sin estado | Si guardara estado, dos llamadas iguales darían días distintos y los chats aparecerían en el día equivocado de forma intermitente |
| Guarda para `undefined` | `toLocaleDateString` devuelve `"Invalid Date"` e `Intl.format` **lanza**. Sin la guarda, tumbaba el panel entero |
| Probada hora por hora un año entero | Cruza los dos cambios de día (UTC y Bogotá). *"Justo donde este proyecto ya se equivocó antes."* El borde que importa son las 19:00 de Bogotá, cuando en UTC ya es mañana |
| Una caché incompleta cae a evaluar, no se salta entradas | Saltárselas es perder chats sin error |

**Token** (`test-token-del-panel.js`)

| Corrección | Por qué |
|---|---|
| El token del panel **nunca** es el de verificación de Meta | Se prueba con dos valores distintos a propósito: si una pantalla usa el viejo, se nota |
| Mirar el **estado HTTP** antes de `r.json()` | Un 403 devuelve el texto `Forbidden`. Sin mirar el estado, el dueño ve `Unexpected token 'F'` y busca el problema donde no está. **Pasó dos veces**: en `/responder` y en `/guias` |

**Flujo**

| Corrección | Por qué |
|---|---|
| Responder por `fetch` y devolver JSON, no redirect | Un redirect recarga la página y **cierra la conversación abierta** |
| Anular ≠ borrar: queda con motivo y fecha, y se filtra en un solo sitio | *"Un pedido borrado es contabilidad que desaparece"* |
| "Atendido" guarda la hora y **reaparece** si el cliente vuelve a escribir | Un chat silenciado para siempre es una venta perdida en silencio |
| Dedup de la respuesta manual por (destino, texto) en pocos segundos | El doble clic mandaba dos veces |
| Error 131047 / 470 traducido a lenguaje claro | Es la ventana de 24h de Meta, no un fallo del panel |

---

## 3 · El defecto de BIKERPRO que NO se porta

Es el caso que me señalaste, y está en su código:

```
server.js:2780   if (store.isPaused(from)) continue;    ← se comprueba la pausa AQUÍ
server.js:2786   await ...                              ← la IA piensa (segundos)
server.js:2791   await sendText(from, reply);           ← envía SIN volver a comprobar
```

Si el operador toma el control **mientras la IA piensa**, el bot contesta igual. Dos voces al mismo cliente.

**En NOVIKA la comprobación va en el punto de salida** (`src/whatsapp/enviar.js`), que es el único camino al exterior y se ejecuta *después* de que la IA haya respondido. No depende de que cada flujo se acuerde de repetirla.

Hay un segundo hallazgo documentado por ellos mismos: al pausar un chat, su webhook hace `continue` antes de la IA, y como el pedido lo emite la IA en un bloque `##ORDER##`, **todo chat escalado a humano perdía la captura del pedido** — justo los más calientes. En NOVIKA la confirmación y el pedido son deterministas en código, no un bloque que emite el modelo, así que ese agujero no existe. La venta manual se porta igual, porque sigue haciendo falta para ventas cerradas por teléfono.

---

## 4 · Dónde se enchufa cada cosa en NOVIKA

No se copia su `store`: sería una segunda fuente de pedidos.

| Dato | BIKERPRO | NOVIKA |
|---|---|---|
| Pedidos | `store.todosLosPedidos()` | `repos.pedidos` (archivos o PostgreSQL, mismo contrato) |
| Conversaciones | `store.getConv()` | `repos.conversaciones` |
| Historial del chat | `store.pushMsg()` | `conversacion.mensajes` |
| Pausa | `store.setPaused()` en memoria+disco | `conversacion.atencion` persistida en los repos |
| Anular pedido | campo propio + filtro | `dominioPedido.cancelar()` + `pedidos.reemplazar()`, versionado |
| Venta manual | `store.saveOrder()` | `pedidos.crearSiNoExiste()` con clave de idempotencia propia |
| Envío | `sendText()` | `emisor.enviarTexto()` con permiso explícito |
| Auditoría | `anotarEvento()` | `diario.anotar()` |

---

## 5 · Lo que esta auditoría dio por bloqueado, y por qué dos de las tres cosas no lo estaban

Detalle completo del flujo portado en [DESPACHO.md](DESPACHO.md).

**Guías / despachos — PORTADO. La conclusión de esta auditoría era falsa, y conviene entender por qué.**

Decía esto:

> *«el lector está ajustado al formato exacto de ese PDF. Para NOVIKA falta decidir la transportadora, y un PDF real de ejemplo contra el que ajustar y probar el lector. Sin eso, portar el parser es escribir código que no se puede verificar.»*

El razonamiento era correcto **sobre el diseño de BIKERPRO**, donde leer el archivo y decidir el destinatario viven en la misma función (`procesarPDF`). Allí, efectivamente, no se puede probar nada sin un PDF.

Lo que no se vio es que ese acoplamiento **no hay que portarlo**:

- `src/despacho/guias.js` es **puro**: recibe el texto ya extraído y decide de quién es cada etiqueta. El 95 % del riesgo —*a quién se le manda*— se prueba con líneas escritas a mano.
- El PDF de prueba **se genera** con `pdf-lib`, la misma librería que lo parte, con los rótulos que imprimen las transportadoras colombianas.

Lo que sí era cierto: si la transportadora elegida usa rótulos distintos, el lector habrá que ajustarlo. Pero eso es una línea en `extraerCampos` con 34 pruebas de red, no un módulo sin verificar.

> La lección general: *«no se puede verificar»* casi nunca es una propiedad del problema. Suele ser una propiedad de **cómo está partido el código**, y entonces es negociable.

**Novedades — PORTADO el flujo; sigue faltando lo de Meta, que no es código.**

Clasificar, cruzar con el pedido, leer el CSV/XLSX y avisar están implementados. Lo que no depende de nosotros son las tres plantillas **aprobadas**: `PLANTILLA_NOVEDAD_AUSENTE`, `PLANTILLA_NOVEDAD_DIRECCION`, `PLANTILLA_NOVEDAD_OFICINA`. No se pueden sustituir por texto libre, porque fuera de la ventana de 24 h Meta solo entrega plantillas.

La diferencia con antes: el panel **bloquea esa fila y lo dice arriba**, antes de que se suba nada, en vez de no tener la pantalla. Y a los clientes que sí tengan la ventana abierta se les escribe igual.

**Atribución / embudo — falta dato, no código.**
Su auditoría cruza `referral` de anuncios con pedidos. NOVIKA no tiene campañas activas ni pedidos reales, así que la pantalla se porta pero dirá "sin datos" hasta que existan. No se inventan números.

**Cierre por WhatsApp — no se porta ahora.**
Depende de que la ventana de 24h con el dueño esté abierta. Ellos lo midieron: Meta aceptó el mensaje con `ok:true` y **nunca lo entregó**. Con `RESPUESTA_AUTOMATICA=0` no tiene sentido todavía.

---

## 6 · Autenticación

No se reutiliza nada. NOVIKA ya tiene `PANEL_TOKEN`, **distinto** del `WHATSAPP_VERIFY_TOKEN`, y hay una prueba que falla si se vuelven a confundir.

El panel añade un **inicio de sesión con cookie firmada** en vez de llevar el token en la URL: una URL con el token se queda en el historial, en los `Referer` y en los logs de cualquier proxy. `/metricas` y `/eventos` siguen aceptando `?token=` para no romper lo que ya usas.

---

## 7 · Envíos

Los envíos del panel pasan por `src/whatsapp/enviar.js`, el único camino al exterior, con un permiso nuevo y explícito: `ATENCION_MANUAL`.

Y tienen **su propio interruptor**, `PANEL_ENVIO_MANUAL`, apagado por defecto. Así el panel está completo y operable sin que se le escape un WhatsApp real durante el desarrollo.

**El panel muestra el resultado real del envío, nunca un "entregado" optimista.** Que Meta acepte un mensaje no significa que lo entregue — ellos lo midieron con el cierre diario. El panel distingue tres cosas: aceptado por Meta (con su `wamid`), bloqueado por un interruptor (y cuál), y fallido (con el motivo traducido). La entrega real solo se da por buena cuando llega el acuse `delivered` por el webhook.
