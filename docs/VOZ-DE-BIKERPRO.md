# La voz de BIKERPRO, y qué traer a NOVIKA

Extraído de `mtavera99/impermeables` (`bot/src/prompt.js`, commit `a89f51c`) y
del panel. **Referencia de solo lectura:** no se copian precios, productos,
transportadoras ni políticas — solo la forma de vender.

Marco lo pidió seis veces. Está aquí para que no haya que volver a buscarlo.

---

## 1 · El tono, textual

> *«Colombiano, cálido y directo. Hablás como un buen vendedor humano:
> mensajes cortos, sin sonar a robot, sin explicaciones innecesarias. Emojis
> con moderación (1 o 2 por mensaje). Tratá al cliente de "vos" o "tú" según
> cómo te hable, y no lo trates de usted todo el tiempo.»*

Lo que hay detrás de cada parte:

| Regla | Por qué |
|---|---|
| mensajes **cortos** | en WhatsApp un párrafo no se lee |
| **sin explicaciones innecesarias** | el cliente pregunta una cosa, se le contesta esa |
| emojis **1 o 2**, no más | NOVIKA usa máximo 1; está bien |
| **tú**, no usted | «usted» pone distancia justo cuando hay que acercarse |

## 2 · Lo que no se sabe: la regla que ellos llaman la más importante

> *«Ese dato específico prefiero confirmártelo para no darte información
> incorrecta 🙌 ¿Querés que te lo confirme y te escribo?»* **y seguí con la
> venta.**

Y la razón, que es un caso real suyo:

> *«Inventar una especificación de un aparato electrónico es lo que produce
> una devolución con motivo: el cliente lo recibe, no cumple lo que le
> dijimos, y lo rechaza.»*

**Lo que NOVIKA hace distinto y peor:** dice que lo confirma y **se para
ahí**. BIKERPRO admite el hueco y **sigue vendiendo en la misma frase**. Es
la diferencia entre un bot honesto y un vendedor honesto.

## 3 · La distinción fina que tienen y nosotros no

> *«Que resista la lluvia SÍ está confirmado y lo podés decir. Que se pueda
> SUMERGIR, o que tenga una certificación IP67, NO: eso es un número medido
> en laboratorio y nadie lo verificó.»*

El paralelo exacto en NOVIKA es el **contorno**: que la correa es graduable
está confirmado y se dice; **hasta cuántos centímetros** es una medida que
nadie tomó. Ya está resuelto así, y viene de la misma idea.

## 4 · Cuándo pasar a una persona

`##HANDOFF##` cuando: el cliente está molesto · pide un asesor · insiste en
un descuento · quiere al por mayor · pregunta algo que no se puede resolver.

**Avisa una vez y deja de responder.** Implementado en NOVIKA el 2026-10-08:
antes entraba en un bucle de dos frases alternas.

## 5 · Lo que NO se copia

Precios, productos, transportadoras, políticas de envío y el uso de «vos»
rioplatense (NOVIKA habla en «tú» colombiano). Nada de BIKERPRO entra en el
catálogo de NOVIKA sin que Marco lo autorice para esta marca.

---

# Lo que falta en NOVIKA

En orden de impacto, medido contra los 15 chats reales del 2026-10-08
(**15 conversaciones, 0 ventas, 5 atendidas a mano por Marco**).

## A · El bot no asesora, informa

El patrón de casi los 15: **precio y pedir datos**, igual para todos. No
pregunta nada del cliente, no conecta el producto con su problema, no
responde a lo que le preocupa.

Lo que Marco pidió, con su ejemplo:

> *«si una persona le pregunta como esto sirve para los cólicos, sí claro eso
> sirve para los cólicos porque el calor»*

Ya está hecho para «¿para qué sirve?». **Falta para todo lo demás**: ajuste,
garantía, confianza, precio. Cada respuesta debería tener el dato *y* el
porqué le sirve a ella.

## B · Admitir un hueco no puede parar la venta

Hoy: «el material te lo confirmo con el equipo y te responden por aquí».
Punto. La conversación se muere ahí.

BIKERPRO: admite y sigue. Habría que añadir a cada `loConfirmo` una
continuación que mantenga la venta viva.

## C · Las objeciones no existen

BIKERPRO tiene guion para precio, confianza, envío y descuento. NOVIKA solo
tiene `CONFIANZA`, y responde una frase. «Está muy caro» no se reconoce
como objeción: cae en el camino genérico.

## D · El panel

Secciones que BIKERPRO ya tiene y NOVIKA no:

- subir el **PDF de guías** y partirlo
- **novedades de entrega**
- **revisar pedidos duplicados**
- **mandar el cierre del día por WhatsApp**
- indicadores de **% de cierre** y **share de 2 unidades**

NOVIKA ya tiene: bandeja con filtros, ficha de chat, CSV, guías a mano,
novedades, y las tareas pendientes de atención humana.
