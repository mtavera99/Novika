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

## Convenciones

- Node ≥ 20, CommonJS, sin paso de compilación. Dependencias: `express` y `dotenv`. Nada más sin una razón.
- Pruebas con `node:test`. `npm test`. Sin credenciales, sin red, sin escribir fuera de `/tmp`.
- Código y comentarios en español, sin acentos en el código fuente (sí en la documentación).
- Un único módulo lee `process.env`: `src/config.js`. **Ningún secreto tiene valor por defecto**; si falta, el proceso no arranca.
- Nombres por lo que hacen: `vistos.esNuevo()`, `diario.anotar()`, `revisarFirma()`.
- Los comentarios explican **por qué**, no qué. Si una decisión viene de un incidente, se cita el incidente.
- Los datos de clientes se enmascaran en los logs salvo `LOG_PII=1`. El log **no** es la base de datos.

## Estado

Fase 1 (recepción) completa: webhook verificable, firma obligatoria, deduplicación persistida, diario en disco, esquema de catálogo.

Pendiente: definir productos reales, envío de mensajes, flujo conversacional, cotización, pedidos, panel.

`RESPUESTA_AUTOMATICA=0`: NOVIKA no le escribe a ningún cliente todavía.
