"use strict";

// ==========================================================================
// QUE ESTA PREGUNTANDO EL CLIENTE
//
// Modulo puro. Sin I/O, sin IA, sin catalogo.
//
// POR QUE EXISTE
//
// Antes el cerebro sabia en que PASO DE LA VENTA estaba -faltan datos, hay
// resumen, esta confirmado- y contestaba segun el paso. Eso produce
// conversaciones como esta, que es real y salio de probar la activacion:
//
//   clienta: "Quiero un cinturón. ¿Cuánto vale con envío?"
//   bot:     "Para continuar me falta la ciudad, la dirección de entrega."
//
// El paso de la venta era correcto -faltaban datos- y la respuesta era
// inservible: le pide los datos a alguien que acaba de preguntar el precio.
//
// Para contestar primero lo que preguntan hay que SABER que preguntaron. Eso
// es lo que hace este modulo: clasifica el mensaje en temas, sin decidir que
// se responde. Quien responde es el cerebro, con datos del catalogo.
//
// DOS REGLAS DE DISEÑO
//
// 1. UN TEMA NO RECONOCIDO NO ES UN ERROR. Si no se reconoce nada, el cerebro
//    sigue su camino normal. Este modulo solo puede MEJORAR una respuesta,
//    nunca bloquearla.
//
// 2. PREGUNTAR NO ES COMPRAR, Y ESA DISTINCION ES LO MAS VALIOSO DE AQUI.
//    Documentado en la referencia de BIKERPRO: el bot contestaba cada duda
//    informativa pidiendo ademas nombre, celular y direccion, y el cliente
//    que estaba averiguando se sentia perseguido y se iba. La diferencia
//    entre "¿tiene garantia?" y "lo quiero" tiene que estar en codigo, no en
//    una instruccion al modelo.
// ==========================================================================

const { aplanar, cantidadesEn, PREGUNTA_PRECIO } = require("./texto");

/**
 * Temas que el cliente puede preguntar.
 *
 * Cada tema se responde desde el catalogo o desde el cotizador. Si un tema no
 * tiene dato aprobado, el cerebro dice que lo confirma una persona: por eso
 * aqui no hay ninguna respuesta escrita, solo la clasificacion.
 */
const TEMAS = {
  PRECIO: "precio",
  ENVIO: "envio",
  PAGO: "pago",
  COLOR: "color",
  TALLA: "talla",
  MEDIDAS: "medidas",
  GARANTIA: "garantia",
  /** Como se hace efectiva / que cubre: el PLAZO esta confirmado, esto no. */
  GARANTIA_TRAMITE: "garantia_tramite",
  ENTREGA: "tiempo_de_entrega",
  MATERIAL: "material",
  USO: "uso",
  CONFIANZA: "confianza",
  FOTOS: "fotos",
  /**
   * "Esta muy caro", "hay descuento?", "me lo dejas mas barato".
   *
   * NO es una pregunta de precio: quien objeta YA sabe el precio. Es la
   * objecion que mas plata mueve y hasta ahora caia en el camino generico,
   * donde el bot contestaba "dime que necesitas" a quien estaba a un paso
   * de comprar.
   */
  OBJECION_PRECIO: "objecion_precio",
  /**
   * Como se alimenta: bateria, cargador, enchufe, cuanto dura.
   *
   * Aparte de USO porque la ficha lo declara NO CONFIRMADO. Dentro de USO,
   * preguntar por el cargador recibia la frase de "para que sirve" -el
   * calor alivia el colico-, que no contesta nada de lo que pregunto.
   */
  ENERGIA: "energia",
};

/**
 * Patrones por tema, sobre el texto APLANADO (minusculas, sin tildes).
 *
 * Se escriben sin tildes a proposito: el cliente escribe desde el movil y el
 * teclado las pone solas, asi que comparar contra el texto crudo haria que
 * "¿cuánto vale?" no coincidiera con `cuanto vale`. Ese error ya se cometio
 * una vez en los alias del catalogo.
 */
const PATRONES = [
  // ---- Objecion de precio ----
  //
  // VA ANTES QUE PRECIO a proposito: el orden de esta tabla es el orden de
  // los temas, y de ahi sale la apertura del mensaje. A quien dice "esta muy
  // caro" no se le abre con "Claro que si,".
  //
  // ⚠️ NO VA UN `caro` SUELTO, y el motivo es de esta casa: "Caro" es como
  // se llama media Carolina en Colombia, y el bot EXTRAE EL NOMBRE del
  // texto. Con `\bcaro\b`, un "soy Caro, vivo en Bogota" se leeria como una
  // objecion de precio y le rebatiriamos el precio a quien estaba dando sus
  // datos para comprar. Siempre con el modificador delante ("muy caro",
  // "esta caro") o en superlativo ("carisimo").
  //
  // ⚠️ Y NO VA UN `mucho` SUELTO: "demora mucho?" pregunta por el tiempo de
  // entrega. BIKERPRO lo tiene documentado como defecto real -clasificarlo
  // como objecion hacia que el bot le rebatiera el precio a quien pregunto
  // cuando le llega- y aqui `demora` ya marca ENTREGA. Por eso `es mucho`
  // lleva el lookahead que descarta el tiempo.
  [TEMAS.OBJECION_PRECIO, /\b(muy|tan|que|bien|super|demasiado)\s+car[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bestan?\s+(muy\s+|bien\s+|algo\s+)?car[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bes\s+(muy\s+|algo\s+)?car[oa]\b/],
  [TEMAS.OBJECION_PRECIO, /\bcar[ií]sim[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bcostos[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bno\s+me\s+alcanza\b/],
  [TEMAS.OBJECION_PRECIO, /\bno\s+tengo\s+(tanto|esa\s+plata)\b/],
  [TEMAS.OBJECION_PRECIO, /\bes\s+mucha\s+plata\b/],
  [TEMAS.OBJECION_PRECIO, /\bes\s+mucho\b(?!\s+(tiempo|rato))/],
  [TEMAS.OBJECION_PRECIO, /\b(descuento|rebaja|rebajas)\b/],
  [TEMAS.OBJECION_PRECIO, /\bmas\s+(barat[oa]s?|economic[oa]s?)\b/],
  [TEMAS.OBJECION_PRECIO, /\b(ultimo|mejor)\s+precio\b/],
  [TEMAS.OBJECION_PRECIO, /\bprecio\s+especial\b/],
  [TEMAS.OBJECION_PRECIO, /\bme\s+lo\s+dej(as|a|arias)\s+en\b/],
  [TEMAS.OBJECION_PRECIO, /\b(me\s+)?(baja|bajas|rebaja|rebajas)\s+(algo|el\s+precio)\b/],
  [TEMAS.OBJECION_PRECIO, /\bpresupuesto\b/],
  [TEMAS.OBJECION_PRECIO, /\besta\s+en\s+promocion\b/],

  // ---- Precio ----
  //
  // La lista vive en `texto.js` porque el cerebro tambien la necesita para
  // decidir si repite una cifra. Tenerla DOS veces fue un defecto real: las
  // dos copias se separaron y el plural ("que valen dos") no estaba en
  // ninguna, asi que preguntar por dos unidades no se reconocia.
  ...PREGUNTA_PRECIO.map((re) => [TEMAS.PRECIO, re]),
  [TEMAS.PRECIO, /\b(cual\s+es\s+el)\s+precio\b/],
  [TEMAS.PRECIO, /\bcuanto\b.*\bcon\s+envio\b/],

  // ---- Envio ----
  // "como es el envio", "hacen envios", "envian a", "domicilio", "flete".
  [TEMAS.ENVIO, /\benvi(o|os|an|a)\b/],
  [TEMAS.ENVIO, /\bdomicilio\b/],
  [TEMAS.ENVIO, /\bflete\b/],
  [TEMAS.ENVIO, /\bmandan?\s+a\b/],
  [TEMAS.ENVIO, /\bllega\s+a\b/],

  // ---- Pago ----
  [TEMAS.PAGO, /\bcontra\s*entrega\b/],
  [TEMAS.PAGO, /\bcontraentrega\b/],
  [TEMAS.PAGO, /\b(como|cuando)\s+(se\s+)?pag(a|o|ar)\b/],
  [TEMAS.PAGO, /\bpago\s+(al|contra)\b/],
  [TEMAS.PAGO, /\b(acepta|aceptan|reciben|puedo\s+pagar)\b.*\b(nequi|daviplata|transferencia|tarjeta|efectivo)\b/],
  [TEMAS.PAGO, /\b(nequi|daviplata|transferencia)\b/],
  [TEMAS.PAGO, /\bpago\s+anticipado\b/],

  // ---- Color ----
  [TEMAS.COLOR, /\bcolor(es)?\b/],
  [TEMAS.COLOR, /\bviene\s+en\s+\w+/],
  [TEMAS.COLOR, /\b(rosado|rosa|negro|blanco|azul|rojo|verde|morado|gris)\b/],

  // ---- Talla ----
  [TEMAS.TALLA, /\btallas?\b/],
  [TEMAS.TALLA, /\bes\s+unitalla\b/],
  [TEMAS.TALLA, /\bque\s+tamano\b/],
  [TEMAS.TALLA, /\b(es|hay)\s+talla\s+unica\b/],

  // ---- Medidas y ajuste: el tema sensible de este producto ----
  // Marco fue explicito: no hay medidas del ajuste y no se promete que sirva
  // para cualquier contorno. Se clasifica aparte de TALLA para poder dar la
  // respuesta honesta en vez de la del dato aprobado.
  [TEMAS.MEDIDAS, /\bme\s+(sirve|queda|servira|quedara)\b/],
  [TEMAS.MEDIDAS, /\b(contorno|cintura|abdomen|barriga|cadera)\b/],
  [TEMAS.MEDIDAS, /\bcuanto\s+(mide|estira|ajusta)\b/],
  [TEMAS.MEDIDAS, /\b(medidas?|centimetros|cm)\b/],
  [TEMAS.MEDIDAS, /\buso\s+talla\b/],
  [TEMAS.MEDIDAS, /\bsoy\s+(gordita|gorda|delgada|grande|pequena)\b/],

  // ---- Garantia: el plazo ----
  [TEMAS.GARANTIA, /\bgarantia\b/],

  // ---- Garantia: el tramite y la cobertura ----
  // Se separa del plazo porque son dos datos distintos: el plazo lo
  // confirmo Marco (1 mes) y el tramite NO esta definido. Responder "1 mes"
  // a "¿cómo la hago efectiva?" contesta otra pregunta.
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+(la\s+)?(hago|hacer)\s+efectiva\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+(reclamo|la\s+reclamo|pido\s+la\s+garantia)\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+funciona\s+la\s+garantia\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bque\s+cubre\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bquien\s+paga\s+(el\s+)?(envio\s+de\s+)?(la\s+)?(devoluci|cambio)/],
  [TEMAS.GARANTIA, /\bsi\s+(sale|viene)\s+(malo|dañado|danado|defectuoso)\b/],
  [TEMAS.GARANTIA, /\b(puedo|se\s+puede)\s+(devolver|cambiar)\b/],
  [TEMAS.GARANTIA, /\bdevoluci(on|ones)\b/],

  // ---- Tiempo de entrega ----
  //
  // ⚠️ EL CONDICIONAL TAMBIEN CUENTA, y es la forma MAS natural de
  // preguntarlo en castellano: "¿cuándo me llegaría?".
  //
  // Esto solo conocia el presente -"cuando me llega"- y Marco lo cazo
  // probando desde su numero el 08-oct:
  //
  //   Marco · "Cuando me llegaría"
  //   bot   · "Esa no te la quiero contestar a medias..."
  //
  // El plazo esta en la ficha, aprobado. Negarse a decirlo por una "r" y
  // dos letras mas es el mismo error que "costó" frente a "cuesta".
  [TEMAS.ENTREGA, /\bcuando\s+(?:me\s+|lo\s+|la\s+|le\s+|nos\s+)?(?:llega|llegaria|llegara|llegarian)\b/],
  [TEMAS.ENTREGA, /\bcuando\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:recibo|recibiria|recibiera|recibimos)\b/],
  [TEMAS.ENTREGA, /\bcuant[oa]s?\s+(?:se\s+)?(?:tarda|tardaria|tardan|demora|demoraria|demoran)\b/],
  [TEMAS.ENTREGA, /\bcuantos\s+dias\b/],
  [TEMAS.ENTREGA, /\bdemora\w*/],
  [TEMAS.ENTREGA, /\bpara\s+cuando\b/],
  [TEMAS.ENTREGA, /\ben\s+cuanto\s+(?:me\s+|lo\s+|la\s+)?(?:llega|llegaria|lleg\w+|recib\w+)\b/],

  // ---- Material ----
  [TEMAS.MATERIAL, /\bmaterial\b/],
  [TEMAS.MATERIAL, /\bde\s+que\s+(esta\s+hecho|es)\b/],
  [TEMAS.MATERIAL, /\b(tela|cuero|plastico|algodon)\b/],

  // ---- Como funciona / para que sirve ----
  [TEMAS.USO, /\bcomo\s+(funciona|se\s+usa|se\s+pone|lo\s+uso)\b/],
  [TEMAS.USO, /\bpara\s+que\s+sirve\b/],
  // "¿esto sirve para los cólicos?" es EL EJEMPLO que dio Marco, y no se
  // reconocia: no casa con "para que sirve". Caia en el camino de la duda
  // no catalogada y recibia "esa no te la quiero contestar a medias",
  // teniendo la respuesta autorizada en la ficha.
  //
  // De un producto que se llama "cinturón térmico para cólicos", no
  // entender esa pregunta es el colmo.
  [TEMAS.USO, /\bsirve\s+(para|contra|de\s+verdad|realmente)\b/],
  // ⚠️ EL LOOKAHEAD NO ES UN ADORNO: "AYUDA CON PEDIDO" NO ES ESTE TEMA.
  //
  // Esto era `\b(funciona|ayuda)\s+(para|con|contra)\b` y casaba con "ayuda
  // con pedido". El 08-oct una clienta escribio justo eso -pidiendo ayuda
  // para comprar- y el bot le explico para que sirve el cinturon. Dos veces
  // en la misma conversacion, y no se cerro la venta.
  //
  // Quien pide ayuda CON EL PEDIDO esta comprando, no preguntando que hace
  // el producto.
  // Y tampoco es este tema "funciona con bateria": eso es ENERGIA, que se
  // contesta admitiendo que el dato no esta confirmado. Si cayera aqui,
  // recibiria la frase de los colicos — el mismo defecto que el cargador.
  [
    TEMAS.USO,
    /\b(funciona|ayuda)\s+(para|con|contra)\s+(?!(?:el\s+|la\s+|mi\s+|un\s+|una\s+)?(?:pedido|compra|orden|pago|envio|comprar|pedir|bateria|pila|cable|cargador|corriente|enchufe|luz)\b)/,
  ],
  [TEMAS.USO, /\bes\s+(para|bueno\s+para)\s+(los\s+)?(colicos|dolor|menstrual)/],
  [TEMAS.USO, /\bquita\s+(el\s+)?dolor\b/],
  [TEMAS.USO, /\bniveles?\s+de\s+(calor|temperatura|intensidad)\b/],
  [TEMAS.USO, /\bcalienta\b/],

  // ---- Como se alimenta: bateria, cargador, enchufe ----
  //
  // TEMA APARTE, y por un motivo concreto: la ficha declara "si funciona
  // con bateria o enchufado, y cuanto dura" como dato NO CONFIRMADO. Estaba
  // dentro de USO, y USO responde con `paraQueSirve`, asi que preguntar por
  // el cargador recibia la frase de los colicos:
  //
  //   clienta: "Con cables para cargar"
  //   bot:     "Sí, es justo para eso: el calor en la zona baja del
  //             abdomen ayuda a relajar y alivia el cólico."
  //
  // Paso el 08-oct. Y "Trae cargador" no casaba con nada, asi que recibio
  // una peticion de datos. Dos mensajes seguidos sin respuesta a lo que
  // pregunto.
  //
  // Separarlo permite contestar lo honesto -que ese dato lo confirma una
  // persona- sin tocar la respuesta de "para que sirve", que es correcta.
  [TEMAS.ENERGIA, /\bes\s+recargable\b/],
  [TEMAS.ENERGIA, /\b(bateria|pila|cable|usb|enchuf|cargador|carga)\w*/],

  // ---- Desconfianza ----
  [TEMAS.CONFIANZA, /\bes\s+(real|confiable|seguro|estafa)\b/],
  [TEMAS.CONFIANZA, /\bson\s+(reales|confiables|seguros)\b/],
  [TEMAS.CONFIANZA, /\bno\s+es\s+estafa\b/],
  [TEMAS.CONFIANZA, /\bdonde\s+(estan|quedan|es)\b/],
  [TEMAS.CONFIANZA, /\btienen\s+(tienda|local|direccion)\b/],

  // ---- Fotos ----
  [TEMAS.FOTOS, /\bfotos?\b/],
  [TEMAS.FOTOS, /\bimagen(es)?\b/],
  [TEMAS.FOTOS, /\bver(lo|la)?\b/],
];

/**
 * Señales de que el cliente QUIERE COMPRAR, no solo averiguar.
 *
 * Es la lista que autoriza a pedir los datos de entrega. Tiene que ser
 * explicita: "lo quiero", "me sirve", "dale". Una duda no entra aqui.
 */
const SENALES_DE_COMPRA = [
  // ----------------------------------------------------------------------
  // EL PLURAL TAMBIEN ES UNA SEÑAL DE COMPRA
  //
  // Esto solo cubria singular -"lo quiero", "la quiero"- y el combo de dos
  // era casi imposible de cerrar hablando:
  //
  //   clienta: "¿cuánto me salen dos?"
  //   bot:     "2 unidades te quedan en $85.000..."
  //   clienta: "las quiero"
  //   bot:     "¿Cuántos quieres?"     <- no lo leyo como compra
  //
  // "las quiero", "me las llevo" y "las dos" son justo lo que dice quien
  // compra dos. Sin el plural, el precio del combo no servia para nada.
  // ----------------------------------------------------------------------
  /\b(lo|la|los|las)\s+(quiero|llevo|compro|necesito)\b/,
  /\bme\s+(lo|la|los|las)\s+(llevo|quedo)\b/,
  // "AYUDA CON PEDIDO", "ayudame a pedirlo", "quiero hacer el pedido".
  //
  // Es alguien pidiendo que le ayuden a COMPRAR, y no se reconocia: casaba
  // con el tema USO -por "ayuda con"- y recibia una explicacion de para
  // que sirve el producto. El 08-oct una clienta lo escribio despues de
  // haber dado ciudad y cantidad, y el bot le volvio a explicar el
  // producto en vez de cerrarle la venta.
  /\bayud(a|ame|arme)\s+(con|a)\s+(el\s+|la\s+|mi\s+)?(pedido|compra|comprar|pedir)/,
  /\bquiero\s+(hacer\s+)?(el\s+|un\s+)?pedido\b/,
  /\b(quiero|llevo|dame|mandame|enviame)\s+(los|las)\s+dos\b/,
  // El DIGITO tambien: "quiero 2 unidades" no se leia como compra porque
  // esto solo cubria los numeros escritos con letras.
  /\bquiero\s+(\d{1,2}|uno|una|un|dos|tres|cuatro|cinco|comprarlo|comprarla|pedirlo|pedirla|ese|esa|el|la)\b/,
  /\b(quiero|llevo|dame|mandame|enviame|necesito)\s+\d{1,2}\s*(unidades?|cinturones|cinturon)?\b/,
  /\b(dale|hagale|hagamoslo|de\s+una|despachalo|despachelo)\b/,
  /\b(como\s+)?(hago|hacemos)\s+para\s+(pedir|comprar|que\s+me\s+llegue)\b/,
  /\b(mandem?el[oa]|envielo|enviamelo|envienmelo|despachenlo)\b/,
  /\bvoy\s+a\s+(llevar|comprar|pedir)\b/,
  /\bcomo\s+pido\b/,
  /\bquiero\s+(hacer|realizar)\s+(el|un)\s+pedido\b/,
];

// --------------------------------------------------------------------------
// SEÑALES DEBILES: LAS QUE CAMBIAN DE SENTIDO CON UN SIGNO DE PREGUNTA
//
// "me sirve" afirmando es una señal de compra clarisima. "¿me sirve?" es la
// duda mas frecuente de un producto que se pone en el cuerpo, y es lo
// CONTRARIO: el cliente todavia no sabe si le queda.
//
// Estaban en la lista de arriba y produjeron esto, que salio al probar el
// dialogo completo:
//
//   clienta: "¿me sirve a mí? uso talla XL"
//   bot:     "...¿Cuántos quieres? Y para despacharlo me pasas la ciudad y
//             la dirección."
//
// Le pidio la direccion a alguien que acababa de preguntar si el producto le
// iba a quedar. Por eso estas solo cuentan como compra cuando la frase NO es
// una pregunta.
// --------------------------------------------------------------------------
const SENALES_DEBILES = [
  /\b(me\s+)?(sirve|interesa|conviene|parece\s+bien)\b/,
  // "las dos" suelto es una señal DEBIL, no fuerte: afirmando es aceptar el
  // combo ("las dos"), pero preguntando es pedir su precio ("¿cuánto
  // cuestan las dos?"). Aqui solo vale sin interrogacion.
  // El lookbehind excluye la hora: "a las dos de la tarde".
  /(?<!\ba\s)\blas\s+dos\b/,
  // "vale" en Colombia es "de acuerdo", y por eso esta aqui... pero tambien
  // es el verbo de "¿cuánto VALE?". Sin el lookbehind, preguntar el precio
  // contaba como aceptar la compra, y el bot le pedia los datos de entrega a
  // quien solo estaba averiguando — justo lo que este modulo existe para
  // evitar. Lo mismo con "a como vale".
  /(?<!\b(?:cuanto|cuantos|cuantas|que|cual|como)\s)\b(listo|perfecto|vale|bueno)\b/,
];

// --------------------------------------------------------------------------
// LA CANTIDAD POR LA QUE PREGUNTA, QUE NO ES LA DEL PEDIDO
//
// "Nunca contestes el precio de una unidad a una pregunta sobre dos". Para
// cumplirlo hay que saber por cuantas pregunta, y eso es un dato DISTINTO
// de la cantidad que ya tiene en su ficha o en un pedido confirmado.
//
// SE LEE PEGADO AL VERBO, no en todo el mensaje, y el motivo es una
// direccion: "cuanto vale a Calle 20 # 15-30" tiene un 20 y un 15, y leer
// cualquier numero del mensaje haria que preguntara por 20 unidades. El
// mismo error que ya se cometio una vez leyendo "calle 45" como 45 unidades.
// --------------------------------------------------------------------------
const UNIDADES_CONSULTADAS = [
  // "que valen dos", "cuanto cuestan 2", "cuanto sale el par", "precio de 3"
  /\b(?:vale|valen|cuesta|cuestan|sale|salen|saldria|saldrian|seria|serian|precio\s+de|por|como)\s+(?:las?\s+|los?\s+|el\s+)?(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par|docena)\b/,
  // "y las dos", "los dos", "el par"
  /\b(?:las|los)\s+(dos|tres|cuatro)\b/,
  /\bel\s+(par)\b/,
  // "dos unidades", "2 cinturones"
  /\b(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par|docena)\s+(?:unidades?|cinturones|cinturon|fajas?)\b/,
  // LA CANTIDAD DE LA PREGUNTA CONDICIONAL: "y si llevo dos?", "llevando
  // tres". El patron que la reconoce como pregunta de precio vive en
  // `texto.js`; aqui hay que sacarle el numero, o se cotizaria por la
  // cantidad de la ficha en vez de por la que pregunto.
  /\b(?:y\s+si\s+(?:me\s+)?(?:llevo|pido|compro)|si\s+(?:me\s+)?(?:llevara|llevaria|pidiera|comprara)|llevando)\s+(?:las?\s+|los?\s+|el\s+)?(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par|docena)\b/,
  // EL NUMERO DELANTE DEL VERBO: "y tres cuánto valen?", "2 cuánto cuestan".
  // Faltaba, y el hueco se colaba justo donde mas duele: con un pedido ya
  // confirmado, "y tres cuanto valen?" contestaba el precio de SU pedido.
  //
  // Va anclado al principio del mensaje -con un "y" opcional- a proposito.
  // Sin el ancla, "Calle 20 cuanto vale el envio" leeria 20 unidades: el
  // mismo error de confundir una direccion con una cantidad, otra vez.
  /^\s*(?:y\s+)?(\d{1,2}|dos|tres|cuatro|cinco|seis|par)\s+(?:cuanto|cuantos|que)\s+(?:vale|valen|cuesta|cuestan|sale|salen)/,
];

/**
 * Por cuantas unidades pregunta, si lo dice.
 *
 * @returns {number|null} null cuando no lo dice: entonces NO se adivina.
 */
function cantidadPreguntadaEn(plano) {
  const { NUMEROS_EN_PALABRAS } = require("./texto");
  for (const re of UNIDADES_CONSULTADAS) {
    const m = plano.match(re);
    if (!m) continue;
    const bruto = m[1];
    const valor = /^\d+$/.test(bruto) ? Number(bruto) : NUMEROS_EN_PALABRAS[bruto];
    // Fuera de 1..20 no es una cantidad: es un precio, un año o una calle.
    if (Number.isFinite(valor) && valor >= 1 && valor <= 20) return valor;
  }
  return null;
}

// --------------------------------------------------------------------------
// "OTRO" ES UNA INTENCION DISTINTA DE "CUANTO VALE"
//
// Con un pedido ya confirmado hay dos preguntas que se parecen y no son lo
// mismo:
//
//   "¿que valen dos?"      -> quiere SABER un precio. Se le dice y punto.
//   "¿cuanto vale otro?"   -> quiere OTRO. Eso es una venta adicional.
//
// La diferencia importa porque la segunda necesita que una persona la arme
// -el bot no toca un pedido confirmado- y la primera no necesita a nadie.
// Confundirlas en un sentido pierde una venta; en el otro, convierte la
// respuesta en el estribillo "le digo a una persona" en cada mensaje.
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// PREGUNTAR POR SU PEDIDO NO ES PREGUNTAR POR EL ENVIO
//
// Con un pedido confirmado, el numero de pedido se añadia a cualquier
// mensaje que mencionara envio o entrega. Y "¿cuánto cuestan 2 con envío?"
// menciona el envio sin preguntar nada de su pedido:
//
//   clienta: "y cuánto cuestan 2 con envío"
//   bot:     "2 unidades te quedan en $85.000. El envío va incluido...
//             Tu pedido NOV-... ya está confirmado y te avisamos..."
//
// Esa ultima frase no la pidio nadie. Mezcla una consulta NUEVA -quiere
// comprar mas- con el estado de una compra vieja, y convierte una respuesta
// de dos lineas en un parrafo donde lo importante queda enterrado.
//
// El estado del pedido se dice cuando pregunta POR EL PEDIDO: "¿ya salió?",
// "¿cuándo me llega lo que pedí?", "mi guía".
// --------------------------------------------------------------------------
const PREGUNTA_POR_SU_PEDIDO = [
  /\b(mi|el)\s+(pedido|compra|paquete|envio|guia|orden)\b/,
  /\b(ya\s+)?(salio|despacharon|despacho|enviaron|mandaron)\b/,
  /\bnumero\s+de\s+(pedido|guia)\b/,
  /\b(cuando|donde)\s+(me\s+)?(llega|va\s+a\s+llegar|esta)\b.*\b(lo\s+que\s+pedi|mi\s+pedido|mi\s+paquete)\b/,
  /\b(lo\s+que|el\s+que)\s+pedi\b/,
  /\bestado\s+de\s+mi\b/,
  /\brastre(o|ar)\b/,
];

const QUIERE_OTRO = [
  /\b(otro|otra|otros|otras)\b/,
  /\b(uno|una|dos)\s+mas\b/,
  /\bmas\s+unidades?\b/,
  /\b(pedir|comprar|llevar)\s+(mas|otro|otra)\b/,
];

// --------------------------------------------------------------------------
// "NO ME CARGARON LAS FOTOS"
//
// El bot ofrece reenviarlas -"si no te cargaron, dime y te las paso otra
// vez"- y la deduplicacion lo impedia: no reenvia dos veces las mismas
// imagenes al mismo chat, que es correcto para no llenar la pantalla pero
// convierte el ofrecimiento en una promesa falsa.
//
// Lo que faltaba era distinguir "muestrame fotos" de "las fotos no me
// llegaron". La segunda es un acto explicito del cliente, y entonces se
// fuerza el reenvio: `enviarFotosDeProducto` ya acepta `forzar`.
// --------------------------------------------------------------------------
/**
 * SE QUEJA DE QUE NO LE LLEGARON. Basta por si sola: es lo que se escribe
 * justo despues de recibir unas imagenes que no abren, y no se dice de
 * ninguna otra cosa de esta conversacion.
 */
const NO_LE_LLEGARON = [
  /\bno\s+(me\s+)?(las|los|la|lo)?\s*(cargaron|cargan|carga|llegaron|llego|llegan|abren|abre|abrieron)\b/,
  /\bno\s+(las|los|la|lo)\s+(veo|puedo\s+ver|recibi|recibo)\b/,
  /\bno\s+(me\s+)?(se\s+ven|se\s+ve|veo)\b/,
  /\bestan?\s+(borrosas?|en\s+blanco|cortadas?)\b/,
];

/**
 * PIDE QUE SE REPITAN. Necesita que nombre las imagenes: "otra vez" suelto
 * tambien sirve para "dime el precio otra vez", que no es pedir fotos.
 */
const OTRA_VEZ = /\b(otra\s+vez|de\s+nuevo|nuevamente|repite|reenvia|reenviame|mandalas|pasalas)\b/;
const NOMBRA_IMAGENES = /\b(fotos?|imagen(es)?|videos?|fotico|fotitos)\b/;

/**
 * ¿Pide que se le reenvien las fotos?
 *
 * EL CONTEXTO IMPORTA, y es la correccion de Marco: "no las veo" o "estan
 * borrosas" solo se refieren a las fotos cuando la conversacion va de las
 * fotos. La primera version aceptaba la queja SOLA, y entonces "no veo el
 * boton", "no veo la direccion que puse" o "no se ve bien el precio"
 * disparaban cinco imagenes que nadie habia pedido.
 *
 * Dos contextos valen, y los dos son explicitos:
 *
 *   · NOMBRA las imagenes -"las fotos no cargan"-, que no deja duda.
 *   · O acabamos de mandarlas. Una queja de "no las veo" justo despues de
 *     recibir unas imagenes se refiere a esas imagenes; la misma frase tres
 *     dias despues, no.
 *
 * @param {string} texto
 * @param {object} [contexto]
 * @param {boolean} [contexto.fotosRecientes] se le mandaron fotos hace poco
 */
function pideReenvioDeFotos(texto, { fotosRecientes = false } = {}) {
  const plano = aplanar(texto);
  if (!plano) return false;

  // Si nombra las imagenes, no hace falta mas contexto.
  if (NOMBRA_IMAGENES.test(plano)) {
    return NO_LE_LLEGARON.some((re) => re.test(plano)) || OTRA_VEZ.test(plano);
  }

  // Si NO las nombra, solo vale la queja y solo si acabamos de mandarlas.
  if (!fotosRecientes) return false;
  return NO_LE_LLEGARON.some((re) => re.test(plano));
}

/** Cuanto tiempo despues de mandarlas una queja sigue siendo sobre ellas. */
const MINUTOS_DE_CONTEXTO_DE_FOTOS = 60;

/**
 * ¿Se le mandaron fotos hace poco? Es lo que convierte "no las veo" en una
 * queja sobre las fotos y no sobre cualquier otra cosa.
 */
function fotosRecientes(cuando, { ahora = Date.now(), minutos = MINUTOS_DE_CONTEXTO_DE_FOTOS } = {}) {
  if (!cuando) return false;
  const t = new Date(cuando).getTime();
  if (!Number.isFinite(t)) return false;
  return ahora - t <= minutos * 60000;
}

// --------------------------------------------------------------------------
// "QUIERO INFORMACION" NO ES "QUIERO UNO"
//
// EL CASO REAL, de un cliente que llego por la publicidad:
//
//   cliente: "Hola, quiero información sobre el cinturón térmico de $49.900."
//   bot:     "¡Hola! Una unidad te queda en $49.900... ¿Cuántos quieres? Y
//             para preparar tu pedido me pasas tu nombre completo, la ciudad
//             y la dirección."
//
// Le pidio nombre, ciudad y direccion a alguien que pidio INFORMACION. Y la
// palabra que lo disparo no fue ninguna señal de compra: el mensaje no se
// reconocia como NADA -sin temas, sin pregunta, sin saludo- y el camino de
// "no pregunto nada" acaba pidiendo los datos.
//
// Es el peor sitio donde fallar: es el PRIMER mensaje de alguien por el que
// estamos pagando publicidad.
//
// Pedir informacion es una intencion propia, distinta de las otras tres:
//
//   "¿tiene garantia?"   -> pregunta un TEMA concreto
//   "lo quiero"          -> compra
//   "hola"               -> saludo
//   "quiero informacion" -> quiere que le CUENTEN, sin preguntar nada aun
//
// Y se responde como se merece: presentando el producto con sus condiciones
// y dejando la puerta abierta a preguntar. Sin pedir un solo dato.
// --------------------------------------------------------------------------
const PIDE_INFORMACION = [
  /\b(quiero|quisiera|necesito|me\s+gustaria|podrias?\s+darme|me\s+das|mandame|me\s+puedes?\s+dar)\s+(mas\s+)?(informacion|info|detalles|datos)\b/,
  /\b(mas\s+)?(informacion|info)\s+(sobre|del|de\s+la|acerca)\b/,
  /^\s*(informacion|info)\b/,
  /\bcuentame\s+(mas|sobre|del|de)\b/,
  /\bque\s+me\s+(puedes?|podrias?)\s+(decir|contar)\b/,
  /\bme\s+explicas?\b/,
  /\bde\s+que\s+se\s+trata\b/,
  // "que tal el producto", "como es el cinturon": piden que les cuenten.
  // Caian en la red de texto vacio y recibian un "¿en qué te puedo
  // ayudar?" generico, teniendo la ficha entera para contestarles.
  /\bque\s+tal\s+(el|la|ese|esa|los|las)\b/,
  /\bcomo\s+es\s+(el|la|ese|esa)\b/,
  /\bque\s+es\s+(eso|esto|el|la)\b/,
  // "TIENES CINTURONES", "¿hay disponible?", "¿todavía los tiene?".
  //
  // Es preguntar si HAY, y la respuesta es presentar el producto. No se
  // reconocia: `PALABRA_DE_PREGUNTA` conocia "tienen" pero no "tienes", asi
  // que el mensaje no era ni una pregunta y Marco recibio esto probando el
  // 08-oct:
  //
  //   Marco · "Tienes cinturones"
  //   bot   · "Perdón, no quiero repetirme. Dime concretamente qué
  //            necesitas y lo reviso con el equipo."
  //
  // A quien pregunta si hay producto no se le pide que se explique mejor.
  /\b(tienes|tiene|tienen|hay|queda|quedan|manejas|manejan|venden|vendes)\s+(\w+\s+)?(cinturon|cinturones|faja|fajas|disponible|disponibles|existencia|stock|unidades)\b/,
  /\b(hay|tienes|tienen)\s+disponib/,
];

/**
 * Un "gracias" pelado: ni pregunta ni compra.
 *
 * DEFECTO MEDIDO, y estaba anotado como conocido sin arreglar: a "gracias"
 * el bot respondia "¿cuántos quieres? y para preparar tu pedido me pasas la
 * ciudad y la dirección". Le pedia los datos a quien estaba despidiendose o
 * dando las gracias por una respuesta.
 *
 * Marco lo volvio a ver probando desde su numero el 08-oct.
 *
 * Va con `^` y con tope de palabras: "gracias, pero cuanto vale?" SI es una
 * pregunta, y "gracias, me lo llevo" SI es una compra. Lo que se quiere
 * cazar es el mensaje que SOLO agradece.
 */
const SOLO_AGRADECE = [
  /^(muchas\s+|mil\s+|muy\s+)?gracias\b/,
  /^(ok|oka|okey|listo|vale|bueno)\s*,?\s*(muchas\s+|mil\s+)?gracias\b/,
  /^(te\s+|le\s+)?agradezco\b/,
];

/** Saludos puros: no preguntan nada. */
const SALUDOS = [
  /^(hola|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|hey|que\s+tal|saludos|buen\s+dia)\b/,
];

/**
 * ¿Qué pregunta este mensaje?
 *
 * @returns {{temas: string[], pregunta: boolean, compra: boolean,
 *            saludo: boolean, soloSaludo: boolean}}
 */
function leer(texto) {
  const plano = aplanar(texto);
  const crudo = String(texto ?? "");

  const temas = [];
  for (const [tema, re] of PATRONES) {
    if (re.test(plano) && !temas.includes(tema)) temas.push(tema);
  }

  // ----------------------------------------------------------------------
  // "¿QUE PRECIO TIENE EL ENVIO?" PREGUNTA POR EL ENVIO, NO POR EL PRODUCTO
  //
  // La palabra "precio" marcaba el tema PRECIO y el bot contestaba las dos
  // cosas: "el cinturón te queda en $49.900. El envío va incluido". Le
  // soltaba una cifra que no habia pedido antes de contestar lo suyo.
  //
  // "con envio" es lo CONTRARIO -"¿cuánto vale con envío?" pregunta el
  // total- y por eso se distingue por la preposicion: "del/el envio" es el
  // envio en si, "con envio" es el producto ya sumado.
  // ----------------------------------------------------------------------
  const PRECIO_DEL_ENVIO = /\b(precio|valor|cuanto|vale|cuesta|sale)\b[^?]*\b(de|del)?\s*(el\s+)?envio\b/;
  const PRECIO_CON_ENVIO = /\bcon\s+(el\s+)?envio\b/;
  if (temas.includes(TEMAS.PRECIO) && PRECIO_DEL_ENVIO.test(plano) && !PRECIO_CON_ENVIO.test(plano)) {
    const i = temas.indexOf(TEMAS.PRECIO);
    temas.splice(i, 1);
    if (!temas.includes(TEMAS.ENVIO)) temas.unshift(TEMAS.ENVIO);
  }

  // ----------------------------------------------------------------------
  // A QUIEN SE QUEJA DEL PRECIO NO SE LE REPITE EL PRECIO
  //
  // "me lo dejas mas barato" marca las dos cosas: la objecion y -por la
  // palabra "precio" o el verbo- el tema PRECIO. Y PRECIO es un tema
  // comercial, asi que el cerebro encabezaba el mensaje volviendo a
  // cantarle la cifra a quien acababa de decir que le parecia alta. Eso no
  // es contestar: es insistir.
  //
  // EXCEPCION: si pregunta por una CANTIDAD concreta ("esta caro, y dos
  // cuanto me salen?") ahi si quiere una cifra, y se le da. Por eso la
  // cantidad se calcula ANTES de quitar el tema.
  // ----------------------------------------------------------------------
  const cantidadEnLaPregunta = temas.includes(TEMAS.PRECIO) ? cantidadPreguntadaEn(plano) : null;
  if (temas.includes(TEMAS.OBJECION_PRECIO) && temas.includes(TEMAS.PRECIO) && !cantidadEnLaPregunta) {
    temas.splice(temas.indexOf(TEMAS.PRECIO), 1);
  }

  const saludo = SALUDOS.some((re) => re.test(plano));
  const interrogacion = /\?/.test(crudo);
  // PEDIR INFORMACION GANA A LAS SEÑALES DE COMPRA.
  //
  // "quiero informacion" contiene "quiero", y "me interesa" es una señal
  // debil. Quien pide que le cuenten NO esta comprando todavia, y tratarlo
  // como comprador es lo que hizo que el primer mensaje de un cliente de
  // publicidad recibiera una peticion de nombre y direccion.
  //
  // Las señales FUERTES y explicitas siguen ganando: "quiero información y
  // me llevo dos" es las dos cosas, y ahi manda la compra.
  const pideInfo = PIDE_INFORMACION.some((re) => re.test(plano));
  const COMPRA_INEQUIVOCA = [
    /\b(lo|la|los|las)\s+(quiero|llevo|compro)\b/,
    /\bme\s+(lo|la|los|las)\s+(llevo|quedo)\b/,
    /\bme\s+llevo\s+(\d{1,2}|uno|una|dos|tres|el|la)\b/,
    /\bquiero\s+(\d{1,2}|uno|una|dos|tres)\b/,
    /\b(dale|de\s+una|hagale)\b/,
  ];

  // OBJETAR EL PRECIO NO ES COMPRAR, y una señal DEBIL no lo convierte.
  //
  // Defecto real medido antes de este cambio: "esta muy caro, pero bueno"
  // salia con `compra: true`. La culpa era de la señal debil `bueno` -que
  // ahi no significa "de acuerdo", es una muletilla de resignacion- y el
  // efecto era el peor posible: el bot le pedia nombre, ciudad y direccion
  // a quien acababa de decir que el precio le parecia alto.
  //
  // Las señales FUERTES siguen valiendo: "esta caro pero me lo llevo" es
  // una compra, y una objecion no puede bloquear un "me lo llevo".
  const objetaElPrecio = temas.includes(TEMAS.OBJECION_PRECIO);
  const compra = pideInfo
    ? COMPRA_INEQUIVOCA.some((re) => re.test(plano))
    : SENALES_DE_COMPRA.some((re) => re.test(plano)) ||
      // Las debiles solo valen si el cliente NO esta preguntando ni objetando.
      (!interrogacion && !objetaElPrecio && SENALES_DEBILES.some((re) => re.test(plano)));

  // Un signo de interrogacion es una señal fuerte, pero no la unica: mucha
  // gente pregunta sin escribirlo ("cuanto vale").
  const interroga = interrogacion || temas.length > 0;

  // ----------------------------------------------------------------------
  // "ESTO ES UNA PREGUNTA" Y "SE DE QUE ME PREGUNTA" SON DOS COSAS
  //
  // `pregunta` exige un tema reconocido, asi que una duda que el catalogo
  // no cubre quedaba clasificada como "no pregunto nada". Y eso llevaba a
  // la peor respuesta que daba el bot:
  //
  //   clienta: "oye y esto me lo puedo poner dormida toda la noche?"
  //   bot:     "¿Cuántos quieres? Y para despachártelo me pasas tu nombre
  //             completo, la ciudad y la dirección."
  //
  // Le pide la direccion a quien pregunta por la seguridad del producto.
  // Es justo lo que este modulo existe para evitar, colandose por el hueco
  // de los temas NO catalogados.
  //
  // Saber que es una pregunta -aunque no se sepa de que- ya basta para no
  // contestar con un formulario.
  // ----------------------------------------------------------------------
  const PALABRA_DE_PREGUNTA =
    /\b(que|qué|cual|cuales|como|cuando|donde|cuanto|cuanta|cuantos|cuantas|quien|por\s+que|se\s+puede|puedo|podria|hay|tienes|tiene|tienen|manejas|manejan|venden|vendes|queda|quedan|sirve|funciona|es\s+seguro)\b/;

  return {
    temas,
    pregunta: interroga && temas.length > 0,
    compra,
    saludo,
    // Por cuantas pregunta. Solo interesa si pregunta el precio: en
    // cualquier otro sitio la cantidad la decide la ficha, no el detector.
    // Ya calculada arriba: se necesitaba ANTES de decidir si el tema PRECIO
    // sobra por venir junto a una objecion.
    cantidadPreguntada: cantidadEnLaPregunta,
    // ¿Habla de UNO MAS? Es lo que distingue una venta adicional de una
    // simple consulta de precio cuando ya hay un pedido confirmado.
    quiereOtro: QUIERE_OTRO.some((re) => re.test(plano)),
    // Parece una pregunta, aunque no se sepa de que. Basta para no
    // responder con un formulario.
    pareceUnaPregunta: interrogacion || PALABRA_DE_PREGUNTA.test(plano),
    // ¿Pregunta por SU pedido? Es lo unico que autoriza a mencionar su
    // numero de pedido y su estado.
    porSuPedido: PREGUNTA_POR_SU_PEDIDO.some((re) => re.test(plano)),
    // ¿Pide que le cuenten? Se presenta el producto y NO se pide un dato.
    pideInformacion: PIDE_INFORMACION.some((re) => re.test(plano)),
    // Un "hola" pelado: ni pregunta ni compra. Merece un arranque, no un
    // interrogatorio.
    soloSaludo: saludo && temas.length === 0 && !compra && plano.split(/\s+/).length <= 4,
    // Un "gracias" pelado. A quien agradece no se le pide la direccion.
    soloAgradece:
      SOLO_AGRADECE.some((re) => re.test(plano)) &&
      temas.length === 0 &&
      !compra &&
      !interrogacion &&
      plano.split(/\s+/).length <= 4,
  };
}

/**
 * ¿Es un turno puramente informativo?
 *
 * Preguntar no es comprar. Si es informativo, el cerebro responde la duda y
 * NO pide los datos de entrega: pedirlos ahi es lo que hace que el cliente
 * que estaba averiguando se sienta perseguido.
 */
function esInformativo(texto) {
  const r = leer(texto);
  return r.pregunta && !r.compra;
}

module.exports = {
  TEMAS,
  leer,
  esInformativo,
  cantidadPreguntadaEn,
  pideReenvioDeFotos,
  fotosRecientes,
  MINUTOS_DE_CONTEXTO_DE_FOTOS,
  SENALES_DE_COMPRA,
  SENALES_DEBILES,
  PATRONES,
};
