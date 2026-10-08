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
