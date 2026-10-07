# NOVIKA — contexto del proyecto

## Qué es

Marca colombiana de e-commerce. *Productos que hacen tu día más fácil.*

**Multiproducto y multicategoría** desde el primer día: hogar, tecnología, bienestar, herramientas, accesorios y categorías que todavía no existen. Añadir un producto debe ser rellenar un archivo JSON en `catalogo/productos/`, no tocar código.

## Aislamiento respecto a BIKERPRO — no negociable

Existe otro proyecto del mismo dueño: **BIKERPRO** (`mtavera99/impermeables`), un bot de WhatsApp que vende impermeables para motociclistas.

Se puede **leer** BIKERPRO para aprender de cómo resolvió problemas. Es **solo lectura**: no se modifica, no se commitea, no se abren PRs, no se toca su configuración, sus variables, su Meta, su Render ni sus Actions. No se implementan funciones de NOVIKA dentro de BIKERPRO.

Pueden compartir **aprendizajes y patrones técnicos**. No pueden compartir base de datos, pedidos, chats, números de WhatsApp, tokens, webhooks, variables de entorno, catálogos, productos, configuración de Meta ni infraestructura.

Si hay que elegir entre reutilizar algo rápido de BIKERPRO o mantener NOVIKA aislada, **gana el aislamiento**.

Hay candados que lo hacen cumplir en `src/aislamiento.js`: el proceso no arranca si detecta un identificador de BIKERPRO en la configuración, y descarta todo evento cuyo `phone_number_id` no sea el de NOVIKA.

## El principio técnico

> **Una instrucción al modelo no es un candado.**

| La IA | El código |
|---|---|
| entender intención, conversar, redactar | producto, precio, cantidad, variantes, total |
| responder con información autorizada | datos del cliente, estado del pedido |
| detectar señales de compra | confirmación, cancelación, modificaciones |
| | deduplicación, persistencia, validaciones |

Cuando el modelo se equivoca, el arreglo es **un candado y una prueba**, no un párrafo más de prompt.

## Prioridades, en orden

1. No perder ventas
2. No cobrar valores incorrectos
3. No guardar pedidos incorrectos
4. No confundir productos
5. No duplicar pedidos
6. No inventar información
7. Minimizar devoluciones causadas por el bot

Lo cosmético va después.

**Asimetría deliberada:** ante la ambigüedad nunca se descarta una venta real. Se guarda marcada y la revisa una persona. Ante ambigüedad de cantidad, se elige la menor.

## No inventar información comercial

Los productos reales de NOVIKA **todavía no están definidos**. Nunca inventar precios, promociones, garantías, tiempos de entrega, características, cobertura, especificaciones, políticas ni costos de envío.

Si falta un dato comercial: dejarlo parametrizable, anotarlo en `pendientes` del producto, y **preguntar al dueño** antes de convertirlo en regla de producción. Un producto con `pendientes` no puede ponerse `activo`: la validación lo rechaza.

## Forma de trabajo

Etapas pequeñas y verificables. Cada cambio con una razón concreta. Pruebas para los comportamientos críticos, y cada prueba documenta en su cabecera el incidente o el riesgo que la originó.

Si una decisión podría contaminar BIKERPRO o mezclar los dos proyectos: **parar y preguntar**.

## Fase 2: el cerebro

Cuatro capas, con una regla de dependencia estricta: **el dominio no conoce el mundo**.

- `src/dominio/` — puro. Sin I/O, sin IA, sin `process.env`. Aquí viven los hechos: confirmación, cotización, estados, validación, pedido, extracción heurística.
- `src/catalogo/` — fuente de verdad del producto e identificación por señales con prioridad.
- `src/ia/` — desacoplada. El modelo **no devuelve hechos, devuelve candidatos**; su salida pasa por un contrato de lista cerrada y si no cumple se descarta completa.
- `src/almacen/repos/` — interfaces con pruebas de contrato. Archivos hoy, PostgreSQL después.
- `src/cerebro/` — coordina. No decide hechos.

Reglas que no se negocian:

- **La confirmación se evalúa ANTES de llamar a la IA.** El modelo no puede influir en si existe un pedido.
- **Todo el turno va dentro de `enSerie(contactoId)`.** Cada `await` es un punto de entrada para otra tarea; sin la cola, dos mensajes seguidos del mismo cliente crean dos pedidos.
- **El candado del envío vive en `src/whatsapp/enviar.js`**, que es el único camino al exterior. No en la capa de arriba: eso sería una instrucción, y las instrucciones se incumplen.
- **No hay producto por defecto.** Sin señal, producto desconocido y se pregunta.
- **`valorConfirmado()` devuelve `null` si el dato no está confirmado.** Nunca el candidato "por si sirve". Si alguien "mejora" esa línea, el sistema pierde su frontera.
- **Nunca contestar 200 sin que el trabajo esté reclamado en disco.** Meta deja de reintentar al recibir el 200; sin registro durable, un crash pierde el mensaje en silencio. Se deduplica por `terminado`, no por "visto": un evento visto a medias es trabajo pendiente, no un duplicado.
- **La recuperación pasa por `atenderEvento()`**, el mismo camino que un evento nuevo. Un camino aparte divergiría, y el que casi nunca se ejecuta es el que acaba roto.
- **Dos claves de idempotencia**, porque hay dos duplicados distintos: retransmisión del webhook (`claveDeEvento`) y "sí" repetido (`claveDeOferta`).
- **Snapshot en el pedido.** Si mañana sube el precio, el pedido de ayer conserva el suyo.

Detalle en `docs/CEREBRO.md`.

## Convenciones

- Node ≥ 20, CommonJS, sin paso de compilación. Dependencias: `express` y `dotenv`. Nada más sin una razón.
- Pruebas con `node:test`. `npm test`. Sin credenciales, sin red, sin escribir fuera de `/tmp`.
- Código y comentarios en español, sin acentos en el código fuente (sí en la documentación).
- Un único módulo lee `process.env`: `src/config.js`. **Ningún secreto tiene valor por defecto**; si falta, el proceso no arranca.
- Nombres por lo que hacen: `vistos.esNuevo()`, `diario.anotar()`, `revisarFirma()`.
- Los comentarios explican **por qué**, no qué. Si una decisión viene de un incidente, se cita el incidente.
- Los datos de clientes se enmascaran en los logs salvo `LOG_PII=1`. El log **no** es la base de datos.

## Almacenamiento

El sistema de archivos de un Web Service de Render es **efímero**. Nada crítico —deduplicación, diario, y más adelante pedidos, conversaciones y estados— puede depender de almacenamiento que desaparezca en un despliegue.

- **Fase 1:** Render Disk de 1 GB en `/var/data`. El servidor **comprueba** que el disco exista (comparando sistemas de archivos) en vez de confiar en `DATA_DIR`, y lleva un contador de arranques como prueba empírica.
- **Fase 3A (hecha):** adaptador de PostgreSQL listo y verificado contra una base real, pasando **las mismas** pruebas de contrato que el de archivos. Sin activar: `DATABASE_URL` vacía en producción. Render Postgres **de pago**; nunca el gratuito, que expira a los 30 días y luego se elimina con sus datos.
- **La bitácora de trabajo del webhook NO se mueve a Postgres.** Es lo único que tiene que funcionar cuando la base no responda: de ella depende contestar 200 a Meta sin perder el mensaje. Si el reclamo dependiera de la base, una caída obligaría a devolver 503 y Meta acabaría desactivando la suscripción.
- **El cutover exige congelar las escrituras y lo VERIFICA con una huella** del origen antes y después. Un cutover que copia un origen en movimiento se declara exitoso dejando pedidos fuera; se midió. Congelado, el webhook sigue contestando 200 y reclamando en el disco, pero no procesa: el recuperador vacía la cola al reiniciar.
- **El punto de no retorno** es el reinicio con `DATABASE_URL` puesta y las escrituras descongeladas. Antes: quitar la variable es seguro. Después: hay que hacer el cutover inverso (`npm run cutover -- --inverso`), porque quitar la variable perdería lo escrito en PostgreSQL.
- **Las migraciones no se aplican al arrancar.** `npm run migrar` es una decisión, no un efecto secundario de desplegar. Si falta el esquema, el arranque falla y lo dice.
- Todo el acceso a almacenamiento pasa por `src/almacen/diario.js` y `src/almacen/vistos.js`. Ningún otro módulo abre un archivo, para que migrar sea un cambio y no una reescritura.
- `esNuevo(id)` marca y pregunta en una sola operación, porque en Postgres eso es un `INSERT ... ON CONFLICT` atómico. Dos llamadas separadas heredarían una carrera.
- Con almacenamiento efímero, `RESPUESTA_AUTOMATICA=1` **bloquea el arranque**.

Detalle en `docs/PERSISTENCIA.md`.

## Estado

Fase 1 (recepción) completa: webhook verificable, firma obligatoria, deduplicación persistida, diario en disco, esquema de catálogo.

Pendiente: definir productos reales, envío de mensajes, flujo conversacional, cotización, pedidos, panel.

`RESPUESTA_AUTOMATICA=0`: **NOVIKA no le escribe a ningún cliente todavía.** No cambiar sin autorización explícita del dueño. Las pruebas de respuesta usan dobles; nunca mensajes reales.

Fase 2 (cerebro) completa en modo sombra: 372 pruebas en verde, sin credenciales y sin red.
