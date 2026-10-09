# Plan de corrección de Marco · qué quedó hecho y qué no

Estado del documento de 3 partes que Marco entregó el 2026-10-09. Sin
adornos: lo que está hecho, lo que no, y por qué.

Verificación: `npm test` (1035, 0 fallos) ·
`node --test test/casos-de-marco.test.js` (25/25) ·
`node herramientas/revivir.js` (3/3 ventas reales cierran) ·
`node herramientas/sondear.js --malas` (5 de 65, y los 5 son escalados
legítimos).

---

## Parte A — los 11 errores

| | Qué pedía | Estado |
|---|---|---|
| **A1** | Responder a clientes con nombre de usuario (BSUID) | ✅ ya estaba (#48): el BSUID va en `recipient`, no en `to`. Los fallos que viste en el panel son **anteriores** al arreglo. Probado en el caso 13 |
| **A1b** | Pedir el celular como un dato más | ✅ ya estaba. Sin celular el pedido no se construye |
| **A1c** | Reintentar y alertar si el envío falla | ⚠️ **parcial**: reintenta y deja tarea visible en el panel. **La alerta a tu celular NO** — ver abajo |
| **A2** | Direcciones informales | ✅ barrio, vereda, corregimiento, sector, finca, casa, apto, torre, bloque, etapa, «vía a…», km. Se aceptan marcadas para revisar antes de la guía |
| **A3** | Bucles y preguntas repetidas | ✅ cantidad por defecto 1; prohibido el mismo texto dos veces seguidas; fuera «no quiero repetirme» y «dime concretamente» |
| **A4** | No negarse a dar lo que ya sabe | ✅ **0 de 65** preguntas reciben «no te lo quiero contestar a medias» (eran 21) |
| **A5** | Reglas de escalado | ✅ escala solo por: pide persona, reclamo, no entender dos veces, pregunta médica, mayorista (>5), insultos. **Y ya no pausa el bot** |
| **A5b** | Alerta inmediata al dueño | ❌ **falta tu número** — ver abajo |
| **A6** | Audios, stickers y fotos | ✅ con tus textos, cambiando «enseguida» por «de una» (ver nota) |
| **A7** | Primer mensaje con pregunta + 3 fotos | ✅ cierra con «¿Para qué ciudad sería?» y manda 3: frente, puesto, con su caja |
| **A8** | Recordatorios automáticos | ❌ **no hecho** — ver abajo |
| **A9** | Pedidos confirmados que se pierden | ✅ y el mecanismo real era peor de lo que creías — ver abajo |
| **A10** | Agrupar mensajes de 5-8 segundos | ❌ **no hecho**. Cada mensaje se contesta bien por separado, que era el fallo de fondo |
| **A11** | No inventar fuera de la base de conocimiento | ✅ es el diseño del repositorio, y hay una prueba que recorre todas las respuestas |

## Parte B — el prompt de Vale

Tu guion se implementó **como datos y como código**, no como un prompt. Es
deliberado y es la regla de esta casa: *una instrucción al modelo no es un
candado*.

- **Los datos del producto** están en `catalogo/productos/`, y de ahí los lee
  el bot. Si estuvieran solo en un prompt, el modelo podría omitirlos o
  cambiarlos.
- **Las FAQ** son temas con respuesta propia (ahora 25). Los precios salen del
  cotizador: ningún texto escribe un importe a mano.
- **Lo que no puede decir** está en `claimsProhibidos`, que se comprueba
  sobre el texto. Incluye lo que tu propia ficha abre: los 7 días con
  devolución de dinero, el cargador de pared, dormir con él puesto.
- **El tono** está en `src/cerebro/voz.js`: tope de 2 emojis, aperturas por
  tema, y cierre con pregunta siempre.

**Una desviación, y te la señalo:** tus textos de audio decían «te ayudo
enseguida». «Enseguida» es una promesa de tiempo y está prohibida desde que
el bot prometió «te confirmo enseguida» a las dos de la mañana. Se cambió por
«de una», que dice lo mismo y no promete a nadie de guardia.

**El nombre «Vale»:** el bot no se presenta con nombre. No se añadió porque
no está decidido si quieres que se identifique como una persona — algunos
clientes preguntan «¿eres un bot?» y responder con un nombre de mujer a eso
es una decisión tuya, no mía. Dime y lo pongo.

## Parte C — los 20 casos

**25 de 25 pasan** (`test/casos-de-marco.test.js`). Dos matices:

- El **15** (recordatorios) no se puede probar porque la función no existe.
- El **5** y el **10** verifican que cada mensaje por separado reciba la
  respuesta correcta. Agruparlos (A10) no está hecho.

---

## Lo que falta, y qué hace falta para hacerlo

### ❌ A8 · Recordatorios automáticos — lo más valioso que queda

Es probablemente **la mayor fuente de ventas perdidas que sigue abierta**: 10
de 25 clientes recibieron el primer mensaje y nadie les volvió a escribir.

No se hizo porque no es un cambio de texto: hace falta un **programador de
tareas** que hoy no existe en este repositorio. Y es la pieza con más riesgo
de todo el plan, porque es la única que **escribe sin que el cliente escriba
primero**: un fallo ahí no es una respuesta mala, son mensajes no deseados a
clientes reales con la campaña encendida.

Lo que hace falta:

1. Un campo por conversación con la hora del próximo recordatorio y cuál toca.
2. Un tick en el servidor (1 instancia en Render, así que no hay carrera).
3. La ventana de 24 h de Meta y el horario de silencio 21:00–07:00 Colombia.
4. Cancelarlos al responder, confirmar o decir que no.
5. **Un interruptor apagado por defecto** (`RECORDATORIOS=0`) y una prueba de
   que no se manda nada fuera de ventana ni de madrugada.

Es el siguiente trabajo que yo haría.

### ❌ A5b / A1c · La alerta a tu celular

Falta **tu número**. Es el punto 5 de tus propios pendientes.

Y una decisión más: ¿por dónde? Mandarla por el mismo WhatsApp de NOVIKA a tu
número personal es lo más simple, pero gasta una conversación de la API y
queda en el mismo historial. La alternativa es un correo o un Telegram.
Dímelo y lo monto.

### ❌ A10 · Agrupar mensajes seguidos

Necesita un buffer de 5-8 segundos en el webhook, y eso choca con una regla
dura del repositorio: **nunca se contesta 200 a Meta sin haber reclamado el
trabajo en disco**. Un buffer mal hecho pierde mensajes en un redespliegue.

Se puede hacer bien, pero es un cambio en el camino más delicado del sistema
y no quise mezclarlo con todo lo demás. El fallo de fondo —que «En qué
ciudad» y «Te encuentras» acabaran en el equipo— ya está arreglado.

---

## Lo que tienes que confirmar tú

De tu propia lista, más uno que apareció:

1. **Medida máxima de la correa.** Sigue siendo la que más vende y la única
   que no puedo responder. Con una cinta métrica sobre la correa estirada.
2. **¿Incluye cargador de pared?** Implementado tu criterio por defecto: el
   bot dice que trae cable USB y **no** menciona cargador de pared.
3. **Garantía.** ⚠️ **Aquí hay un conflicto que tienes que resolver tú:** el
   07-oct confirmaste **1 mes de garantía por defecto de fábrica**, y el bot
   lo dice. Tu documento nuevo lo marca como [CONFIRMAR] y menciona la
   promesa del anuncio **«Pruébalo 7 días: si no sientes alivio, te
   devolvemos tu dinero»**. Dejé el mes de garantía y **bloqueé los 7 días**:
   es una promesa de devolver plata y el anuncio ya la está haciendo. Si el
   anuncio la promete, el bot debería poder sostenerla — o el anuncio debería
   cambiar. Esto es lo más urgente de esta lista.
4. **¿Nequi o Daviplata al recibir?** Hoy el bot dice contraentrega, según tu
   instrucción por defecto.
5. **Tu celular para las alertas.**
6. **Horario en que hay alguien para los escalados.** El bot ya no promete
   plazos, pero saberlo cambia qué se le dice al cliente.
7. **La ficha técnica contra la unidad física.** Lo escribiste tú:
   *«Verificar con la unidad física»*. El bot ya afirma 3 niveles (50/55/60
   °C), 10 segundos de calentamiento, 4 modos de masaje, batería de 1.800 mAh
   y ~2 h de uso. **Si la unidad real no coincide, el bot está prometiendo
   algo que no llega y la devolución es nuestra.** Es el riesgo abierto más
   grande del catálogo.

---

## Sobre A9, porque el mecanismo era peor de lo que creías

Decías que «reiniciar la conversación» anulaba el pedido. Reiniciar **no
cancela nada** — lo comprobé.

Lo que lo cancelaba era otra cosa: la lista de negaciones tenía un `/^no\b/`,
que casa con **cualquier mensaje que empiece por «no»**. Sobre un pedido ya
confirmado eso no se queda en un escalado: cancela el pedido de verdad. Un
«No entiendo» o un «no me ha llegado» —que es posventa pura— borraba una
venta cerrada.

La raíz ya está arreglada, y además ahora un pedido confirmado **solo se
cancela con una intención inequívoca** («cancelar», «anular», «ya no lo
quiero»). Lo ambiguo lo mira una persona. Está probado en el caso 16-bis.
