# NOVIKA · estado al 2026-10-08 y lo que falta

Documento de traspaso. Lo pidió Marco para abrir una sesión nueva sin
gastar la mitad del contexto redescubriendo lo ya hecho.

**Léelo completo antes de tocar nada.** Y lee también
`docs/VOZ-DE-BIKERPRO.md`, que es el material de referencia ya extraído.

---

## Dónde está todo

| Qué | Dónde |
|---|---|
| Repo | `mtavera99/Novika` · rama `main` |
| Producción | https://novika-bot.onrender.com · Render, plan starter, 1 instancia |
| Panel | `/panel` · cookie de sesión con `PANEL_TOKEN` |
| Almacén | PostgreSQL (`DATABASE_URL`) · disco `/var/data` para el diario |
| BIKERPRO (referencia **solo lectura**) | `mtavera99/impermeables` · copia local en `_ref_bikerpro_readonly` (`a89f51c`) |
| Panel de BIKERPRO | `https://bikerpro-bot.onrender.com/panel?token=…` |

**Estado de los interruptores (no tocar sin que Marco lo pida):**
`numeros_de_prueba: 0` (abierto al público) · `respuesta_automatica: 1` ·
`panel_envio_manual: 1` · IA configurada (proveedor OpenAI-compatible vía
`IA_BASE_URL`/`IA_MODELO`).

**Entorno de desarrollo:** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`
en **cada** llamada (node v22). Postgres local:
`sh /projects/sandbox/pg-local.sh` + `DATABASE_URL_PRUEBAS=…` en la **misma**
invocación. Cada comando es un contenedor nuevo: `/tmp` se borra y los
procesos no sobreviven.

**Pruebas:** `npm test` → 862 sin base (1 omitida), **917 con Postgres**.

---

## Lo que se arregló el 2026-10-08 (PRs #25 – #39)

Todo desplegado y verificado en producción.

### Diálogo

1. **El plural no se reconocía.** «¿qué valen dos?» no era una pregunta de
   precio. Había **dos** listas de patrones (`texto.js` y `preguntas.js`) que
   se habían separado; ahora hay una.
2. **Se contestaba el precio de otra cantidad.** La cantidad *preguntada* no
   existía como dato. Ahora se cotiza para informar, sin tocar ficha, oferta
   ni pedido. Por 3 unidades (sin tarifa) **no se improvisa**: se dice y queda
   tarea.
3. **El cliente no podía corregir sus datos.** «espera, la dirección es…» no
   cambiaba nada y el pedido salía a la vieja. `campos.reabrir` existía y solo
   se llamaba desde el panel. Ahora el **cliente** puede corregir; la **IA**
   sigue sin poder.
4. **El resumen no decía a dónde va el paquete.** Se aprobaba a ciegas.
5. **«dime qué necesitas» ante preguntas claras.** La guarda anti-eco exigía
   temas idénticos.
6. **«¿qué precio tiene el envío?»** soltaba además el precio del producto.
7. **Preguntar el precio pedía la dirección** («vale» es *de acuerdo*… y el
   verbo de «¿cuánto vale?»).
8. **«quiero información» se trataba como compra.** Era el primer mensaje de
   los clientes de publicidad. Ahora se presenta el producto sin pedir datos.
9. **Dar una ciudad no es comprar.** El cierre tras un dato ahora exige señal
   de compra previa.
10. **No se promete despacho, y menos «hoy».** `para despachártelo hoy` →
    `para preparar tu pedido`. 14 frases nuevas en `claimsProhibidos`.
11. **Ni respuesta inmediata.** Fuera «enseguida», «en un momento» y
    «momentico» (estas dos últimas se escaparon una vez por buscar la palabra
    exacta).
12. **Consultar un precio arrastraba el pedido anterior.** Ahora el número de
    pedido solo si pregunta por **su** pedido.
13. **El bot se quedaba MUDO** en chats veteranos: tres marcadores de memoria,
    cada uno correcto, sumaban cero y el emisor bloqueaba por `texto_vacio`.
    Hay **red**: ninguna situación puede devolver texto vacío.
14. **Escalar era un bucle de dos frases.** Ahora, como `##HANDOFF##` de
    BIKERPRO: contesta lo que sepa, avisa **una vez**, y se calla hasta que
    atienda una persona. La pausa caduca a las 12 h.
15. **Si el modelo lanza**, el turno degrada al camino determinista.
16. **El nombre no se extraía** del texto; una dirección con el teléfono al
    lado se descartaba entera.
17. **«no me cargaron las fotos»** ahora las reenvía, y solo con contexto de
    imágenes.
18. **Admitir un hueco ya no mata la venta** (regla principal de BIKERPRO).
19. **«¿esto sirve para los cólicos?»** no se reconocía.

### Envío

20. **8 fallos de envío con error 131026.** Eran clientes con **nombre de
    usuario de WhatsApp** (BSUID `CO.…`, sin teléfono). El bot mandaba al
    BSUID y Meta lo rechazaba. Ahora no se intenta, queda tarea visible, y el
    identificador se registra **sin recortar**.

### Panel

21. Producto y **método de pago** en la tabla de pedidos (es contraentrega:
    quien despacha debe saber que hay que recaudar).
22. **Tareas pendientes visibles** en ficha y bandeja, con el motivo en
    castellano. Se cierran solo con «marcar atendido», no porque alguien
    escriba.
23. **Aviso cuando la lista se recorta** y techo configurable
    (`PANEL_TECHO_CHATS`, 20.000).
24. **Orden estable** en los dos backends (`ORDER BY …, id ASC`), probado en
    el contrato: sin desempate, paginar podía perder o duplicar filas.
25. **«Empezar de cero»**: el bot vuelve a tratar un chat como nuevo. No borra
    historial ni pedidos.

### Catálogo

Confirmado por Marco y en uso: precio 1 u **$49.900** y 2 u **$85.000** ·
envío **incluido** · **contraentrega** · color rosado · talla única ·
garantía **1 mes** (alcance y trámite) · entrega **1 a 3 días hábiles** ·
correa **graduable** · **para qué sirve** (el calor alivia el cólico) ·
**material** (plástico, almohadillas en el abdomen).

### Herramientas nuevas

- `node herramientas/conversar.js` — conversaciones completas, sin red
- `node herramientas/demostrar.js [--con-ia]` — etiqueta **quién redacta**
  cada mensaje (código / modelo / modelo descartado y por qué)
- `node herramientas/auditar.js --mios=… [--crudo] [--detalle]` — auditoría en
  **modo lectura**, cruza el chat con el diario de acuses
- `node herramientas/probar-panel.js` — arranca el panel y recorre las rutas

---

## Lo que falta, en orden de impacto

### A · Las objeciones (lo que pidió Marco y no se hizo)

Hoy «está muy caro» **no se reconoce como objeción**: cae en el camino
genérico. BIKERPRO tiene guion para precio, confianza, envío y descuento.

Marco autorizó el enfoque con su ejemplo: *«mira, está en valor promoción, el
envío está totalmente gratuito»* — y en NOVIKA el envío **sí** va incluido,
así que es verdad y se puede decir.

Hay que: añadir `TEMAS.OBJECION_PRECIO` y los patrones, sacar de BIKERPRO el
guion de cada objeción, y adaptarlo **sin copiar sus condiciones**.

### B · Asesorar en todos los temas, no solo en «para qué sirve»

Cada respuesta debería traer el dato **y por qué le sirve a ella**. Hecho para
«para qué sirve»; falta ajuste, garantía, entrega, confianza.

### C · El panel, con las secciones de BIKERPRO

Faltan: subir el **PDF de guías** y partirlo · **novedades de entrega**
(NOVIKA tiene una versión, BIKERPRO otra más trabajada) · **revisar pedidos
duplicados** · **cierre del día por WhatsApp** · indicadores de **% de cierre**
y **share de 2 unidades**.

### D · Paginación completa en el almacén

Ver `docs/PENDIENTES-TECNICOS.md`. El orden estable ya está; faltan búsqueda,
filtros y conteos en SQL. **Riesgo a cubrir:** dos implementaciones del mismo
filtro se separan — ya pasó con las dos listas de «pregunta de precio». Va con
pruebas de contrato o no va.

### E · Verificar la prosa del modelo real

Lo verificado con proveedor **simulado** demuestra el reparto y los filtros,
**no** qué redacta el modelo real. Hace falta `IA_API_KEY` en un entorno de
pruebas, o capturas de producción.

### F · Defectos conocidos y no arreglados

- A **«gracias»** se le responde *«¿cuántos quieres? y para preparar tu pedido
  me pasas la ciudad y la dirección»*. Pedir datos a quien agradece.
- Mayúscula tras dos puntos en algunas composiciones: *«Te cuento: Es en
  plástico…»*.
- Los mensajes del bot **no guardan el `wamid`** en la conversación, así que
  cruzarlos con los acuses del diario es parcial.

---

## Decisiones que solo puede tomar Marco

1. **El contorno en cm.** Es la pregunta que más vende. Dijo que «es graduable
   y le va a quedar», pero eso es una conclusión, no una medida — y la garantía
   **no** cubre «no me quedó». Con el número, la respuesta pasa a «ajusta hasta
   X cm», que vende más porque se sostiene.
2. **Precio de 3 o más.** Hoy se escala a una persona.
3. **Qué trae exactamente el paquete.**
4. **Nequi o transferencia**, sí o no.
5. **Si a los clientes con nombre de usuario** (sin teléfono) se les puede
   responder de otra forma. Hay que comprobarlo en la documentación de Meta.

---

## Reglas de trabajo que no se negocian

- **BIKERPRO es solo lectura.** Se copia la *forma de vender*, nunca precios,
  productos, transportadoras ni políticas.
- **Los datos comerciales los autoriza Marco.** No se saca nada de
  MercadoLibre ni de fichas de otros vendedores: si el bot afirma algo que no
  llega, la devolución es nuestra.
- **Los importes salen del cotizador**, nunca del texto.
- **No se tocan los interruptores** ni la lista de prueba.
- **Nunca `git push` a `main`**: rama, PR, CI verde, merge con guarda de SHA.
- **No afirmar nada que no venga de una salida verificada.** Afirmé que había
  tráfico de Canadá mirando cinco dígitos que mi propia máscara había
  recortado; era un BSUID. Un identificador recortado no es un dato.
