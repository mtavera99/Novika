# NOVIKA

Bot de WhatsApp para NOVIKA — *productos que hacen tu día más fácil*.

E-commerce colombiano **multiproducto y multicategoría**: hogar, tecnología, bienestar, herramientas, accesorios y lo que venga. El bot está diseñado desde el principio para que añadir un producto sea rellenar un archivo, no reconstruir el bot.

> **Proyecto independiente.** NOVIKA no comparte base de datos, pedidos, chats, números, tokens, webhooks, variables de entorno, catálogo, configuración de Meta ni infraestructura con ningún otro proyecto. Hay candados en el código que lo hacen cumplir: ver [`src/aislamiento.js`](src/aislamiento.js).

## Estado

**Fase 1 — recepción.** El webhook está listo. NOVIKA recibe, verifica y registra. Todavía no responde.

| | |
|---|---|
| Verificación del webhook de Meta | ✅ |
| Firma `X-Hub-Signature-256` | ✅ obligatoria para procesar |
| Deduplicación de eventos | ✅ persistida |
| Diario de eventos en disco | ✅ |
| Aislamiento respecto a BIKERPRO | ✅ arranque + por evento |
| Esquema de catálogo multiproducto | ✅ sin productos activos |
| Respuestas a clientes | ❌ `RESPUESTA_AUTOMATICA=0` |
| Cotización y pedidos | ❌ fase 2 |

**No hay productos, precios, promesas ni políticas definidas.** A propósito: el catálogo solo tiene la plantilla. Un dato comercial inventado que se cuela es un cobro incorrecto.

## Arrancar en local

```bash
npm install
cp .env.example .env     # rellena WHATSAPP_VERIFY_TOKEN
npm run comprobar-config # dice qué falta, sin levantar nada
npm start
npm test
```

## Conectarlo a WhatsApp

Paso a paso, incluido qué pegar exactamente en Meta: **[`docs/META-WHATSAPP.md`](docs/META-WHATSAPP.md)**.

Resumen: generar el token de verificación → desplegar en Render → pegar `https://<servicio>.onrender.com/webhook` y el token en Meta → pulsar "Verificar y guardar" → suscribir `messages`.

## Rutas

| Ruta | Acceso | Para qué |
|---|---|---|
| `GET /` | público | ¿vive el proceso? |
| `GET /health` | público | ¿está en condiciones de atender? |
| `GET /health?token=…` | `PANEL_TOKEN` | detalle operativo |
| `GET /eventos?token=…` | `PANEL_TOKEN` | diario: ¿llegó el evento y fallamos, o Meta no llegó? |
| `GET /webhook` | Meta | handshake de verificación |
| `POST /webhook` | Meta (firmado) | eventos |

`/health` responde a casi cualquier "no funciona" con tres banderas: `firma_activa`, `puede_enviar` y `respuesta_automatica`.

## El principio

> **Una instrucción al modelo no es un candado.**

La IA entiende, conversa y redacta. Todo lo que puede causar un cobro, un despacho o una devolución equivocada se calcula en código y se prueba. Cuando el modelo se equivoca, el arreglo es un candado y una prueba, no un párrafo más de prompt.

Y una asimetría deliberada: ante la ambigüedad **nunca se descarta una venta real**; se guarda marcada y la revisa una persona.

Detalle completo en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Siguiente

1. Verificar el webhook en Meta y recibir el primer mensaje real
2. Definir los primeros productos de NOVIKA (**decisión del dueño**: precios, políticas, garantías, cobertura)
3. Envío de mensajes con política de reintentos
4. Flujo conversacional con IA, acotado a datos autorizados
5. Cotización determinista
6. Pedidos: confirmación inequívoca, modificaciones, cancelaciones, antiduplicados
7. Panel y auditoría

## Repositorio

Público. **Ningún secreto vive aquí**: todas las credenciales van en variables de entorno, y CI falla si aparece un `.env`.
