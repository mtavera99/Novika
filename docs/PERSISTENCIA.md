# Persistencia de NOVIKA en Render

Documento de decisión. Responde qué se guarda, qué se pierde, dónde va a vivir y por qué, y qué se puede hacer sin nada de eso.

---

## 1 · Qué se guarda hoy en disco

Tres archivos bajo `DATA_DIR`. Nada más:

| Archivo | Contenido | Volumen | Crítico |
|---|---|---|---|
| `diario/<AAAA-MM-DD>.jsonl` | Cada evento recibido (cuerpo crudo del webhook), cada decisión tomada sobre él, cada acuse de entrega, cada error | ~1–3 KB por mensaje | **Sí** — es la auditoría |
| `vistos.jsonl` | Un `wamid` por línea, con su marca de tiempo. Memoria de qué eventos ya se procesaron | ~80 bytes por mensaje | **Sí** — es el antiduplicados |
| `marcador-de-disco.json` | Contador de arranques | ~100 bytes | No — es diagnóstico |

**No se guarda** —porque todavía no existe— ningún pedido, conversación, estado conversacional ni dato de cliente más allá del propio mensaje registrado en el diario.

---

## 2 · Qué se pierde con un restart o un redeploy

Tenías razón en el fundamento: **el sistema de archivos de un Web Service de Render es efímero.** La documentación de Render lo dice sin matices: sin un disco persistente, los cambios en los archivos locales se pierden en cada redeploy y en cada restart.

Pero el `render.yaml` de este PR **ya declara un disco** montado en `/var/data`, con `DATA_DIR=/var/data`. Y los discos persistentes sí están disponibles en servicios web de pago — Starter cuenta. Así que en la configuración propuesta no se pierde nada.

El riesgo real es más sutil, y es el que no estaba cubierto:

| Escenario | Qué se pierde |
|---|---|
| Disco montado (lo que declara `render.yaml`) | **Nada.** El disco sobrevive a deploys, restarts y movimientos de instancia |
| **Disk no montado pero `DATA_DIR=/var/data`** | **Todo, en cada deploy** — y sin ningún síntoma |
| `DATA_DIR` sin configurar | Todo, en cada deploy |

El del medio es el peligroso. Declarar `DATA_DIR=/var/data` **no crea un disco**. Si el Disk no está montado, `/var/data` es una carpeta corriente del contenedor: se escribe bien, se lee bien, el nombre tranquiliza, y desaparece en el siguiente despliegue. Un `ls` no lo distingue.

Y lo que desaparece es el antiduplicados. Meta reintenta durante **36 horas** lo que no recibe un 200 —su documentación lo dice y añade que *el servidor debe encargarse de deduplicar*—, así que el reintento llega **después** del deploy que borró la memoria y se procesa como un mensaje nuevo.

### Lo que se añadió para cerrar eso

**Se comprueba, no se deduce.** Un disco montado es otro sistema de archivos, así que se comparan los ids de dispositivo de `DATA_DIR` y del código. Si coinciden, no hay disco.

```json
GET /health
{ "persistencia": "efimera", "almacenamiento_durable": false }
```

**Prueba empírica además de la deducción.** Cada arranque incrementa un contador en disco. Si tras varios despliegues sigue en 1, la carpeta se está borrando, diga lo que diga la configuración:

```json
GET /health?token=…
{ "marcador_de_disco": { "arranques": 7, "primerArranque": "…" } }
```

**Candado.** Con almacenamiento efímero, **el servidor se niega a arrancar si `RESPUESTA_AUTOMATICA=1`**. Recibir y verificar sí funciona; responder sin memoria durable, no. El mensaje de error dice qué hacer, y hay un escape explícito (`PERMITIR_SIN_PERSISTENCIA=1`) para una prueba controlada.

---

## 3 · Almacenamiento propuesto

### Fase 1 — ahora: disco persistente de Render

| | |
|---|---|
| Qué | Render Disk, 1 GB, `/var/data` |
| Coste | El disco se factura por GB/mes; **confírmalo en render.com/pricing**, no pude verificar la cifra exacta y no te la voy a inventar. Con 1 GB es un cargo marginal al lado de los $7 del servicio |
| Suficiente para | Unos cientos de miles de mensajes de diario |

**Por qué basta ahora:** en Fase 1 solo hay un registro append-only y un conjunto de ids. No hay consultas relacionales, ni concurrencia entre instancias, ni transacciones. Montar Postgres para esto sería pagar y operar una base de datos para escribir dos archivos de texto.

**Lo que cuesta un disco, y hay que saberlo:**

| Restricción | Consecuencia |
|---|---|
| **Desactiva los deploys sin interrupción** | La instancia vieja se detiene antes de arrancar la nueva: hay un hueco de unos segundos en cada deploy |
| **Una sola instancia** | `numInstances` debe ser 1; no hay escalado horizontal |
| **No disponible durante el build** | El disco no existe en `buildCommand` ni en `preDeployCommand` |

La primera suena peor de lo que es, y en realidad valida el diseño: durante ese hueco Meta no recibe el 200, y **reintenta durante 36 horas**. El reintento llega, y el antiduplicados —persistido en el disco que sobrevivió al deploy— impide procesarlo dos veces. Por eso el diario se escribe **antes** del 200 y el candado de duplicados está **en la puerta**: el deploy con hueco es exactamente el escenario para el que se diseñaron.

### Fase 2 — pedidos, conversaciones y estados: Render Postgres de pago

Cuando entren pedidos, el disco deja de ser suficiente. No por tamaño, por garantías:

| Lo que exigen los pedidos | Lo que un archivo JSON no da |
|---|---|
| Que guardar un pedido sea atómico | Un pedido a medias es un despacho equivocado |
| Que dos mensajes simultáneos del mismo cliente no se pisen | Leer-entero / escribir-entero pierde escrituras en cualquier `await` |
| Consultar "¿hay conversaciones donde el cliente confirmó y no quedó pedido?" | Recorrer archivos a mano |
| Copias de seguridad y recuperación a un punto en el tiempo | Un disco se restaura desde snapshot, con lo que hubiera |

**Propuesta:** Render Postgres, instancia de pago (desde unos 6 USD/mes + almacenamiento).

**No la gratuita.** La base de datos gratuita de Render **expira 30 días después de crearse**, con 14 días de gracia, y después se elimina con sus datos. Para pedidos reales eso no es una opción: es una fecha de caducidad silenciosa sobre la contabilidad del negocio.

El disco **no se tira** al llegar Postgres. El diario append-only sigue siendo útil al lado de una base de datos: es un registro inmutable de qué llegó exactamente por el webhook, independiente de cómo lo interpretó el código. Si mañana hay que reconstruir un pedido, se reconstruye desde ahí.

---

## 4 · Que la migración sea un cambio, no una reescritura

Todo el acceso a almacenamiento pasa por dos módulos con una interfaz estrecha:

```
src/almacen/diario.js    anotar(tipo, datos) · ultimas(n) · resumenDeHoy()
src/almacen/vistos.js    esNuevo(id) · cuantos()
```

Ningún otro módulo abre un archivo. `procesar.js` y `rutas.js` solo conocen esas funciones. Sustituir la implementación por Postgres es reescribir dos archivos sin tocar la lógica.

Dos decisiones de diseño que ya apuntan ahí:

- **`esNuevo(id)` marca y pregunta en una sola operación.** No es por comodidad: en Postgres eso es un `INSERT ... ON CONFLICT DO NOTHING RETURNING`, atómico de verdad. Si la interfaz fueran dos llamadas (`yaVisto()` y luego `marcar()`), cualquier `await` entre ellas abriría la ventana que el candado cierra, y la migración heredaría la carrera.
- **El diario es append-only.** Traducir a `INSERT` es directo. Un almacén que se reescribe entero —como el de BIKERPRO— no tiene traducción: hay que rediseñarlo.

**Esquema previsto para Fase 2** (`eventos`, `conversaciones`, `pedidos`, `vistos`), con los candados que ya sabemos que hacen falta: `oferta_id` para ligar la confirmación a una oferta concreta, estado de pedido explícito, y anulación como borrado suave idempotente.

---

## 5 · Fase 1 y Fase 2, separadas y probadas

Esta es la respuesta corta a tu pregunta 6: **para verificar la Callback URL no hace falta nada de esto.**

| | Fase 1 · conectar Meta | Fase 2 · responder y guardar |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | **obligatorio** | obligatorio |
| `META_APP_SECRET` | no hace falta | **obligatorio** |
| Disco persistente | no hace falta | **obligatorio** |
| Postgres | no | sí, al llegar los pedidos |
| `RESPUESTA_AUTOMATICA` | `0` | `1` |

El handshake de verificación es un `GET` que no escribe nada. Puedes completar el paso en el que estás ahora en Meta con **una sola variable**.

Y está probado, no afirmado. `test/fase1-sin-persistencia.test.js` corre con `META_APP_SECRET` y el filtro de número deliberadamente sin configurar, y fija que:

- el servidor arranca sin `META_APP_SECRET`, sin errores;
- Meta **puede** verificar la Callback URL en ese estado;
- el handshake no depende de que nada sobreviva en disco;
- un `POST` en ese estado se registra y **no** se procesa, y responde 200 (un 4xx repetido haría que Meta desactivara la suscripción, y entonces se dejan de recibir *todos* los mensajes);
- con almacenamiento efímero, encender las respuestas **no arranca**;
- con almacenamiento efímero y sin responder, solo avisa.

`test/persistencia.test.js` fija la detección: carpeta en el mismo dispositivo que el código → efímera; en otro dispositivo → disco; si se borra la carpeta, el contador de arranques vuelve a 1.

---

## 6 · Resumen

| Pregunta | Respuesta |
|---|---|
| ¿Qué se guarda en disco? | Diario de eventos, ids ya vistos, marcador de arranques. Ningún pedido todavía |
| ¿Qué se pierde en un redeploy? | Con el disco montado, nada. Sin disco, todo — y antes esto no se detectaba |
| ¿Qué almacenamiento se propone? | Fase 1: Render Disk de 1 GB. Fase 2: Render Postgres de pago, nunca el gratuito |
| ¿Se puede migrar sin reescribir? | Sí: dos módulos con interfaz estrecha, append-only y marcar-y-preguntar atómico |
| ¿Infraestructura cara ahora? | No. Un disco de 1 GB. Postgres entra cuando entren los pedidos |
| ¿Hace falta `META_APP_SECRET` para el handshake? | **No.** Solo para validar la firma de los POST |

### Antes de desplegar, comprueba

1. Render → tu servicio → **Disks** → debe aparecer `novika-datos` montado en `/var/data`
2. `GET /health` → `"persistencia": "disco-persistente"`
3. Despliega otra vez y mira `GET /health?token=…` → `marcador_de_disco.arranques` debe **subir**, no volver a 1

Si el paso 3 vuelve a 1, el disco no está montado: avísame antes de encender las respuestas.
