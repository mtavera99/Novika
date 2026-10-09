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


## 4 · Los clientes con nombre de usuario (BSUID): ya se les escribe, pero no se les puede despachar

**Estado:** el envío está **resuelto** (PR #48). Lo que queda es el despacho, y
es una decisión de Marco.

### Corrección de un error mío (2026-10-09)

En la primera versión de este documento escribí que a estos clientes **no se
les puede responder** y lo presenté como la fuga más grande que quedaba, con
un 24 % del tráfico. **Era falso**, y el error estuvo en cómo leí la
evidencia.

Vi seis chats en el panel con `no enviado: destinatario_sin_telefono` y
concluí que el problema seguía abierto. Pero esos seis mensajes son de las
**09:38, 11:17 y 12:37 del 08-oct**, y el arreglo (#48) se mezcló a las
**13:28 de ese mismo día**. Estaba mirando fallos anteriores al arreglo y
tratándolos como el estado actual.

Es justo el error que este repositorio tiene anotado como regla:
*«no afirmar nada que no venga de una salida verificada»*. Un chat del panel
es una foto del pasado, no del código que corre ahora.

### Lo que sí está implementado

`src/whatsapp/enviar.js` distingue un teléfono de un BSUID
(`{país ISO}.{alfanumérico}`) y los direcciona distinto, porque Meta lo exige
distinto:

- teléfono → va en `to`
- BSUID → va en `recipient`, y **se omite `to`**

El comentario del código deja escrito el error anterior: se mandaba el BSUID
en `to`, y eso es lo que Meta rechazaba con el **131026**. La conclusión de
entonces —«a estos clientes no se les puede escribir»— era una conclusión sin
comprobar, y Marco tenía razón al dudarla.

### Lo que sigue pendiente, y es distinto

Un BSUID **no trae teléfono**, y la transportadora llama al cliente para
entregar. Así que:

- **se le puede vender** y conversar con normalidad;
- **no se le puede despachar** sin pedirle el celular, porque
  `REQUERIDOS_PARA_DESPACHAR` lo exige — y con razón: un contraentrega sin
  número es un paquete que vuelve.

El bot ya lo pide con esas palabras («tu número de celular»), que es la regla
que pidió Marco. Lo que no está decidido:

- **¿Qué hacer si el cliente no quiere dar el celular?** Hoy queda como tarea
  en `/panel/sin-responder`. Las opciones son pedirlo una vez más, ofrecer
  otra forma, o dejarlo en manos de una persona. Es una decisión comercial.

### Qué conviene comprobar

El arreglo está desplegado pero **no se ha verificado contra un cliente BSUID
real posterior al 13:28 del 08-oct** — en los chats que auditué no hay
ninguno. Cuando entre el siguiente, mirar en su chat que el mensaje salga sin
`no enviado`. Si volviera a fallar con 131026, el sitio es
`destinatarioDe()` en `src/whatsapp/enviar.js`, y el dato a revisar es la
versión de la Graph API contra la documentación de Meta.

### Fuentes

El BSUID es un cambio de plataforma de Meta, no algo de NOVIKA. Para
contexto, si hay que volver a mirarlo:

- Los webhooks incluyen el campo de identidad `user_id` desde el
  **31 de marzo de 2026** ([Medium · Meta BSUID is live in WhatsApp Cloud API](https://medium.com/@matthias_20536/meta-bsuid-is-live-in-whatsapp-cloud-api-what-to-change-in-your-webhooks-and-crm-9b6dc69058dd)).
- El BSUID es **distinto por negocio**: la misma persona tiene uno diferente
  por cada marca a la que escribe ([architjn · BSUID y claves de CRM](https://architjn.com/blog/whatsapp-bsuid-breaks-phone-crm-keys-2026)).
- El envío a BSUID se habilitó por fases a partir de **junio de 2026**
  ([Azure Communication Services · WhatsApp usernames y BSUID](https://learn.microsoft.com/en-us/azure/communication-services/concepts/advanced-messaging/whatsapp/whatsapp-username-support-overview)).

*Contenido reformulado para cumplir las restricciones de licencia de las
fuentes.*
