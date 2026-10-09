# Pendientes técnicos

Lo que está decidido pero no hecho. No incluye datos comerciales por
confirmar: esos viven en `DATOS-PENDIENTES.md`.

---

## 1 · Paginación completa en el almacén

**Estado:** pendiente. Decidido que hace falta; no empezado.

### Qué hay hoy

| Pieza | Dónde se calcula | Estado |
|---|---|---|
| Orden estable | almacén (`ORDER BY … , id ASC`) | ✅ hecho, probado en el contrato |
| Paginación | memoria, sobre lo leído | ⬜ pendiente |
| Filtros (6) | memoria | ⬜ pendiente |
| Búsqueda | memoria | ⬜ pendiente |
| Conteos de pestañas | memoria | ⬜ pendiente |

La bandeja lee hasta `PANEL_TECHO_CHATS` (20.000 por defecto) y filtra,
cuenta y pagina en memoria. Avisa cuando recorta.

**Eso es una ampliación, no una solución.** El techo sigue existiendo y el
coste crece con el volumen: con el backend de archivos, listar son N
lecturas de disco.

### Por qué no se hizo paginando antes de filtrar

Porque hacerlo mal es peor que el límite. Si se pagina **antes** de filtrar,
la página 1 de «sin pedido» trae solo los que haya entre los primeros 25 de
todos: páginas incompletas y contadores falsos. Un número equivocado no se
nota; un aviso sí.

Filtrar antes de paginar **sí es posible** —y es lo correcto— pero exige
bajar los filtros al almacén, y hoy no se puede porque no son columnas.

### Lo que falta, concreto

1. **Materializar los filtros derivados.** `esperando` y `en_curso` dependen
   de quién habló el último mensaje y cuándo, y los mensajes viven en un
   JSONB. Hacen falta columnas (`ultimo_de`, `ultimo_ts`, `atendido_en`) o
   una vista, con índices.
2. **`con_pedido` / `sin_pedido` cruzan dos tablas.** Necesitan un `EXISTS`
   o un contador denormalizado en `conversaciones`.
3. **Búsqueda.** Hoy compara contra nombre, teléfono, ciudad, producto y el
   texto del último mensaje. En SQL, índice `pg_trgm` o una columna
   `tsvector`; en archivos, un índice en disco.
4. **Implementarlo dos veces**, en PostgreSQL y en archivos, idénticos.

### El riesgo que hay que cubrir

Dos implementaciones del mismo filtro **se separan con el tiempo**. No es
teórico: ya pasó en este repo con las dos listas de «pregunta de precio»
—`texto.js` y `preguntas.js`— cada una con sus huecos, y el resultado fue
que preguntar por dos unidades no se reconocía.

**Mitigación obligatoria:** pruebas en `repos/contrato.js` que comparen el
resultado del almacén contra el cálculo en memoria sobre un conjunto
sembrado, para los seis filtros y la búsqueda. Sin esas pruebas, el cambio
introduce más riesgo del que quita.

### Cuándo deja de poder esperar

- Cuando la bandeja muestre el aviso de recorte en producción.
- O cuando cargar `/panel/chats` empiece a tardar de forma perceptible.

Mientras no pase ninguna de las dos, el techo con aviso es suficiente y
este trabajo tiene menos valor que mejorar la conversación.

---

## 2 · Verificar la prosa del modelo real

**Estado:** bloqueado por credenciales.

Lo verificado con un proveedor **simulado** demuestra el reparto
—quién redacta cada mensaje— y que los filtros tumban un importe inventado.
**No demuestra qué redactará el modelo real en producción.** Son cosas
distintas y no deben presentarse juntas.

Para cerrarlo hace falta `IA_API_KEY` en un entorno de pruebas, o capturas
de producción.

Nota: el proveedor es OpenAI-compatible (`IA_BASE_URL`, `IA_MODELO`), así
que cuál modelo responde depende de esas variables en Render. `/health` no
las publica.

---

## 3 · Auditar producción

**Estado:** herramienta lista, ejecución bloqueada por credenciales.

`herramientas/auditar.js` funciona en modo lectura estricto y está
verificada contra casos sembrados. Para correrla contra producción hace
falta `DATABASE_URL` de solo lectura, o ejecutarla en el entorno de Render.

---

## 4 · Los clientes con nombre de usuario de WhatsApp (BSUID)

**Estado:** diagnosticado. Hace falta una decisión de Marco y una
comprobación en la consola de Meta.

**Es el 24 % del tráfico del anuncio, y se está tirando a la basura.**

En la auditoría del 2026-10-09, **6 de 25 chats** del panel llegaron con un
identificador tipo `CO.1234567890123456` en vez de un teléfono. El bot prepara
la respuesta, el emisor la descarta con `destinatario_sin_telefono` y queda la
tarea. Los mensajes que el operador manda a mano **también fallan**
(`fallo_de_envio`). Antes de que existiera el candado, Meta los rechazaba con
el error **131026**.

### Qué es esto

No es un defecto de NOVIKA: es un cambio de plataforma de Meta.

WhatsApp está desplegando **nombres de usuario**, una opción de privacidad que
permite al usuario ocultar su teléfono a los negocios con los que escribe. Para
que el negocio siga pudiendo identificarlo, Meta introduce el
**business-scoped user ID (BSUID)**: un identificador por usuario y por
portafolio de negocio, que aparece en los webhooks y **puede sustituir al
teléfono** en los campos `from` y `wa_id`.

- Los webhooks empezaron a incluir el campo de identidad `user_id` el
  **31 de marzo de 2026** ([Medium · Meta BSUID is live in WhatsApp Cloud API](https://medium.com/@matthias_20536/meta-bsuid-is-live-in-whatsapp-cloud-api-what-to-change-in-your-webhooks-and-crm-9b6dc69058dd)).
- El BSUID es **distinto para cada negocio**: la misma persona tiene uno
  diferente por cada marca a la que escribe ([architjn · BSUID y claves de CRM](https://architjn.com/blog/whatsapp-bsuid-breaks-phone-crm-keys-2026)).
- Microsoft documenta, para su propio conector, que **enviar a un BSUID queda
  disponible a partir de junio de 2026**, y que hasta entonces el campo `to`
  solo acepta teléfonos ([Azure Communication Services · WhatsApp usernames y BSUID](https://learn.microsoft.com/en-us/azure/communication-services/concepts/advanced-messaging/whatsapp/whatsapp-username-support-overview)).
- Algunos proveedores ya aceptan el BSUID en un campo aparte (`recipient`)
  junto al `to`, y el teléfono tiene precedencia si van los dos
  ([YCloud · BSUID API & webhook updates](https://docs.ycloud.com/reference/webhook-updates-bsuid)).

*Contenido reformulado para cumplir las restricciones de licencia de las
fuentes.*

### Qué hay que hacer, en este orden

1. **Comprobar la versión de la Graph API** que usa `src/whatsapp/enviar.js`
   contra la documentación oficial de Meta, y si la cuenta de NOVIKA ya tiene
   habilitado el envío a BSUID. Esto es mirar la consola, no código.
2. **Si está habilitado:** el cambio es pequeño y vive en un solo sitio
   —`enviar.js` es el único camino al exterior—. Debe ir **detrás de una
   variable de entorno** (`WHATSAPP_ENVIAR_A_BSUID=1`, apagada por defecto) y
   **conservando la tarea como respaldo**: si Meta vuelve a rechazar, el chat
   tiene que seguir apareciendo en la bandeja. Un reintento que falla en
   silencio es peor que el candado actual.
3. **Mientras no esté:** los seis chats son clientes reales que preguntaron el
   precio y nadie les contestó. Hoy quedan visibles en `/panel/sin-responder`
   con el motivo en castellano, que es lo único que se puede hacer desde
   nuestro lado.

### Lo que NO se puede hacer

- **No se puede inventar el teléfono.** El candado de `enviar.js` existe porque
  antes se intentaba mandar al BSUID y Meta lo rechazaba: ocho fallos el
  07-oct. Quitarlo sin la capacidad habilitada reproduce exactamente eso.
- **No se puede responder por otro canal.** No hay ninguno aprobado, y el bot
  no puede prometer una llamada que nadie va a hacer.

### Por qué importa el número

Si el 24 % se mantiene, de cada 100 clics del anuncio **24 no reciben
respuesta**. Es la fuga más grande que queda, y es la única de este informe
que no se arregla escribiendo código en este repositorio.
