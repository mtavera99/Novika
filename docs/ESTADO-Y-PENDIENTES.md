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

**Pruebas:** `npm test` → **884 sin base** (1 omitida), **939 con Postgres**
(0 omitidas). Medidas el 08-oct tras el PR #41; eran 862 y 917. Las 884 en
local y las **939 en CI**, que es quien tiene la base: aquel sandbox no traía
binarios de PostgreSQL ni el `pg-local.sh`.

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

### A · ~~Las objeciones~~ · LA DE PRECIO, HECHA (PR #41)

`TEMAS.OBJECION_PRECIO` existe y «está muy caro» ya no cae en el camino
genérico. La **forma** salió de BIKERPRO (su escalera: no saltar al
descuento, porque las jugadas que no cuestan nada cierran igual o mejor); las
**condiciones no se copiaron**. La escalera de NOVIKA:

1. el envío ya va incluido → el precio que vio es el final;
2. paga al recibir → no arriesga plata;
3. **si lleva dos, la pareja sale mejor que dos sueltas** (el paso más fuerte
   y el único donde bajarle el costo a la clienta nos deja *más* plata);
4. y si insiste, **una persona** — no una cifra.

**🚫 El bot no ofrece ningún descuento, y es a propósito.** NOVIKA no tiene
política de descuento aprobada y el catálogo declara «si hay descuento por
cantidad» como dato NO confirmado. El tope de $3.000 de BIKERPRO es **suyo**:
copiarlo habría sido inventarnos una política. Hay prueba de que, si el
modelo se inventa un descuento, **no sale**: el turno lo cubre el catálogo y
se envía el texto determinista. Es el riesgo que BIKERPRO tasó en
~$482.400/mes cuando su bot ofreció «$55.900 con pago anticipado» en la
primera objeción.

**Tres cosas que se encontraron por el camino y estaban rotas:**

- **«está muy caro, pero bueno» salía con `compra: true`** y el bot le pedía
  nombre, ciudad y dirección a quien acababa de quejarse del precio. La culpa
  era de la señal débil `bueno`, que ahí es una muletilla de resignación.
- **«y si llevo dos?» no se entendía.** La respuesta ofrece pasar el precio
  de dos; cuando la clienta decía que sí, recibía *«¡Perfecto, gracias!»* sin
  una sola cifra — una promesa que el bot no cumplía. Ahora es una pregunta
  de precio condicional y se cotiza por dos.
- **A quien se queja del precio ya no se le repite el precio.** «me lo dejas
  más barato» marcaba también el tema PRECIO y el mensaje encabezaba
  volviéndole a cantar la cifra. Excepción: si pregunta por una cantidad
  concreta («está caro, ¿y dos cuánto me salen?»), ahí sí quiere un número.

**Dos trampas que quedaron documentadas en el código, con su motivo:**

- **`caro` suelto NO va en el patrón.** «Caro» es como se presenta media
  Carolina en Colombia, y el bot **extrae el nombre del texto**: un «soy
  Caro, vivo en Bogotá» se habría leído como objeción y le habríamos rebatido
  el precio a quien estaba dando sus datos para comprar.
- **`mucho` suelto tampoco.** «¿demora mucho?» pregunta por la entrega.
  BIKERPRO lo tiene documentado como defecto real.

**Lo que falta de la A:** las objeciones de **confianza** y **envío** (la de
confianza ya tiene tema propio y respuesta; le falta el guion completo), y
«lo vi más barato en otro lado», que BIKERPRO trata aparte a propósito —
bajar el precio contra un competidor cuyo número no conoces es una carrera
perdida, y lo que sí tenemos es el contraentrega.

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
- Una pregunta **hipotética** por otra cantidad («y si llevo dos?») sí deja
  la cantidad en la ficha (`aporto:cantidad`), porque la pone el extractor y
  no el detector. La **cotización** ya es solo informativa, así que no cambia
  el total que se confirma; pero la ficha queda en 2 y conviene cerrarlo.
- «Sí, **L**a correa es graduable»: mayúscula después de coma, el mismo
  defecto de la mayúscula tras dos puntos.

---

## Decisiones que solo puede tomar Marco

1. **El contorno en cm.** Es la pregunta que más vende. Dijo que «es graduable
   y le va a quedar», pero eso es una conclusión, no una medida — y la garantía
   **no** cubre «no me quedó». Con el número, la respuesta pasa a «ajusta hasta
   X cm», que vende más porque se sostiene.
2. **Precio de 3 o más.** Hoy se escala a una persona.
6. **¿Hay descuento, y con qué tope?** Hoy el bot **no ofrece ninguno** y al
   final de la escalera pasa a una persona, que es lo único honesto sin una
   política aprobada. Si Marco autoriza un tope, el sitio donde ponerlo es el
   catálogo —nunca el texto— y la escalera ya está lista para usarlo como
   último escalón. Lo que **no** se puede es copiar el de BIKERPRO.
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
