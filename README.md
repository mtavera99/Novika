# NOVIKA

Bot de WhatsApp para NOVIKA — *productos que hacen tu día más fácil*.

E-commerce colombiano **multiproducto y multicategoría**: hogar, tecnología, bienestar, herramientas, accesorios y lo que venga. El bot está diseñado desde el principio para que añadir un producto sea rellenar un archivo, no reconstruir el bot.

> **Proyecto independiente.** NOVIKA no comparte base de datos, pedidos, chats, números, tokens, webhooks, variables de entorno, catálogo, configuración de Meta ni infraestructura con ningún otro proyecto. Hay candados en el código que lo hacen cumplir: ver [`src/aislamiento.js`](src/aislamiento.js).

## Estado

**Fase 2 (cerebro) en modo sombra · Fase 3A (PostgreSQL) preparada sin activar.** NOVIKA procesa el mensaje de principio a fin, prepara la respuesta, la valida contra los hechos y la registra. **No la envía.**

| | |
|---|---|
| Verificación del webhook de Meta | ✅ |
| Firma `X-Hub-Signature-256` | ✅ obligatoria para procesar |
| Deduplicación de eventos | ✅ persistida, por *terminado* |
| Recuperación de trabajo tras un crash | ✅ automática al arrancar |
| Diario de eventos en disco | ✅ |
| Aislamiento respecto a BIKERPRO | ✅ arranque + por evento |
| Persistencia comprobada, no supuesta | ✅ disco de Render + candado |
| Esquema de catálogo multiproducto | ✅ sin productos activos |
| Identificación de producto con prioridad y falsa señal | ✅ |
| Confirmación determinista y blindaje de lo confirmado | ✅ |
| Cotizador determinista (el LLM no produce importes) | ✅ |
| Pedidos con snapshot e idempotencia doble | ✅ |
| Modificaciones y cancelaciones versionadas | ✅ |
| Modo sombra + métricas | ✅ |
| Productos reales en el catálogo | ❌ pendiente de la ficha |
| Proveedor de IA configurado | ❌ funciona sin él |
| PostgreSQL | ⏳ adaptador listo y verificado, **sin activar** |
| **Respuestas a clientes** | ❌ **`RESPUESTA_AUTOMATICA=0`** |

**No hay productos, precios, promesas ni políticas definidas.** A propósito: el catálogo solo tiene la plantilla. Un dato comercial inventado que se cuela es un cobro incorrecto.

## Arrancar en local

```bash
npm install
cp .env.example .env     # rellena WHATSAPP_VERIFY_TOKEN
npm run comprobar-config # dice qué falta, sin levantar nada
npm start
npm test
```

Comandos de la base de datos (ninguno se ejecuta al desplegar):

```bash
npm run comprobar-postgres  # revisión de SOLO LECTURA: ¿se puede migrar?
npm run migrar              # aplicar el esquema
npm run cutover             # archivos → postgres (· --simular · --inverso)
npm run congelar            # frenar las escrituras durante el cutover
```

## Conectarlo a WhatsApp

Paso a paso, incluido qué pegar exactamente en Meta: **[`docs/META-WHATSAPP.md`](docs/META-WHATSAPP.md)**.

Resumen: generar el token de verificación → desplegar en Render → pegar `https://<servicio>.onrender.com/webhook` y el token en Meta → pulsar "Verificar y guardar" → suscribir `messages`.

## Rutas

| Ruta | Acceso | Para qué |
|---|---|---|
| `GET /` | público | ¿vive el proceso? |
| `GET /health` | público | ¿está en condiciones de atender? ¿el almacenamiento es durable? |
| `GET /health?token=…` | `PANEL_TOKEN` | detalle operativo |
| `GET /eventos?token=…` | `PANEL_TOKEN` | diario: ¿llegó el evento y fallamos, o Meta no llegó? |
| `GET /metricas?token=…` | `PANEL_TOKEN` | contadores. Sólo números, sin PII |
| `GET /webhook` | Meta | handshake de verificación |
| `POST /webhook` | Meta (firmado) | eventos |

`/health` responde a casi cualquier "no funciona" con tres banderas: `firma_activa`, `puede_enviar` y `respuesta_automatica`.

## El principio

> **Una instrucción al modelo no es un candado.**

La IA entiende, conversa y redacta. Todo lo que puede causar un cobro, un despacho o una devolución equivocada se calcula en código y se prueba. Cuando el modelo se equivoca, el arreglo es un candado y una prueba, no un párrafo más de prompt.

Y una asimetría deliberada: ante la ambigüedad **nunca se descarta una venta real**; se guarda marcada y la revisa una persona.

Cómo viaja un mensaje y dónde está cada candado: [`docs/CEREBRO.md`](docs/CEREBRO.md). Arquitectura general: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

La línea que hay que mirar en `/metricas`:

```
respuesta_preparada   puede subir
respuesta_enviada     tiene que quedarse en 0
```

Qué se guarda, qué se pierde en un redeploy y a dónde va a migrar: [`docs/PERSISTENCIA.md`](docs/PERSISTENCIA.md).

## Almacenamiento transaccional

Hoy: **archivos** sobre el Render Disk. Preparado y verificado: **PostgreSQL**, con el mismo contrato y las mismas pruebas.

```
repos/index.js  --+- archivos/   <- hoy (DATABASE_URL vacia)
                  +- postgres/   <- verificado, sin activar
```

Lo que aporta la base: la idempotencia de pedidos deja de depender de un indice en disco y pasa a dos indices `UNIQUE` del motor; la concurrencia por contacto deja de depender de una cola en memoria y pasa a `pg_advisory_xact_lock`.

Lo que **no** se mueve: la bitacora de trabajo del webhook se queda en el disco, porque es lo unico que tiene que funcionar cuando la base no responda. Detalle y que hay que crear en Render: [`docs/POSTGRES.md`](docs/POSTGRES.md).

## Almacenamiento

El sistema de archivos de un Web Service de Render es **efímero**. `render.yaml` monta un Disk de 1 GB en `/var/data`, y el servidor **comprueba** al arrancar que ese disco exista de verdad —comparando sistemas de archivos— en vez de confiar en que `DATA_DIR` esté definida. `/health` lo publica:

```json
{ "persistencia": "disco-persistente", "almacenamiento_durable": true }
```

Con almacenamiento efímero, recibir y verificar el webhook funciona igual, pero **el servidor se niega a arrancar con `RESPUESTA_AUTOMATICA=1`**: sin memoria que sobreviva al despliegue, un reintento de Meta se procesa dos veces.

Para verificar la Callback URL en Meta **no hace falta disco ni `META_APP_SECRET`**: basta `WHATSAPP_VERIFY_TOKEN`. Está probado en `test/fase1-sin-persistencia.test.js`.

## Panel operativo

Todo lo que hace falta para dirigir el día: tablero, bandeja de chats, conversación con respuesta manual, venta manual, indicadores, auditoría, y el **despacho de punta a punta** — subir el PDF de guías de la transportadora y repartir cada una a su cliente, y avisar las novedades de entrega desde su reporte.

Se entra por `/panel` con `PANEL_TOKEN`, por formulario: el token **no** viaja en la URL, que se queda en el historial, en los `Referer` y en los logs de cualquier proxy.

Dos cosas que conviene saber antes de usarlo:

- **Los envíos manuales tienen su propio interruptor**, `PANEL_ENVIO_MANUAL`, apagado por defecto. El panel se opera completo —se sube el PDF, se revisa el pareo, se lee el mensaje exacto de cada cliente— y al enviar, cada fila dice que la frenó el interruptor. Nunca un envío fingido.
- **Aceptado por Meta no es entregado.** El panel distingue las tres cosas: aceptado (con su `wamid`), bloqueado por un interruptor (y cuál), y fallido (con el motivo traducido). La entrega real solo se da por buena con el acuse del webhook.

Detalle: [`docs/PANEL.md`](docs/PANEL.md) y [`docs/DESPACHO.md`](docs/DESPACHO.md).

## Siguiente

1. **Definir los primeros productos** (decisión del dueño: precios, políticas, garantías, cobertura)
2. **Crear las plantillas en Meta y esperar su aprobación** — `PLANTILLA_NOVEDAD_DIRECCION`, `_AUSENTE`, `_OFICINA` y `PLANTILLA_GUIA`. Es lo único que separa el despacho de estar operativo: la guía y las novedades caen siempre fuera de la ventana de 24 h, y fuera de ella Meta solo entrega plantillas
3. Ejecutar el cutover a PostgreSQL — el adaptador ya pasa las mismas pruebas de contrato; falta la operación, desde el Shell de Render
4. Configurar el proveedor de IA
5. Auditar conversaciones reales en modo sombra
6. Encender `RESPUESTA_AUTOMATICA` — sólo después de 5

## Repositorio

Público. **Ningún secreto vive aquí**: todas las credenciales van en variables de entorno, y CI falla si aparece un `.env`.
