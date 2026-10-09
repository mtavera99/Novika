# Los ocho defectos del 10-oct

Marco revisó las 15 conversaciones más recientes del panel de producción y
los numeró por prioridad. Este documento dice qué era cada uno, por qué
pasaba y qué se cambió.

**Lo que Marco confirmó que ya funcionaba y no se tocó:** el mensaje de
bienvenida (con el combo de $85.000, la pregunta «¿Para qué ciudad sería?» y
las 3 fotos), la respuesta a los audios y la respuesta de garantía.

Se reproducen todos con:

```
node herramientas/reproducir-10oct.js            # los siete chats
node herramientas/reproducir-10oct.js popayan    # uno solo
```

Y quedan fijados en `test/correcciones-10oct.test.js`.

---

## 1 · CRÍTICO — el «sí» después de la pregunta de cierre entraba en bucle

Cuatro clientes del panel diciendo que sí, de cuatro formas distintas, y
ningún pedido:

| cliente | dijo | recibió |
|---|---|---|
| Santiago | «Mándamelo» | la misma pregunta de cierre, otra vez |
| Jhon Jaider | «Si claro por favor» | el precio repetido y la pregunta otra vez |
| Precioso | «Si Agame el favor» | «¿Te lo aparto…?» |
| Popayán | «Si» y luego «Claro» | **«Perdón, creo que no te entendí bien»** |

**Dos causas, y una era una errata de una letra.**

La primera: **el bot no recordaba haber preguntado**. La conversación
guardaba `saludado`, `precioInformado`, `datosPedidos` y `pasoPropuesto`, y
ninguna decía «mi último mensaje fue una pregunta de cierre». El permiso para
pedir los datos es `lectura.compra || huboSenalDeCompra ||
datosAportados.length`, y «Mándamelo» no era ninguna de las tres. Sin
permiso, el redactor volvía a soltar el mismo cierre; y al ser texto
idéntico, la guarda anti-eco remataba con «no te entendí bien».

Se añadió `conversacion.cierrePropuesto`, que se escribe al final del turno
**solo si el mensaje salió de verdad y llevaba una pregunta de cierre**
(`responder.prometeCierre`), y `confirmacion.esAfirmacionDeCierre()` con la
lista que dictó Marco. Un sí ahí vale como señal de compra.

> La lista puede ser tan amplia («listo», «ok», «por favor», 👍) porque solo
> se consulta con `cierrePropuesto` puesto. Fuera de ese contexto esas
> palabras no afirman nada y la función no se llama. Y **no crea el pedido**:
> lleva a pedir lo que falta. El pedido sigue exigiendo el resumen a la vista
> y su propia confirmación.

La segunda: `SENALES_DE_COMPRA` tenía `\bmandame\b`, que **no casa con
«mandamelo»** — detrás de «mandame» viene una `l`, que es carácter de
palabra, así que `\b` no cierra ahí. Y `mandem?el[oa]` cubría «mandelo» y
«mandemelo», pero no «manda-melo». Entre los dos patrones quedaba un hueco
con la forma más natural de decirlo. Por eso «Envíamelo» funcionaba y
«Mándamelo» no: **el mismo cliente, la misma intención, y una letra de
diferencia.**

**Cantidad por defecto 1.** A quien dice «mándamelo» ya no se le pregunta
cuántos quiere. Se elige la menor, nunca se cobra de más, y la ve escrita en
el resumen antes de confirmar. Dos candados: si el mensaje trae un número
manda el número, y si el bot informó el precio de dos no se baja a 1 a sus
espaldas.

---

## 2 · CRÍTICO — después de la ciudad no pedía los datos

```
Duitama:  "Duitama boyaca"
bot:      "¡Perfecto! A Duitama te llega en 1 a 3 días hábiles según la ciudad 🙌"
          (y ahí se acabó la conversación)

Santiago: "Bogotá"  ->  el mismo mensaje, y tampoco siguió.
```

Había un atajo: si el único dato aportado era la ciudad —un dato «neutro»— se
contestaba el plazo y se volvía sin pedir nada. La idea era la regla del
PR #9, *«dar una ciudad no es comprar»*, porque muchas veces la ciudad es en
realidad «¿me llega allá?».

El precio fueron dos conversaciones muertas justo donde el cliente acababa de
contestar **la pregunta que hace el propio bot** en su primer mensaje.

El arreglo fue **borrar el atajo**, no escribir un camino nuevo:
`cerrarTrasElDato` ya daba el plazo y la lista de lo que falta en un solo
mensaje.

**Lo que sigue protegido** —y es la parte de la regla del PR #9 que de verdad
importa—: esa rama exige `!lectura.pregunta`, así que «¿Llega a Palmira?» no
entra y sigue recibiendo solo la cobertura. Tiene su prueba.

---

## 3 · CRÍTICO — un cliente con todos los datos se quedaba sin resumen

Chat de Popayán. El cliente contestó los tres datos en **un solo mensaje de
tres líneas**, que es como los contesta medio mundo cuando se los piden
juntos:

```
Alejandro león Garzón
Popayán Cauca
Barrio pueblillo en la cantera la pintada
```

La ciudad y la dirección sí se capturaron —sus patrones buscan dentro del
texto—. **El nombre no**, porque el bloque que captura un nombre sin marcador
miraba el mensaje entero como un solo candidato: doce palabras, con una
ciudad y un tipo de vía dentro, falla los cuatro candados a la vez.

En el panel quedó «Destinatario: sin confirmar», y el bot se pasó la
conversación pidiendo un nombre que ya tenía escrito delante.

Ahora `nombreEn` prueba **el mensaje completo primero y luego línea por
línea**. Cada línea pasa exactamente las mismas comprobaciones que antes: no
se relaja ningún candado, solo se aplican al trozo correcto.

### Por qué esa conversación seguía pausada

No era el bot. **Un operador escribió «Me confirmas» a las 21:33 desde el
panel, y eso calla al bot 12 horas.** El cliente contestó «Si» a las 21:36 y
esa respuesta no salió: `no enviado: conversacion_pausada`.

Ver el bloque de «errores propios» más abajo: el panel decía justo lo
contrario.

---

## 4 · «No te la quiero contestar a medias» en las preguntas por las funciones

`Ese que funciones trae` **no casaba con ningún tema**. El patrón de EMPAQUE
es `que (trae|incluye|viene con)`, y ahí «que» va seguido de «funciones», no
de «trae». Sin tema, la pregunta caía en el camino de la duda no catalogada
—teniendo los cuatro modos y los tres niveles en la ficha—.

Se creó `TEMAS.COMO_SE_USA`, que va **antes de EMPAQUE** (para que «¿qué
funciones trae?» no se lea como «¿qué trae en la caja?»; el «qué trae» pelado
sigue siendo el empaque, que es lo correcto) y **antes de USO**.

---

## 5 · La respuesta de «¿Cómo funciona?» era floja y se repetía igual

«Cómo funciona» vivía en `TEMAS.USO`, que responde con `paraQueSirve.texto`.
Esa respuesta empieza con «Sí, es justo para eso», que a «cómo funciona»
afirma algo que nadie preguntó y no explica nada de la mecánica. David lo
preguntó **dos veces y recibió el mismo párrafo las dos**.

Ahora hay `comoSeUsa` en el catálogo, con el texto que dictó Marco:

> Te lo pones en la parte baja del abdomen con la correa, lo prendes y en unos
> 10 segundos ya da calor 🔥 Tiene 3 niveles de calor (50, 55 y 60 °C) y 4
> modos de masaje, y es recargable, así que no va conectado mientras lo usas.

**No añade ninguna afirmación nueva.** Cada dato que dice ya estaba
autorizado en esa misma ficha desde el 09-oct: los 10 segundos salen de
`temperatura.segundosEnCalentar`, los tres niveles de `temperatura.niveles`,
los cuatro modos de `masaje.modos` y lo de ir sin cable de
`energia.recargable`.

Y hay un `textoAlternativo` que **se alterna**: la tercera vez no repite la
segunda. Marco pidió que repetir la pregunta nunca devuelva el mismo texto.

---

## 6 · El plazo de Bogotá estaba mal

A Bogotá el bot decía «1 a 3 días hábiles». Son 1 a 2.

Lo llamativo: **el dato correcto estaba en el catálogo desde el 09-oct**
—`logistica.tiempoDeEntrega.porCiudad.bogota`— y no lo leía nadie. Un campo
que nadie consulta es peor que un campo que falta: parece que el dato está y
en realidad no se usa.

Se añadió `contestar.plazoDeEntrega(producto, ciudad)` y se usa en los tres
sitios que redactaban el plazo.

**Y arregla también el matiz.** Cuando ya sabemos la ciudad, «según la
ciudad» sobra y suena a letra pequeña:

```
antes:  "A Duitama te llega en 1 a 3 días hábiles según la ciudad"
ahora:  "A Duitama te llega en 1 a 3 días hábiles"
```

Sin ciudad sí se dice, porque ahí el rango de verdad depende de algo que
todavía no se conoce.

---

## 7 · Una ciudad fuera del listado se ignoraba

`Ciénaga guacamayal` → el bot saltaba a «¿Te lo aparto…?» sin usar la ciudad.
Guacamayal es un corregimiento de Zona Bananera (Magdalena), y
`CIUDADES_SEMILLA` tiene ~60 entradas de los ~1.100 municipios del país:
está incompleta **a propósito**.

`destino.resolverCiudad` ya sabía qué hacer con una ciudad desconocida —la
acepta con `revisar: true` y una persona confirma el destino antes de la
guía, que es la regla «MARCAR, NO BLOQUEAR»—. El hueco estaba en
`extraer.ciudadEn`: no le daba nada que resolver.

Ahora, **cuando se le acaba de pedir la ciudad**, un topónimo de 1 a 4
palabras se acepta marcado para revisar.

Dos candados que importan:

- **Solo con el contexto.** Sin él, esto leería cualquier palabra suelta como
  una ciudad.
- **Y solo si el nombre ya está resuelto.** «Alejandro león Garzón» y
  «Ciénaga guacamayal» son indistinguibles para una máquina: tres palabras,
  todas letras. Cuando el nombre todavía falta, el mensaje corto se lo queda
  el nombre, que se pidió primero. Así dos reglas que miran lo mismo no se
  pelean por el mismo mensaje.
- **Y el ruido de teclado no entra.** Lo cazó el sondeo de las 65 preguntas:
  «sihh» —un «sí» escrito a toda prisa— entraba como topónimo y el bot
  contestaba «A Sihh te llega en 1 a 3 días hábiles».

---

## 8 · «Te paso las fotos» salía sin fotos

Las fotos están deduplicadas por producto (`conversacion.fotosEnviadas`): se
mandan una vez y no se repiten, que es lo correcto. Pero el texto no se
enteraba y seguía anunciándolas.

Ahora `fotosYaEnviadas` viaja hasta las respuestas, y la frase solo sale si
las fotos de verdad van a salir.

---

# Dos defectos más, que no estaban en la lista

Aparecieron al arreglar los otros. Los dos costaban pedidos.

## 9 · El nombre de perfil de WhatsApp borraba el nombre del cliente

El nombre de perfil viaja en **cada** mensaje. Se proponía en cada turno con
origen `CLIENTE`, y `aplicarCandidatos` trata un valor distinto sobre un campo
confirmado como «el cliente lo corrigió»: reabre el campo y mete el valor
nuevo. Con el chat real de Popayán, cuyo perfil es un emoji:

```
cliente · "Alejandro león Garzón / Popayán Cauca / Barrio..."
bot     · (resumen correcto, con el nombre bien)
cliente · "Si"
          -> el perfil "🤪" "corrige" a "Alejandro león Garzón"
          -> "🤪" no pasa validarNombre, el campo queda VACÍO
          -> "no se puede crear el pedido, falta: nombre"
          -> escalado
```

**El cliente dijo que sí a un resumen correcto y perdió el pedido y el nombre
en el mismo turno.** El defecto no se veía porque hasta ahora el nombre
escrito en el mensaje no se capturaba nunca: no había nada bueno que pisar.

Ahora el perfil solo rellena el hueco. Corregir el nombre sigue siendo
posible diciéndolo («me llamo X»), que es una corrección de verdad.

## 10 · A quien decía que compraba dos veces se le decía «no te entendí»

```
Santiago · "Mándamelo"   -> "dime el barrio, o un punto de referencia"
Santiago · "Envíamelo"   -> "Perdón, creo que no te entendí bien"
```

Las dos son compra, las dos se entendieron, y como el texto que tocaba era el
mismo —falta la dirección, se vuelve a pedir— la guarda anti-eco lo leyó como
un bot atascado. Decirle «no te entendí» a quien lleva dos mensajes diciendo
que compra es la peor respuesta posible en el mejor momento posible.

Un turno reconocido como compra ahora cuenta como turno entendido: si hay que
repetir, se repite con otra envoltura.

---

# Un error propio, y hay que decirlo

El 09-oct cambié el aviso del panel a «Al enviar, el bot **sigue atendiendo**
este chat» y le dije a Marco por escrito que responder a mano no callaba al
bot.

**Las dos cosas eran falsas.** `panel/rutas.js`, al enviar un mensaje manual,
pone `pausado: true`. La propia respuesta de la API lo decía bien («El bot
queda pausado en este chat»), así que el panel afirmaba una cosa antes de
enviar y la contraria después, y la versión que leía el operador **antes** de
escribir era la equivocada.

Y no es un detalle de redacción: es exactamente lo que dejó el chat de
Popayán muerto durante cuatro horas.

El aviso ahora dice la verdad y dice qué hacer:

> Al enviar, **el bot se calla en este chat** (12 h, o hasta que pulses
> «Devolver al bot»). Quédate tú con la conversación, o devuélvesela cuando
> termines.

Y hay una prueba que ata el aviso al comportamiento: si alguien cambia uno
sin el otro, falla en el test y no en la cara de un cliente.

**Queda una decisión para Marco**, que no se toma sin él: si prefiere que
responder a mano **no** pause. Pausar evita hablar a dos voces, que es un
riesgo real. Pero un mensaje suelto durante una caída silencia el bot 12
horas, y eso ya costó una venta.

---

# Medición

| | antes | después |
|---|---|---|
| `npm test` | 1139, 0 fallos | **1178, 0 fallos** |
| `herramientas/sondear.js` | 5 de 65 con síntomas | **5 de 65** (los 5 escalados legítimos) |
| `herramientas/revivir.js` | 3 de 3 cierran | **3 de 3** |
| `herramientas/reproducir-10oct.js` | 8 defectos reproducidos | **0** |
| Popayán, de punta a punta | sin resumen a las 4 h | **pedido creado** |
